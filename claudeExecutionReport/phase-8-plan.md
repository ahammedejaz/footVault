# Phase 8 — Stage 2: The Plan

**Date:** 2026-08-08 · **Status:** awaiting owner approval · **Code written:** none

---

## What changed since Stage 1

**`NEXT_PUBLIC_SITE_URL` is fixed and verified live.** Stage 1's P1-1 is closed:

```
/shop        rel="canonical" href="https://www.footvault.in/shop"
sitemap.xml  <loc>https://www.footvault.in/</loc>
homepage     og:image content="https://www.footvault.in/opengraph-image-…"
```

That unblocks lifting `noindex` (P2-1), which is now safe to do at any point after the canonical host is settled everywhere else.

**Two facts found while planning that change what these fixes can achieve:**

1. **All 35 products have `weight_grams`, `length_cm`, `breadth_cm` and `height_cm` set to NULL.** Every one. This means P0-c's code fix, shipped alone, changes **nothing** — every product already falls through to the 900 g default, so quotes and the fulfilment payload currently *agree* at 900 g × units. The bug is armed rather than firing: the moment you type a real weight into one product, fulfilment uses it and the quote does not. P0-c therefore needs a data task alongside the code, or it is a no-op.

2. **`prune-shipping-quotes` deletes `shipping_quotes` older than 6 hours** (pg_cron, `23 * * * *`). This directly caps the "recent quote" fallback proposed in P0-b — the recency window cannot exceed 6 hours without changing that job too.

---

## Decision 1 — Canonical host: **www**

`footvault.in` 308-redirects to `www.footvault.in`. **Recommendation: keep www.** It is already the live redirect direction, `NEXT_PUBLIC_SITE_URL` is already set to it and verified, and switching to apex would mean redoing the redirect, the env var, a redeploy and the verification for no user-visible gain. www also keeps DNS on a CNAME rather than requiring A/ALIAS records.

**The four places that must match. Only #1 is done.**

| # | Where | Exact value | Status |
|---|---|---|---|
| 1 | Vercel → `NEXT_PUBLIC_SITE_URL` (Production) | `https://www.footvault.in` | ✅ done, verified live |
| 2 | Google Cloud Console → OAuth 2.0 Client → **Authorized JavaScript origins** | `https://www.footvault.in` | ⬜ owner |
| 3 | Supabase → Authentication → URL Configuration → **Site URL** | `https://www.footvault.in` | ⬜ owner |
| 3b | Same screen → **Redirect URLs** allow-list | `https://www.footvault.in/**` (keep `http://localhost:3000/**` for dev) | ⬜ owner |
| 4 | Razorpay → Settings → Webhooks, **Live mode** → URL | `https://www.footvault.in/api/payments/razorpay/webhook` | ⬜ owner |

Two notes. Google's **Authorized redirect URIs** stays `https://ahumjhwqgmskjsitctcj.supabase.co/auth/v1/callback` — that is Supabase's own callback and the domain move does not touch it. And the Razorpay URL must be the **www** host directly: the apex answers 308, and a webhook POST should never depend on a redirect being followed.

The apex does not need to be in the OAuth allow-list — a visitor typing `footvault.in` is redirected to www before any sign-in begins, and `redirectTo` is built from the request origin at that point (`src/lib/actions/auth.ts:97`). Adding `https://footvault.in/**` to Supabase's redirect list anyway is harmless belt-and-braces.

---

## Decision 2 — Staging database (approved)

**Recommendation: a second Supabase *project*, not a Supabase *branch*.** Branches are tied to the production project's billing and lifecycle, and a branch that can be reset by a migration mistake is still sitting next to production in the same dashboard. A separate project gives a different URL, a different service-role key, and no path by which a mis-set env var reaches production.

**Setup (Stage 3, first task):**

1. Create Supabase project `footvault-staging`, same region (`ap-south-1`).
2. Apply all 72 migrations from `supabase/migrations/` in order.
3. Run `npm run seed` against it.
4. Add `.env.staging` (gitignored) with the staging URL, anon key and service-role key.
5. **Harden the fixtures against a repeat.** `scripts/audit/fixtures.ts` gains a guard that refuses to run when `NEXT_PUBLIC_SUPABASE_URL` matches the production project ref, regardless of what else is set. A comment is not enough here — the failure mode is writing orders into a live shop, and it has to be impossible rather than discouraged.
6. Point `AUDIT_BASE_URL` at a local server bound to `.env.staging`, and run the gates that Stage 1 could not: `audit:overflow`, `audit:a11y`, and the six-width sweep.

