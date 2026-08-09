# Phase 8 — Stage 1: The Audit

**Date:** 2026-08-08 · **Scope:** read-only · **Code changed:** none

---

## The headline

**No real customer money has ever moved through this shop, and the mechanism that would take it safely is not connected.**

Both halves of that sentence matter.

The reassuring half: the live Razorpay account has **zero payments, zero settlements and zero refunds**, ever. The two orders the database marks `paid` reference payment ids that **do not exist in live mode**. Nobody is out of pocket, no refund is owed today, and there is no money to reconcile.

The alarming half: **there is no live-mode webhook at all.** The shop is open, the keys are live, and the confirmation path that survives a customer closing their tab does not exist. The first real order is where this fires.

The chain, precisely:

1. Customer pays. Razorpay captures the money.
2. Confirmation depends **entirely** on the browser calling back (`src/lib/actions/payment.ts:125`), because no webhook is registered to do it server-to-server.
3. Customer's browser dies, or they close the tab, or their phone drops the network.
4. Thirty minutes later `release_abandoned_orders` cancels the order and restocks it. Its exclusion list is `payments.status in ('pending','captured','refunded')`; a freshly-created Razorpay order sits at `'created'` (`src/lib/actions/checkout.ts:722`), so it **is** swept.
5. If the money is later reconciled, `applyPaymentOutcome` writes `payment_status = 'paid'` onto a `cancelled` order, records *"The customer has been charged and a refund is owed"* — and the route logs that at **`console.info`** and answers 200 (`src/app/api/payments/razorpay/webhook/route.ts:236`).
6. Nothing refunds it. Nothing alerts. There is no refund code in this codebase at all.

Net: a real customer is charged, their order is cancelled, their shoes are sold to somebody else, and the only trace is an info-level log line in Vercel's runtime logs, which nothing watches.

---

## Method, and what I could not verify

Every finding below carries evidence — an API response, a query result, or a `file:line`. Where I could not establish something, I say so rather than guessing.

**Verified live:** Razorpay live API (webhooks, payments, orders, settlements, refunds), the live domain's HTTP responses, the production database, Supabase auth configuration, Lighthouse on `www.footvault.in`.

**Could not verify, and why:**
- **Vercel env *values*.** `vercel env pull` returns `[SENSITIVE]` for every variable marked sensitive — all ten. I established what each *must* be by observing production behaviour instead, which is noted per finding.
- **Supabase's redirect allow-list.** Not exposed by any API I have. The `/auth/v1/authorize` endpoint echoes any `redirect_to` back — I confirmed this by passing `evil.example.com` as a control and getting the same 302 — so that probe proves nothing either way. Owner action below.
- **Backup / point-in-time recovery.** Not queryable from the database or the MCP server. Owner action below.
- **`audit:overflow`, `audit:a11y` and the six-width sweep — deliberately not run.** See P1-9. Running them would have written test orders into the production database, which Stage 1 forbids.

---

# P0 — armed, not yet fired

The brief defines P0 as *losing money now*. Strictly, nothing is: no real money has moved. Every item here is loaded and fires on the first real order, so I have graded them P0 rather than P1.

### P0-1 · There is no live-mode Razorpay webhook

**Evidence** — `GET https://api.razorpay.com/v1/webhooks` with the live key pair:

```json
{"entity":"collection","count":0,"items":[]}
```
`HTTP 200`

Not an auth failure, not a 404 — a successful call reporting that this account has **no webhooks registered in live mode**. Razorpay's webhook configuration is per-mode, exactly as the brief suspected.

That a webhook once worked in *test* mode is visible in `payment_events`: three server-to-server events (`payment.authorized`, `payment.captured`, `order.paid`) landed within 0.5 s of each other for `pay_TNEWQBLIJ4gAGN`. That webhook does not exist in the live world.

