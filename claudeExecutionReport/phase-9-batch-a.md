# Phase 9 · Batch A — the money and the blocked owner

**Status: built and proven on staging. No Batch A change has been applied to
production, and nothing is committed or merged.** Five migrations are written
and replay from empty; two owner actions are queued behind them, one of which is
the stranded stock on FV-2026-00623.

I have to lead with something else, though, because it is not in the plan and
you should hear it from me rather than find it: **the QA suite has been writing
to the live shop.** It is fixed, the damage is bounded and measured, and one
small piece of cleanup is your call. §0.

---

## 0 · The gates were running against production

`npm run audit` builds accounts, carts, orders, payments and stock movements. It
is supposed to build them in staging. Three of its harnesses were building them
in the **live shop**, and had been since before staging existed.

I found it the way these things get found: a migration I had just written was
missing from the database a run was talking to.

`scripts/audit/clients.ts` exists to make this impossible. It resolves the target
once, refuses production, and writes the staging credentials back into
`process.env` so a harness that reads `.env.local` itself still lands on staging.
It works — for the files that import it. These three never did:

| Harness | In `npm run audit` | Writes |
|---|---|---|
| `checkout-orders.ts` | yes (`audit:checkout`) | orders, payments, carts, stock movements |
| `cart-merge.ts` | yes (`audit:cart`) | accounts, carts, cart items |
| `shipping.ts` | yes (`audit:shipping`) | shipments — and it picked its fixture order out of production |
| `zero-stock.ts` | no (`audit:zero-stock`) | products, variants, stock |

The first three read `.env.local` directly and built a service-role client from
`NEXT_PUBLIC_SUPABASE_URL`, which is production. **`shipping.ts` was worse and
found last**: it names no credential at all — it gets its database through the
app's own `createAdminClient()` — so my first version of the fix's own gate
passed it. It surfaced when its Pay-on-Delivery fixture asserted against an order
with a ₹5 subtotal and a ₹135 total: FV-2026-00623, which exists only in
production.

That is worth stating plainly, because it is the third instance of the same
mistake in one day: **my first gate checked how a harness gets its client
instead of whether it can write.** The rule now keys on the write.

**What it actually cost, checked rather than estimated.** Queried against
production after the fact, for the window my runs occupied (from 12:40 UTC):

| | |
|---|---|
| orders | **16**, unchanged, highest still `FV-2026-00623` — the orders the runs created were cancelled and deleted by their own cleanup |
| inventory movements | 72, across six variants, netting **exactly zero** |
| variants left out of balance | **none** from the runs |
| products changed | 0 |
| accounts left behind | 0 — created and deleted |
| carts left behind | **6**, with 6 cart items |

The one variant that *is* out of balance shop-wide, `FV-CAMPUS-KIDSSNEA-BLUE-1`
at −1, has a single movement stamped 11:21:02 — that is FV-2026-00623's own
deduction, the stranded pair 9B is about, and it predates any of this.

So: nothing a customer can see, no money touched, no stock drift. What is left
is six empty guest carts and an order-number sequence that has advanced past
orders that no longer exist. I have **not** deleted the carts.
`AUDIT_TARGET=env-local npx tsx scripts/audit/teardown.ts` is the documented tool
and it deletes rows from the live shop, so that is your call rather than mine.

**The fix, and why it is a gate rather than a promise.** All four files now
reach the guard before anything else. And `audit:fixtures-guard` grew a check
that reads the directory:

> Any file in `scripts/audit/` that **can write** — `.insert`, `.update`,
> `.upsert`, `.delete`, `.rpc` — must import `./clients` or `./fixtures`.

`./fixtures` counts because it imports `./clients` and calls
`assertNotProduction` at module scope, so importing it throws on load against
the live shop; demanding a redundant second import would teach people to satisfy
a checker rather than to be safe.

Read-only harnesses are exempt and are **named on every run** rather than
silently skipped — `literals.ts` checks the shop's own owner-edited copy and
`payment-health.ts` runs the dashboard's query against real rows, and pointing
either at a seeded staging database would turn a real assertion into an
assertion about fixtures.