**Files:** `.env.example` (document the staging vars), `scripts/audit/fixtures.ts` (the guard), `README.md` and `docs/rls-tests.md` (how to run gates against staging), new `docs/staging.md`.

**Test:** the guard itself — assert `fixtures.ts` throws when handed the production URL, and that the whole `npm run audit` chain passes against staging.

**Risk:** low, and it is the enabling task for verifying everything else. The one real risk is drift — a staging database whose migrations fall behind production stops being evidence. Mitigate by applying migrations to staging first, then production, for the rest of this phase.

---

## Backups and point-in-time recovery on production today

Queried directly from the production database:

| Setting | Value |
|---|---|
| `archive_mode` | `on` |
| `archive_command` | `/usr/bin/admin-mgr wal-push %p >> /var/log/wal-g/wal-push.log 2>&1` |
| `wal_level` | `logical` |
| `max_wal_senders` / `max_replication_slots` | 5 / 5 |

**What this proves:** WAL archiving is active and shipping to WAL-G. That is the machinery PITR is built on, and it is running.

**What it does not prove, and I want to be precise:** Supabase runs `wal-push` on every project as part of its own backup process, so `archive_mode = on` does **not** establish that customer-facing PITR is enabled on this plan, nor what the retention window is. On Free-tier projects the entitlement is daily logical backups with roughly 7 days of retention and **no** PITR; PITR is a paid add-on. I cannot read the plan tier or the retention setting from the database or the MCP server.

**Owner action:** Supabase Dashboard → *Database → Backups*. Report (a) whether PITR is listed as enabled, (b) the retention window in days, (c) the timestamp of the most recent successful backup. If PITR is not enabled, enabling it is the single highest-value ₹/risk purchase in this phase — the shop now holds order records that cannot be reconstructed from anywhere else.

---

# P0-a · The live webhook — both halves

Stage 1 evidence: `GET /v1/webhooks` with live keys returns `{"count":0,"items":[]}`. And `release_abandoned_orders` excludes `payments.status in ('pending','captured','refunded')` — a Razorpay-backed order sits at `'created'` (`src/lib/actions/checkout.ts:722`), so it **is** swept.

## a1 · Create the live webhook, and make "silently wrong" detectable

**Fix — owner half.** Create the live-mode webhook (URL in Decision 1), subscribing to `payment.captured`, `payment.failed`, `order.paid`, and — added now so Stage 3's refund work has them ready — `refund.processed` and `refund.failed`. Copy the secret shown at creation into Vercel `RAZORPAY_WEBHOOK_SECRET` (Production), then redeploy.

**Fix — code half.** Two assertions, because the secret cannot be verified without a delivery:

- **Mode consistency.** A check that `RAZORPAY_KEY_ID`'s prefix agrees with the deployment: `rzp_live_` in Production, `rzp_test_` anywhere else. Mismatch is surfaced on the admin dashboard and logged at error on boot. This catches the inverse of today's bug — test keys reaching production.
- **Webhook liveness.** `select max(received_at) from payment_events where event_type <> 'client.callback'` gives the last time Razorpay talked to us server-to-server. Rendered on the admin dashboard as "Last webhook: 4 minutes ago" or, when null or older than the last paid order, a red state saying the webhook chain is not delivering. A shop whose webhook is broken should see it, not learn it from a customer.

**Files:** new `src/lib/payments/health.ts`; `src/lib/queries/admin/dashboard.ts`; `src/app/admin/page.tsx`; `.env.example`; `docs/admin-guide.md`.

**Test:** unit tests for the mode check across the four key/environment combinations; a query test asserting the liveness read ignores `client.callback` rows (otherwise a browser callback would mask a dead webhook — this is the subtle one and it is the whole point of the `<>` filter).

**Risk:** low. Read-only additions to an admin page. The one hazard is the liveness indicator crying wolf on a quiet shop with no orders at all; it is defined against *the last paid order*, not against wall-clock time, to avoid that.

## a2 · The sweep must ask Razorpay before cancelling

**The fix, and why it takes this shape.** The sweep runs inside Postgres via pg_cron and cannot make an HTTP call. To ask Razorpay anything, the decision has to move into application code. Splitting it by what actually needs asking:

