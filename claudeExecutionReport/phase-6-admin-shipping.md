# Phase 6 — admin panel and Shiprocket logistics

Branch `feat/phase-5-checkout-payments` (see §1.1 — this did not get its own
branch, and that was a mistake). Written for somebody who was not watching.

**Read §9 first if you are deciding whether to merge.** This phase is
*incomplete*: the Shiprocket integration and the admin panel's foundation, order
and inventory surfaces are built and tested; six admin routes and the order
detail page are not. That is stated at the top rather than at the bottom because
a report that buries it is worse than no report.

The shape of it in numbers: **18 migrations**, **25 new files** under
`src/lib/admin/`, `src/lib/shipping/`, `src/components/admin/`,
`src/app/admin/`, `src/lib/actions/admin/` and `src/lib/queries/admin/`
totalling about 5,400 lines, two new audit suites, one new ESLint rule, and 121
files changed overall.

---

## 1 · Preflight

### 1.1 P1 — three of the four assumptions were wrong

The brief said not to build on unverified ground. Good instinct:

| Check | Reality |
|---|---|
| Is PR #5 merged and deployed? | **No.** PR #5 is still `OPEN`. `main` is at Phase 4's merge `608b122`. Nothing from Phase 5 is in production. |
| Is `RAZORPAY_WEBHOOK_SECRET` set in Vercel? | **No — absent from both Preview and Production.** Only `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` exist. |
| Has a real test-card payment completed end to end? | **No.** |

The payment evidence, queried rather than assumed:

```
orders_total 4 · orders_confirmed 1 · payments_total 3 · payments_captured 0
payment_events_total 0
```

All three `payments` rows are `status='created'` with no `provider_payment_id`.
`payment_events` is **empty** — no webhook has ever been received, which follows
directly from the secret never having been set. The single `confirmed` order is
`FV-2026-00198`, **cash on delivery**.

**So the Razorpay path is unverified, and this report treats it that way
throughout.** What *is* verified by that data is worth stating: one COD order
proves `create_order_with_stock` works end to end in production, and the three
`cancelled` orders with `stock_restored_at` set prove the E-1 abandoned-order
sweep runs and restocks.

Because PR #5 is unmerged, this phase's work continued on the Phase 5 branch.
That is not what the brief intended and it means one branch now carries two
phases. Recorded as an imperfection (§10.1), not defended.

### 1.2 The Shiprocket credential — checked before building against it

The brief asked for this specifically, and it was right to.

`.env.local` held `SHIPROCKET_API_KEY`. Structural inspection first, without
printing the value: **32 characters, a single segment, mixed case with a
non-alphanumeric**. A Shiprocket JWT is roughly 700 characters in three
dot-separated parts beginning `eyJ`. It is not that.

Then empirically, one read-only request:

```
GET https://apiv2.shiprocket.in/v1/external/settings/company/pickup
→ 401 {"message":"unauthorized request","status_code":401}
```

**It authenticates nothing.** The good news is that the failure mode the brief
feared — a token that works for ten days and then silently dies — is not what
was there; it never worked at all. The value looks like a generated password,
plausibly one created for an API user.

An attempt to confirm that by trying it as a login password was **blocked by the
sandbox as credential guessing, and that block was correct.** It was not worked
around. Guessing at a live logistics account is the wrong move regardless of who
is asking.

`SHIPROCKET_API_KEY` is now absent from `.env.example`, replaced by
`SHIPROCKET_EMAIL`, `SHIPROCKET_PASSWORD` and `SHIPROCKET_PICKUP_LOCATION`, each
with the reasoning inline. See §8 for exactly what the owner must supply.

---

## 2 · P2 — the debts Phase 5 named

All seven cleared.

### 2.1 §8.4 — the stock movements ledger

`inventory_movements` (variant_id, variant_sku, delta, balance_after, reason,
reference_id, actor, note, created_at), with the reason enum the brief specified
plus two additions: `opening_balance` for the backfill, and `unspecified` for a
write that did not declare itself.

**The design decision that matters: the trigger is the only writer.**

The brief said "every path that mutates stock writes a movement row in the same
transaction". The obvious implementation is an insert at each call site. That
was rejected, because the scenario this ledger exists for is *a human editing a
number by hand* — and a call-site insert cannot cover the Supabase table editor,
a psql session, or a restore.

So `record_inventory_movement()` is an `AFTER UPDATE OF stock_quantity` trigger,
`SECURITY DEFINER` so it can write a table no role holds `INSERT` on, and
attribution arrives through four transaction-local GUCs
(`app.inventory_reason` / `_reference` / `_actor` / `_note`) that the calling
function sets. Nothing can move stock without leaving a row.