Proved on the pre-fix tree: the check reports `WOULD FAIL` for all four and
passes `literals.ts`. `audit:shipping` is now **110 passed, 0 failed** against
staging; it was 107/3 while it was reading production, and the three failures
were its fixture describing an order it should never have been able to see.

This is the same shape as 9A, and worth saying plainly: a gate proved a property
of a helper and never proved that the callers used the helper.

### And a second gate that has never run

Found in the same sweep. `audit:literals` is the rule written after the ₹2,499
threshold escaped **three times** — the third time in owner-edited *content*,
after the gate existed and was passing, discovered by curling the deployed site.
It has two halves, and the second one has never executed:

```
2 · no currency literal in owner-edited content
  ! skipped: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.
      The content half of this gate did not run. That is a gap, not a pass.
```

It reads those names from `process.env` and nothing ever put them there: the
script is `tsx scripts/audit/literals.ts`, and npm does not read `.env.local`.
The message was honest on every run and nobody read it as *the half that matters
has never executed*.

Fixed — it loads `.env.local` itself now, read-only, against the shop's own
copy, which is the content that matters. First real run:

```
✓ pages: 7 rows          ✓ site_settings: 10 rows     ✓ homepage_sections: 6 rows
✓ banners: 1 row         ✓ collections: 3 rows
· homepage_sections.title: "Under ₹2,000" — allowed, a price-band rail name
```

Clean. But it is clean **for the first time**, not clean again.

---

## 1 · What needs you

### a · Five migrations, in order, and a snapshot first

```
20260809180000_order_history_customer_note.sql        additive column
20260809180100_orders_prepaid_discount.sql            additive column + CHECK
20260809180200_create_order_records_discount_split.sql  create_order_with_stock
20260809180300_cancel_guard_net_outstanding.sql       cancel_order_with_restock
20260809180400_history_customer_notes_in_sql.sql      the two SQL callers
```

Two of them recreate load-bearing functions, so this is a snapshot-first change
under the merge policy. All five replay from an empty database: `npm run
rebuild:stage` is green at **89 migrations**, one `cancel_order_with_restock`,
all four cron jobs, the parcel complete, 35 products and 409 variants.

**PostgREST caches its schema.** After pushing, the new
`create_order_with_stock` parameter is invisible until the cache reloads —
`notify pgrst, 'reload schema'`. On staging this took a minute; a deploy that
races it returns "could not find the function in the schema cache" on checkout.

### b · Then FV-2026-00623, through the button that has been failing

Once the migrations are on production: open the order and press **Mark
Cancelled**. Nothing else. No hand-written `UPDATE` — a manual stock correction
writes no `inventory_movements` row, and `inventory_movements` reconciling to
zero drift is one of this phase's own gates.

What should happen, and what I proved on staging against an order built to that
exact shape (₹1,698 captured, refunded in two parts to zero outstanding):

- status → `cancelled`, `stock_restored_at` stamped
- **exactly one** `inventory_movements` row, reason `cancellation`, delta +1
- the variant's stock up by one
- pressing it twice restocks once

### c · One thing I could not decide for you

**The six QA carts in production** (§0) — delete or leave. That is the only open
question in Batch A. Every other decision that came up was made under the
standing rule and is listed with its reasoning in §7.

### d · What I have deliberately not done

**Nothing is committed and nothing is merged.** The merge policy is explicit:
merge without asking only when the change touches no money computation,
payments, refunds, auth, RLS or admin authorisation, and applies no production
migration. Batch A is four of those six. So it sits in the working tree, and the
branch and PR are yours to ask for.

---

## 2 · 9E — the invisible discount

**The defect.** `checkout-flow.tsx` replaced `grandTotal` with the quote's
discounted figure and left `discountTotal` and `prepaidDiscount` at the
pre-quote zeros. The customer was charged the discounted total, shown a Discount
row reading "—", and shown no "Paying online" row at all — that row only draws
above zero. The comment four lines above the bug said *"updating one and not the
other is how a checkout ends up not adding up"*.

**What I found that the plan did not know.** The 20% prepaid discount went live
in `site_settings.shipping` at **12:26 UTC on 2026-08-09**, which is *after* every
order in the database — the most recent, FV-2026-00623, was placed at 11:21. So
all 16 production orders carry `discount_total = 0` and **no customer has yet
been charged a discount they were not shown.** The next prepaid order would have
been the first. That also means the new column needs no backfill: zero is the
true value for every row that exists, not a placeholder.

