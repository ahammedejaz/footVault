# Phase 6 (revised) — payment model, returns policy, admin panel, Shiprocket

Written against `docs/phase-6-brief-revised.md`. This supersedes the report of
the same name from the first Phase 6 run, which is in git history at `996f0b2`
and remains accurate about what that run built.

Branch `feat/phase-6-payment-model`, 19 commits, 99 files, +15,893/−807.

---

## 0 · The two instructions that changed the brief

Both came from the owner mid-run and both overrule the written brief. They are
first because everything else follows from them.

**Delivery rates come from the Shiprocket API and are never hardcoded.** Asked
to resolve a conflict — the brief says "shipping stays flat ₹99, free over
₹1,999", the live database said ₹199 and ₹2,499 — the owner rejected both fixed
options: *"Delivery charges should be picked up from shiprocket api we will not
hardcode anything. Min order value is decided by us or admin from admin panel."*

**The Pay-on-Delivery surcharge stays**, on the condition that it appears as an
explicit named line rather than as an unexplained gap between two totals.

So: rates live, thresholds in `site_settings` and editable at `/admin/settings`,
and a `Pay-on-delivery fee` row wherever a total is shown. The brief's ₹99 and
₹1,999 turned out to come from `scripts/seed-data.ts`, which still held the
Phase 0 placeholders — see §5.

---

## 1 · Preflight

### P1 — verified by query, not by reading the last report

| Check | Verdict |
|---|---|
| PR #5 merged | Yes (`d8d09bc`); PR #6 merged the first Phase 6 run (`996f0b2`) |
| A real test-card payment end to end | **Yes.** `FV-2026-00487`: `confirmed`/`paid`, one `payments` row `captured` at 169800, 4 `payment_events`, exactly one `inventory_movements` row |
| `RAZORPAY_WEBHOOK_SECRET` in Vercel | **Unverified from here.** Owner task, still open |

The previous report contradicted itself on P1.3 — §8.3 lists "one real test-mode
payment" as outstanding while §12 opens "raised by the owner after the first
real payment succeeded". The database settles it: the Razorpay path is proven.

### P2 — all seven debts had already landed in the first run

Confirmed present: `inventory_movements` (372 rows at the start), rate limiting,
`abandonUnpaidOrder` wired, the reconciled suites, the colourway caption,
`isSupabaseConfigured()`, and the rail affordance. Nothing to redo.

---

## 2 · Part 0 — the payment model

Cash on delivery no longer means "pay nothing now". The customer pays an advance
through Razorpay at checkout; the courier collects the balance.

**One provider, no second path.** `codAdapter` delegates all four money-moving
methods to `razorpayAdapter` (`src/lib/payments/cod.ts`). Every Phase 5
guarantee — idempotency, webhook-as-truth, compare-and-swap, the unique
constraint on `razorpay_order_id`, timing-safe signatures — therefore covers a
Pay-on-Delivery order without a line of new code.

**Nothing is confirmed before money moves.** Both methods now start `pending`.
A COD order used to be written `confirmed` with nothing paid — `FV-2026-00488`
is one, ₹1,719 of stock committed against a promise. Starting pending also means
the existing abandonment sweep covers Pay on Delivery for free.

**The advance rule** is `src/lib/payments/advance.ts`: `shipping_fee` | `fixed` |
`greater_of`, floored at the configured minimum and at Razorpay's 100 paise, and
clamped to the order total. Pure, and deliberately not `server-only`, so the
checkout UI can display a split without dragging a Supabase client into the
browser bundle — the failure CI caught in `9440fa0`.

**Schema.** `orders` gains `advance_amount`, `balance_due_on_delivery`,
`cod_handling_fee`, `cash_collected_at`, `cash_collected_by`, `delivered_at`,
with a check constraint `advance_amount + balance_due_on_delivery = grand_total`.
The invariant is the database's, not a convention: a courier collecting the
wrong amount is discovered by customer complaint.