**Consequence:** the browser callback is the only path to `confirmed`. Confirmed by reading it end to end — `src/lib/orders/payment-state.ts:200-213` sets `paymentStatus = "paid"` and `status = "confirmed"` from the callback alone. Worse, `src/lib/actions/payment.ts:161-174` swallows an apply failure and still returns `ok: true` to the customer, on the written assumption that *"the webhook will confirm the order independently"* — which is currently false.

### P0-2 · `RAZORPAY_WEBHOOK_SECRET` cannot be the right secret

`RAZORPAY_WEBHOOK_SECRET` **is** set in Vercel Production (created 16 h ago). But since no live webhook exists, the only secret it can hold is the one from the **test-mode** webhook. When the live webhook is created it gets its own secret, and every live delivery will fail signature verification until Vercel is updated and redeployed.

The failure is silent and correct: `src/lib/payments/razorpay.ts:660` rejects, the route answers 400 (`route.ts:147-151`), and the rejection reason is deliberately not disclosed. From the outside it looks like nothing is happening.

Locally, `.env.local` has `RAZORPAY_WEBHOOK_SECRET=` with a **zero-length value**, so every webhook is rejected in development too.

### P0-3 · Money kept on a swept-then-captured order is logged at `console.info`

`src/lib/orders/payment-state.ts:214-222` correctly detects the case and writes the sentence *"The customer has been charged and a refund is owed."* into `order_status_history`. Then `src/app/api/payments/razorpay/webhook/route.ts:235-236` branches severity on `not_found` versus everything else — so `illegal_transition`, the code that means *we kept a customer's money*, is the quiet branch.

No admin screen, query or job reads `payment_events.result` or looks for `status='cancelled' AND payment_status='paid'`. I checked: that count is currently 0, and nothing would surface it if it were not.

### P0-4 · No refund mechanism exists

Razorpay's Refunds API is never called. The only two paths ever passed to `razorpayRequest` are `/orders` and `GET /payments/{id}`. `refund.processed` / `refund.failed` fall through the webhook switch to `"unhandled"` (`src/lib/payments/razorpay.ts:761-770`).

What *does* exist, fully built and wired to nothing:
- `public.refunds` — including `razorpay_refund_id text unique`, the idempotency floor (`supabase/migrations/20260808140300_refunds_table.sql:15`). **0 rows.**
- `refundFor()` / `stageFor()` — the complete policy decision table (`src/lib/orders/refund-policy.ts:76,252`). Its only importer is `scripts/audit/totals.ts:34`.
- `payment_status` and `payment_txn_status` both carry a `'refunded'` value no code ever writes.

**Today, cancelling a paid order** returns `already_paid` and shows the admin, verbatim:

> "This order has been paid, so cancelling it would mean refunding it. Refunds are not built yet — refund in Razorpay first, then cancel."

It names **neither the amount nor the payment id** (`src/lib/orders/transition.ts:118-126`) — while reading a row that holds both `advance_amount` and `payment_reference`. For a Pay-on-Delivery order the correct figure is the *advance*, not `grand_total`, which is precisely the mistake that message invites.

**Nothing reconciles Razorpay against the orders table.** A refund issued by hand in the Razorpay dashboard would never be learned about. (The only `reconcile*` in the codebase is `reconcile_inventory()`, which is about stock.)

---

# P1 — will lose money, or is misleading customers now

### P1-1 · `NEXT_PUBLIC_SITE_URL` is still the vercel.app host

Set in Vercel Production, but to the old value. The live site proves it:

```
sitemap.xml  <loc>https://foot-vault.vercel.app/</loc>
/shop        rel="canonical" href="https://foot-vault.vercel.app/shop"
homepage     og:image content="https://foot-vault.vercel.app/opengraph-image-…"
```

Served *from* `www.footvault.in`, every URL points at the old host. It drives the sitemap, robots' sitemap link, product canonicals and OG images, breadcrumb JSON-LD, and order links in emails (`src/lib/email/order-confirmation.ts:98`). Once indexing is enabled, canonical tags actively tell Google the real page lives on vercel.app.

