# Phase 6 (revised) — Payment Model, Returns Policy, Admin Panel, Shiprocket

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
> **Single agent this phase — no sub-agents** (brief, standing rule 5).

**Goal:** Replace unsecured Cash-on-Delivery with a Razorpay-secured advance
("Pay on Delivery"), implement the store's real returns policy, finish the admin
panel, and wire the already-written Shiprocket fulfilment actions to a UI.

**Architecture:** One server-side totals function feeds every surface (cart,
product, checkout, order, email, invoice, Shiprocket). Delivery is priced from
live Shiprocket quotes — never hardcoded. COD becomes a Razorpay payment for the
*advance* only, reusing the entire Phase 5 payment machine unchanged; the balance
is carried on the order and handed to the courier.

**Tech Stack:** Next.js 16 App Router, React 19, Supabase/Postgres (RLS + RPC),
Razorpay, Shiprocket, Tailwind v4, Playwright audit scripts, tsx.

## Global Constraints

- **Delivery charges are always fetched from the Shiprocket API. Nothing is
  hardcoded.** Owner instruction, 2026-08-08, overruling the brief's flat-₹99 text.
- **Every threshold is an admin-panel setting** (free-delivery minimum, COD
  advance minimum, fallback amounts), stored in `site_settings`, edited at
  `/admin/settings`.
- **The COD surcharge stays**, and must appear as an explicit **named line item**
  ("COD handling"), never as a silent difference between two totals.
- Money is **integer paise** everywhere. `assertPaise` at every boundary.
- Advance must **never** be below Razorpay's `MIN_CHARGEABLE_PAISE` (100 paise).
- **`advance + balance == grand_total`**, asserted in tests, not eyeballed.
- **Shiprocket COD collectable == `balance_due_on_delivery`**, never `grand_total`.
- Every admin mutation independently verifies `is_admin()` **server-side, inside
  the action**. Middleware 404 is not authorization.
- Every stock mutation writes an `inventory_movements` row in the same transaction.
- Admin status changes reuse the Phase 5 state machine (compare-and-swap). No new
  writer to `orders.status`.
- No `any`, no `@ts-ignore`, no suppressed lint rules without a justifying comment.
- `no-unchecked-supabase-error` and the cached-shape gate stay green.

---

## Verified starting state (Preflight P1 / P2)

Established by query and by reading the code, not from the previous report — which
contradicts itself on P1.3.

| Check | Verdict |
|---|---|
| PR #5 merged | **Yes** — `d8d09bc`, and PR #6 (`996f0b2`) merged Phase 6 part 1 |
| Real test-card payment end to end | **Yes** — `FV-2026-00487`: `confirmed`/`paid`, one `payments` row `captured` 169800, 4 `payment_events`, exactly 1 `inventory_movements` row. The Razorpay path **is** verified. |
| `RAZORPAY_WEBHOOK_SECRET` in Vercel | **Unverified from here** — owner task, still listed outstanding |
| P2 debts (ledger, rate limit, abandon, suites, colourway, isSupabaseConfigured, rail) | **All landed** in `619baf7`; 372 `inventory_movements` rows exist |

**The totals drift, root-caused.** Three independent shipping computations:

1. `src/lib/queries/cart.ts:261` — flat from `site_settings.shipping` (₹199 / free ≥ ₹2,499)
2. `src/app/(storefront)/product/[slug]/page.tsx:81-82` — **hardcoded literals** 19900 / 249900
3. `src/lib/shipping/fee.ts` `deliveryFee()` — live Shiprocket rate, method-dependent;
   prepaid free ≥ `FREE_DELIVERY_THRESHOLD_PAISE` (**hardcoded** 249900), COD = forward + RTO, no free tier

Proof in production data: `FV-2026-00487` and `FV-2026-00488` share a ₹1,499
subtotal but carry shipping of **₹199 (razorpay)** vs **₹220 (cod)**. The cart
promises one number; checkout charges another. Both (2) and (3) violate the
owner's no-hardcoding rule.

**The COD landmine (confirmed in code).** `src/lib/orders/payment-state.ts:157`
computes `const expected = order.grand_total || recordedAmount` and refuses a
short capture with `illegal_transition`. Under the new model every COD capture is
*supposed* to be short, so this fires on the happy path and strands every order
until the sweep cancels it. Fix: compare against the advance, not the total.

**Also true today:** `FV-2026-00488` is `confirmed` + `unpaid` — a confirmed order
with no money against it. That is what Part 0 removes.

---

## File Structure

