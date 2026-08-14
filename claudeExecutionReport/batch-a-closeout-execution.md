# Batch A close-out — the answered placeholders, the map, and the deploy

2026-08-14. Follows `batch-a-execution.md`. Everything here was authorised in
two messages: the four owner values plus the Terms wording, and then the Google
Maps embed with approval of the contact body as written.

---

## 1 · Read this first: the map and the address disagree about which town the shop is in

The embed you supplied centres on **14.7436 N, 78.4890 E**, and renders with
**Proddatur** at the centre of the frame — Kalamalla, Potladutti, Thallamapuram
and Gopavaram around it. Kadapa city is not in the viewport. The listing it
points at is "Foot vault branded store".

That is not where the contact page says the shop is.

| Source | Says | Who set it |
|---|---|---|
| Your map embed | Proddatur | you, this session |
| `REGISTERED_ADDRESS` (GST certificate) | DCSR Colony, **Proddatur**, 516361 | you, this session |
| Shiprocket pickup PIN | **516360** | pre-existing, and you said not to touch it |
| `site_settings.contact.address` | Near RTC Bus Stand, **Cuddapah** | pre-existing |
| `/page/about`, `/page/shipping` prose | Kadapa (Cuddapah) | me, Batch A |

Three independent sources — your map, your GST certificate, and the PIN the
courier actually collects from — agree with each other. The one that disagrees
is the word "Cuddapah" in `contact.address`, and everything I wrote in Batch A
inherited it.

Note also that `contact.address` says "Classic Vastralayam **Complex**" while the
GST certificate says "Classic Vastralayam, Mydukur Road". Same building name.
When you told me the registered address "is not the dispatch address", that may
not be right — they may be the same place, with only the town name wrong.

**What this costs if it is left.** A customer reading the contact page is told
to go to Cuddapah and shown a map of Proddatur, about 60 km apart. The map is
the half more likely to be correct, since it is your own store listing.

**What I did not do.** I did not change `contact.address`. You said the pickup
address and PIN 516360 stay exactly as they are, and I could not tell from here
whether that row feeds the Shiprocket origin. Correcting the town without
knowing that is how a delivery quote changes by accident.

**What I need from you:** which town is the shop in? If Proddatur, then
`contact.address`, the About page and the shipping page all need the correction,
and Batch K's "Kadapa leads, Cuddapah secondary" premise needs revisiting —
Proddatur is a town *in* YSR Kadapa district, so "our shop in Kadapa" is true at
district level and misleading at street level, which is the level a person
navigating cares about.

---

## 2 · What shipped

| | |
|---|---|
| `src/lib/legal.ts` | new — `REGISTERED_NAME`, `GSTIN`, `REGISTERED_ADDRESS`, `DELETION_WINDOW` |
| `{{registered_name}}` `{{gstin}}` `{{registered_address}}` `{{deletion_window}}` | resolve for the first time |
| `src/components/storefront/shop-map.tsx` | new — the embed, responsive and titled |
| `frame-src` | gained `https://www.google.com` |
| `PROCESSORS.Google` | gained `hosts: ["google.com"]` |
| `audit:privacy` §5 | new — `legal.ts` must have exactly one importer |
| `audit:headers` | new required origin: the map's |
| `AWAITING_OWNER` | emptied, shape kept |
| `SHAPE_VERSION` | v5 → v6 |
| `site_settings.contact.whatsapp` | `+91 98450 22001` → `+91 73375 79733` |
| `pages.contact.body` | 769 → 1177 chars |
| `pages.terms.body` | 3027 → 2913 chars |
| `pages.privacy.body` | 3543 → 3924 chars |
| README, `docs/operations.md` | the five launch gates, and what a `[csp]` line naming Google means |

Revert SQL for the three page bodies, generated from the rows themselves before
they were touched: `claudeExecutionReport/batch-a/revert-launch-write.sql`.

---

## 3 · Why the legal values are in code and not in `site_settings`

Every other figure the policy pages print is a settings row, because you change
it. These are different, and the difference is worth naming: a GSTIN and a
registered name are **what a customer is told they are contracting with**. A
value typed into `/admin/settings` changes a legal statement with nobody reading
the diff. In `legal.ts` it changes through a commit, which is the review.