`create_order_with_stock` takes the advance and **derives the balance** as
`grand_total − advance`. Two independently-supplied numbers would fail the
constraint the moment a price moved under the row lock and take the whole
checkout down with an opaque error.

### The totals drift, root-caused

The owner reported that COD and pay-online totals differ. Three places computed
delivery independently:

| Where | Rule | ₹1,499 bag |
|---|---|---|
| `queries/cart.ts` | flat fee from `site_settings` | ₹199 |
| `product/[slug]/page.tsx` | **hardcoded literals** | ₹199 |
| `shipping/fee.ts` (charged) | live rate, method-dependent | ₹199 / **₹220** |

`FV-2026-00487` and `FV-2026-00488` carry identical ₹1,499 subtotals and
₹199 against ₹220. The cart promised one number and checkout charged another.

`computeOrderTotals` in `src/lib/orders/totals.ts` is now the only place a total
is computed, and `shipping.flat_fee_paise` was **deleted** rather than corrected
so it cannot come back. The COD extra is returned separately as
`codHandlingPaise` and rounded once-then-split, so the customer pays exactly
what they paid before — asserted, not assumed.

### Four things found that were not in the brief

1. **`applyPaymentOutcome` would have refused every Pay-on-Delivery capture.**
   Its under-payment guard compared against `grand_total`; an advance is
   *supposed* to be short. Every such order would have been charged, then
   stranded `pending`, then swept. The guard is not weakened — it now expects
   `advance_amount`.
2. **`create_order_with_stock` had drifted from its own migration.** The last
   file to define it dropped the four `set_config('app.inventory_*')` calls that
   attribute stock movements, while the live database kept them. A fresh
   `db reset` would have produced a function that still moves stock and records
   every movement as `unspecified`, with no actor and no order.
3. **The ledger never recorded a variant's opening stock.** The movement trigger
   was `AFTER UPDATE` only, so a variant inserted with stock had no rows at all
   and counted as drifting for ever. Invisible until now because the 370
   existing variants were backfilled by hand — and this phase adds a form that
   creates variants with stock in them.
4. **`npm run audit` could never have gone green.** `audit:checkout` sets stock
   directly for its contested-stock fixture, leaving unattributed movements that
   made `audit:admin` fail immediately afterwards.

---

## 3 · Part 0b — returns and replacements

`delivered_at` is captured from Shiprocket tracking onto the shipment and
mirrored onto the order, using **the courier's own timestamp** rather than the
moment of the fetch: tracking is read when somebody opens a page, so stamping
`now()` would hand one customer a window running from whenever an admin happened
to look. Shiprocket returns IST with no offset, which `new Date()` would read as
UTC on Vercel — five and a half hours early, silently shortening every window —
so `+05:30` is explicit. Written once; a later fetch that still says "Delivered"
cannot restart the clock.

The window is shown as a wall-clock deadline that ticks, and swaps itself for
the shop's phone and WhatsApp once it lapses. It is a `useSyncExternalStore`,
not state set in an effect: React's lint rule flags the latter as cascading
renders, and time genuinely is an external system.

Admin recording lives on `/admin/orders/[id]` and moves `delivered → returned`
through the same compare-and-swap as every other status change. It deliberately
**does not touch stock** — a replacement means another pair leaves the shelf and
possibly one comes back, and "possibly" written into a count is a number nobody
can later explain. The 24-hour window is recorded, not enforced: whether to
honour a late claim is the shop's decision, and the timeline says it was late.

---

## 4 · Part 1 — the admin panel

All twelve routes in the nav now open. `/admin/orders/[id]` and
`/admin/settings` were built here; the other seven by two subagents working in
disjoint file sets (the brief asked for a single agent — the owner authorised
agents explicitly, twice).

The order detail page is where the phase's two halves meet: the five Shiprocket
actions had existed since the first run — written, guarded, rate-limited, tested
against a mock — with **no button in the interface calling them**. Each step now
shows the state it reached and gates on the one before it, and the panel states
what the courier will be asked to collect before any button is pressed.