**New**
- `src/lib/shipping/settings.ts` — typed reader for every admin-tunable shipping/COD threshold
- `src/lib/orders/totals.ts` — **the** totals function. Single authority for every surface.
- `src/lib/payments/advance.ts` — the `cod_advance` rule (mode × minimum × floor)
- `src/app/admin/settings/*` — settings UI
- `src/app/admin/orders/[id]/*` — order detail + shipping panel + replacement
- `src/app/admin/products/*`, `categories/*`, `brands/*`, `customers/*`, `media/*`
- `src/components/account/replacement-window.tsx` — live countdown
- `supabase/migrations/*` — advance columns, settings seed, `delivered_at`, replacement reason

**Modified**
- `src/lib/shipping/fee.ts` — thresholds/fallbacks from settings, COD extra split out as its own field
- `src/lib/queries/cart.ts`, `src/app/(storefront)/product/[slug]/page.tsx` — call the shared function; delete hardcoded literals
- `src/lib/payments/cod.ts` — stops returning `kind:"none"`; initiates Razorpay for the advance
- `src/lib/orders/payment-state.ts` — expectation becomes the advance
- `src/lib/actions/checkout.ts` — COD starts `pending`, records the split
- `src/lib/shipping/fulfilment.ts` — COD collectable from the balance
- `docs/{admin-guide,architecture,database,rls-tests}.md`, `README.md`, `.env.example`

---

## Stage A — Part 0: the payment model

### Task A1: Admin-tunable shipping & COD settings

**Files:** Create `src/lib/shipping/settings.ts`; migration seeding `site_settings`.

**Interfaces — Produces:**
```ts
export type ShippingSettings = {
  freeAbovePaise: number;          // prepaid free-delivery threshold
  fallbackFeePaise: Record<PaymentMethod, number>;  // Shiprocket unreachable
  codEnabled: boolean;
  codAdvanceMode: "shipping_fee" | "fixed" | "greater_of";
  codAdvanceMinimumPaise: number;
  codAdvanceFixedPaise: number;
};
export async function shippingSettings(): Promise<ShippingSettings>;
```

- [ ] **Step 1:** Migration: extend `site_settings.shipping` with `cod_enabled`,
      `cod_advance_mode` (default `greater_of`), `cod_advance_minimum_paise`
      (default 9900), `cod_advance_fixed_paise`, and keep `free_above_paise`.
      Preserve existing `free_above_paise: 249900`.
- [ ] **Step 2:** Write `shippingSettings()` with a typed parse and defaults for a
      missing key. Cache per request.
- [ ] **Step 3:** Delete `FREE_DELIVERY_THRESHOLD_PAISE` and `FALLBACK_FEE_PAISE`
      constants from `fee.ts`; take both from settings.
- [ ] **Step 4:** Commit.

### Task A2: One totals function — kill the three-way drift

**Files:** Create `src/lib/orders/totals.ts`. Modify `fee.ts`, `queries/cart.ts`,
`product/[slug]/page.tsx`.

**Interfaces — Produces:**
```ts
export type OrderTotals = {
  subtotalPaise: number;
  shippingFeePaise: number;      // live Shiprocket, base leg
  codHandlingPaise: number;      // named line item. 0 for prepaid.
  grandTotalPaise: number;
  advancePaise: number;          // paid online now
  balanceDuePaise: number;       // collected by the courier
  basis: "free" | "shiprocket" | "fallback";
};
export async function computeOrderTotals(input: {
  method: PaymentMethod; subtotalPaise: number; units: number;
  postalCode: string; cartId?: string;
}): Promise<OrderTotals>;
```

- [ ] **Step 1:** Failing test in `scripts/audit/totals.ts`: for identical bags,
      prepaid and COD totals differ **only** by `codHandlingPaise`; and
      `advance + balance === grandTotal` for every mode; and advance ≥ 100 paise.
- [ ] **Step 2:** Run it — expect FAIL (module absent).
- [ ] **Step 3:** Split `deliveryFee()` so the COD return leg is returned as its
      own `codHandlingPaise` rather than folded into `feePaise`. Implement
      `computeOrderTotals` on top of it plus `advanceFor()` (A3).
- [ ] **Step 4:** Repoint `queries/cart.ts` and the product page at it. **Delete**
      the hardcoded 19900/249900 literals in both.
- [ ] **Step 5:** Run test — expect PASS. Commit.

### Task A3: The `cod_advance` rule

**Files:** Create `src/lib/payments/advance.ts`.

**Interfaces — Produces:**
```ts
export function advanceFor(input: {
  settings: ShippingSettings; deliveryTotalPaise: number; grandTotalPaise: number;
}): { advancePaise: number; balanceDuePaise: number };
```
Rules: `shipping_fee` → delivery total; `fixed` → configured amount;
`greater_of` → `max(delivery, minimum)`. Then clamp: never below
`MIN_CHARGEABLE_PAISE`, never above `grandTotal`. Balance = total − advance.

- [ ] **Step 1:** Table-driven test over all three modes incl. the zero-delivery
      case (must floor to the minimum, never 0) and delivery > total.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit.

### Task A4: Schema — record the split