- **Postgres keeps the safe subset.** `release_abandoned_orders` is narrowed to orders with **no `payments` row at all** — pure Pay-on-Delivery abandonment, where there is nothing to ask Razorpay about. The pg_cron job keeps running every 10 minutes against the narrowed function.
- **A new Vercel Cron route handles the rest.** `/api/cron/release-abandoned-orders` takes orders with a `payments` row at `'created'` past the cutoff and, for each, calls `GET /v1/orders/{provider_order_id}/payments`:
  - **A payment is `captured` or `authorized`** → do **not** cancel. Feed it through `recordAndApply` so the order confirms properly. This also retro-rescues any order stranded by the missing webhook.
  - **No payment** → cancel and restock, exactly as today.
  - **Razorpay unreachable, or any error** → do nothing this tick. Retry next tick. **Never cancel on an unknown** — that is the entire point of the change.
  - Bounded at 50 orders per tick so a backlog cannot turn into a rate-limit incident.

**Idempotency is already solved and I want to be explicit about why**: the reconciler goes through `recordAndApply`, the same seam the webhook uses, so the `payment_events_unique_per_provider unique (provider, event_id)` constraint makes a reconciled event and a later webhook delivery for the same payment collapse to one application. No new idempotency machinery is needed.

**Fix, third part.** `illegal_transition` — the code meaning *we kept a customer's money* — moves from `console.info` to `console.error` and onto the admin dashboard as a "needs a refund" queue (`orders where status='cancelled' and payment_status='paid'`). Stage 1 found that count is currently 0; it must never silently become 1.

**Files:** new `src/app/api/cron/release-abandoned-orders/route.ts`; new `vercel.json` (cron declaration); `src/lib/payments/razorpay.ts` (a `fetchOrderPayments` call); new migration narrowing `release_abandoned_orders`; `src/app/api/payments/razorpay/webhook/route.ts:235-236` (severity); `src/lib/queries/admin/dashboard.ts`; `src/app/admin/page.tsx`; `.env.example` (`CRON_SECRET`).

**Test:** against staging, with Razorpay test keys — (a) capture a payment, suppress the webhook, run the reconciler, assert `confirmed` and **not** cancelled; (b) no payment → cancelled and restocked, and `inventory_movements` still nets to zero; (c) Razorpay stubbed to 500 → order untouched, no cancellation; (d) run the reconciler twice → exactly one `payment_events` row and one application; (e) the route rejects a request without the `CRON_SECRET` bearer token.

**Risk — three, and the third is the one to watch.** The route is a new public endpoint, so it must authenticate on `CRON_SECRET` and 401 otherwise. It calls Razorpay per candidate, hence the 50-row bound. And **Vercel Cron frequency is plan-dependent** — Hobby allows one run per day, which would make this useless. The project sits under a team org so this is very likely fine, but it needs confirming before the design is committed; if frequency is capped, the fallback is to keep the narrowed pg_cron sweep and run reconciliation hourly, which is still strictly better than cancelling paid orders.

---

# P0-b · The fallback pricing in `fee.ts:152-162`

Stage 1 evidence: `₹150 = 34900 − 19900`, two settings constants subtracted; the real courier COD charge on that lane was `₹31.80`; the real delivery was `₹130` against `₹349` charged.

## What the fallback should do instead

Four defects sit in those eleven lines, and the fix has to address all four:

1. `codHandlingPaise` is invented by subtraction.
2. The result is shown to the customer as if it were a live rate (Stage 1 P1-3).
3. The **advance** is also derived from the fallback (`src/lib/orders/totals.ts:139-144` passes `fallbackFeePaise.cod` as *both* the forward and RTO leg), so the deposit protecting the shop is a guess too.
4. The guess was 2.7× the real number.

**The absolute rule, which alone kills the ₹150:** `codHandlingPaise` is **only ever** Shiprocket's actual `cod_charges`. When that number is unknown it is **0**. It is never derived, never inferred, never the difference between two other numbers.

**Then a layered fallback, in order:**

- **Layer 0 — retry once.** A single retry with short backoff in `serviceability.ts` before declaring the quote unavailable. Most outages of this kind are transient timeouts and this costs one round trip.
- **Layer 1 — the most recent live quote for the same PIN.** `shipping_quotes` already stores `postal_code`, `freight_paise`, `cod_fee_paise`, `cost_rto_paise` and `source`. Reuse the newest `source='shiprocket'` row for that PIN. Real courier numbers a few hours old beat a constant by an enormous margin. Recorded as `basis: "recent"`, distinct from both `shiprocket` and `fallback`.
  - **`cod_fee_paise` is not reused**, because it scales with declared value and this basket's value is different — so under Layer 1 the COD handling fee is 0, per the absolute rule. The freight and RTO legs *are* reused, which is what the advance needs.
  - **Constrained by `prune-shipping-quotes`, which deletes at 6 hours.** The recency window is therefore ≤ 6 h unless that job is also changed. I would leave the pruner alone and set the window to 6 h; a quote older than that on a rate card that changes is not obviously safer than refusing.