`/admin/settings` finally exposes the `cod_advance` rule. Money is entered in
**rupees**; a field that silently wants 9900 when you meant ₹99 is a
hundredfold pricing error waiting for a distracted afternoon.

---

## 5 · Part 0b §6 — the contradicting copy, which was worse than described

The brief said the 7-day returns line survived in `site_settings`, the
announcement bar and the footer. `232c297` had already fixed four places. Two
more were still live and both were found by looking rather than by being told:

- **The homepage promo strip** — "Free returns within 7 days", "Free shipping
  over ₹1,999 / Flat ₹99 below that", "Cash on delivery — on every order". Three
  claims, three false, at the top of the shop.
- **`scripts/seed-data.ts` and `supabase/seed.sql`**, two copies of the same
  content, both still carrying "Refunds are issued to the original payment
  method within 5 working days" — the exact sentence the owner had removed. One
  `npm run seed` would have reinstated an advertised refund policy on a live
  shop.

Both corrected, and the jsonb literals in `seed.sql` were verified by parsing
them in Postgres rather than by reading them.

---

## 6 · Part 2 — Shiprocket

The COD collectable is now `balance_due_on_delivery`, never `grand_total`, and
is recorded on the shipment in `cod_collectable_amount` (a column the brief
specified and the table never got, along with `delivered_at`).

This was very nearly right by coincidence: under the default `greater_of` rule
the advance is the whole delivery charge, so the balance *is* the goods
subtotal, which is what the payload was sending. Change the rule to a fixed ₹99
against a ₹220 delivery and every parcel under-collects by ₹121. The test
fixture is therefore built so the balance equals neither the subtotal nor the
grand total, and all three are asserted — the only shape in which the assertion
can fail when the code is wrong.

Customer-facing tracking (AWB, courier, latest status) is on the confirmation
page and in the account history, read through the caller's own RLS client so the
`customers read their own shipment` policy decides visibility. A product-page
delivery check answers "do you deliver to me, and how long" — and deliberately
returns **no price**, because a figure for one pair at a default weight would
disagree with checkout and recreate the drift this phase removed.

---

## 7 · Measurements

Every number here is from a run, not an estimate.

| Gate | Result |
|---|---|
| `audit:totals` | 15 passed, 0 failed |
| `audit:shipping` | 54 passed, 0 failed |
| `audit:admin` (security) | 23 held, 0 holes |
| `audit:admin-pages` | 54 passed, 0 failed |
| `audit:security-advance` | 13 held, 0 holes |
| `audit:keyboard-checkout` | all green — `FV-2026-00528`, 34900 + 649500 = 684400 |
| `audit:overflow` | clean: 22 routes + 15 states × 6 widths, 9,119 elements |
| `audit:checkout` | all checks passed |
| axe on all 12 admin routes | 0 violations |
| `tsc --noEmit` | 0 errors |
| `eslint src/ scripts/` | 0 errors, 0 warnings |
| `next build` | passes |

**Contrast, found by running axe behind the admin guard for the first time.** A
tinted chip eats the contrast its text token was chosen for: `--fv-orange-ink`
is documented at 5.20:1, but behind a 22% fill it measured **4.36:1**, under AA
for a 12px label. Green was worse at **4.13:1**, because `--fv-green` was
serving as both the fill and the text and cannot do both. Green now has its own
ink at 5.28:1 on its own tint; the orange fill drops to 14% for 4.65:1. Computed
first, then confirmed by axe.

---

## 8 · What I got wrong and caught

- **I put the quote gate before form validation.** Pressing pay on an empty form
  said "add a delivery address so we can price delivery" and highlighted
  nothing. The form answers first now.
- **My first Place Order fix was incomplete.** Gating on "a complete pin code
  with no quote" left an untouched checkout enabled, offering the bag subtotal
  as an advance. It gates on having a quote at all.