**Files:** New migration; regenerate `src/lib/database.types.ts`.

- [ ] **Step 1:** `alter table orders add column advance_amount bigint not null
      default 0, add column balance_due_on_delivery bigint not null default 0,
      add column cod_handling_fee bigint not null default 0,
      add column cash_collected_at timestamptz, add column cash_collected_by uuid`.
- [ ] **Step 2:** `check (advance_amount + balance_due_on_delivery = grand_total)`
      — the invariant enforced by the database, not by hope. Backfill existing
      rows as `advance = grand_total, balance = 0` before adding the constraint.
- [ ] **Step 3:** Extend `create_order_with_stock` to accept and persist
      `p_advance_amount`, `p_balance_due`, `p_cod_handling_fee`.
- [ ] **Step 4:** Regenerate types, `npm run typecheck`. Commit.

### Task A5: The webhook expectation — defuse the landmine

**Files:** `src/lib/orders/payment-state.ts:153-173`.

- [ ] **Step 1:** Test: a capture of exactly `advance_amount` on a `partial_cod`
      order **confirms** it; a capture of `advance − 1` still refuses with
      `illegal_transition`; a prepaid order is unchanged (expects `grand_total`).
- [ ] **Step 2:** Run — FAIL. 
- [ ] **Step 3:** Change `expected` from `order.grand_total` to the amount owed
      *online*: `advance_amount` when it is non-zero, else `grand_total`. Do not
      weaken the guard — give it the right expectation.
- [ ] **Step 4:** PASS. Commit.

### Task A6: COD becomes a Razorpay advance

**Files:** `src/lib/payments/cod.ts`, `src/lib/actions/checkout.ts`,
`src/lib/payments/types.ts`.

- [ ] **Step 1:** Rename the method's customer-facing copy to **"Pay on Delivery"**
      with the note *"Pay ₹X now to confirm your order. Pay the rest in cash when
      it arrives."* — amount interpolated, never a bare "COD".
- [ ] **Step 2:** `codAdapter.initiate()` delegates to the Razorpay adapter for
      `advancePaise`. `verifyClientCallback`/`parseWebhook` delegate too — they
      currently fail closed, which would reject every real COD capture.
- [ ] **Step 3:** In `checkout.ts`, COD's `initialStatus` becomes `pending`
      (was `confirmed`), and the advance/balance/handling are passed to the RPC.
      Record the `payments` row with **`advancePaise`**, not `grandTotal`.
- [ ] **Step 4:** Gate on `codEnabled` and on `quote.codAvailable`. Commit.

### Task A7: Shiprocket collects the balance

**Files:** `src/lib/shipping/fulfilment.ts`; `scripts/audit/shipping.ts`.

- [ ] **Step 1:** Test asserting the adhoc payload's COD amount equals
      `balance_due_on_delivery` and **not** `grand_total`, for a bag where the two
      differ. This is the single most expensive available mistake.
- [ ] **Step 2:** Run — expect FAIL. **Step 3:** Fix. **Step 4:** PASS. Commit.

### Task A8: The three numbers, everywhere

**Files:** checkout payment step, `/order/[orderNumber]`, `/account/orders/[id]`,
`src/lib/email/order-confirmation.ts`, admin order row + detail.

- [ ] **Step 1:** Render, separately and always: `Pay now (shipping)`,
      `Pay on delivery`, `Order total` — plus `COD handling` as its own line
      wherever it is non-zero.
- [ ] **Step 2:** Admin order rows show payment type, advance paid, balance due.
- [ ] **Step 3:** axe + overflow pass on each surface. Commit.

### Task A9: Place Order must not be pressable before the rate is known

Owner-reported, 2026-08-08: the button is always enabled, so an order can be
submitted while the Shiprocket quote is still in flight — the customer presses
pay without having been shown what delivery costs.

**Files:** checkout payment step + its client component.

- [ ] **Step 1:** Disable the submit control until `computeOrderTotals` has
      resolved for the entered postcode, with a visible pending state
      ("Checking delivery to 516360…") rather than a dead button.
- [ ] **Step 2:** Re-disable whenever the postcode or payment method changes and
      a new quote is in flight — the previously shown number is no longer the one
      that would be charged.
- [ ] **Step 3:** Keep it enabled on the fail-soft path: when Shiprocket is
      unreachable the fallback fee *is* the answer, and the sale must not be
      blocked. Disabled means "we do not yet know", never "we could not reach it".
- [ ] **Step 4:** Keyboard + axe: the disabled state must be announced, not just
      greyed. Commit.

---

## Stage B — Part 0b: returns and replacements

- [ ] **B1 `delivered_at`:** capture on the shipment *and* the order when tracking
      reaches delivered (`src/lib/shipping/fulfilment.ts` track step). Migration
      adds `orders.delivered_at`.
