# Phase 9 · Stage 2 — Plan

Reads from `claudeExecutionReport/phase-9-audit.md`. No feature code has been
written. This document is the gate: nothing below gets built until it is
approved.

One finding is new since the audit and is the most serious thing in this
document — **9E, the invisible prepaid discount**. It is money already being
given away without the customer being told, and I have traced it to its exact
line.

There is one decision I cannot make for you, at the end of 9E: whether the
customer's total should land on a whole rupee. Options are laid out with what
each costs.

---

## Contents

| | |
|---|---|
| [9E](#9e--the-prepaid-discount-is-deducted-and-never-shown) | **New P0** — the discount is applied but invisible |
| [9B](#9b--a-refunded-order-can-never-be-cancelled) | Cancel guard, plus restoring FV-2026-00623's stock |
| [9C](#9c--the-order-page-contradicts-itself) | Refunded copy, and internal notes as customer text |
| [9A](#9a--the-controls-nobody-can-find) | The settings redesign, delivery panel as the worked example |
| [G](#g--the-standing-gate-requirement) | **The gate rule** — and how many controls fail it today |
| [9F](#9f--coupon-codes-new-feature) | **Coupons** — enable/disable, scheduling, user-specific |
| [Rest](#the-rest-by-severity) | Email, addresses, error reporting, logo, literals, latency |
| [Batches](#batches-and-sequence) | Sequence, interactions, what is deferred |

---

# 9E · The prepaid discount is deducted and never shown

**Severity P0.** The shop is giving away money and telling nobody. On the
owner's worked example — a ₹3,999 loafer, ₹50 delivery — the customer is charged
**₹3,249.20**, meaning **₹799.80** (20% of goods) has been deducted, while the
Discount line reads "—" and no other line accounts for it.

## Where it breaks

The arithmetic is right. `computeOrderTotals` (`src/lib/orders/totals.ts:100-108`)
computes `prepaidDiscount`, folds it into `discountTotal`, and returns both. The
`Totals` component is right too: `src/components/checkout/totals.tsx:107-114`
draws a named **"Paying online"** row whenever `prepaidDiscount > 0`.

The break is between them, at `src/components/checkout/checkout-flow.tsx:313-322`:

```ts
const shownTotals = quote
  ? {
      ...totals,                            // ← stale: the bag before a destination
      shippingFee:  quote.feePaise,
      codHandlingFee: quote.codHandlingPaise,
      grandTotal:   quote.grandTotalPaise,  // ← discounted total, overwritten
      advanceAmount: quote.advancePaise,
      balanceDueOnDelivery: quote.balanceDuePaise,
    }
  : totals;
```

`grandTotal` is replaced with the quote's discounted figure. **`discountTotal` and
`prepaidDiscount` are not** — they keep the values from the pre-quote `totals`
prop, computed before a destination or method existed, where both are zero. So:

- `grandTotal` = ₹3,249.20 — discounted ✓
- `prepaidDiscount` = 0 → the "Paying online" row is **not rendered**
- `otherDiscount` = `discountTotal − 0` = 0 → the Discount row renders **"—"**

Exactly the reported symptom. The comment four lines above this code says
*"updating one and not the other is how a checkout ends up not adding up"* — and
then does that, for the discount.

It cannot be fixed in the client alone: the quote action never sends the numbers.
`src/lib/actions/shipping-quote.ts:124` returns `grandTotalPaise` and the response
type carries **no** `discountTotalPaise` or `prepaidDiscountPaise` at all.

## Every surface that shows totals

| Surface | Renders via | State | Fix |
|---|---|---|---|
| Bag drawer | `bag-drawer.tsx:214` | ✅ Correct — says shipping and discount are worked out at checkout | none |
| Cart page | `(storefront)/cart/page.tsx` | ✅ Pre-quote; no discount applies yet | none |
| **Checkout** | `checkout-flow.tsx:1102` → `Totals` | ❌ **Total discounted, both discount lines blank** | carry the fields through the quote |
| **Confirmation** | `order-detail.tsx:166` → `Totals` | ⚠️ Shows a muted generic **"Discount"**, not "Paying online" | persist the split |
| **Account order page** | same component | ⚠️ same | same |
| **Admin order page** | `admin/orders/[id]/page.tsx:148-149` | ⚠️ Generic "Discount"; owner cannot tell a coupon from a prepaid incentive | same |
| **Order email** | `actions/checkout.ts:841` | ❌ **`discountTotal: 0` hardcoded** — the email's lines will not sum to its own total | pass the real figure |

The confirmation, account and admin cases share one root cause: **`prepaidDiscount`
is not a database column.** `orders` has `discount_total` and nothing else
(confirmed against production). The type comment at
`src/lib/orders/types.ts:274-277` documents this as intentional — "the reason it
was given belongs to the moment of choosing rather than to the row" — which was a
defensible call when the discount was zero everywhere and is wrong now: a
customer opening their order a week later, and an owner reconciling it, both need
to know *why* ₹799.80 came off.

The email case is latent but certain: it lands the moment Batch B switches email
on, and it will produce a confirmation whose arithmetic visibly disagrees with
itself.

## The fix

1. **Add the two fields to the quote response** — `shipping-quote.ts`, its return
   type, and `quoteFor`'s caller. They already exist on `CheckoutTotals`.
2. **Carry them in `shownTotals`** — `checkout-flow.tsx:313-322`, alongside the
   five fields already copied. Two lines.
3. **Persist the split** — one migration adding `orders.prepaid_discount` (paise,
   not null, default 0), written by `create_order_with_stock` from the value
   `placeOrder` already holds. Then read it in `queries/orders.ts:212` and
   `queries/admin/orders.ts:352`, and drop the `?` from `OrderTotals.prepaidDiscount`
   so a missing value becomes a type error rather than a silent zero.
4. **Label it in admin** — `admin/orders/[id]/page.tsx:148` splits into "Paying
   online" and "Discount" exactly as the customer view does.
5. **Fix the email input** — `checkout.ts:841`, pass the real `discountTotal` and
   `prepaidDiscount`.

**Files:** `src/lib/actions/shipping-quote.ts`, `src/components/checkout/checkout-flow.tsx`,
`src/lib/orders/types.ts`, `src/lib/queries/orders.ts`, `src/lib/queries/admin/orders.ts`,
`src/app/admin/orders/[id]/page.tsx`, `src/lib/actions/checkout.ts`, one migration.

**The test that proves it:** extend `scripts/audit/totals.ts` with a prepaid order
at a non-zero discount asserting `subtotal − discountTotal + shippingFee ===
grandTotal` **and** `prepaidDiscount > 0`; plus a browser assertion in the
checkout suite that with a discount configured, the string "Paying online" and
the exact discount figure are both **on screen** — not merely returned. (That
second form is the standing rule in §G, and this is its first application.)

**Risk:** medium. It touches the money path and adds a column. It changes no
arithmetic — every figure it displays is one the server already computed — so
`advance + balance = grand_total` is untouched. The migration must default to 0
so existing rows stay valid against `orders_advance_balance_sums`.

## The rounding decision — yours

**There is no arithmetic bug here.** `prepaidDiscountFor`
(`src/lib/payments/advance.ts:265-278`) already uses `Math.floor`, so the discount
is always a whole number of paise. ₹3,249.20 is exactly 324920 paise. Nothing is
lost or invented.

The question is only whether a customer should ever see a total that is not a
whole rupee. It matters most for **Pay on Delivery**: the courier collects cash at
the door, and sub-rupee coins are effectively out of circulation in India. A
balance of ₹3,249.20 is not physically collectable, and Shiprocket's collectable
figure would carry those 20 paise into a gate that asserts it equals the balance.

| Option | What happens | Cost |
|---|---|---|
| **A · Leave it exact** (today) | Totals may end in paise. Razorpay charges 324920 exactly | A COD balance the courier cannot collect; receipts ending in ₹.20 |
| **B · Round the discount down to whole rupees** ⭐ | ₹799.80 → ₹799; total becomes ₹3,250 | Shop keeps 80p. **One line changed**, in a function that already floors. Every invariant holds because everything downstream derives from the discount |
| **C · Round the grand total, carry an adjustment line** | Total forced to a whole rupee | Breaks `subtotal − discount + shipping = grand_total` unless a new column and a new visible line are added. Most invasive |
| **D · Round only the COD balance** | Prepaid stays exact, cash orders land whole | `advance + balance = total` fails unless the advance absorbs the remainder — two figures to keep in step, and a gate to rewrite |

**My recommendation: B.** It is a one-line change to a function that already
rounds, it makes every total whole for both payment methods, it cannot break the
advance/balance invariant, and the shop's cost is under a rupee per order. A and
B are both defensible; C and D I would not do.

**If you pick B, say so and I will fold it into Batch A. If you say nothing, I
will build A — exact — because that is the current behaviour and changing what a
customer is charged is not a default I should choose for you.**

---

# 9B · A refunded order can never be cancelled

**Severity P0.** Both limbs of the guard in `cancel_order_with_restock` fire on a
fully refunded order, and the second names `'refunded'` explicitly — so no data
state lets it through.

## The fix

**Compare net outstanding, not history.** A new migration replaces the guard:

```sql
-- captured minus refunded, per order. Zero means nothing is owed back.
if p_require_unpaid and (
     select coalesce(sum(pm.amount), 0)
       from public.payments pm
      where pm.order_id = p_order_id and pm.status = 'captured'
   ) - (
     select coalesce(sum(r.amount_paise), 0)
       from public.refunds r
      where r.order_id = p_order_id and r.status = 'processed'
   ) > 0 then
  return 'already_paid';
end if;
```

`orders.payment_status <> 'unpaid'` is dropped from the condition entirely — it is
a denormalised summary, and it is the limb that fires on a refunded order.

**The other three callers must not loosen.** `checkout.ts:764`, the cron route at
`route.ts:178`, and `20260809030000_narrow_release_abandoned_orders.sql:67` all
pass `p_require_unpaid: true` against genuinely unpaid orders. Net outstanding on
an unpaid order is zero minus zero — they keep passing, and an order with a live
capture still blocks. This preserves the Phase 8 fix where the sweep cancelled
paid orders; that is the regression to watch.

**Also fix `refundInstruction`** (`transition.ts:233-280`). It currently tells the
owner to refund an amount that may already have been refunded. It should compute
the same net figure and, at zero, not be reached at all.

## Restoring FV-2026-00623's stranded stock

`stock_restored_at` is null, so that pair is still deducted from sellable
inventory in production. **Once the guard is fixed, the fix restores it by
itself** — the owner presses Mark Cancelled, `cancel_order_with_restock` runs its
normal restock path, writes an `inventory_movements` row with reason
`cancellation`, and stamps `stock_restored_at`.

That is the right way to do it, and I want to be explicit about why:

- **No manual `UPDATE` against production.** A hand-written stock correction
  writes no movement row, so `inventory_movements` would stop reconciling to zero
  drift — which is one of this phase's own gates.
- **It doubles as the proof.** The fix is verified by the owner performing the
  exact action that has been failing, on the exact order that has been failing, and
  watching the stock come back.

**Sequence, on staging first then production:**

1. Snapshot before the migration (a migration touching the cancel path is a
   snapshot-first change under the merge policy).
2. Apply the migration.
3. On staging, reproduce: refund an order in full, cancel it, confirm status
   `cancelled`, `stock_restored_at` set, one movement row, stock back.
4. In production, the owner opens FV-2026-00623 and presses **Mark Cancelled**.
5. Verify: `stock_restored_at` non-null, exactly one `inventory_movements` row for
   that order with reason `cancellation`, variant stock +1, and
   `npm run audit:teardown`-style drift check at zero.

**Also worth fixing, separately:** that order's `payments` row still reads
`captured` though the refund is `processed` and webhook-confirmed. The new guard
does not depend on it, so this is bookkeeping rather than a blocker — but I would
check with one query whether it is systematic across all refunded orders before
deciding whether it needs its own repair.

**Files:** one migration; `src/lib/orders/transition.ts`.
**Test:** a new `scripts/audit/refunds.ts` case building a captured-then-fully-refunded
order and asserting cancel **succeeds**, restocks exactly once, and that a
partially refunded order with a positive balance is still **refused**. Plus a
replay: cancelling twice restocks once.
**Risk:** high — it is the money path and a production migration. Mitigated by the
partial-refund case, which is the one that would silently let a genuinely paid
order be cancelled if the sum is written wrongly.

---

# 9C · The order page contradicts itself

**Severity P0** for the copy, **P1** for the notes.

## 1 · The missing `refunded` branch

`whatHappensNext` (`src/components/checkout/order-format.ts:114-146`) handles
`paid` and falls through to *"We have not seen your payment settle yet… reload
this page rather than paying again"* for everything else — including `refunded`.

**Fix:** add an explicit `refunded` branch before the fallback, in the owner's own
register: *"₹135 is on its way back to you. Refunds usually reach your account in
5–7 working days."* Then convert the chain to an exhaustive `switch` on
`PaymentStatus` so a fourth status becomes a compile error rather than a customer
seeing the wrong sentence.

**This interacts with 9B and the interaction must be built deliberately.** Today
FV-2026-00623 is `confirmed` + `refunded`. After 9B it can become `cancelled` +
`refunded` — and `whatHappensNext` returns on the `cancelled` branch at line 120,
never reaching the new refunded branch. The cancelled blurb currently reads *"This
order was cancelled and the pairs went back on the shelf"* and says **nothing about
the money**. So both must be right:

| Order state | Must say |
|---|---|
| `confirmed` + `refunded` (today) | the refund is on its way |
| `cancelled` + `refunded` (after 9B) | cancelled **and** the money is coming back |
| `cancelled` + `unpaid` | cancelled, nothing was charged |

Writing either fix without the other leaves the page wrong in a new way.

## 2 · Internal notes rendered as customer copy

Root cause: `order_status_history.note` serves two audiences.
`refunds.ts:522-529` writes an engineer's audit line; `queries/orders.ts:158-170`
passes it through unfiltered; `order-timeline.tsx:66-70` prints it. The customer
of FV-2026-00623 currently reads `rfnd_TNeaZX8YweRyFi`, `cancelled_before_dispatch`,
and "webhook".

Rewriting the strings fixes today's instances and not the cause, so:

**Fix — split the field.** A migration adds `order_status_history.customer_note`
(nullable). `note` stays exactly what it is, an internal audit trail, and stops
being customer-visible. `toTimeline` reads `customer_note` only. Where a status
change has nothing to say to a customer, the timeline shows the status label alone
— which is already good copy (`ORDER_STATUS_COPY`).

Then write customer sentences for the events that have one: placed, payment
received (not "captured"), refund sent, refund arrived, shipped, delivered.

**Why a column rather than a translation layer:** a mapping from internal text to
customer text is a second place the truth lives, and it goes stale silently the
first time someone edits a note string. A nullable column makes "this event has
nothing to say to the customer" the default and safe state.

**Files:** one migration; `src/lib/orders/refunds.ts`, `src/lib/queries/orders.ts`,
`src/components/checkout/order-format.ts`, and every `writeHistory` caller.
**Test:** a gate that fails if any `customer_note` in the database, or any
customer-facing string in `src/components/checkout/` and `src/app/(storefront)/`,
matches `/webhook|captur|reconcil|idempotent|\bRPC\b|rfnd_|pay_|_before_|_after_/i`.
This is the copy sweep made permanent, and it is cheap.
**Risk:** low. Additive column; the worst failure is a timeline entry with no
sentence, which renders as a clean status label.

**Also in scope:** `checkout-failure.tsx:386` mentions "the thirty-minute sweep" —
one look to confirm whether it is rendered, and rewrite if so. The `webhook`
mentions in `admin/orders/[id]/page.tsx:197` and `refund-panel.tsx:245` are
**admin-facing and I would leave them** — that vocabulary is correct for the
owner. Say if you disagree.

---

# 9A · The controls nobody can find

**Severity P0** — the owner is blocked from operating their own shop.

The audit's finding: both controls are on the page, visible, deployed, and
working. The failure is information design. So the fix is not to build a toggle;
it is to make the page legible.

## The delivery panel as the worked example

Per your instruction, `ShippingSettingsForm` is done first, in full, and becomes
the pattern the other panels follow.

**Three rules, in priority order:**

1. **Controls first, prose second.** Today every control carries 3–5 lines of grey
   text that is physically larger and darker than the control itself. The
   consequence lines stay — they are genuinely good and were a real requirement —
   but they move *below* the control in a smaller, lighter treatment, and the
   control gets visual weight. A shopkeeper scanning for a switch should hit
   switches, not paragraphs.
2. **The word "flat" is visible without opening a dropdown.** The delivery-charge
   control becomes two labelled radio options rendered inline — *"Charge the
   courier's rate"* / *"Charge one flat amount"* — so both words are on screen in
   the default state. The flat-amount field stops being conditionally absent: it
   renders **disabled with its value visible** when live mode is selected, so the
   feature is discoverable before it is chosen.
3. **The panel stops denying its own contents.** The bolded *"Delivery rates are
   not set here"* is the single most prominent line in the panel and it is what
   stops the owner reading further. It becomes something true and non-blocking,
   e.g. *"Per-pin-code rates come from Shiprocket. What you set here is how the
   customer is charged."*

Also: the three 16-px native checkboxes become real toggle controls, and the two
unset values (`flat_cod_deposit_mode`, `wallet_low_balance_paise`) say "not set"
rather than rendering as an empty box or ₹0.

## Then the grouping

Once the delivery panel is right, the page regroups into the sections you asked
for: **Delivery & rates · Cash on delivery · Returns · Store details**.
*Appearance* is deliberately left out — it belongs to the homepage editor in
Batch D and an empty section is worse than none.

**Files:** `src/components/admin/settings/settings-forms.tsx`,
`src/app/admin/settings/page.tsx`, possibly a small shared control in
`src/components/admin/ui.tsx`.
**Test:** §G's rule applied to all 31 controls on the page.
**Risk:** low for the money — this is presentation only, and the save action is
untouched. The real risk is regressing the save path while moving JSX, which §G's
tests now catch.

---

# G · The standing gate requirement

**This is the most valuable item in the phase.** Every other fix here is
conventional. This one is what stops Phase 10 repeating Phase 9.

## The rule

> **Any owner-facing control ships with a test that locates the control by its
> visible label, changes it, and asserts the stored value changed.**
>
> Locating by `id` is allowed only where no visible label exists — and that is
> itself a defect to fix. Asserting on page text is never sufficient.

The audit showed why: `admin-pages.ts` passes its settings check on
`body.innerText` containing "Pay on Delivery", which is satisfied by the panel
*title*. Delete the checkbox and the gate stays green. That is how two toggles
were reported "Built · proved" for two phases.

## How many controls fail the bar today

Counted, not estimated:

| | Count |
|---|---|
| Controls on `/admin/settings` (18 delivery + 5 parcel + 8 shop) | **31** |
| Of those, operated and asserted by a gate | **1** — `#free-above` |
| **Ungated settings controls** | **30** |
| Exported owner-facing admin server actions (`src/lib/actions/admin/*`) | **41** |
| Of those, with a test that drives the UI and asserts an effect | **2** — `saveShippingSettings` via `#free-above`, `addOrderNote` via `#order-note` |
| **Ungated admin actions** | **39** |

The only two controls `admin-pages.ts` ever operates are those two. Everything
else in the panel — every product, variant, category, brand, inventory, customer,
refund and RTO control — is covered by "the page returned 200 and axe found no
violations".

## What gets built, and how far

Closing all 39 in this phase is not realistic and I would not propose it. The
plan is:

- **Batch A:** build the harness — a helper in `scripts/audit/` that takes
  (page, visible label, new value, read-back query) and does the four steps —
  then apply it to **all 31 settings controls**, because that is where the
  reported failure was and the redesign is touching every one of them anyway.
- **Batch C:** extend to the highest-consequence remaining controls — order
  status transitions, refunds, RTO, inventory adjustment, and the Pay-on-Delivery
  customer block. Roughly 10 more.
- **Deferred, named:** the product/variant/category/brand/media CRUD surfaces,
  ~29 actions. They are lower consequence — a wrong product description is
  visible and reversible, a wrong delivery setting is neither — and I would rather
  ship the rule with real coverage of the money-adjacent controls than a thin
  pass over everything. **This is a deliberate gap and it is recorded here so it
  does not read as coverage later.**

**Risk:** none to production; it is test code. The real risk is that it is slow to
write and gets cut under time pressure, which is exactly what happened to the
thing it is replacing.

---

# 9F · Coupon codes (new feature)

Requested during planning: **enable/disable, a scheduled window, and
user-specific coupons.** This is the only new *feature* in the phase; everything
else is repair.

## What already exists — more than expected

The groundwork was laid in Phase 3 and is good. I checked the live schema rather
than the migration alone:

| Piece | State |
|---|---|
| `coupons` table | ✅ Exists, **0 rows** |
| `code` | ✅ Unique, plus `coupons_code_upper_idx` for case-insensitive lookup |
| `type` (`percent` \| `fixed`), `value` | ✅ With `value <= 100` enforced for percent |
| `min_order_value`, `max_discount` | ✅ Floor and cap already modelled |
| `usage_limit`, `used_count` | ✅ Global limit and counter |
| **`is_active`** — your enable/disable | ✅ **Column already there** |
| **`starts_at` / `expires_at`** — your timer | ✅ **Already there**, with `expires_at > starts_at` enforced |
| RLS | ✅ Admin-only; no policy grants anon or authenticated anything, so codes cannot be enumerated |
| `orders.coupon_code` | ✅ Column exists — but **nothing ever writes it** |
| `computeOrderTotals(discountPaise)` | ✅ Arithmetic already correct: `discountTotal = couponDiscount + prepaidDiscount` |
| Cart UI | ⚠️ `coupon-field.tsx` — deliberately **disabled** placeholder that says so honestly |

So two of your three requirements are already columns. **What is missing is
everything that makes them real.**

| Missing | Why it matters |
|---|---|
| **User-specific coupons** | No table links a coupon to a customer. This is the one genuinely new piece of schema |
| **Per-customer usage limit** | `used_count` is global only — "one per customer" is impossible today |
| **A redemption ledger** | Without it you cannot enforce per-user limits, release a code when an order is cancelled, or answer "who used this" |
| **Atomic redemption** | `create_order_with_stock` takes `p_discount_total` but **no coupon code** — it never touches `coupons`, so nothing decrements the counter |
| **Validation** | Nothing turns a typed code into a discount |
| **Admin UI** | No `/admin/coupons` page; not in `ADMIN_NAV` |

## Schema

**One migration**, three parts.

**1 · Per-customer limiting and audience, on `coupons`:**

```sql
alter table public.coupons
  add column per_user_limit integer check (per_user_limit > 0),      -- null = unlimited
  add column audience text not null default 'everyone'
    check (audience in ('everyone', 'specific_customers'));
```

**2 · Who a private coupon is for:**

```sql
create table public.coupon_customers (
  coupon_id uuid not null references public.coupons (id) on delete cascade,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  primary key (coupon_id, user_id)
);
```

**3 · The redemption ledger — the piece everything else hangs off:**

```sql
create table public.coupon_redemptions (
  id             uuid primary key default gen_random_uuid(),
  coupon_id      uuid not null references public.coupons (id),
  order_id       uuid not null references public.orders (id) on delete cascade,
  user_id        uuid references public.profiles (id) on delete set null,  -- null for guests
  code           text not null,        -- snapshot; the coupon may be renamed or deleted
  discount_paise bigint not null check (discount_paise >= 0),
  released_at    timestamptz,          -- set when the order is cancelled
  redeemed_at    timestamptz not null default now(),
  unique (order_id)                    -- one coupon per order, and replay-safe
);
```

Both new tables get RLS with an admin-only policy, matching `coupons`. Customers
never read any of it.

**And the discount split, mirroring 9E:**

```sql
alter table public.orders add column coupon_discount bigint not null default 0;
-- with 9E's prepaid_discount, the sum becomes self-proving:
alter table public.orders add constraint orders_discount_parts_sum
  check (discount_total = prepaid_discount + coupon_discount);
```

That constraint is the same trick as `orders_advance_balance_sums`: the database
refuses a row whose parts do not add up, so no read site has to trust arithmetic
done elsewhere.

## Validation, and where the truth lives

Two layers, and the split matters:

**Preview (advisory)** — a server action `applyCoupon(code)` using
`createAdminClient()`, because coupons are unreadable from the client by design
(`src/lib/supabase/admin.ts:21` already says so). It validates, returns a verdict
and a discount preview, and **stores the code on the cart row** (`carts.coupon_code`)
so it survives navigation from cart to checkout and is never held only in the
browser.

**Authoritative (binding)** — redemption happens **inside
`create_order_with_stock`**, in the same transaction as the stock decrement,
given a new `p_coupon_code`. It re-reads the coupon `for update`, re-validates
every rule, recomputes the discount from the goods total, writes
`coupon_redemptions`, increments `used_count`, and writes `orders.coupon_code`
and `orders.coupon_discount`.

**The client's discount figure is never trusted.** This is the same discipline
the checkout already applies to delivery — `checkout-flow.tsx:1182` notes the
totals shown are a preview and the server recomputes. A coupon that changed, was
disabled, expired, or ran out between the cart and Place Order is caught at the
only moment that counts.

**The eight rules, checked in both layers:**

1. Code exists (case-insensitive)
2. `is_active` is true
3. `now()` is within `starts_at` … `expires_at` (either may be null)
4. `used_count < usage_limit` (null = unlimited)
5. Goods total ≥ `min_order_value`
6. `audience = 'everyone'`, or the customer is in `coupon_customers`
7. This customer's non-released redemptions < `per_user_limit`
8. The resulting discount is capped by `max_discount` and never exceeds goods

## Four decisions that are yours

**a · Does a coupon stack with the prepaid discount?** Both fold into
`discountTotal`. My recommendation: **both apply, each computed on the original
goods subtotal, with the sum capped at the goods total.** The `Totals` component
already draws them as two separate named lines, so the customer sees exactly what
they got and why. The alternative — a coupon suppressing the prepaid discount —
is defensible on margin and needs one sentence of copy.

**b · Is a redemption released when an order is cancelled?** This one has a trap.
Redemption happens at *order creation*, which is **before payment** — so an
abandoned unpaid order would burn the customer's code, and the 30-minute sweep
cancels those. My recommendation: **release on every cancellation**, implemented
inside `cancel_order_with_restock` (set `released_at`, decrement `used_count`).
That reuses the function the sweep and the admin already call, and it means a
customer whose order the *shop* cancelled does not lose their coupon. Abuse is
bounded because a released code still required a real order attempt.

**c · Do we tell a customer why a code failed?** "Expired" and "not for you" are
far better UX than "invalid", but they confirm a code exists. Coupon codes are
low-value secrets, so my recommendation is **be specific, and rate-limit hard** —
a new `couponCheck` policy in `RATE_LIMITS` (the mechanism is already built and
proven). Say if you would rather every failure read the same.

**d · Rounding** — a percent coupon on ₹3,999 has the same fractional-rupee
question as 9E. **Whatever you choose in 9E must apply here**, in the same helper,
so the shop has one rounding rule rather than two.

## Admin UI

A new `/admin/coupons`, added to `ADMIN_NAV`, following the existing
brand/category CRUD pattern (`src/components/admin/brands/brand-form.tsx` is the
closest template):

- **List** — code, type/value, window, `used_count / usage_limit`, active toggle
- **Create / edit** — code, percent-or-fixed, value, minimum order, maximum
  discount, total uses, **per-customer uses**, **active on/off**, **starts / ends**
- **Audience** — everyone, or pick specific customers (reusing the customer search
  that `/admin/customers` already has)
- **Redemptions** — who used it, on which order, for how much

**Dates are entered and shown in IST.** `starts_at`/`expires_at` are `timestamptz`,
and the storefront already pins `Asia/Kolkata` (`order-format.ts:26-40`). A coupon
typed as "starts today" that silently means UTC starts five and a half hours late,
which for a festival sale is the whole morning.

Per §G, every one of those controls ships with a locate-change-assert test — and
the active toggle and the two dates especially, since they are the three things
you asked for by name.

## Files

`supabase/migrations/` (one), `src/lib/actions/coupon.ts` (new),
`src/lib/actions/admin/coupons.ts` (new), `src/lib/queries/admin/coupons.ts` (new),
`src/app/admin/coupons/` (new), `src/components/admin/coupons/` (new),
`src/components/storefront/coupon-field.tsx` (enable it),
`src/lib/orders/totals.ts`, `src/lib/actions/checkout.ts`,
`src/lib/rate-limit.ts`, `src/components/admin/nav.ts`.

## The test that proves it

A new `scripts/audit/coupons.ts`, plus additions to the money gates:

| Assertion | Why |
|---|---|
| Inactive, not-yet-started, and expired codes are all refused | your three headline requirements |
| A code below `min_order_value` is refused; `max_discount` caps a percent | the floor and the cap |
| **Two orders placed concurrently against `usage_limit = 1` → exactly one succeeds** | the race that oversells a limited coupon |
| A `specific_customers` code is refused for another customer **and for a guest** | user-specific coupons |
| `per_user_limit = 1` refuses the same customer's second order | per-customer limiting |
| Replaying `placeOrder` produces **one** redemption row | idempotency |
| Cancelling an order releases the redemption and decrements `used_count` | decision (b) |
| `discount_total = prepaid_discount + coupon_discount` on every order | the DB constraint, exercised |
| Discount never exceeds goods; `advance + balance = grand_total` still holds | the standing money gates |
| A customer cannot read `coupons`, `coupon_customers` or `coupon_redemptions` | added to `audit:auth` RLS suite |

## Risk

**High, and higher than it looks.** It writes to the money path and to stock in
the same transaction. Three specific hazards:

1. **The concurrency test is the one that matters.** A coupon limit enforced with
   a read-then-write rather than `for update` will pass every single-threaded test
   and oversell in production.
2. **Redemption before payment** means the ledger and the sweep must agree, or
   codes leak (never released) or double-spend (released twice). The `released_at`
   column exists so the state is explicit rather than inferred.
3. **It touches `create_order_with_stock`**, which is the most load-bearing
   function in the system. It needs a snapshot and a staging rebuild before it
   goes near production.

---

# The rest, by severity

| # | Finding | Fix | Test | Risk |
|---|---|---|---|---|
| **P1** | **No email to anyone** (`lib/email` is console-only; one call site; no owner notification exists at all) | Add a provider adapter behind the existing `EmailAdapter`; add the owner "new order" mail and the customer states (placed, paid, shipped, delivered, refunded). Keep the soft-fail — a missing email must never fail an order | A gate asserting a failing adapter does not fail `placeOrder`, and that the owner mail contains items, size, address, method and what the courier collects | Low — interface already correct |
| **P1** | **Addresses cannot be edited**; `/account/addresses` copy claims they can | Add `updateAddress` (id + full record) and an Edit affordance in `address-book.tsx`; re-trigger the delivery quote on PIN change | Browser test: edit an address, assert the stored row changed and the quote re-ran | Medium — the quote re-trigger is the fiddly part |
| **P1** | **Server errors reach nobody** — no Sentry, no `instrumentation.ts`, no alerting | Add `instrumentation.ts` with `onRequestError` reporting to one destination, plus the fail-open rate-limit and history-write paths | Force a server error on staging; assert it arrives | Low |
| **P1** | **`logo-original.png` used nowhere**; OG image has no mark; favicon duplicates the tread path by hand | Render the real logo in header, footer, admin shell, favicon and OG; make the favicon derive from `TreadMark` rather than a copy | Snapshot the OG route and assert a mark is present | Low |
| **P2** | **₹2,499 hardcoded** in `product/[slug]/page.tsx:82` and `queries/cart.ts:96`, invisible to the literals gate | Remove both fallbacks — fail loudly instead. Extend the gate to flag numeric `*_paise` literals in `src/` outside `lib/` | The extended gate, which must fail on today's tree before it passes | Low |
| **P2** | **Add to bag: 822 ms** median; ~340 ms of it re-rendering the layout | Optimistic bag count with rollback (the pattern already exists in `cart-lines.tsx:86-91`); replace `revalidatePath("/", "layout")` with a targeted tag | Re-run the measurement; assert the count moves in <100 ms | Medium — optimistic state that disagrees with the server is worse than slow |
| — | **Rate limiting** | **Nothing to do.** Complete, and the RPC exists in production. Recommend documenting the deliberate fail-open in `docs/architecture.md` | — | — |

---

# Batches and sequence

## Batch A — the money and the blocked owner

1. **9E** the invisible discount (+ your rounding decision)
2. **9B** the cancel guard, then the owner cancels FV-2026-00623 and the stock returns
3. **9C** the refunded copy and the note split — built *with* 9B, not after
4. **G** the gate harness, applied to all 31 settings controls
5. **9A** the settings redesign, delivery panel first

## Batch B — before the shop can open

6. Order emails, customer and owner
7. Address editing with quote re-trigger
8. Production error reporting
9. The logo everywhere, including OG and favicon

## Batch C — coupons (9F)

10. Schema: per-customer limit, audience, `coupon_customers`, `coupon_redemptions`,
    the discount split and its CHECK constraint
11. Validation and atomic redemption inside `create_order_with_stock`; release on
    cancel
12. `/admin/coupons` — enable/disable, the scheduled window, per-customer limits,
    audience
13. The cart field goes live; `scripts/audit/coupons.ts` including the
    concurrency case

**Why here and not sooner.** Coupons are the only thing in this plan that is not
either a defect or a prerequisite for opening, and they sit on top of two things
that must be right first: **9E**, because a coupon discount would be swallowed by
exactly the same display bug that is currently swallowing the prepaid one, and
**Batch B's email**, because a discount the customer never sees confirmed in
writing is a support conversation waiting to happen.

**If you want a launch promotion, this moves up** — it can run immediately after
Batch A, ahead of B. It cannot run before A. Tell me and I will re-sequence.

## Batch D — running the shop

14. Health page · 15. Stuck-order detection · 16. Add-to-bag latency
17. Gate coverage extended to refunds, RTO, inventory, order transitions

## Batch E — deferred, and why

The homepage editor, image pipeline, per-destination ETD, courier selection,
pickup addresses and the focus-ring pass all stand as Phase 9's Batch D in the
brief. I would **defer all of it past this phase** and say so plainly: Batches A
and B are what stand between this shop and opening, and the homepage editor is a
week of work that changes nothing about whether an order can be taken, paid,
shipped or refunded correctly. It has been deferred every phase and it should be
deferred once more, on purpose, rather than half-built.

Adding coupons makes this more true, not less: 9F is real feature work with a
concurrency hazard in it, and it is the right place for the phase's remaining
appetite.

## Interactions, called out before anything is written

1. **9B × 9C** — fixing the cancel guard creates the `cancelled` + `refunded`
   state, which never reaches 9C's new refunded branch. Both copy paths must be
   written together. *(Detailed in 9C.)*
2. **9E × 9B** — both touch order money. 9E adds a column and reads; 9B changes a
   guard. They do not overlap in code, but both must be verified against the same
   invariant `advance + balance = grand_total`, and 9E's migration must default to
   0 so existing rows stay valid.
3. **9E × rounding** — if you choose option B, the discount changes value, so
   9E's tests must be written against the rounded figure. Deciding after the
   tests are written means rewriting them.
4. **9E × email** — the email's `discountTotal: 0` is fixed in Batch A but only
   *observable* in Batch B when email is switched on. Batch B must re-verify it
   rather than assume Batch A proved it.
5. **9A × G** — the redesign moves every control on the page. The gate tests must
   be written **before** the redesign, against the current labels, then updated
   with it — otherwise the redesign is unverified in exactly the way that caused
   this phase.
6. **9F × 9E** — the hard dependency. Coupons produce `otherDiscount`, which is
   the row currently rendering "—" while money is deducted. Building coupons
   before 9E ships a second invisible discount on the same broken path. 9E also
   adds `orders.prepaid_discount`; 9F adds `coupon_discount` and the CHECK that
   binds them to `discount_total`, so **9F's migration must land after 9E's** or
   the constraint has nothing to reference.
7. **9F × 9B** — both change order lifecycle behaviour. 9B rewrites the guard
   inside `cancel_order_with_restock`; 9F adds redemption release to the *same
   function*. Two edits to one function in one phase, so they must be written in
   a known order (9B first, it is P0) and the second must re-run the first's
   tests.
8. **9F × rounding** — the rounding rule chosen for 9E applies to percent coupons
   too, in the same helper. One rule, one place.

---

# What needs you

1. **The rounding decision** — option A, B, C or D above. My recommendation is B.
   Absent an answer I build A, because changing what a customer is charged is not
   a default I should pick.
2. **Contact details** — production holds phone `+91 91602 52643`, WhatsApp
   `+91 98450 22001`, email `hello@footvault.in`, address *Cuddapah 516360*. The
   address matches the real pickup PIN; the WhatsApp number is a Bengaluru series
   against a Cuddapah shop, and the two social URLs look like placeholders. Each
   needs a yes/no.
3. **An email provider** — four steps, already documented in
   `src/lib/email/index.ts:24-45`. Nothing reaches a customer until this is done.
4. **Real product photography** — still the largest blocker to opening.
5. **The flat-mode Pay-on-Delivery deposit** and the **wallet low-balance
   threshold** are both null in production by design, and both are decisions only
   you can make.
6. **Do you want the admin-facing "webhook" wording left alone?** I plan to leave
   it; it is correct for the owner and only the customer-facing copy is wrong.
7. **Confirm Batch E stays deferred.** I recommend it does.

### On coupons (9F) specifically

8. **Do coupons stack with the prepaid discount?** Recommend yes, both on the
   original goods total, sum capped at goods.
9. **Is a coupon released when an order is cancelled?** Recommend yes — otherwise
   an abandoned unpaid order silently burns the customer's code, because
   redemption happens before payment.
10. **Should a failed code say why?** Recommend yes ("expired", "not for you"),
    with a hard rate limit, rather than a uniform "invalid".
11. **Do coupons need to be ready for a launch promotion?** If so I move Batch C
    ahead of Batch B. It cannot move ahead of Batch A.