**The fix, end to end.**

| Where | What changed |
|---|---|
| `shipping-quote.ts` | the response carries `discountTotalPaise` and `prepaidDiscountPaise` |
| `checkout-flow.tsx` | both are copied into `shownTotals` beside the five fields already there |
| migration | `orders.prepaid_discount`, written by `create_order_with_stock`, clamped inside `discount_total` under the row lock |
| `queries/orders.ts`, `queries/admin/orders.ts` | read it back |
| `orders/types.ts` | `prepaidDiscount` is **required** — omitting it is now a compile error, and that caught all three read sites |
| `admin/orders/[id]` | "Paying online" and "Discount" as separate lines, so the owner can tell an incentive from a coupon |
| `email/order-confirmation.ts` | the hardcoded `discountTotal: 0` is gone **and the email now draws the lines** — it had no discount row at all, so a discounted order would have produced a receipt whose own arithmetic disagreed with its total |

**The rounding, per your decision.** `prepaidDiscountFor` now rounds **up** to a
whole rupee via a shared `roundedDiscountPaise` in `src/lib/payments/discount.ts`
— one rule, one file, ready for the coupon in Batch C. Caps are applied *after*
the rounding, never before, so rounding up cannot push a figure through a
ceiling it was already sitting on. Your worked example: 20% of ₹3,999 is now
**₹800**, not ₹799.80 and not ₹799.

**Proved three ways.** Arithmetic (`audit:totals`, 48/48, including the cap
cases). Database (`audit:checkout` — the split is stored, `subtotal − discount +
delivery = grand_total`, `advance + balance = grand_total`, and a prepaid part
larger than the whole is clamped rather than raising a constraint at the
customer). And **on the screen**: a new `audit:checkout-discount` drives a real
checkout at 12.5% and asserts "Paying online" is on the page, the figure beside
it is a whole number of rupees, the printed lines sum to the printed total, and
choosing Pay on Delivery removes the row.

That last one fails on the pre-fix code with exactly the reported symptom — no
"Paying online" row — and passes after. I checked, rather than assuming.

---

## 3 · 9B — the cancel guard

Both limbs of the old guard fired on a fully refunded order and the second named
`'refunded'` explicitly, so no data state let one through. It now compares
**captured minus refunded**: above zero the shop is still holding the customer's
money and cancelling would be a refund, which is a decision rather than a side
effect.

It is robust to the second defect the audit found — FV-2026-00623's `payments`
row still reads `captured` against a `processed` refund. Either bookkeeping nets
to the same answer, so the guard does not depend on that row being repaired.

**`refundInstruction` had the same blind spot from the other side.** It told the
owner to refund `advance_amount` without asking whether that had already
happened; on FV-2026-00623 it instructed a second refund of ₹135 that was
already back with the customer. It now nets off what has settled, says
*"already been refunded in full, so there is nothing left to send back"* when
that is the case, and on a partial refund names only the remainder **and** the
part already sent, so the two figures reconcile.

`audit:refund-message` is 16/16, up from 9 — it had pinned this sentence for two
phases and never once constructed an order that had already been refunded.

`audit:refunds` is 33/33 and now includes the whole risk surface: outstanding
refuses, **partial** refuses, net-zero cancels, one ledger row, a second press is
a no-op, an unpaid order still cancels so the abandonment sweep is unaffected.

---

## 4 · 9C — the order page

**The refunded branch.** `whatHappensNext` handled `paid` and let everything else
fall through to *"We have not seen your payment settle yet… reload this page
rather than paying again"*. `refunded` is everything else. It is now a `switch`
over `PaymentStatus` with no default, so a fourth status is a compile error here
rather than a sentence shown to somebody whose money is in the wrong place.

Because 9B creates `cancelled` + `refunded`, cancelled carries a matrix rather
than a blurb: unpaid says nothing was charged, paid and refunded both say money
is coming back and how long it takes. That matrix is its own function precisely
so it is *also* a compile error — inlined, a fourth status would have fallen
quietly through to the general copy.

I checked that claim rather than making it. Adding a fourth `PaymentStatus` to
the type produces three errors in `order-format.ts`: the label map, and both
switches.