- **Layer 2 — refuse rather than guess.** If no live quote and no recent quote exists for that PIN: **withdraw Pay on Delivery** with a clear message, and offer prepaid at the prepaid fallback **explicitly labelled as an estimate**.

**My recommendation, and the reasoning, since the value is yours to set:** refuse COD, allow prepaid-as-estimate. A mispriced COD order is wrong twice — the customer is overcharged for delivery *and* the deposit no longer covers the round-trip risk the deposit exists to cover. A mispriced prepaid order is a small delivery-fee error on an order the shop has already been paid for in full. The asymmetry is large enough that they deserve different answers.

**New settings — mechanism built, values yours:** `fallback_behaviour` (`refuse_cod` | `refuse_all` | `estimate`, recommend `refuse_cod`) and `recent_quote_max_age_hours` (recommend 6, capped by the pruner).

**Files:** `src/lib/shipping/fee.ts`; `src/lib/shipping/quote-store.ts` (recent-quote lookup); `src/lib/shipping/settings.ts`; `src/lib/shipping/serviceability.ts` (retry); `src/lib/orders/totals.ts` (advance must not fall back to a fee); `src/lib/actions/checkout.ts` (refusal path); `src/components/checkout/checkout-flow.tsx` and `src/components/storefront/delivery-check.tsx` (surface `basis`); `src/lib/actions/admin/settings.ts` + `src/components/admin/settings/settings-forms.tsx`.

**Test:** extend `npm run audit:totals` — assert (a) no fallback path can produce a non-zero `codHandlingPaise`; (b) COD is withdrawn when there is neither a live nor a recent quote; (c) a recent quote is used, labelled `recent`, and its `cod_fee` is not reused; (d) the advance is never derived from `fallbackFeePaise`; (e) a `basis !== "shiprocket"` renders a visible estimate label at checkout — the assertion Stage 1 found missing.

**Risk:** refusing COD during a Shiprocket outage loses sales, and that is a real cost, not a hypothetical one. Layer 1 should cover most of it in practice because this shop's traffic concentrates on a few PINs, but the trade is yours to accept explicitly. Second risk: the `basis` enum gains a value, so anything switching on it needs updating — including `orders.quote_source`, whose column comment currently promises a fallback is never read as live.

---

# P0-c · The weight bug

Stage 1 evidence: `computeOrderTotals` calls `quoteFor` without `lines` (`src/lib/orders/totals.ts:69-75`), so `parcelWeightKg` is unreachable and every quote is 900 g × units.

**Correction to Stage 1, found while planning.** Because all 35 products have NULL weight, the quote and the fulfilment payload currently *agree* — both compute 900 g × units. Stage 1 said they "can disagree", which was conditionally true but understated the timing: they diverge the instant you save a real weight on any product. Fixing the code without populating the data is a no-op; populating the data without fixing the code introduces the divergence. **They must ship together.**

**Fix:**

1. Thread `lines` from the cart through `computeOrderTotals` into `quoteFor`. The cart already carries `weightGrams` per line (`src/lib/queries/cart.ts:205`, `src/lib/cart-types.ts:46`) and both callers hold the cart. Pass it explicitly rather than re-querying inside `computeOrderTotals` — it keeps the dependency visible and avoids a second round trip.
2. **Cache invalidation, which is the part that will bite if missed.** `shipping_quotes` is keyed `(cart_id, postal_code, payment_method)`. Existing rows were computed at 900 g and `readQuote` would happily serve them after the fix. Add a `quoted_weight_grams` column and treat a mismatch as a cache miss — deterministic, and it does not throw away still-valid quotes the way a blanket purge would.
3. **Verify `parcelWeightKg` accounts for volumetric weight.** Couriers bill the greater of actual and volumetric; if it only sums actual grams, heavy-but-small and light-but-bulky both price wrongly. To be confirmed against a live quote during implementation.
4. **Data task (owner):** enter weight and dimensions for the 35 products. Until then the default applies and nothing changes. A shoebox is typically 700–1,100 g; the current default of 900 g is a reasonable placeholder, which is why nothing has visibly broken.

**Files:** `src/lib/orders/totals.ts`; `src/lib/actions/checkout.ts`; `src/lib/actions/shipping-quote.ts`; `src/lib/shipping/quote-store.ts`; `src/lib/shipping/quote.ts`; new migration for `quoted_weight_grams`.