Note the domain shape: **`footvault.in` 308-redirects to `www.footvault.in`**. The www host is canonical, and that is the value to set.

OAuth is *not* affected — `redirectTo` is built from the request origin (`src/lib/actions/auth.ts:97`), falling back to `SITE_URL` only when the host header is missing (`auth.ts:42`).

### P1-2 · The ₹150 "pay-on-delivery fee" is not a fee — it is two constants subtracted

**This is the answer to the brief's question about FV-2026-00571.**

| | Paise | Rupees | Where from |
|---|---|---|---|
| Goods | 149900 | ₹1,499 | cart |
| `shipping_fee` | 34900 | **₹349** | `site_settings.shipping.fallback_fee_paise.cod` |
| — displayed as delivery | 19900 | **₹199** | `fallback_fee_paise.razorpay` |
| — displayed as PoD fee | 15000 | **₹150** | `34900 − 19900` |
| `grand_total` | 184800 | ₹1,848 | |
| `advance_amount` | 34900 | ₹349 | |
| `balance_due_on_delivery` | 149900 | ₹1,499 | |
| `quote_source` | `NULL` | | **no live quote was stored** |

The formula, `src/lib/shipping/fee.ts:152-162`:

```ts
if (forward === null) {
  const prepaid = settings.fallbackFeePaise.razorpay;      // 19_900
  const total   = isCod ? settings.fallbackFeePaise.cod    // 34_900
                        : prepaid;
  return { shippingFeePaise: Math.min(prepaid, total),     // 19_900 → "₹199 delivery"
           codHandlingPaise: Math.max(0, total - prepaid), // 15_000 → "₹150 PoD fee"
           feePaise: total, basis: "fallback" };
}
```

Shiprocket did not answer, so the fallback pair was used, and `codHandlingPaise` is the **arithmetic residue of two unrelated settings numbers**. It is not a cash-handling charge, not a return-leg charge, and not related to anything the courier does.

**Proof it was the fallback and not a live quote** — FV-2026-00572, a **₹6,999** order placed 16 minutes later, carries the *identical* ₹349 / ₹150. The courier's real `cod_charges` provably scale with declared value on this account (from `shipping_quotes`, same day): ₹769 basket → ₹31.80, ₹2,796 → ₹50.33, ₹3,146 → ₹56.63, ₹9,999 → ₹179.98. Two baskets 4.7× apart cannot produce identical courier fees. These are constants.

**What the live rate for that lane actually was**, captured in `shipping_quotes` for PIN 516002 the same day: freight **₹94.56**, RTO **₹92.20**, COD fee **₹31.80**.

So for FV-2026-00571 the correct figures were:
- delivery ≈ `roundUp₹10(94.56 + 31.80)` = **₹130**, not ₹349 — **overcharged ≈ ₹219**
- round-trip advance ≈ 94.56 + 92.20 = **₹187**, matching the brief's ₹190–230 estimate
- the ₹150 "cash-handling fee" is **~4.7× the courier's actual ₹31.80** on that lane

The customer was not a real customer — `pay_TNEWQBLIJ4gAGN` returns *"The id provided does not exist"* against live keys, so this was the owner's own test order. **But the mechanism is live and will do exactly this to a real customer any time Shiprocket does not answer.**

Two footnotes for accuracy: the ₹349 advance equals the delivery charge because this order predates Phase 7's advance rule — orders from 15:47 onward correctly use `forward + RTO` (FV-2026-00595's advance of ₹187 is exactly `94.56 + 92.20` rounded). And the advance would today be capped at ₹500 by `cod_advance_maximum_paise`, changing the split but not the overcharge.

### P1-3 · A guessed price is shown to the customer as if it were live

The distinction is computed, persisted and logged — and then dropped in the browser.