A third fix rode along, found while writing the matrix: an unsettled
Pay-on-Delivery order was telling the customer *"You have paid ₹281"* before the
advance had captured. A customer who dismisses the Razorpay modal was reading
that. It now says nothing has been taken yet.

**The notes.** `order_status_history.customer_note` is a new nullable column.
`note` keeps every existing value and stops being customer-visible — the
customer query does not select it at all, so there is no field to reach for by
mistake. Every writer now supplies a customer sentence where the event has one
and null where it does not, and null renders as the status label alone.

`audit:customer-copy` is the gate. It reads both surfaces: customer-facing code,
and every stored `customer_note`. Proved by planting FV-2026-00623's actual
string on staging — it fails on `rfnd_` and passes once removed.

**Two things checked and left alone.** The "thirty-minute sweep" line in
`checkout-failure.tsx` is inside a JSX comment and is not rendered — the audit
asked for one look, and that is what it found. The admin-facing "webhook"
wording stays: that vocabulary is correct for the owner, and the gate reads only
customer surfaces.

**And one thing the split quietly fixed.** The admin's "Add a note" box —
placeholder *"Rang the customer, no answer"* — was writing straight onto the
customer's own timeline. It is internal now, and the form says so under the
field, because an owner who does not know that will find out the hard way.

---

## 5 · G — the standing gate requirement

`scripts/audit/settings-controls.ts`. It locates each control by its **visible
label**, changes it, saves, and reads the stored value back out of
`site_settings`. All **31** controls, and coverage is asserted rather than
claimed: the run fails if any control in the table was never actually operated.

**The proof that matters.** On a tree with the Pay-on-Delivery checkbox deleted —
the exact failure the audit described — the old gate stays **fully green** and
the new one fails with *"no control carries that label"*.

It also caught a false pass in its own first draft: with the control deleted, the
"switch it back on" assertion passed because the stored value happened to be
true already. A read-back now only counts when the control was successfully
operated first.

**And it found two real defects on its first run** — this is the harness earning
its keep on day one:

1. **The packed-weight field silently refused legal values.** `step={10}` on a
   number input is constraint validation, not an arrow-key size: the browser
   blocks submission of anything that is not a multiple, with a native bubble no
   code here controls. An owner typing a real 1,234 g parcel pressed Save and
   nothing happened — no toast, no error, no request. Every numeric settings
   input is now `step="any"`; the server already decides what is legal.
2. **Two labels were substrings of each other.** "Percentage off" (the amount
   field) sat beside "A percentage off" (the radio). Renamed to "Discount amount
   (%)".

**The gap, named.** The ~29 product, variant, category, brand, media and customer
CRUD actions in `src/lib/actions/admin/` are covered by nothing that drives their
UI. That is deliberate, and the harness **prints it at the end of every run** so
it cannot later read as coverage.

---

## 6 · 9A — the settings page

The delivery panel first, as the worked example, then the same treatment across
the page.

- **Controls first.** Label above, control, consequence line below in a smaller,
  lighter treatment. The consequence lines all stay — they were a real
  requirement and they are good — they simply stop outweighing the thing they
  describe.
- **"Charge one flat amount" is on screen with nothing opened.** The `<select>`
  is now inline radios. Every word an owner might scan for is in the closed
  state.
- **The flat field is visible and disabled**, with a hint saying when it applies,
  instead of being absent from the DOM. Same for the deposit rule — that rule is
  what *blocks* saving a flat charge, so meeting it as a refusal rather than as a
  field was the worst version.
- **The bolded line is gone.** *"Delivery rates are not set here"* now reads
  *"Per-pin-code rates come from Shiprocket. What you set here is how the
  customer is charged, and the thresholds the shop decides for itself"* — and it
  is a caption, not a headline. The page title and panel description changed for
  the same reason: both led with what the page does not do.
- **Real switches**, and their accessible name is the label alone. The old markup
  put the four-line consequence paragraph *inside* the `<label>`, so a screen
  reader announced the whole explanation as the control's name.
- **Unset says "not set".** The wallet threshold renders empty with "not set —
  the dashboard shows no wallet warning" rather than ₹0.