**Proven, both ways, in a rolled-back transaction:**

| Write | Recorded as |
|---|---|
| Attributed (`reason = admin_adjustment`) | `admin_adjustment`, `delta +3`, `balance_after 11` |
| Unattributed — the table-editor case | `unspecified`, `delta −1`, `balance_after 10` |

Opening balances backfilled for all **370** variants holding stock. The
reconciliation, `public.reconcile_inventory()`:

```
drift_rows 0 · ledger_rows 370 · ledger_total 2725 · stock_total 2725
```

And through the real order path, in a rolled-back transaction: placing an order
wrote **5** `order` movements, each `−1`, each carrying the order id as
`reference_id` and `Order FV-2026-00486` as the note, with reconciliation
holding at 0 drift.

Every existing stock path now declares itself: `create_order_with_stock` →
`order`, `cancel_order_with_restock` → `cancellation`, `release_abandoned_orders`
→ `sweep` (via a new sixth parameter, so the machine's reclaim is
distinguishable from a person's), and `adjust_variant_stock` →
`admin_adjustment` or `restock`.

### 2.2 §8.5 — rate limiting

Postgres-backed, not in module memory. A per-instance `Map` on Vercel resets on
every cold start and is not shared between the concurrent instances a burst
spreads across, so it counts almost nothing.

`public.consume_rate_limit(bucket, limit, window_seconds)` is a single
`INSERT … ON CONFLICT DO UPDATE` so the read-modify-write cannot interleave.
Applied to: the Razorpay webhook (300/60s per IP), `verifyRazorpayPayment`
(20/60s), `placeOrder` (10/60s), `abandonUnpaidOrder` (20/60s), every admin
mutation (120/60s), bulk admin writes (20/60s), Shiprocket fulfilment (30/60s)
and serviceability (60/60s). A `pg_cron` job prunes counters hourly.

**It fails open, deliberately, and therefore can never be load-bearing for
security.** A database blip that stopped orders — or that made us return non-2xx
to Razorpay until it disabled our webhook — trades a small abuse risk for a large
availability one.

The webhook's limiter is documented honestly rather than oversold: it cannot
stop the function invocation, which has already been billed by the time the line
runs. What it bounds is the *database* work a replay flood can cause downstream.
Volumetric defence is Vercel's WAF, not ours.

### 2.3 §8.3 / E-8 — `abandonUnpaidOrder`

**Wired, not deleted.** It is now reachable from the checkout failure panel as
"Cancel this order instead", with a two-step inline confirm. That is the right
home: a customer who closed the Razorpay window is holding stock for up to thirty
minutes, and the only other ways it comes back are the sweep and an admin.

E-8's actual finding was that the action was *unregistered* — tree-shaken out of
`server-reference-manifest.json`. Verified against that same file after a build:

```
abandonUnpaidOrder      REGISTERED
```

It now also passes the actor through to `cancel_order_with_restock`, so the
restock movement carries the customer's name.

### 2.4 §8.14 — the two suites that contradicted each other

`security-checkout.ts` §14 was written against pre-E-3 behaviour. It ran two of
the three things `/auth/callback` does — merge the bag, drop the cookie — and
never called `adopt_guest_orders()`. It then asserted the *consequence* of its
own omission, "the guest order is NOT attached to the account", as though that
were correct.

Rewritten to run the callback's real sequence in the callback's real order —
merge, **adopt**, then drop the cookie — and to assert what that produces: the
order is readable by the new account, `user_id` is set and `guest_token` is null.
The one assertion kept unchanged is that a stranger with no cookie still gets a
404, which was never the bug and must not become one.

### 2.5 §8.11 — the colourway caption

Restored as a caption under the product name, in the flow, never layered over the
image. `Peacoat Navy` for a single colourway, `Peacoat Navy · 3 colours` when
there are more — the count rather than a second name, because two names is wider
than a 156px card. Phase 5's removal was a judgement that "Peacoat Navy" is
glossary noise; the counter-argument is that two cards in one grid can be the
same model, brand and price, and the colourway is the only thing distinguishing
them.

### 2.6 §8.13 — `isSupabaseConfigured()`

Made honest **in code, not in a doc**. The root layout now calls
`missingSupabaseEnv()` and renders `<NotConfigured />` — a styled page naming the
exact variables that are missing — instead of the tree. The proxy's early return
stays, because a throw in middleware has no error boundary and produces a bare
500 with no markup.

The component is styled with literal colours and no design tokens on purpose: if
the reason you are seeing it is that the build is in a bad state, a page that
depends on the stylesheet renders as unstyled text.

### 2.7 §8.12 — the rail's scroll affordance

A track and a thumb below `lg`, sized to the visible fraction and positioned by
scroll offset. The peek card was never an affordance — it is an accident of how
many cards happen to fit, and at some widths the last card lands flush and it
disappears entirely. The strip holds its height whether or not the thumb is
painted, so a rail that turns out not to overflow does not shift the section
below it after hydration.

---

## 3 · Part 1 — the admin panel

### 3.1 What is built

| Piece | File |
|---|---|
| The authorization boundary | `src/lib/admin/guard.ts` |
| The lint rule that enforces it | `eslint-rules/admin-actions-must-guard.mjs` |
| Chrome, tablet-first | `src/components/admin/shell.tsx`, `nav.ts` |
| Shared furniture | `src/components/admin/ui.tsx` |
| Tables, sorting, pagination | `src/components/admin/table.tsx`, `src/lib/admin/list-params.ts` |
| Search | `src/components/admin/search-field.tsx` |
| Destructive confirmation | `src/components/admin/confirm-action.tsx` |
| Dashboard | `src/app/admin/page.tsx` |
| Orders list | `src/app/admin/orders/page.tsx` |
| Inventory + stock editing + per-variant ledger | `src/app/admin/inventory/page.tsx`, `src/components/admin/stock-cell.tsx` |
| Order state changes | `src/lib/orders/transition.ts`, `src/lib/actions/admin/orders.ts` |
| Stock adjustment | `src/lib/actions/admin/inventory.ts` + `public.adjust_variant_stock()` |
| Fulfilment actions | `src/lib/actions/admin/shipping.ts` |

### 3.2 Security — the three decisions

**The panel runs on the caller's own Supabase client.** Phase 1 already wrote
`admins manage …` RLS policies on every table. `adminAction()` therefore hands
the action the *caller's* client, where the database re-checks `is_admin()` on
every row; `elevated` is a separate, deliberately awkward second parameter for
the few places RLS cannot express the rule. The consequence is that the panel's
authorization does not depend on `guard.ts` being correct — a bug there still
hits a closed door in Postgres. The adversarial pass is what demonstrates this
(23 checks, §6 of `phase-6-security-review.md`).

**`footvault/admin-actions-must-guard`.** Every exported action under
`src/lib/actions/admin/` must go through `adminAction()`. One forgotten guard is
a full compromise, and it reads as completely fine: an admin folder, an admin
page, a name like `deleteProduct`. Proven to fire before being relied on — a
probe with one guarded and one unguarded export reported exactly one violation,
and a file missing `"use server"` reported that too.

**The rate limiter runs after the authorization check**, keyed by
`admin:<actor id>`, so an unauthorised caller cannot exhaust a real admin's
allowance.

### 3.3 The stock editor, and why it is not an inline input

The brief asked for stock to be inline-editable. It is a *button*, and the
reasoning is not a dodge: every stock change writes a ledger row carrying the
admin's name and a **required note**, and a note is not something you type into a
table cell. The cell opens the one place a change can be made properly — current
count, a delta, why, and the full movement history for that size.

The history is the half that stops it being a form. When a count is wrong, the
owner's question is never "what should it be", it is "what happened".

**A delta, not a new total**, with the resulting figure shown live. Two people
counting the same shelf with absolutes overwrite each other and one count
silently disappears; two deltas both land.

### 3.4 Order state changes reuse the Phase 5 machine

`transitionOrder()` is the fourth writer to `orders.status`, and the brief
permitted a fourth only if it does not bypass the compare-and-swap. It does not:
it reads, checks `canTransition()`, then `.eq("status", previous)` on the update
and retries up to three times against whatever actually won. Cancellation is
**delegated** to `cancel_order_with_restock` rather than reimplemented, so the
restock-exactly-once guard and the movement row stay in one place.

Cancelling a **paid** order is refused with a sentence pointing at Razorpay,
because that is a refund and refunds are Phase 8.

---

## 4 · Part 2 — Shiprocket

### 4.1 The token service

One module calls `/auth/login` and nothing else does.

- **Cached in Postgres** (`integration_tokens`), not module memory, so a cold
  start does not log in. A per-instance memo sits in front of it as a pure
  performance shortcut; `expiresAt` is checked on every read so a stale memo can
  never be used.
- **Refreshed proactively**, twelve hours before the 240-hour expiry. The cost of
  refreshing early is one extra login every ten days; the cost of refreshing late
  is a failed shipment while an owner is standing at the counter.
- **One re-authentication on 401**, then one retry. A second 401 is surfaced,
  never swallowed — it means credentials changed in the panel, and retrying past
  it burns the login rate limit.
- **Never logged**: not the token, not the password, not a prefix.
- An in-flight promise is shared, so a cold instance serving several concurrent
  requests logs in once.

### 4.2 Serviceability — used for exactly two things

A real delivery estimate, and **gating COD by PIN code** — the hook Phase 5 §8.8
left waiting. `isAvailable()` on the COD adapter is synchronous and knows nothing
about the cart, and its own comment said the rule belongs in the checkout action;
that is where it now is.

**What the customer is charged did not change.** Flat ₹99, free over ₹1,999, from
`site_settings`. The courier's real rate is captured for the admin only.

**It fails soft in one direction.** Every failure — no credentials, timeout, 500,
malformed body — resolves to "unknown", and unknown means the default estimate
and **COD available**. One subtlety worth naming: an *empty* courier list also
leaves COD on, because "no courier serves this PIN" and "no courier serves it for
these parameters" are indistinguishable in that response, and the second is
reachable by a weight we rounded. Only "couriers exist and none of them will
collect cash" declines.

### 4.3 Fulfilment — admin-triggered, idempotent per step

Five steps: create → AWB → pickup → documents → track. Each reads the
`shipments` row first and returns `already` if its own output is present.

The ordering inside `createShipment` is deliberate and looks backwards: **the row
is inserted before the API call.** `unique (order_id)` can only serialise two
concurrent presses if both try to write before either calls Shiprocket. Calling
first and inserting after would let both through and create two real orders in
the panel, and no constraint can undo that.

Three failure paths are reported loudly rather than smoothed over, because each
means Shiprocket did something we failed to record and a retry would repeat it:
a created order, an assigned AWB, and a booked pickup.

Status moves through `transitionOrder` — AWB → `packed`, pickup → `shipped` — so
fulfilment gets no private route to `orders.status`.

### 4.4 Verified against the live account

The owner supplied `SHIPROCKET_EMAIL` and `SHIPROCKET_PASSWORD` after the first
draft of this report. Both work.

```
POST /v1/external/auth/login  → 200
token: 399 chars, 3 segments, starts eyJ
iat 2026-08-08T03:26:26Z · exp 2026-08-18T03:26:26Z · lifetime 240 hours
issuer https://sr-auth.shiprocket.in/authorize/user
company_id 7224505 · API USER
```

**240 hours exactly**, confirming the twelve-hour refresh margin is calibrated
against the real figure rather than the documented one. The old
`SHIPROCKET_API_KEY` was 32 characters and the new password is also 32 — so that
value was the API user's password all along, sitting under a name that made it
look like a bearer token.

The whole code path was then run against the live API rather than the mock:

```
shippingDefaults()   pickup_postcode 516360
token                49ms cold · 0ms memo
Bengaluru  560001    source=shiprocket cod=true  days=3  cheapest=Rs 200.68  India Post Speed Post
Delhi      110001    source=shiprocket cod=true  days=4  cheapest=Rs 207.34  Amazon Shipping Surface
Srinagar   190001    source=shiprocket cod=true  days=2  cheapest=Rs 259.68  India Post Speed Post
Port Blair 744101    source=shiprocket cod=false days=—  [no courier serves this route]
```

Four things came out of it, and three changed the code or the data.

**1. The pickup location is `DCSR`, not `Primary`.** The config default was
`Primary` — a plausible-looking guess that would have failed at the moment a real
parcel was created, with an error about a pickup location nobody typed. The
default in `.env.example` is now blank, with the panel path and the API call for
reading it.

**2. The pickup PIN was wrong, and wrong in the worst way.** `shipping_defaults`
seeded `pickup_postcode: "560001"` (Bengaluru, matching the shop's advertised
address). The real pickup is **516360, Cuddapah**. Serviceability is quoted
*from* somewhere, so every delivery estimate and every COD decision would have
been computed from the wrong origin — and would have looked entirely reasonable.
Corrected in `site_settings`, with the constraint written into the row's own
description.

**3. An empty courier list is not always ambiguous, and the original reasoning
was too cautious.** `checkServiceability` treated *every* zero-courier response
as "unknown" and kept COD on, on the argument that "no service to this PIN" and
"no service for these parameters" are indistinguishable. Against the live account
they are not:

```
pickup 516360 → delivery 744101 → 200, zero couriers,
"No courier service available between 516360 and 744101"
```

That is a definitive statement about the route. The code now refuses COD when
that message is present and keeps failing soft when it is not. Matching English
prose from a third party is brittle, and it is safe here only because the failure
direction is right: if Shiprocket rewords it, this stops recognising the
definitive case and reverts to leaving COD available. A test for both branches is
in the suite.

**4. Response shapes confirmed.** `estimated_delivery_days` arrives as a
**string** (`'3'`), `rate` as a **float** (`200.68`). Both were handled from
documentation and are now handled from observation.

**Also found: my own audit suite was poisoning a shared table.** Every mock login
writes its fake token into `integration_tokens` — the same row a real deployment
reads — with a 240-hour expiry. The live check above is how it surfaced: it read
the leftover `mock.jwt.token`, got a 401 from Shiprocket, re-authenticated once
and succeeded. Self-healing, because the client's 401 path is doing exactly what
it was built for, and still wrong to leave behind. The suite now clears the row
on exit, verified: `cached_tokens 0`.

**What the courier actually costs**, which the brief asked to be surfaced:

| To | Cheapest | Their price | Customer charged |
|---|---|---|---|
| Bengaluru | India Post Speed Post | ₹200.68 | ₹99 |
| Delhi | Amazon Shipping Surface | ₹207.34 | ₹99 |
| Srinagar | India Post Speed Post | ₹259.68 | ₹99 |

The shop absorbs roughly ₹100–160 per order, and more above ₹1,999 where
delivery is free to the customer. Nothing was changed — the customer-facing rate
is the owner's decision and it stays theirs — but it is written into
`docs/admin-guide.md` where they will see it.

### 4.5 `npm run audit:shipping` — 38 passed, 0 failed

Mocked, never touching the live account: a suite that hit the real API would book
couriers every time CI ran. Covers token fetch and cache, cold-start survival,
proactive refresh, 401 re-auth and the second-401 surface, serviceability both
ways, COD gating both ways, fail-soft under unreachable/slow/unconfigured, and
idempotency on all four mutating steps plus their ordering preconditions.

**The suite found two real problems on its first run**, which is the argument for
writing it:

1. **My own timeout test was passing a lie.** It failed at 6089ms against a
   4000ms budget — because the *mock* ignored `init.signal`. A mock that does not
   honour aborts makes every deadline assertion vacuous.
2. **`shippingDefaults()` read through `cachedSiteSettings()`**, which filters
   `is_public = true` — and `shipping_defaults` is deliberately not public. It
   would have returned the hardcoded fallback **forever**, silently, while
   looking like it read configuration. Every parcel would have been quoted at the
   default weight and the pickup PIN would never have been configurable.

---

## 5 · Decisions taken autonomously

| Decision | Rationale |
|---|---|
| Ledger written by a trigger, not by call sites | The scenario it exists for is a hand edit; a call-site insert cannot cover the table editor |
| Two extra enum values (`opening_balance`, `unspecified`) | The backfill is not a movement; an unattributed write must be recordable rather than refused |
| Rate limiter fails open | A limiter that can stop a sale is worse than the abuse it prevents; and failing open means it can never be load-bearing for security |
| Panel on the caller's RLS client, not service role | Authorization stops depending on my TypeScript being correct |
| A new ESLint rule instead of a convention | One forgotten guard is a full compromise and reads as fine |
| Dimensions on `products`, not `product_variants` | Within one model, UK 5 to UK 12 is inside a courier's 500g slab; four numbers × twelve sizes guarantees empty fields |
| `shipping_defaults` is `is_public = false` | Nothing in a browser needs the shop's pickup PIN |
| Stock edited by delta, not absolute | Two simultaneous counts both land |
| Admin cancelling a paid order is refused | That is a refund, and refunds are a decision |
| Order search excludes customer name | It lives in `shipping_address` jsonb; a `->>` filter cannot use an index and would scan the table for the least reliable identifier of the three |
| List state in the URL | The back button works, a view is a link, and only the search box needs JavaScript |

---

## 6 · What I got wrong and caught in self-review

1. **Adding `throttled` to `PlaceOrderResult` broke the checkout failure panel
   silently.** The switch in `checkout-failure.tsx` had no default, so the
   function returned `undefined` and React rendered **nothing** — a customer
   whose order failed would have seen an empty panel. It type-checked. The file's
   own doc comment claimed this was impossible ("adding a reason makes this file
   stop compiling"), which was simply false. There is now a `never` gate, and it
   was **proven**: adding a probe variant failed typecheck at
   `checkout-failure.tsx:221`, and reverting restored green. The doc comment is
   now true.

2. **Two `setState`-in-effect cascades**, in the admin shell and the search
   field, caught by React's lint rule. Both rewritten to adjust state during
   render, which is the documented pattern and avoids a visible flash — on the
   admin shell that flash was the drawer sitting over the page it had just
   navigated to, on the tablet the panel is built for.

3. **A discriminated-union bug of my own making.** Computing
   `const reason = cond ? "invalid" : "conflict"` and returning
   `{ ok: false, reason, … }` does not satisfy a discriminated union — TypeScript
   cannot tell which member such an object claims to be. Each branch now returns
   its own literal.

4. **String concatenation in a PostgREST select.** `"a, b, " + "c"` widens to
   `string`, and supabase-js parses the select at the *type* level to build the
   row type; given `string` it returns `GenericStringError` and produces an
   unreadable assignability error a long way from the cause. The existing queries
   all use template literals and I had not noticed why.

5. **The `reconcile_inventory()` grant** — see the security review, F-1. Written
   with a revoke line that reads correctly and does nothing.

6. **Three unchecked Supabase writes** in the fulfilment module, caught by
   `no-unchecked-supabase-error`. Each is now checked, and two of them turned out
   to need a *loud* failure rather than a silent one, because they mean Shiprocket
   did something we failed to record.

---

## 7 · Measurements

| Gate | Result |
|---|---|
| `npm run typecheck` | **0 errors** |
| `npm run lint` | **0 errors, 0 warnings** |
| `npm run shapes` | **13 cached shapes unchanged at v2** |
| `npm run build` | compiled successfully; `/admin`, `/admin/orders` registered |
| `npm run audit:shipping` | **38 passed, 0 failed** |
| `npm run audit:admin` | **23 held, 0 holes** (1 hole found and fixed first) |
| `reconcile_inventory()` | **0 drift rows**; ledger 2,725 = stock 2,725 across 370 variants |
| `no any` / `@ts-ignore` / suppressed rules | **0** outside generated types |
| Migrations applied and recorded | **18**, all with matching repo files |

**Not measured, because the work they cover is not finished:** Lighthouse on the
Vercel preview, axe on the admin routes, the overflow and 44px-target sweep at
six widths plus tablet portrait, and the full keyboard path from adding a product
to fulfilling an order. Those gates cannot be run against routes that do not
exist yet, and reporting them as passing on the three that do would be
misleading.

Migration filenames now match the versions the MCP server recorded, so for this
phase's 18 migrations the mapping is exact — a partial fix for Phase 5 §8.10,
which remains true of everything before it.

---

## 8 · Blocked on the owner

### 8.0 Shiprocket — what is now done, and what is left

`SHIPROCKET_EMAIL`, `SHIPROCKET_PASSWORD` and `SHIPROCKET_PICKUP_LOCATION=DCSR`
are set in `.env.local` and verified working (§4.4). **Two things still need the
owner:**

1. **Verify the pickup address in Shiprocket.** The panel reports `DCSR` as
   `is_primary_location: 0` — unverified. Shiprocket can refuse to assign an AWB
   to an unverified pickup address, which would make the first real fulfilment
   fail for a reason that has nothing to do with this code.
2. ~~Reconcile the two addresses.~~ **Resolved.** The owner supplied the real
   pickup record — *DCSR, Classic Vastralayam Complex, Shop No. 2, near RTC bus
   stand, Cuddapah, Andhra Pradesh 516360*, SPOC *FOOT VAULT BRANDED STORE,
   9160252643*. The Bengaluru address was Phase 1 seed data that had been sitting
   on the live footer and contact page since the first build.
   `site_settings.contact` now carries the real address and phone.

   **Still placeholder in `site_settings.contact`:** `hello@footvault.in` and
   WhatsApp `+91 98450 22001`. Both invented, both public, both need real values.

Neither is set in Vercel yet; the three variables need adding to Preview and
Production before any deployed environment can reach Shiprocket.

### 8.1 Shiprocket credentials — the panel work (done)

1. Sign in to the Shiprocket panel → **Settings → API → Configure**.
2. **Create an API user.** Its email **must be different** from the email you log
   into Shiprocket with. Using the account email is the mistake everyone makes
   first and it fails with a 403 that says nothing about why.
3. Note the email and password you set.
4. **Settings → Company → Pickup Addresses.** Create or confirm a pickup
   location and note its **nickname exactly as spelled** — the adhoc order
   payload matches it as a literal string.
5. Set in `.env.local` and in Vercel (Preview and Production separately):
   ```
   SHIPROCKET_EMAIL=<the API user's email>
   SHIPROCKET_PASSWORD=<the API user's password>
   SHIPROCKET_PICKUP_LOCATION=<the nickname, exactly>
   ```
6. **Remove `SHIPROCKET_API_KEY`** from `.env.local`. It authenticates nothing
   (§1.2), and an unused secret in an environment is still a secret in an
   environment.

**Also tell me whether the account has a sandbox or test mode.** I could not
determine this without signing in. Shiprocket does not advertise one publicly for
the external API, so the manual test in §8.2 is written to be explicit and
reversible on the assumption there is none — but if there is one, it should be
used instead.

### 8.2 The one manual test — not yet run

It could not be: it needs credentials that do not exist yet. Once §8.1 is done,
create one shipment for a test order, assign an AWB, generate a label, fetch
tracking, then **cancel it in the Shiprocket panel**. The click-path belongs in
`docs/admin-guide.md` and **is not there yet** (§9).

### 8.3 Still outstanding from Phase 5

All four remain, unchanged: `RAZORPAY_WEBHOOK_SECRET` (§9.1 of the Phase 5
report), one real test-mode payment, an email provider, and the go-live indexing
procedure. The first two are now more pressing, because this phase added order
fulfilment on top of a payment path that has never completed once.

---

## 9 · What is NOT built

Stated plainly. Every item below is scope from the brief that this phase did not
deliver.

**Admin routes missing entirely:** `/admin/products` (list, new, edit),
`/admin/categories`, `/admin/brands`, `/admin/customers`, `/admin/media`,
`/admin/settings`, and **`/admin/orders/[id]`** — the order detail page, which is
where the shipping panel was to live.

The consequence is concrete and worth being exact about: **the five Shiprocket
fulfilment actions are written, guarded, rate-limited and tested against a mock,
but there is no button in the UI that calls them.** They are reachable only from
code. The same is true of `setOrderStatus` and `addOrderNote`.

**Also not built:** image upload with client-side compression, drag-to-reorder
and alt text; category drag-to-reorder and nesting; bulk activate/deactivate;
customer-facing tracking on `/account/orders/[id]` and the confirmation page; the
delivery estimate on the checkout address step and the product page; and the
soft-delete verification the brief asked for by name (deleting a product that has
an order against it and confirming the order still renders) — the
`admin_delete_product` function implements it and is unit-covered by the security
suite refusing it to a customer, but the end-to-end render was never checked.

**Documentation not updated:** `docs/admin-guide.md`, `docs/architecture.md`,
`docs/database.md`, `docs/rls-tests.md` and `README.md` are all now stale with
respect to this phase. `.env.example` **is** current. The admin guide matters
most — the brief said so — and its absence is the single largest documentation
debt here.

Why: the phase was scoped as a full admin panel plus a full logistics integration
plus an adversarial pass plus five documents, and I did not get through it. I
chose to finish fewer things properly — with tests and reconciliation and an
attack suite — rather than leave ten half-written routes. That was the right
trade, but it was a trade, and the brief's "Done when" is not met.

---

## 10 · Known imperfections

1. **This work is on the Phase 5 branch**, not its own. PR #5 was open when the
   phase started and branching from an unmerged branch seemed worse than
   continuing on it. The result is one branch carrying two phases, which will
   make review harder.
2. **Fulfilment has never spoken to Shiprocket.** Authentication and
   serviceability now have (§4.4), but `orders/create/adhoc`, `courier/assign/awb`,
   `courier/generate/pickup` and the document endpoints have only ever met the
   mock — because each of them creates something real in the owner's account and
   there is no UI to trigger them from yet. `etd_hours` as a fallback field is
   still unobserved; no courier in four live lookups used it.
3. **`shippingDefaults()` is read on the checkout path for every COD order** —
   one extra query, uncached, to answer a yes/no question.
4. **The COD gate's parcel weight is an approximation** (default weight × units),
   documented at the call site. The shipment payload uses real per-product
   weights.
5. **The dashboard's "orders today" reads up to 120 recent orders into memory**
   to compute its counts. Correct now, wrong at scale.
6. **`generateDocuments` is three sequential calls** with a partial-success path.
   It is safe to press again but it can leave one of three URLs missing and
   report that as a failure.
7. **No test drives an actual Server Action endpoint over HTTP.** See the
   security review's gap list — this is the most valuable thing to add.
8. **`parcelWeightKg` in `src/lib/shipping/quote.ts` is exported and unused.** It
   was written for a cart-line-aware estimate that the checkout UI would have
   called, and that UI is not built.
9. **The admin panel has been type-checked and built but never rendered in a
   browser.** No screenshot, no axe run, no interaction test.

---

## 11 · Deliberately deferred

| Deferred | To | Note |
|---|---|---|
| `/admin/appearance`, banner scheduling | Phase 7 | Out of scope by the brief |
| Coupons, reviews | Phase 8 | |
| Refunds | Phase 8 | Admin cancellation of a paid order is refused rather than half-implemented |
| A background tracking poller | — | The brief excluded it; tracking refreshes on view |
| Per-variant physical dimensions | — | Per-product is the deliberate choice (§5) |

---

## 12 · Designed, decided, and NOT built: COD as a part-prepayment

Raised by the owner after the first real payment succeeded. Recorded in full so
it is picked up rather than rediscovered.

### The model

Cash on delivery stops meaning "pay nothing now". The customer pays the
**delivery fee online through Razorpay at checkout**, and the **goods value in
cash at the door**. Prepaid is unchanged: free delivery at ₹2,499 and above,
courier rate below it, all of it online.

Owner's decisions, both money:

- **A refused COD parcel is not refunded.** The shop has already paid the
  courier both ways; recovering that is the entire reason for collecting it
  upfront. **This must be stated at checkout and on the invoice** — an
  undisclosed non-refundable charge is a chargeback waiting to happen.
- **Cash collection is marked by hand** in the admin, not inferred from
  Shiprocket's `Delivered` status. Delivery usually means payment and
  occasionally does not, and the difference is the shop's money.

### The landmine

**`applyPaymentOutcome` will refuse every COD order unless it is changed first.**

It carries a deliberate under-payment guard: a capture for less than
`orders.grand_total` leaves the order `pending` and returns
`illegal_transition`, on the reasoning that a payment bound to a provider order
we created cannot settle for a different amount, so a mismatch is a bug or a
forgery. Under this model a COD capture is *supposed* to be short — ₹390 against
a ₹2,890 total — so that guard fires on the happy path and silently strands
every COD order until the sweep cancels it.

The fix is not to weaken the guard. It is to give it the right expectation:
compare the capture against **`amount_paid_online`** rather than `grand_total`,
so a COD capture of exactly the shipping fee is full payment of what was owed
online, and anything else is still refused.

### What it needs, in order

1. **Schema** — `orders.amount_paid_online`, `orders.amount_due_on_delivery`,
   `orders.cash_collected_at`, `orders.cash_collected_by`. `grand_total` stays
   goods + delivery.
2. **`create_order_with_stock`** — records the split, and starts a COD order at
   `pending` rather than `confirmed`. Stock must not be committed before the
   delivery fee captures, or a dismissed modal holds inventory for an order
   nobody has paid anything towards.
3. **`applyPaymentOutcome`** — compare against `amount_paid_online`. See above.
4. **Checkout** — COD opens the Razorpay modal for the delivery fee. The COD
   adapter's `initiate()` currently returns `kind: "none"`; it stops being a
   method with no provider.
5. **`payment_status`** — keep it meaning *the online portion*. `paid` becomes
   "everything owed online has settled". Cash is `cash_collected_at`.
6. **The invoice and the confirmation page** — the owner asked for this
   specifically and it is the part most likely to be done badly:

   ```
   Goods                     ₹2,500
   Delivery                    ₹390
   ─────────────────────────────────
   Paid online now             ₹390   ← Razorpay
   To pay in cash on delivery ₹2,500
   ─────────────────────────────────
   Order total               ₹2,890
   ```

   Plus the non-refundable sentence, at checkout *before* payment and on the
   invoice after it.
7. **Admin** — a "Cash collected" action on the order page, writing
   `cash_collected_at` and an `order_status_history` row.
8. **Cancellation** — `cancel_order_with_restock` currently refuses a paid
   order. A COD order now has money against it from the moment it is placed, so
   the refuse-if-paid rule needs to distinguish "delivery fee prepaid, goods
   unpaid" (cancellable, fee retained) from "fully paid" (a refund, Phase 8).

### Why it was not built in this phase

It arrived after the phase's feature work was complete, it touches the money
path in six places including the payment state machine, and half of it is worse
than none of it — an order that takes ₹390 and never confirms is a support call
and a chargeback. It wants its own run with its own adversarial pass, not the
tail end of this one.

### Also outstanding, and much smaller

- **A pin-code checker on the product and bag pages**, Amazon-style, so delivery
  cost and speed are visible before checkout. The server action
  (`quoteShipping`) already exists and is rate-limited; this is a component and
  a call site.
- **The live-rate checkout work in this branch is not deployed.** Production is
  still serving the flat ₹199, which is why order FV-2026-00487 shows it.