- `basis` is written to `orders.quote_source` and `shipping_quotes.source` ✓
- `quote-store.ts:102-108` logs `console.warn("[shipping] quote served from the FALLBACK, not a live rate")` ✓
- `shipping-quote.ts:115` returns `live: totals.basis === "shiprocket"` ✓
- **`src/components/checkout/checkout-flow.tsx:258-268` destructures the result and omits `live`.** The view type at `:110-120` has no such field.

So a guessed ₹349 renders pixel-identically to a live courier rate, and the delivery estimate prints with no caveat. Same on the product page: `checkDeliveryTo` returns `live` (`delivery-check.ts:90`) and `delivery-check.tsx:93-109` never reads it — it says *"Usually 3–5 working days"* whether Shiprocket answered or timed out.

The design intent is stated at `quote-store.ts:91-100`: *"a fallback must never be presented silently as a live rate."* It holds in the database and in the log, and fails in the one place the customer can see.

### P1-4 · Every quote in the shop is priced at 900 g × units

`computeOrderTotals` calls `quoteFor` **without** `lines` (`src/lib/orders/totals.ts:69-75` — I read this directly). So `quote-store.ts:74-75` always takes the else branch:

```ts
weightKg: input.lines?.length
  ? parcelWeightKg(input.lines, defaults)
  : Math.max(0.1, (defaults.weight_grams * input.units) / 1000),   // ← always this
```

`parcelWeightKg()` has exactly one call site and it is unreachable. The cart already loads the real value (`src/lib/queries/cart.ts:205`) and nothing consumes it. The admin product form collects weight and dimensions (`product-form.tsx:446-507`) and they reach the **fulfilment** payload (`fulfilment.ts:151-158`) but never the **quote**.

Consequence: on an account with per-0.5 kg rate bands, the shop under-recovers on every heavy order and over-quotes every light one, and the freight it quoted can disagree with the freight it declared.

### P1-5 · Free delivery applies to prepaid only

`src/lib/shipping/fee.ts:113-117`:

```ts
if (!isCod && settings.freeAbovePaise > 0 && subtotalPaise >= settings.freeAbovePaise) {
```

Confirmed in live data. Two quotes for the same ₹9,999 basket to the same PIN, 11 seconds apart:

| Method | `fee_paise` | `source` |
|---|---|---|
| razorpay | **0** | `free` |
| cod | **28000** (₹280) | `shiprocket` |

The owner is right, and the brief's fix is the correct one. Note the mechanism already supports it cleanly: the advance is computed from `costForwardPaise`/`costRtoPaise`, which are carried in **every** branch including `free` — so zeroing the delivery charge does **not** zero the deposit. The two are already separate fields.

### P1-6 · Shiprocket's own error message is captured, carried two layers, then discarded

It is captured correctly at the transport layer (`client.ts:207-221`) and survives fulfilment (`fulfilment.ts:223-233`). It dies at the Server Action boundary — `src/lib/actions/admin/shipping.ts:106`:

```ts
if (!outcome.ok) return { ok: false, reason: "error", message: outcome.message };
```

`outcome.detail` — Shiprocket's raw body — is **never read by any caller**. And there is nowhere to put it: `shipments` has `raw_order`, `raw_awb`, `raw_pickup`, `raw_tracking`, and every one is written **only on the success path**. There is no `last_error` column.

**Live proof** — the one `shipments` row, for FV-2026-00571:

```
shiprocket_order_id 1504658793 · shipment_id 1500879834
awb_code NULL · courier_name NULL · status 'created' · raw_awb NULL
```

That is the owner's AWB failure. The reason it failed was shown in one toast and is now unrecoverable — which is exactly why the owner had to call the API themselves.

A second path is worse: `shiprocketPickupLocation()` **throws** when unset (`config.ts:107-114`), after the claim row is inserted. The throw unwinds to `guard.ts:149-157`, which replaces the specific message with *"That did not save. Nothing has been changed"* — and that is false: `releaseClaim()` runs only on the `!result.ok` branch, so the row is stranded at `status='creating'` permanently.