`audit:settings-controls` was written against the old labels, run green, then
updated with the redesign and run green again — which is the interaction the plan
called out: a redesign that moves every control on the page must not be the thing
that goes unverified.

`admin-pages.ts` stopped asserting `/Delivery rates are not set here/`. A gate
that holds a page to the wording that caused the reported failure is worse than
no gate; it now asserts that both words the owner scans for are readable without
opening anything.

Screenshots: `screenshots/phase-9-settings-1440.png`,
`screenshots/phase-9-settings-390.png`, `screenshots/phase-9-settings-flat.png`.

---

## 7 · Decisions I made, under the standing rule

| # | Decision | Why, in one line |
|---|---|---|
| 1 | No backfill of `orders.prepaid_discount` | Checked production: all 16 orders carry `discount_total = 0`, so zero is the true value rather than a placeholder |
| 2 | A CHECK that `prepaid_discount <= discount_total` now, not the full equality in Batch C | The part cannot exceed the whole today, and a database that refuses a bad row means no read site has to trust arithmetic done elsewhere |
| 3 | The refunded sentence names **no figure** | `refunds` is admin-only under RLS and `advance_amount` is not the refunded amount on a partial refund — naming one needs an RLS change or an invented number |
| 4 | The admin cancel writes no customer note | What the customer needs — is money coming back — is derived from payment status in one place, not frozen into a row that cannot know whether a refund settles later |
| 5 | A **failed** refund gets no customer note | It moved no money; the customer can do nothing with the news but worry |
| 6 | The cancel guard still refuses an order that claims to be paid with no payments row | No evidence is not evidence of nothing; refusing costs one support message, allowing costs a customer their money |
| 7 | `step="any"` on every numeric settings input | A step is submit-blocking validation, and the server already decides what is legal |
| 8 | "Discount amount (%)" replaces "Percentage off" | It was a substring of the radio beside it — ambiguous to a person and to the gate |
| 9 | The deposit rule is visible-and-disabled too, not just the flat charge | It is the requirement that blocks saving flat mode; discovering it as a refusal is the worst way to meet it |
| 10 | Disabled fields mute their **surface**, never their text | Dimming took a hint to 2.53:1 — and that hint is how the owner learns when the control applies |
| 11 | An unsettled Pay-on-Delivery order stops claiming money was taken | It said *"You have paid ₹281"* before the advance had captured |
| 12 | `admin-pages.ts` stops pinning "Delivery rates are not set here" | It was actively holding the page to the sentence that caused the failure |
| 13 | The refund arrival window is one shared constant | The order page and the timeline entry both quote it, and two typed copies of "5–7 working days" is one edit from telling a customer two different things |
| 14 | `audit:literals` loads `.env.local` itself, against production | Read-only, and the copy that matters is the shop's own — pointing it at seeded staging would turn a real assertion into one about fixtures |
| 15 | The refunds fixture places a **real** order rather than inserting rows | Its first version deducted nothing and then adjusted stock by hand, which put an `unspecified` movement in the ledger — the exact thing `reconcile_inventory` exists to catch, and it did |
| 16 | `security-advance.ts` compares the whole settings row before and after | It asserted `cod_advance_minimum_paise === 9_900`, a key Phase 7 deliberately deleted — passing on production's fossil and failing on a rebuilt database while the security property was intact |

---

## 8 · Evidence

Every number below is from a run on this tree, against staging, with
`npm run dev:stage` up on :3210 — the mode `docs/staging.md` §4 documents.

**One suite does not pass, and it is not mine.** `audit:hydration` fails the
whole `npm run audit` chain on four warnings, all of the same shape:

```
[warning] /product/nike-air-max-90-mens — Image with src "/seed/…svg" was
detected as the Largest Contentful Paint. Please add the `loading="eager"` …
```

It exits non-zero on *any* console warning, and `next/image` emits that advice
only in development. Two things follow, both checkable rather than argued: my
diff touches no product page, no image component and no `next.config.ts`; and
the suite cannot currently be run against a production build either, because
`src/lib/cart/token.ts` sets the guest cookie `secure` when
`NODE_ENV === "production"`, so a `next start` on plain-http localhost drops
`fv_guest` and every fixture that needs a guest bag fails on the spot.