**Test:** `audit:totals` — a cart of 3 pairs at 1.2 kg quotes at 3.6 kg, not 2.7 kg; `parcelWeightKg` is provably reached; a cached quote at a different weight is a miss. Plus one real staging call comparing the weight sent to `courier/serviceability` against the weight sent to `orders/create/adhoc` for the same cart — they must be equal.

**Risk:** **prices change for every customer once weights are entered.** This is a correction, not a regression, but you should see a before/after on representative carts before it ships — I will produce that table. It also shifts free-shipping economics, since heavier carts now cost more to deliver against an unchanged ₹6,499 threshold.

---

# Remaining findings, by severity

## P0 (carried from Stage 1)

### P0-4 · Refunds — build the mechanics
**Fix:** Razorpay Refunds API against the stored `razorpay_payment_id`, partial refunds supported; `refund.processed` / `refund.failed` webhooks verified over the raw body with event ids stored; admin UI on the order page showing the computed amount and deduction breakdown before confirming; every refund written to `order_status_history` with amount, reason and authoriser; import of refunds issued directly in the Razorpay dashboard so manual action is not invisible. Never compute an amount on the client.
**Reuse, not rebuild — most of this already exists:** `public.refunds` with `razorpay_refund_id text unique` (the idempotency floor) and `refundFor()`/`stageFor()` (the complete policy table) are built and wired to nothing but `scripts/audit/totals.ts`. This is a wiring job, not a design job.
**Files:** `src/lib/payments/razorpay.ts` (refund create + webhook cases), `src/lib/payments/apply.ts`, new `src/lib/actions/admin/refunds.ts`, `src/components/admin/orders/order-actions.tsx`, `src/lib/orders/transition.ts`, new reconciliation route.
**Test:** a refund cannot exceed captured; a replayed `refund.processed` produces exactly one refund row; a double-clicked button issues one refund; the policy matrix cases already in `audit:totals` now exercise the live path.
**Risk:** highest-risk change in the phase — it moves real money outward. Ship behind an admin-only path, test exhaustively on staging with test keys, and require the deduction breakdown to be displayed before confirmation.

### P0-4b · Until refunds ship, say exactly what to refund
**Fix:** `src/lib/orders/transition.ts:118-126` returns a message naming the amount and the `pay_…` id, reading `advance_amount` and `payment_reference` off the row it already has. For a Pay-on-Delivery order the figure is the **advance**, not `grand_total` — the mistake the current wording invites.
**Files:** `src/lib/orders/transition.ts`. **Test:** assert the message contains both values for a COD and a prepaid order. **Risk:** none. This is a two-hour change and should ship in the first batch regardless of when refunds land.

## P1

### P1-3 · A guessed price shown as live
Folded into **P0-b** — same files, same test. Listed separately only because it also affects the product page (`delivery-check.tsx:93-109`), which P0-b's checkout work does not otherwise touch.

### P1-5 · Free delivery must apply to Pay on Delivery
**Fix:** drop `!isCod` from `fee.ts:113-117`. Keep the deposit: the advance already comes from `costForwardPaise`/`costRtoPaise`, which are carried in the `free` branch too, so zeroing delivery does **not** zero the deposit — the two are already separate fields and neither is derived from the other. On a free-delivery COD order the customer's total is goods only, split into deposit now plus remainder at the door. Add `waive_cod_fee_above_threshold` as a setting, defaulted to match the delivery behaviour; **the value is yours.**
**Files:** `src/lib/shipping/fee.ts`, `src/lib/shipping/settings.ts`, `src/components/checkout/totals.tsx` (labels), admin settings.
**Test:** the gate the brief asks for — free delivery applies identically to both methods, asserted; and `advance + balance = grand_total` still holds with free delivery on a COD order.
**Risk:** **this is the fix that changes revenue most directly.** Every COD order above ₹6,499 loses its delivery charge while the shop still pays the courier. That is the owner's stated intent and it is the right call for the promise, but it should be a conscious number.

