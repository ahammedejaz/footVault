# The courier webhook

Shiprocket's status-update webhook, the reconciliation sweep behind it, and the
queue they both feed.

Written on 2026-08-15, after FV-2026-00668 was cancelled in the Shiprocket
portal and sat `packed` in this shop for a day with the customer's ₹13.50 still
captured. Nothing was broken. There was no inbound path.

---

## 1 · What exists now

| path | trigger | what it can do |
|---|---|---|
| `POST /api/parcel/inbound` | Shiprocket pushes on every shipment status change | records the event, applies *delivered* and *RTO*, raises everything else |
| `POST /api/cron/poll-deliveries` | pg_cron → pg_net, every 30 minutes | the same, pulled — plus the shipments no webhook can reach |
| "Refresh tracking" on an order | a person | the same, for one parcel |

All three parse into one `CourierSignal` and call one `applyCourierSignal`
(`src/lib/shipping/inbound.ts`). They deduplicate **against each other** on a
shared `event_key`, so a sweep that rediscovers what the webhook already told us
writes nothing and raises nothing. Two inbound paths that disagree would be
worse than one; these cannot disagree, because there is only one interpreter.

## 2 · The vocabulary, and what is deliberately missing

This shop understands two things a courier can say:

- **delivered** — stamps `orders.delivered_at` from the courier's own
  timestamp, once and never again, and promotes the order;
- **RTO** — hands off to `detectRtoFromTracking`.

**Everything else is recorded and raised for a person.** That is a decision, not
a gap. Shiprocket's documented sample payload carries exactly one status
(`Delivered`, id 7), and a status map assembled from recollection is a map of
guesses that will be trusted like facts. `current_status_id` is stored on every
row and dispatched on by nothing.

The queue is where an unknown goes: `courier_events.needs_attention`, rendered
on `/admin` and on the order's own page, with the refundable amount computed
live beside it. When the same status has arrived enough times to be understood,
the payloads are all there to write the map from.

## 3 · Setting it up in the Shiprocket portal

Settings → API → Webhooks (the page with the "Auth Token Type" dropdown).

| field | value |
|---|---|
| Webhook URL | `https://www.footvault.in/api/parcel/inbound` |
| Auth Token Type | **`Authorization`** (the default) |
| Auth Token | the value of `COURIER_WEBHOOK_TOKEN` — see below |
| Method | POST |

**The URL must not contain `shiprocket`, `kartrocket`, `sr` or `kr`.** That is
Shiprocket's own rule and it is why the path is `/api/parcel/inbound` rather
than anything that names the courier. `audit:courier-inbound` asserts all four
substrings against the full URL, host included, so a future rename cannot
quietly break the configuration.

The endpoint must be reachable **without deployment protection**: Vercel's
protection covers `*.vercel.app` previews, and the custom domain above is
public. Do not paste a `*.vercel.app` URL into the portal — it is SSO-gated and
every event will 401.

## 4 · The token

Generate one that exists nowhere in this repository:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

Set it in **two** places, identical:

1. **Vercel** → the project → Settings → Environment Variables →
   `COURIER_WEBHOOK_TOKEN`, Production (and Preview if you want the preview
   deployments to accept it too). Redeploy after adding it; environment
   variables are read at boot.
2. **Shiprocket** → the Auth Token box on the webhook page.

If it is set in neither, the endpoint refuses every request — deliberately.
"Unset means open" is how a route quietly becomes public the first time a
variable fails to copy across.

`Authorization: <token>` and `Authorization: Bearer <token>` are both accepted,
because the second is what a person pastes when the header is called
`Authorization` and they have seen an API before.

## 5 · Pressing "Test Webhook"

Then look, in this order:

1. **`/admin`** — a red strip near the top: *"A courier said something about a
   parcel that this shop did not act on."* Shiprocket's test payload names a
   parcel this shop has never heard of, so the expected result is one raised
   event reading *"A courier update arrived for a parcel this shop cannot find.
   AWB …"*. **That is a success.** It means the URL resolved, the token matched,
   the body parsed, and the row was written.
2. **Vercel → the project → Logs**, filtered to `/api/parcel/inbound`. A
   successful test logs `[parcel-inbound] recorded — NEEDS ATTENTION` at error
   level, with the AWB, the status, the parsed timestamp and what we made of it.
   A rejected one logs `[parcel-inbound] refused: bad or missing token` and
   answers 401.
3. **The database**, if you want the payload itself:
   `select * from courier_events order by received_at desc limit 5;`

Clear the test event with **"I have dealt with this"** on the dashboard strip.
That records who cleared it and when; it does not delete anything.

## 6 · What this deliberately will not do

It will not refund anything, cancel anything, or move an order for any status
other than delivered and RTO. A cancelled parcel becomes a row with the
refundable amount computed and a person's name on the decision, because whether
a shipment is actually dead is a fact that lives in the Shiprocket portal rather
than in this database — and a shop does not move a customer's money on an
inference.

## 7 · Security, stated plainly

There is no HMAC. Shiprocket authenticates with a static token, and that is the
whole of it: anyone with the URL and the token can post arbitrary courier state.
What the receiver does about that:

- constant-time comparison, so the endpoint is not an oracle for guessing the
  token a byte at a time;
- an identical 401 for a wrong token and for a body we cannot read, so a prober
  cannot tell which half to keep changing;
- a body size cap and a per-caller rate limit;
- and the containment that matters most — **a forged status cannot move an
  order unless it is one of the two this shop understands**, because a real one
  cannot either.

Rotate the token by changing it in Vercel and in the portal. There is no
in-between state to worry about: events sent with the old token answer 401,
Shiprocket retries, and they land once the portal is updated.

## 8 · The gate

`npm run audit:courier-inbound` — 44 checks over the IST offset, the numeric
AWB (including one long enough to lose precision in `JSON.parse`), matching
precedence, the unmatched miss, unknown statuses, replay, out-of-order arrival,
the refusals, and one real POST end to end.

Proved red twice on 2026-08-15: removing the token check turned six checks red
(including "an unauthenticated caller did not touch the order"), and changing
the timezone offset from `+05:30` to `+00:00` turned three red — one of them the
`delivered_at` actually written to an order.