- **My own audit helper was the bug I spent longest on.** `deliveryPriced`
  waited on `button[type=submit]:not([aria-disabled=true])` — and the header
  search is also a submit button, so it matched that, resolved instantly, and
  every assertion after it read an unpriced checkout. I lost a long stretch to
  this before instrumenting properly instead of theorising.
- **I used the wrong cache API.** This Next takes `revalidateTag(tag, profile)`
  and ships `updateTag(tag)` for Server Actions. `AGENTS.md` warns that this is
  not the Next.js in training data; it was right, and I had briefed both agents
  wrongly before correcting them.
- **I exported a constant from a `"use server"` module**, which may only export
  async functions, and an action that did no work but would still have been a
  POST endpoint in the bundle. The lint rule caught the second.
- **I read the clock during render** in two components. React's purity rule
  caught both.
- **I dropped a Supabase error** in an audit; `no-unchecked-supabase-error`
  caught it, in a commit I had already made.

---

## 9 · Known imperfections

1. **Shiprocket authenticates and fails.** Every quote this session logged
   `serviceability unavailable { reason: 'auth' }`, so all live figures came
   from the fallback. Credentials exist in `.env.local` but do not work.
2. **No test drives a Server Action over HTTP with a forged payload.** The data
   layer is covered thoroughly; the action endpoints are covered only through
   the RPCs they depend on. This remains the most valuable missing test and is
   carried in `phase-6-security-review.md`.
3. **`site_settings.contact` looks like placeholder data** — WhatsApp
   `+91 98450 22001`, `hello@footvault.in`. Contacting the shop is the only
   route to a replacement claim, so a wrong number makes the policy unclaimable.
4. **The admin panel has never been driven on real tablet hardware**, only at a
   768px viewport.
5. **`/admin` returns 200 to an anonymous visitor** with the not-found body.
   Pre-existing (F-2), unfixed.
6. **The Pay-on-Delivery advance has never been captured for real.** The order
   is created correctly and the modal opens; no test-card payment has completed
   through the COD path.
7. **Categories cannot be sorted and customers can only be sorted two ways** —
   both are aggregate or ordering limitations that need a view or an RPC.

---

## 10 · Deferred

| Deferred | To | Note |
|---|---|---|
| `/admin/appearance`, banner scheduling | Phase 7 | Out of scope by the brief |
| Coupons, reviews | Phase 8 | |
| Refunds | Phase 8 | Now contradicts the no-refunds policy — README still lists it as planned scope, which is the owner's call |
| Background tracking poller | — | Excluded by the brief; tracking refreshes on view |
| Policy page editing in admin | — | The pages are CMS rows; settings links to them rather than half-building an editor |

---

## 11 · Blocked on the owner

1. **`RAZORPAY_WEBHOOK_SECRET` in Vercel**, Preview and Production separately.
   Now more pressing than ever: with both methods running through Razorpay, a
   missing webhook secret means *no* order confirms itself.
2. **Shiprocket.** Fix the failing credential; verify the pickup address in the
   panel; put `SHIPROCKET_EMAIL`, `SHIPROCKET_PASSWORD` and
   `SHIPROCKET_PICKUP_LOCATION` into Vercel. Note that
   `shiprocketPickupLocation()` falls back to `"Primary"`, which this account is
   not called — so an unset variable fails when a real parcel is created, not at
   boot.
3. **Run the one manual end-to-end Shiprocket test.** The click-path is in
   `docs/admin-guide.md`, ending in cancelling the shipment in the panel.
4. **Confirm the contact details** in `/admin/settings`.
5. **One real Pay-on-Delivery payment** with a test card, to prove the advance
   captures and the webhook confirms.
6. **The consumer-law question the brief raised.** India's Consumer Protection
   (E-Commerce) Rules require return, refund and exchange terms to be displayed
   clearly, and a blanket no-refund position may not hold for goods that arrive
   defective or not as described. "Damage in shipment only" also does not cover
   the shop sending the wrong size, which is its own error. Worth an hour with
   someone who knows Indian consumer law before real orders start.