### P1-6 · Surface Shiprocket's own error
**Fix:** add `last_error_message text`, `last_error_detail jsonb`, `last_error_at timestamptz` to `shipments`; stop discarding `outcome.detail` at `src/lib/actions/admin/shipping.ts:106` (and 131, 186, 234, 259); render the provider's message on the order page with what to do about it and a link to the Shiprocket panel; log every call with its outcome. Fix the stranded-claim bug too — `shiprocketPickupLocation()` throws after the claim row is inserted, and `releaseClaim()` only runs on the `!result.ok` branch, so the row sticks at `status='creating'` and the operator is told "Nothing has been changed", which is false.
**Files:** new migration; `src/lib/shipping/fulfilment.ts`; `src/lib/actions/admin/shipping.ts`; `src/components/admin/orders/shipping-panel.tsx`; `src/app/admin/orders/[id]/page.tsx`.
**Test:** a stubbed Shiprocket 422 persists the provider message and renders it; a throw in `shiprocketPickupLocation` leaves no `creating` row behind.
**Risk:** low. Note `scripts/audit/shipping.ts:43-45` unconditionally sets `SHIPROCKET_PICKUP_LOCATION="Primary"`, so that suite currently cannot detect this failure — the test must not live there, or that assignment must go.

### P1-7 · Wallet balance visibility
**Fix:** fetch the Shiprocket wallet balance, surface it on the admin dashboard with a low-balance warning threshold (value yours). An empty wallet stops all shipping and nothing warns today.
**Files:** `src/lib/shipping/client.ts`, `src/lib/queries/admin/dashboard.ts`, `src/app/admin/page.tsx`.
**Test:** stubbed balance renders; below-threshold renders the warning state.
**Risk:** low. Adds one Shiprocket call to the dashboard — cache it, and make sure a failure degrades to "unknown" rather than breaking the page.

### P1-8a · Order confirmation emails
**Fix:** a real adapter behind the existing interface, failing soft — a missing email must never fail an order. Four events: placed, captured, shipped with tracking, delivered. `getEmailAdapter()` currently returns the console adapter unconditionally with no env branch; that becomes a real selection. Provider setup is an owner task; exact steps below.
**Files:** `src/lib/email/index.ts`, new provider adapter, `src/lib/actions/checkout.ts`, `src/app/api/payments/razorpay/webhook/route.ts`, `src/lib/shipping/fulfilment.ts`, `.env.example`.
**Test:** each event calls the adapter once; an adapter throw does not fail the order; the console adapter is still selected when unconfigured.
**Risk:** low if fail-soft is genuinely enforced. The hazard is a synchronous send in the checkout path adding latency — send after the order is committed, never before.

### P1-8b · Production error reporting
**Fix:** wire `report-error.ts` to a real sink and add Next's `onRequestError` via `instrumentation.ts`, which is the hook that catches server errors today reaching nothing. `app/global-error.tsx` currently logs nothing at all.
**Files:** new `instrumentation.ts`, `src/lib/report-error.ts`, `src/app/global-error.tsx`, `.env.example`.
**Test:** a thrown server error produces a sink call; the boundary still renders.
**Risk:** low. Choice of provider is an owner decision (Sentry is the default recommendation).

### P1-9 · Quality gates — resolved by Decision 2
Covered above. The gates get run against staging and the numbers reported in the Stage 3 report.

## P2

| # | Fix | Files | Test | Risk |
|---|---|---|---|---|
| **P2-1** noindex | Set `SITE_INDEXABLE=true` in Production, redeploy. **Now safe** — canonicals are correct as of today's deploy. | Vercel env only | `robots.txt` allows; `x-robots-tag` gone; Lighthouse SEO ≥ 90 | Low. Irreversible in the sense that Google will crawl; everything it will read is now correct. |
| **P2-2** Lighthouse `/shop` 88, product 85 | LCP-bound. Image priority/sizes on the first rail, and check the product gallery's largest paint. | `src/components/storefront/product-listing.tsx`, `product-gallery.tsx`, `rail.tsx` | Re-run `audit:lighthouse` against www; both ≥ 90 | Low, but measure on the live domain — localhost numbers mislead. |
| **P2-3** Shiprocket latch fails open | Change the bare `return` at `token.ts:163` to a throw, matching the documented contract; build the missing `/admin/settings` control that calls the already-written `clearShiprocketLockout`; move `inFlight` de-dup behind the DB latch so cold instances cannot each spend a login. | `src/lib/shipping/token.ts`, admin settings | Simulate an `integration_tokens` read failure → no login attempted; the clear button clears | Medium — failing closed means a Supabase blip stops shipping quotes. That is the correct direction and it is what the comment already promises, but it is a behaviour change. |
| **P2-4** flat mode recorded as live | `fee.ts:137` must record `basis: "flat"`, not `"shiprocket"`. Needs the enum widened alongside P0-b's `"recent"`. | `src/lib/shipping/fee.ts`, migration for the `quote_source` comment | Assert a flat-mode order stores `quote_source='flat'` | Low. **Interacts with P0-b** — same enum, same file, sequence them. |
| **P2-5** checkout copy contradicts the model | `totals.tsx:78` calls the PoD fee a return-journey charge; since Phase 7 that is the advance. Rewrite both labels. | `src/components/checkout/totals.tsx` | `audit:literals` extension asserting no currency literal; visual check | None. |
| **P2-6** `payment_methods` is dead | Either wire it or delete it. **Recommend delete** — `shipping.cod_enabled` is the live switch and two settings that look like the same thing is how the wrong one gets edited. Then build the brief's `cod_enabled` toggle properly: checkout hides the method, the API refuses it, the customer sees a clear message. | migration; `src/lib/orders/totals.ts`; `src/lib/actions/checkout.ts`; checkout UI | `cod_enabled: false` honoured at UI **and** API, both asserted | Low. Deleting a settings key is irreversible without a migration — confirm before dropping. |