So `npm run audit` cannot go green end to end on a developer's machine today,
for reasons that predate Batch A. It matters because the merge policy says
"merge without asking when every gate is green" — and that phrase currently has
no state in which it is true locally. I have **not** fixed it: the honest fixes
are either an allowlist for dev-only Next advice or a localhost exception on the
cookie flag, and both are decisions about the gates rather than about this
batch. Flagging it for Batch B.

| Gate | Result |
|---|---|
| `npm run rebuild:stage` | green — 89 migrations, from empty |
| `audit:totals` | 48 passed |
| `audit:checkout` | all passed, including the new discount-split section |
| `audit:checkout-discount` | **9 passed** (new) |
| `audit:refunds` | **33/33**, including the cancel guard |
| `audit:refund-message` | **16/16**, up from 9 |
| `audit:customer-copy` | pass (new) |
| `audit:settings-controls` | **34 passed, 31/31 controls** (new) |
| `audit:admin-pages` | 56 passed |
| `audit:shipping` | **110 passed**, up from 107/3 once it stopped reading production |
| `audit:admin` | 23 held, **0 holes** |
| `audit:security-advance` | 13 held, **0 holes** |
| `audit:fixtures-guard` | **28/28**, including the new write-must-be-guarded check |
| `audit:literals` | both halves, and the content half for the first time |
| `audit:delivery` | 53 passed · `audit:parcel` 12 passed · `audit:rto` 35/35 · `audit:reconciler` 15/15 · `audit:payment-health` 30 passed |
| `audit:overflow` · `a11y` · `keyboard` · `keyboard-checkout` · `focus` · `gallery` · `links` · `interactions` · `auth` · `cart` · `bag` · `signedin` | all clean |
| `audit:hydration` | fails — see above, pre-existing and dev-only |
| `npm run build` | succeeds |
| `npm run typecheck` / `npm run lint` / `npm run shapes` | clean |

---

## 9 · Where the two standing rules are written down

Neither belongs only in a report, so both are now in the docs a future phase
reads:

- **`docs/architecture.md` § The reachability rule** — the §G rule itself, the
  exact `admin-pages.ts` check that passed on a deleted control, why
  `getByLabel` is the rule rather than an implementation detail, and the ~29
  actions it does not reach.
- **`docs/staging.md` § 4.5** — the guard only covers the files that ask it, the
  three that did not, the mechanism that now checks, and the two read-only
  exemptions with their reasons.

---

## 10 · Two gates that were wrong, found by running them

Neither is Batch A work; both were exposed by rebuilding staging from empty and
then running the suites against it, which is the first time either had faced a
database without production's history in it.

**`audit:admin` — the ledger.** `reconcile_inventory` reported three drifting
variants. They were mine: the first version of the cancel-guard fixture inserted
`orders` and `order_items` directly, deducted nothing, and then adjusted stock by
hand in its cleanup. A stock write that does not declare `app.inventory_reason`
records its movement as `unspecified`, and the ledger reports **any**
unspecified row as a finding — deliberately, because "a stock correction without
a reason is the thing this ledger exists to prevent". The fixture now places a
real order through `create_order_with_stock`, so the `order −1` and the
`cancellation +1` sum to zero and nothing has to be unpicked afterwards. The
assertion is stronger too: it now checks the whole round trip rather than "one
cancellation row", which would also have passed on a hand-written `UPDATE` that
moved stock with no ledger entry at all. Staging's three stray rows are repaired
and `audit:admin` is 23 held, 0 holes.

**`audit:security-advance` — a fossil.** It asserted that after an attacker's
write `cod_advance_minimum_paise` was still `9_900`. Phase 7 deleted that key
from `site_settings` on purpose. So the check passed against production's older
row by reading something dead, and failed against a rebuilt one while the
security property it names — an attacker cannot write the row — was perfectly
intact. It now compares the whole row before and after, which is the property
itself and cannot go stale with the schema. `admin-pages.ts` already learned
this exact lesson and wrote it down; this file had not.

---

## 11 · What Batch A did not touch

Everything in Batch B and beyond, unchanged: email delivery, address editing,
error reporting, the logo, the ₹2,499 literals, add-to-bag latency. Coupons stay
in Batch C per your decision, and 9E's rounding helper and discount split are
already shaped for them.