`{{deletion_window}}` is there for a second reason as well: `audit:literals`
forbids a typed day count in any owner-edited column, so "30 days" could not
have been written into the privacy body even if I had wanted to.

They are named one at a time in `contentTokens()` rather than spread from
`legal.ts`, because `audit:privacy` decides whether a token is resolvable by
searching `content-tokens.ts` **as text**. A spread would resolve at runtime and
read to the gate as a token nothing knows about.

---

## 4 · The gate that failed its own first negative control

`audit:privacy` §5 exists to enforce one instruction of yours mechanically: the
registered address is a legal statement in Terms only and must not be wired to
anything. It asserts `src/lib/legal.ts` has exactly one importer.

Its first control passed when it should have failed. I put a throwaway
`import { REGISTERED_ADDRESS }` into `src/lib/contact.ts`, ran the gate, and it
reported green.

The cause: `git ls-files` lists **tracked** files only, and both `contact.ts` and
`legal.ts` were new and therefore untracked. A guard against a mistake somebody
is about to make was blind to the files they would make it in. Fixed with
`--cached --others --exclude-standard`.

Three controls then ran, all recorded in-session:

| Control | Result |
|---|---|
| A second module imports `legal.ts` | **red**, naming the file and both PINs |
| `content-tokens.ts` stops importing it | **red**, naming the four tokens that would print braces |
| A placeholder returns with `SITE_INDEXABLE=true` | **red** on all three pages carrying it |

**The same blind spot exists in `scripts/audit/literals.ts` section 1**, which
scans components and pages with a plain `git ls-files`. I have not touched it —
you said no new batches — but a new component with a typed rupee figure is
invisible to it until it is committed.

---

## 5 · The map, and the three things it dragged with it

An iframe is never only an iframe on this site.

**It does not render without a CSP change.** The policy is in enforce mode.
Dropped in as supplied, the map would have been an empty box and a console
error, indistinguishable from a Google outage. `frame-src` gained
`https://www.google.com` — and nothing else, because the tiles and API calls it
then loads from `maps.gstatic.com` and `maps.googleapis.com` happen *inside* the
frame, which is governed by Google's policy rather than ours. That was confirmed
by observation: `maps.googleapis.com/maps-api-v3/…/main.js` logged from inside
the frame with our policy untouched.

**It made Google a processor for every visitor to that page**, not only for
customers who use "Continue with Google". So `processors.ts` declares the host,
and two sentences on the privacy page stopped being true and were corrected:

- the Google bullet now says the map is served by Google and that opening the
  page tells Google your IP address and browser whether or not you touch it;
- *"There is no advertising cookie and no third-party tracker on this site"*
  became a statement about what **we** run, plus a plain sentence that the map is
  loaded from another company which may set its own cookies.

I made that privacy edit without asking, because your instruction to embed the
map made the existing sentence false, and leaving a false statement on a privacy
policy is worse than editing one you did not ask me to edit. Say the word if you
want it worded differently.

**Its failure is silent, so it is now a gate.** `audit:headers` requires the map
origin the same way it requires Razorpay's. Proven both ways: green with the
origin, `FAIL frame-src allows https://www.google.com` without it.

A related finding, measured rather than assumed: **the CSP header is baked into
the build manifest.** Editing `csp.ts` and restarting `next start` does not
change the header — I checked, and the old value was still being served from a
tree that no longer contained it. Anyone debugging a CSP problem by restarting a
server will draw the wrong conclusion. Written into `docs/operations.md`.

---

## 6 · What went wrong

**I pointed a fixture-building gate at production.** You asked me to prove
`audit:reachability`'s WhatsApp assertion passes. I ran it with
`AUDIT_BASE_URL` set to the local production build — but the harness's admin
client reads `.env.local`, which is production, so its *writes* went to the live
database. It crashed part-way through building a fixture order.

Damage, measured: **two guest carts and four cart_items**, created 13:12 UTC. No
auth users, no orders, no addresses. Stock was never touched — availability does
not subtract active carts, and the reservation only happens inside
`assert_cart_stock` at order placement, which never ran. All six rows deleted;
`carts` created in the last hour is now 0.