### P1-7 · Wallet balance is invisible

`grep -rni "wallet"` across `src/`, `scripts/` and `supabase/` returns one hit, and it is Razorpay copy. No Shiprocket balance endpoint is called, stored or surfaced. An empty wallet stops all shipping and would surface as an untyped provider error whose message is discarded per P1-6.

### P1-8 · No order emails, and no production error reporting

**Email:** `getEmailAdapter()` returns the console adapter **unconditionally** (`src/lib/email/index.ts:41-43`) — no env branch. `sendOrderConfirmation` has exactly one call site (`checkout.ts:819`). Payment captured, shipped and delivered have **no email path at all**. A customer who pays online receives nothing from this system, ever; the courier's own SMS is currently their only notification.

**Errors:** `report-error.ts` is a single `console.error`. `app/error.tsx` calls it from a `useEffect` — i.e. in the *customer's* browser. `app/global-error.tsx` logs nothing at all. There is no `instrumentation.ts`, no `onRequestError`, and no Sentry/Axiom/OTel dependency. A server error on the live site reaches Vercel's runtime logs and stops there, unaggregated and unalerted.

### P1-9 · The quality gates cannot be run without writing to the production database

`scripts/audit/fixtures.ts` is not read-only: it signs up real accounts through the real auth path (`:97`), drives the real checkout form over HTTP (`:161`, `:279`), and calls `admin.rpc("create_order_with_stock", …)` and `admin.from("addresses").insert(…)` with the **service-role key** (`:228`, `:262`). `audit:overflow` and `audit:a11y` import it at module load.

There is one Supabase project. It is production. Pointing `AUDIT_BASE_URL` at the live site — or running against localhost, which uses the same database — creates real orders and consumes real stock.

I therefore **did not run** `audit:overflow`, `audit:a11y` or the six-width sweep. This is itself the finding: the gates the brief wants run cannot currently be run safely.

Separately, `scripts/audit/shipping.ts:43-45` unconditionally assigns `SHIPROCKET_PICKUP_LOCATION = "Primary"`, so that suite can never detect the missing-pickup-location failure in P1-6, and `:981-984` deletes the live `integration_tokens` row on teardown.

---

# P2 — broken but contained

### P2-1 · The site is still `noindex`

`SITE_INDEXABLE` is **absent** from the Vercel Production environment (full list of 10 variables checked; it is not among them). Confirmed on the live domain:

```
$ curl -sSI https://www.footvault.in/
x-robots-tag: noindex, nofollow, noarchive

$ curl -sS https://www.footvault.in/robots.txt
User-Agent: *
Disallow: /
```

`footvault.in` is invisible to Google. This is one env var plus a redeploy — but see P1-1: fixing indexing *before* `NEXT_PUBLIC_SITE_URL` would invite Google in to read canonicals pointing at vercel.app. **Order matters.**

### P2-2 · Lighthouse — two routes miss the ≥90 gate

Measured on **`https://www.footvault.in`**, mobile, devtools throttling:

| Route | Perf | A11y | Best | SEO | LCP | CLS | TBT |
|---|---|---|---|---|---|---|---|
| `/` | **90** | 100 | 100 | 66 | 2.86 s | 0.000 | 49 ms |
| `/shop` | **88** ✗ | 100 | 100 | 69 | 3.15 s | 0.000 | 43 ms |
| product | **85** ✗ | 100 | 100 | 58 | 3.51 s | 0.000 | 64 ms |
| `/cart` | **95** | 100 | 100 | 63 | 2.31 s | 0.001 | 15 ms |
| `/checkout` | **91** | 100 | 100 | 63 | 2.80 s | 0.000 | 40 ms |

Accessibility and best-practices are **100 on every route**. CLS is effectively zero everywhere. The SEO column fails purely because of P2-1 — `noindex` plus a disallowing `robots.txt` is counted as a failure; it is the environment, not the markup. The real gaps are **`/shop` at 88 and the product page at 85**, both LCP-bound.