- [ ] **B2 Live countdown:** `src/components/account/replacement-window.tsx` —
      *"Damaged item? Contact us before 4:30 PM tomorrow."* Once lapsed, swap for
      store contact details and no countdown. Window length from settings (24h).
- [ ] **B3 Contact route:** phone + WhatsApp from `site_settings.contact`, one tap,
      on the order page, confirmation page and policy page.
- [ ] **B4 Policy page:** rewrite `/page/returns` in plain language — no online
      returns, no refunds, replacement for shipment damage reported within 24h.
      Link from footer, product page, checkout payment step, confirmation email.
- [ ] **B5 Checkout disclosure:** *"Replacements for shipping damage only, reported
      within 24 hours. No refunds."* on the payment step, linking to the page.
- [ ] **B6 Contradicting copy:** audit `site_settings`, announcement bar, footer,
      meta descriptions. (`232c297` fixed four instances — verify none remain.)
- [ ] **B7 Admin replacement:** record on `/admin/orders/[id]` with reason + note,
      through the Phase 5 state machine. Add `replacement` to the movement reason
      enum. No customer-initiated path.

## Stage C — Part 1: the missing admin routes

Ordered by value. C1 first: it unlocks five Shiprocket actions that are written,
guarded, rate-limited and tested but have **no button in the UI**.

- [ ] **C1 `/admin/orders/[id]`** — detail, status changes (state machine), notes,
      invoice, replacement recording, and the shipping panel (create shipment →
      assign AWB → schedule pickup → documents → track), each idempotent and
      showing its current state.
- [ ] **C2 `/admin/settings`** — store info, contact, social, shipping thresholds,
      **COD advance rule**, policies. Depends on A1.
- [ ] **C3 `/admin/products`** + `new` + `[id]` — table with server-side
      pagination/search/sort/empty state; bulk activate/deactivate; images with
      drag-to-reorder, client-side compression, progress, alt text, one primary
      enforced; variants; **dimensions**; SEO.
- [ ] **C4 `/admin/categories`** (tree, drag to reorder/nest), **`/admin/brands`** (CRUD).
- [ ] **C5 `/admin/customers`** (list + order history), **`/admin/media`** (browser, upload, delete).
- [ ] **C6** Soft-delete verification the brief asks for **by name**: delete a
      product that has an order against it, confirm the order still renders.

## Stage D — Part 2: the customer-facing half

- [ ] **D1** AWB, courier, latest status on `/account/orders/[id]` and the
      confirmation page. Refresh on view, no background poller.
- [ ] **D2** Real delivery estimate on the checkout address step and the product
      page, from serviceability. Fails soft.
- [ ] **D3** COD gating by PIN — never offer COD on an unverified PIN; say why
      rather than silently hiding the option.

## Stage E — gates, docs, adversarial pass

- [ ] **E1** `npm run audit` green; report every number.
- [ ] **E2** Lighthouse mobile ≥90 ×4 on the Vercel preview for `/`, `/shop`,
      a product page, `/cart`, `/checkout`. Admin exempt from SEO only.
- [ ] **E3** axe clean on every new admin route and overlay; zero overflow; zero
      sub-44px targets; all routes × six widths + tablet portrait.
- [ ] **E4** `inventory_movements` reconciles against `stock_quantity` for every
      variant after the full run.
- [ ] **E5** Full keyboard path: add product → variants → image → publish →
      storefront → order with Pay on Delivery → fulfil.
- [ ] **E6** Docs: `admin-guide.md` (highest priority — non-technical owner, incl.
      the Shiprocket manual-test click-path), `architecture.md`, `database.md`,
      `rls-tests.md`, `README.md`, `.env.example`.
- [ ] **E7** `claudeExecutionReport/phase-6-admin-shipping.md` — rewrite for the
      revised brief.
- [ ] **E8** **Adversarial pass, cold**, its own step →
      `claudeExecutionReport/phase-6-security-review.md`. Must attempt: calling
      each admin action as a plain customer; escalation via crafted form payload;
      admin-only reads through PostgREST; mutating another customer's order; and
      **altering `advance_amount` / `balance_due_on_delivery` from the client**.

---

## Self-review against the brief

- **Part 0** → A1–A8. **Part 0b** → B1–B7. **Part 1** → C1–C6 (+ security in E8).
  **Part 2** → A7, B1, C1, D1–D3. **Preflight** → verified above; P2 already landed.
- **Deviation, owner-approved:** the brief's "flat ₹99, free over ₹1,999" is
  superseded — rates come from Shiprocket, thresholds from the admin panel, COD
  surcharge kept as a named line. Everything else in Part 0 stands.
- **Open owner items:** `RAZORPAY_WEBHOOK_SECRET` in Vercel Preview+Production;
  Shiprocket API user + pickup location; the one manual live-account test;
  the Indian consumer-law review flagged in the brief.