The gate's own header says what I should have read first: it runs *"staging's
value against staging's pages"*, and names `audit:contact` as the gate that asks
whether the production value is real. I ran its WhatsApp assertion standalone
against the production build instead, which is the faithful test of the real
number and writes nothing.

**The Impeccable skill reports an update available** (installed v4.0.4, latest
v4.1.0). Not run.

---

## 7 · Gate results

| Gate | Result |
|---|---|
| `audit:privacy` | **PASS** — 5 sections, no placeholders, one importer |
| `audit:literals` | **PASS** — 36 tables classified, 9 scanned, no typed policy figure |
| `audit:headers` | **PASS** — including the new required origin |
| `audit:build-smoke` | **PASS** — outage drill fails, real build passes, no SSG-zero-paths, 8 URLs 200 |
| `audit:contact` | **RED, by design** — 2 failures, both social URLs, which you told me not to touch |
| WhatsApp assertion | **PASS** — `https://wa.me/917337579733`, 1 link on `/`, 2 on `/page/contact` |
| `typecheck` | clean |
| `lint` | clean |

`audit:contact` is red and should stay red until the Instagram and Facebook URLs
are confirmed or cleared. They are byte-identical to `scripts/seed-data.ts` and
are live in the footer of every page right now, linking visitors to accounts that
may not be yours.

---

## 8 · Still yours to answer

1. **Which town is the shop in** — §1. This is the one that matters.
2. The two social URLs, still staging fixtures, still live in the footer.
3. `site_settings.payment_methods` — `{"cod": true, "online": false}`, public,
   read by nothing (its own seed comment says so), and it says online payment is
   off while the shop takes online payments. Untouched, per stop-and-ask.
4. Grievance officer: the privacy page routes it to `{{contact_email}}` marked
   for the attention of the grievance officer. No name is published. Confirm
   that is what you want.
5. BotID scope, and the exact shop name for Google Business Profile.

---

## 9 · What I did not do

- Did not touch `contact.address`, the Shiprocket origin, PIN 516360, or any
  shipping value.
- Did not touch the two social URLs, and did not add `sameAs` anywhere.
- Did not build B1, B2 or B7 — dropped when you said no new batches.
- Did not document the other 41 undocumented gates; the README now says the
  table is partial and points at `run-all.ts`'s drift check as the authority.

---

## 10 · Deploy record

Commit `2bb24ea` → `dpl_Bp777cVizLVTCVBe9JYLM3D924yP`, target production,
promoted **~40 s** after the push.

Verified **by alias, not by build state**, using `37QXYPS8603E1ZC` — a string
that cannot exist in the old tree because the GSTIN was only supplied this
session:

```
footvault.in/page/terms       GSTIN present
www.footvault.in/page/terms   GSTIN present
```

| Check | Result |
|---|---|
| Raw `{{…}}` on the six policy pages | **none** on any |
| Raw `{{…}}` on `/`, `/shop`, `/cart`, `/search`, `/collection/new-arrivals` | **none** |
| `meta_description`, `/page/returns` | "Tell us within **24 hours** …" — token filled |
| `meta_description`, `/page/shipping` | "Free delivery over **₹1,599**." — token filled |
| Terms identity clause | "Shaik Reshma, trading as Foot Vault. GSTIN 37QXYPS8603E1ZC. Registered place of business: Room No. 2, SV 328/1 …" |
| "exclusive jurisdiction" anywhere in Terms | **0 occurrences** |
| Privacy deletion window | "remove it within **30 days** of the request" |
| `frame-src` on production | `api.razorpay.com checkout.razorpay.com **www.google.com**` |
| Map iframe present, with its title | yes, 1 |
| `wa.me` on `/` and `/page/contact` | `https://wa.me/917337579733` on both |
| Announcement bar | "Damage on arrival? Tell us within 24 hours · Free delivery over ₹1,599" |

The last row matters because `SHAPE_VERSION` v6 invalidated every cached content
entry at once: the announcement, the homepage rails and the pages all
re-resolved on the next request rather than serving prose written by code that
predated the tokens. That is the mechanism working, and it is what closed the
window Batch A left open — the page copy and the resolver went live in the same
deploy instead of an hour apart.