Also in P2, from the brief and not yet built: **admin settings reorganisation** (#9), **the homepage editor** (#10), **order page clarity — "Deposit paid"** (#11), and **the search-bar focus ring** (#8, as part of a site-wide focus pass, keeping focus visible). These are UI work with no money risk; they are sequenced last and are the first candidates to drop if the phase runs long.

## P3

`audit:literals` cannot see `src/lib` (widen its scope and its regex to catch bare paise integers); the inert ₹2,499 defaults in `cart.ts:96` and the product page; dead code (`parcelWeightKg` becomes live under P0-c, `chargeableFee` should be deleted); dead settings keys (`cod_advance_mode`, `cod_advance_minimum_paise`, `cod_advance_fixed_paise`); `shipping_quotes.advance_paise` never written; the `orders.shipping_fee` / `shipping_quotes.shipping_fee_paise` naming collision; Supabase advisors (enable leaked-password protection — one dashboard toggle).

Carried debt from the brief, all deferred: address book at checkout, `sharp` image pipeline, RTO admin flow, courier selection UI, pickup addresses from the API, per-destination delivery estimates.

---

# Where fixes interact

The brief asks for these explicitly, and this codebase has already produced one case where fixing one bug would have activated another.

1. **P0-c ↔ the product data.** The weight fix is inert until weights are entered, and entering weights without the fix creates a quote/declare divergence that does not exist today. **Ship together.** This is the one that would have bitten.
2. **P0-c → P0-b.** P0-b's Layer 1 replays recent quotes. If those quotes were computed at 900 g, the fallback faithfully reproduces the wrong weight. **P0-c must land first**, and `shipping_quotes` written before it should be treated as stale for Layer 1 purposes.
3. **P0-b ↔ P2-4.** Both widen the `basis` / `quote_source` enum (`"recent"`, `"flat"`) and both edit `fee.ts`. One writer. Sequence, do not parallelise.
4. **P0-b ↔ P1-5.** Both restructure `fee.ts`'s branch order — the free branch currently sits above the fallback branch, and P1-5 changes which orders reach it. Same file, sequence them.
5. **P0-a2 ↔ P0-4.** The reconciler finds orders that were charged and cancelled; the refund mechanism is what resolves them. Reconciler first, so the refund queue has real input rather than being built blind.
6. **P1-5 ↔ P0-b.** Free delivery zeroes the delivery charge but must not zero the deposit. The advance already reads `costForwardPaise`/`costRtoPaise`, carried in every branch — but P0-b changes what those hold under fallback. Test the combination explicitly: free delivery **and** fallback pricing on a COD order.
7. **P2-1 ↔ everything customer-facing.** Lifting `noindex` makes the current state of the shop permanent in Google's cache. It is now safe with respect to canonicals; it is worth doing after the pricing fixes, so the first crawl sees correct prices.
8. **Decision 2 ↔ every test above.** Nearly every "test that proves it" runs against staging. Staging is the first task for that reason.

---

# Sequence

**Batch 1 — stop the bleeding (nothing here changes a price).**
1. Staging database + fixtures guard *(Decision 2 — enables everything else's tests)*
2. P0-a1 webhook creation + mode/liveness assertions *(owner + code)*
3. P0-a2 reconciling sweep + `illegal_transition` severity
4. P0-4b the "here is exactly what to refund" message *(hours, ships now)*

Rationale: the shop is open and taking orders. Every hour that passes with no live webhook is an hour in which the first real customer can be charged and cancelled. Nothing in Batch 1 alters a customer-facing number, so it can ship fast and be verified narrowly.

**Batch 2 — the money model.**
5. P0-c weight fix + `quoted_weight_grams` + owner enters product weights
6. P0-b fallback pricing + `basis: "recent"` + surfacing `live` at checkout and on the product page
7. P2-4 flat-mode basis *(same enum, immediately after)*
8. P1-5 free delivery for Pay on Delivery + `waive_cod_fee_above_threshold`

Rationale: strict dependency order per the interaction map — weights before recent-quote reuse, enum changes together, free-delivery last because it sits on top of the branch structure the other two rewrite. I will produce a before/after price table across representative carts before this batch ships.

**Batch 3 — refunds.**
9. P0-4 refund mechanics, webhooks, admin UI, dashboard reconciliation

Rationale: highest risk, and it wants Batch 1's reconciler in place so its queue has real input. Isolated in its own batch so it can be reviewed on its own.

**Batch 4 — operations.**
10. P1-6 Shiprocket errors + stranded claim · 11. P1-7 wallet · 12. P1-8a email · 13. P1-8b error reporting · 14. P2-3 latch · 15. P2-6 `cod_enabled`
16. The health page pulling together webhook liveness, Shiprocket auth, wallet, stuck orders and stock drift
17. Quality gates run against staging; Lighthouse re-run on www; P2-2 if needed
18. P2-1 lift `noindex`

**Batch 5 — interface, if the phase has room.**
19. Focus-ring pass · 20. Admin settings reorganisation · 21. Order page clarity · 22. Homepage editor

**Documentation runs with each batch**, not at the end: `README.md`, `.env.example`, `docs/architecture.md`, `docs/database.md`, `docs/admin-guide.md` (including the "first live order" runbook), `docs/rls-tests.md`.

---

# What I would defer

- **The homepage editor (brief #10).** It is the largest single build in the brief, it carries no money risk, and it has been deferred every phase for that reason. I would rather ship batches 1–4 verified than half-build this.
- **All P3 carried debt** — address book, `sharp` pipeline, RTO admin flow, courier selection UI, pickup addresses, per-destination estimates.
- **Legal and policy pages.** Worth doing, but the brief itself flags that the no-refunds position should be checked with someone who knows Indian consumer law. I can build the pages; I should not draft the policy.
- **Coupons.** `discountPaise` is threaded through `computeOrderTotals` and no caller passes it. Out of scope here.

---

# What needs you

**Blocking Batch 1:**
1. Create the live Razorpay webhook and put its secret in Vercel *(Decision 1, row 4)*.
2. Confirm the Vercel plan allows sub-daily cron. If not, I use the hourly fallback described in P0-a2.
3. Google OAuth origins, Supabase Site URL and redirect allow-list *(Decision 1, rows 2–3b)*.
4. Report the Supabase backup/PITR state from the dashboard, and enable PITR if it is not on.

**Blocking Batch 2:**
5. Enter weight and dimensions for the 35 products, or approve shipping the code with the 900 g default still applying to all of them.
6. Decide `fallback_behaviour` — my recommendation is `refuse_cod`, with prepaid allowed as a labelled estimate.
7. Accept that free delivery on Pay on Delivery above ₹6,499 means the shop absorbs the courier cost on those orders.
8. Decide `waive_cod_fee_above_threshold`.

**Blocking Batch 4:**
9. Choose an email provider (Resend is the usual fit for this stack) and an error sink (Sentry).
10. Set the Shiprocket low-balance warning threshold.

---

# Risks in this plan itself

- **Batch 2 changes prices customers see.** Every fix in it is a correction, but corrections are still changes, and the shop is live while they land. I will produce the before/after table first.
- **P0-b's refusal path can lose sales** during a Shiprocket outage. That is a deliberate trade of revenue for correctness and it needs your explicit agreement, not my inference.
- **P0-a2 introduces a new public endpoint.** It authenticates on `CRON_SECRET` and 401s otherwise, but it is new attack surface on a shop taking payments.
- **P0-4 moves money outward.** It is the one change in this phase that can, if wrong, send funds that should not be sent. It gets its own batch and its own review.
- **Everything is verified against staging, which is not production.** Staging will have the same schema and seeded data, not the same data. The gap is real; the alternative was writing test orders into a live shop.
- **Sixteen numbered items across five batches is a lot for one phase.** If it runs long, Batch 5 drops first, then P1-7 and P2-3. Batches 1–3 are the phase.

---

**No code has been written. Awaiting approval.**