### P2-3 · The Shiprocket credential latch fails open, and its escape hatch does not exist

`token.ts:150-163` documents *"It errs towards refusing"* — and then:

```ts
if (error) {
  console.error("[shiprocket] could not read the auth latch:", error.message);
  return;                       // ← a bare return, not a throw
}
```

Control falls through to `login()`. It errs towards **attempting**, the exact opposite of the stated contract — restoring one-login-per-request during a Supabase outage, which is the pattern that locked this account out during setup.

The message at `token.ts:171-174` tells the operator to *"clear the lockout in /admin/settings"*. `clearShiprocketLockout` and `shiprocketLockout` have **zero call sites** outside their own file. That UI was never built.

Third vector: `inFlight` de-duplication is module-scope, so on Fluid Compute N cold instances each spend a login before any writes the latch.

### P2-4 · A flat-mode price is recorded as a live rate

`src/lib/shipping/fee.ts:137` sets `basis: verdict.source === "shiprocket" ? "shiprocket" : "fallback"` even when the price came from `customerDeliveryFlatPaise`. That value is persisted as `orders.quote_source`, whose column comment promises *"A fallback must never be read as a live rate."*

Worth noting for Stage 2: **the flat-rate toggle the brief asks for in item 5 already exists** — `customer_delivery_fee_mode` (`live`/`flat`) and `customer_delivery_flat_paise` are read at `fee.ts:108,127-139`. It needs correcting and surfacing, not building.

### P2-5 · Checkout copy contradicts the money model

`src/components/checkout/totals.tsx:78` tells the customer the pay-on-delivery fee *"covers the return journey if the parcel is refused."* Since Phase 7 the return leg is in the **advance** (`fee.ts:24-31`); `codHandlingPaise` is the cash-collection fee. In the fallback branch it is neither. The hint string was never updated when the return leg moved.

### P2-6 · `payment_methods` is a setting nothing reads

`site_settings.payment_methods` is currently `{"cod": true, "online": false}`. Grepping `src/` for `payment_methods` returns **nothing** — the only hit in the repo is `scripts/seed-data.ts:1073`. Online payment is switched "off" in settings and Razorpay orders are being created regardless. The live master switch is `shipping.cod_enabled`, which *is* read (`totals.ts:161`, `delivery-check.ts:89`). Two settings, one dead, and the dead one reads like the important one.

---

# P3 — cosmetic or latent

- **`scripts/audit/literals.ts` cannot see `src/lib`.** It scans only `src/components/**/*.tsx` and `src/app/**/*.tsx`, and matches only `/₹\s*\d/` or `/\bRs\.?\s*\d/`. A bare paise integer matches neither. Its claim *"No policy number is typed anywhere"* is not true for `src/lib`.
- **Latent threshold drift.** `src/lib/queries/cart.ts:96` and the product page hardcode `free_above_paise: 249900` (₹2,499) as defaults while settings say ₹6,499. **These are inert today** — `setting()` returns the stored value wholesale (`content.ts:178-185`) and the row has the key. They bite only if the `shipping` key goes missing.
- **Dead code:** `parcelWeightKg` and `chargeableFee` (`quote-store.ts:132`) have zero production callers; `checkout.ts:220` describes `chargeableFee` as the function `placeOrder` uses, which is wrong.
- **Dead settings:** `cod_advance_mode`, `cod_advance_minimum_paise`, `cod_advance_fixed_paise` remain in the row; the rule they configured was deleted in Phase 7. `shipping_quotes.advance_paise` exists and is never written.
- **Same name, different meaning:** `orders.shipping_fee` is the delivery **total** (COD handling included); `shipping_quotes.shipping_fee_paise` is the **forward leg only**. A footgun for anyone joining them.
- **Supabase advisors:** `leaked password protection disabled`; three tables with RLS on and no policy (`integration_tokens`, `rate_limits`, `shipping_quotes` — all correctly service-role-only, so this is informational). The `SECURITY DEFINER` warnings on `adjust_variant_stock` and `admin_delete_product` are **false positives**: I read both function bodies and each raises `not_admin` unless `public.is_admin()` passes.

---

# What is healthy

Worth recording, because a list of only problems misrepresents the state of this codebase.

- **Stock reconciles to zero drift.** 370 variants with movements, `sum(delta)` equals `stock_quantity` on every one; total absolute drift **0**.
- **Every money identity holds on all 14 orders.** `advance + balance = grand_total` and `grand_total = subtotal − discount + shipping_fee + tax`, with zero gap on every row — both enforced by DB check constraints (`orders_advance_balance_sums`, `orders_total_adds_up`).
- **The COD collectable ties out.** The one shipment's `cod_collectable_amount` (149900) equals its order's `balance_due_on_delivery` exactly.
- **`/admin` 404s for anonymous users on the live domain** — `curl` returns `HTTP 404`. Two independent locks (proxy rewrite to a nonexistent path, plus a layout guard), both failing closed.
- **All 31 admin Server Actions are guarded**, and it is enforced mechanically by a custom ESLint rule (`eslint-rules/admin-actions-must-guard.mjs`, wired as `error`).
- **The webhook endpoint rejects unsigned POSTs** — live `curl` returns `HTTP 400` with an opaque body.
- **Rate limiting is real and correct.** Postgres-backed via an atomic `INSERT … ON CONFLICT DO UPDATE`, so it is shared across Fluid Compute instances rather than per-lambda. The webhook (300/min), checkout (10/min), payment verify (20/min) and all admin mutations (120/min) are covered. Cart, wishlist, address and auth actions are not.
- **Payment idempotency is properly enforced** — `payment_events_unique_per_provider unique (provider, event_id)`, claimed by insert with `23505` as the sole discriminator, plus two partial unique indexes on `payments`.
- **Stock cannot run out after capture.** The decrement happens inside the order transaction under a `FOR UPDATE` cart lock, before Razorpay is contacted.

---

# Blocked on the owner — exact steps

1. **Create the live-mode webhook.** Razorpay Dashboard → *Settings → Webhooks*, with the **Live** toggle on (top-right). URL: `https://www.footvault.in/api/payments/razorpay/webhook` — **www, not the apex**, which 308-redirects. Subscribe to `payment.captured`, `payment.failed`, `order.paid`. Add `refund.processed` and `refund.failed` now too, so they are ready for Stage 3.
2. **Copy the new webhook's secret** into Vercel → `RAZORPAY_WEBHOOK_SECRET` (Production), then **redeploy**. The secret is shown once at creation.
3. **Set `NEXT_PUBLIC_SITE_URL=https://www.footvault.in`** in Vercel Production and redeploy. It is inlined at build time, so a redeploy is required.
4. **Confirm the Supabase redirect allow-list.** Dashboard → *Authentication → URL Configuration*: Site URL should be `https://www.footvault.in`, and the redirect list should include `https://www.footvault.in/**`. I could not read this. Google is confirmed enabled (`external.google: true`).
5. **Confirm Google Cloud Console** → the OAuth client's *Authorized JavaScript origins* includes `https://www.footvault.in`, and *Authorized redirect URIs* still contains `https://ahumjhwqgmskjsitctcj.supabase.co/auth/v1/callback` (unchanged by the domain move).
6. **Report the backup posture.** Supabase Dashboard → *Database → Backups*: whether PITR is enabled and the retention window. Not queryable from here.
7. **Do not lift `SITE_INDEXABLE` until step 3 has shipped** — otherwise Google is invited in to read canonicals pointing at vercel.app.
8. **Decide two policy numbers** for Stage 2 (yours, not mine): whether the free-delivery threshold also waives the cash-handling fee (`waive_cod_fee_above_threshold`), and what the flat-mode deposit should be when there is no live quote to derive a round trip from.

---

# What I got wrong, and caught in self-review

- **I initially read the COD handling fee as excluded from `grand_total`.** My first reconciliation query computed `subtotal − discount + shipping + cod_fee + tax − grand_total` and reported a gap equal to `cod_handling_fee` on every COD order — which I briefly took for a revenue leak. It is not. `orders.shipping_fee` is the delivery **total**, of which `cod_handling_fee` is a *component*, not an addend (`totals.ts:110-112`). The identity holds on all 14 orders. Adding the component twice was my error.
- **I nearly reported the hardcoded ₹2,499 as a live customer-facing lie.** The cart's free-shipping meter and the product page both carry `free_above_paise: 249900` while settings say ₹6,499. I checked `setting()` before writing it up: it returns the stored value wholesale, so the literal is unreachable while the key exists. Downgraded from P1 to P3 (latent).
- **My first attempt to prove the fallback used `quote_source IS NULL`** — which is weak, because the `quote_source` column was added at 14:00 on 2026-08-08, after FV-2026-00571 was placed at 09:54, so NULL was expected regardless. The argument that actually holds is the one in P1-2: two orders 4.7× apart in value carrying identical fees.
- **My OAuth allow-list probe was worthless and I nearly reported it as a pass.** `/auth/v1/authorize` echoes any `redirect_to` into the Google URL. I ran `evil.example.com` as a control, got the same 302, and reclassified it as owner-verification rather than a finding.
- **Both subagents reported `RAZORPAY_WEBHOOK_SECRET` as a local-only problem** because `.env.local` has it blank. That is true but not the important half — the production variable is set, and the reason it is still wrong is the missing live webhook, which neither agent could see. I verified the live account directly rather than taking the file-level conclusion.

---

# Known imperfections in this audit

- **I never observed a real live payment**, because none exists. The P0-1 chain is traced through code and confirmed by the absence of any registered webhook, not by watching it fail.
- **Ten Vercel env values are masked.** I inferred `RAZORPAY_KEY_ID` is the live key from behaviour — the production deployment created `order_TNOTi8YQv1Ahdd` in the **live** account for FV-2026-00597 at 19:38 today. That is strong but indirect.
- **I did not run `audit:overflow`, `audit:a11y` or the six-width sweep** (P1-9). Overflow and sub-44px-target coverage is therefore **unmeasured**, not clean. Lighthouse's a11y score of 100 on five routes is real but is a much weaker check than axe across 20 routes × 6 widths.
- **I did not verify tablet admin rendering.**
- The COD fee percentage I derived (~1.8% of declared value, floor ~₹31.80) is **inferred from five observed quotes**, not read from a Shiprocket rate card.
- I did not audit the storefront UI, the homepage editor gap, or the search-bar focus ring beyond noting they are unstarted — they are P2 in the brief and carry no money risk.

---

# Suggested sequence for Stage 2

Reasoning about order, since two of these interact:

1. **P1-1 before P2-1.** Fix `NEXT_PUBLIC_SITE_URL`, ship it, *then* lift `SITE_INDEXABLE`. Reversing this hands Google canonicals pointing at the wrong host.
2. **P0-1/P0-2 together, in one change.** Creating the live webhook without updating the secret produces 400s that look exactly like the current silence. Both, then redeploy, then verify with a ₹1 live order.
3. **P0-3 before P0-4.** Make the "money kept" case loud before building refunds — otherwise the refund UI has nothing pointing it at the orders that need one.
4. **P1-2 and P1-3 are one fix.** Correcting the fallback split without surfacing the `live` flag just changes which wrong number is shown confidently.
5. **P1-4 (parcel weight) changes every quote.** It should land before any pricing is verified against Shiprocket, or the verification measures the wrong weight.
6. **P1-9 blocks its own verification.** Until the fixtures can run against something that is not production, the overflow and axe gates cannot be reported honestly. A seeded branch database is the cheapest route.

Stage 2 plan to follow. No code has been written.
