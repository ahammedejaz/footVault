# Foot Vault — Phase 6 Brief (revised)

**Payment model change, returns policy, admin panel, Shiprocket. Single agent.**

> Save as `docs/PHASE_6.md` and tell Claude Code: *"Read docs/PHASE_6.md and begin."*

---

## Standing rules — every phase

**1. Execution report** at `claudeExecutionReport/phase-6-admin-shipping.md`: what was built with file paths; every autonomous decision with a one-line rationale; every bug found, root cause not symptom; every measurement as an actual number; **what you got wrong and caught in self-review**; **known imperfections**, honestly listed; what was deferred and to which phase; anything blocked on the owner with exact steps.

**2. Documentation stays current.** `README.md`, `.env.example`, `docs/architecture.md`, `docs/database.md`, `docs/admin-guide.md`, `docs/rls-tests.md`. A stale doc is a bug. `docs/admin-guide.md` matters most this phase — it is written for a non-technical shop owner, and this is the phase that finally gives them something to use.

**3. Authority.** Full authority to fix any bug anywhere, refactor what's in your way, add migrations, change dependencies, adjust tokens where measurement justifies it — including earlier phases' code. Still mine: business policy (pricing, shipping rates, returns, sizing, currency), destructive data or git operations, scope beyond this phase.

**4. Skills.** Check what's available and use every one that applies. Load **frontend-design** before UI work.

**5. Single agent this phase.** No sub-agents. But Phase 5 showed what a separate adversarial reader is worth — E-1 was an anonymous, free, unbannable way to empty the shop's stock, and no amount of charitable self-review would have found it. So this phase runs a **dedicated adversarial pass as its own step**, after the feature work is complete, written up in `claudeExecutionReport/phase-6-security-review.md`. Come to it cold, trying to break what you built rather than confirm it.

---

## Part 0 — The payment model changes. Read this first.

**The current "Cash on Delivery" implementation is wrong for this business** and must be replaced before anything else in this phase.

Today a customer can select COD and place an order having paid nothing. That is not how Foot Vault operates. The correct model:

> **The customer pays the shipping fee online via Razorpay at checkout. The order is not placed until that payment captures. The goods amount is collected by the courier on delivery.**

### What this means structurally

Both payment methods now run through Razorpay. There is no longer a path that creates a confirmed order without a captured payment. That simplifies the order lifecycle rather than complicating it — reuse the Phase 5 machinery exactly:

1. Customer selects "Pay on Delivery" and submits checkout.
2. Server recomputes totals from the cart and determines the **advance amount** (see below).
3. In one transaction: create the Razorpay order, write our order as `pending` / `unpaid` with `payment_type = 'partial_cod'`, write `order_items`, decrement stock, store `razorpay_order_id`, and record `advance_amount` and `balance_due_on_delivery` as separate columns.
4. Razorpay modal opens for the advance only.
5. Webhook confirms capture → order becomes `confirmed`, with `balance_due_on_delivery` outstanding.
6. Abandoned or failed → the existing timed sweep releases stock and cancels.

Every guarantee Phase 5 built — idempotency, webhook-as-truth, compare-and-swap on status, the unique constraint on `razorpay_order_id`, timing-safe signature comparison — applies unchanged. Do not build a second payment path.

### The free-shipping conflict — this needs solving, not ignoring

Shipping is currently ₹99, free over ₹1,999. Most footwear orders will exceed ₹1,999, which under a naive reading means the advance is ₹0 — no payment, no Razorpay order (their minimum is 100 paise), and we are back to unsecured true COD, which is the thing we are removing.

**Implement a configurable `cod_advance` rule in `site_settings`** with these fields: `cod_advance_mode` (`shipping_fee` | `fixed` | `greater_of`), `cod_advance_minimum` (paise), and `cod_enabled`. Default to `greater_of` with a minimum of ₹99, so:

- Order under ₹1,999 → advance = ₹99 shipping, balance = goods total
- Order over ₹1,999 → shipping is free, advance = ₹99 minimum, balance = goods total − ₹99

**Never produce an advance below Razorpay's 100 paise minimum.** If the computed advance would be zero, fall back to the configured minimum. Surface these as editable fields in `/admin/settings` — I will tune the numbers, you build the mechanism.

### The customer must not be able to misunderstand this

This is the highest-stakes copy on the site. On the payment step, and again on the confirmation page and in the confirmation email, show all three numbers explicitly and separately:

```
Pay now (shipping)        ₹99
Pay on delivery           ₹16,900
Order total               ₹16,999
```

Rename the method in the UI. "Cash on Delivery" is misleading when money is due upfront — use **"Pay on Delivery"** with a one-line explanation directly beneath it: *"Pay ₹99 now to confirm your order. Pay the rest in cash when it arrives."* Never show a bare "COD" label with no advance disclosed.

### Shiprocket must collect the right amount

When the shipment is created, the COD collectable amount is **the balance, not the order total.** Passing the full total means the courier collects the shipping fee a second time from a customer who already paid it. Compute the Shiprocket `sub_total` and COD amount from `balance_due_on_delivery`, and assert it in a test — this is the single most expensive mistake available in this phase, because it happens to real customers with real money and you find out by complaint.

### Also audit the totals

The owner reports that checkout totals now differ between COD and pay-online. Find out why, document what each method currently computes, and make total computation a single shared server-side function that both methods call. Any difference between the two must be an explicit, named line item — never an artefact of two code paths that drifted.

---

## Part 0b — Returns and replacements policy

The store's policy, to be implemented as written:

- **No online returns.** Customers contact the store directly. No self-service return flow, no RMA form, no return labels.
- **No refunds.** Replacement only.
- **Replacements are for damage during shipment only**, reported by contacting the store **within 24 hours of delivery**.

### What to build

1. **Record `delivered_at`.** The 24-hour window is unenforceable and unprovable without a delivery timestamp. Take it from Shiprocket tracking (Part 2) and store it on the shipment and the order. Without this the policy is decorative.
2. **Show the window as a live countdown**, not as legal text. On `/account/orders/[id]`, once delivered: *"Damaged item? Contact us before 4:30 PM tomorrow."* Once it lapses, replace it with the store contact details and no countdown. A customer should never have to compute this themselves.
3. **Contact route, prominent and one tap.** Phone and WhatsApp from `site_settings`, on the order page, the confirmation page, and the policy page. If the only way to claim a replacement is to contact the store, that contact must be impossible to miss.
4. **Rewrite the policy CMS page** at `/page/returns` in plain language, and link it from the footer, the product page, the checkout payment step, and the confirmation email.
5. **Surface it at the moment of purchase.** A short, honest line on the checkout payment step — *"Replacements for shipping damage only, reported within 24 hours. No refunds."* — linking to the full page. Do not bury this in the footer and call it disclosed.
6. **Remove any contradicting copy.** The 7-day returns line placeholdered in Phase 0 is still in `site_settings`, the announcement bar and the footer. It now states a policy the store does not offer. Find every instance and correct it.
7. **Admin side:** on `/admin/orders/[id]`, a replacement can be recorded with a reason and a note, moving the order through the state machine. No customer-initiated path.

### Owner note — worth checking before launch

I'm not a lawyer and this isn't legal advice, but flag it in the report so it isn't forgotten: India's Consumer Protection (E-Commerce) Rules require sellers to display return, refund, exchange and warranty terms clearly, and a blanket no-refund position may not hold for goods that arrive defective, wrong, or not as described. "Damage in shipment only" also doesn't cover a wrong size being sent, which would be the store's own error. Worth an hour with someone who knows Indian consumer law before real orders start, and worth deciding now what happens when the store ships the wrong shoe.

---

## Preflight

### P1 · Confirm Phase 5 actually landed

Report the state of each. Do not build on unverified ground.

1. Is PR #5 merged and deployed?
2. Is `RAZORPAY_WEBHOOK_SECRET` set in Vercel for Preview **and** Production?
3. Has a real test-card payment completed end to end? Query for it: one order `confirmed`, one `payments` row `captured`, exactly one stock decrement, webhook event recorded. If it hasn't happened, say so plainly and treat the Razorpay path as unverified in everything downstream.

### P2 · Clear the debts Phase 5 named

Prerequisites, not nice-to-haves.

- **§8.4 — build the stock movements ledger.** `product_variants.stock_quantity` is a single mutable integer, so a wrong count leaves no trace of how it got wrong. This phase hands a human the ability to edit stock by hand, which makes the ledger mandatory. Create `inventory_movements` (variant_id, delta, reason enum — `order` / `cancellation` / `sweep` / `admin_adjustment` / `restock` / `replacement`, reference id, actor, note, created_at). **Every** path that mutates stock writes a movement row in the same transaction. Backfill current quantities as an opening balance, and add a check reconciling movement sums against `stock_quantity`.
- **§8.5 — add rate limiting.** Nothing is rate-limited: not the webhook, not the verify action, not checkout, and now not the admin mutations. Add it before there is an admin panel to attack.
- **§8.3 / E-8 — `abandonUnpaidOrder` is unregistered dead code.** Wire it or delete it. Do not leave a third cancellation path half-connected.
- **§8.14 — two suites disagree** about guest-merge behaviour. A suite that contradicts itself is worse than no suite. Reconcile them.
- **§8.11 — restore the colourway caption** to product cards, as a caption under the product name rather than baked into the image.
- **§8.13 — `isSupabaseConfigured()`** promises graceful degradation the render path doesn't deliver. Make the code honest or delete the promise.
- **§8.12 — the rail's peek card below `lg`** is the only scroll affordance for touch. Give it a real one.

---

## Part 1 — The admin panel

Route group `/admin`, already 404'd in middleware for non-admins. Visually distinct from the storefront — denser, more utilitarian, same tokens — but held to the same quality bar. The shop owner will live in here, and they are not technical.

### Security — read before writing a single admin route

**Middleware returning 404 is not authorization.** It protects page navigation. It does not protect server actions, route handlers or RPCs, which can be invoked directly with a valid session and the right payload. Every admin mutation must independently verify `is_admin()` **server-side, inside the action**, before doing anything. Assume every admin action will be called by a signed-in customer who read your JavaScript bundle.

The adversarial pass must specifically attempt: calling each admin server action as a plain customer; escalating through a crafted form payload; reading admin-only data through PostgREST directly; mutating another customer's order; and altering `advance_amount` or `balance_due_on_delivery` from the client.

### Routes

```
/admin                      Dashboard — today's orders, revenue, low stock, unfulfilled shipments,
                            and outstanding COD balances
/admin/products             Table: search, filter, bulk activate/deactivate
/admin/products/new         Create
/admin/products/[id]        Edit — details, images (drag to reorder), variants, dimensions, SEO
/admin/categories           Tree view, drag to reorder and nest
/admin/brands               CRUD
/admin/inventory            Every variant, stock inline-editable, low-stock filter,
                            movement history per variant
/admin/orders               Filter by status, payment type and date; search by order number,
                            phone or email
/admin/orders/[id]          Detail, status changes, notes, invoice, replacement recording,
                            and the shipping panel (Part 2)
/admin/customers            List with order history
/admin/media                Storage browser, upload, delete
/admin/settings             Store info, contact, social, shipping rules, COD advance rule, policies
```

### Non-negotiables

- Every destructive action confirms and names what is being deleted.
- **Deleting a product that appears in past orders soft-deletes it.** Verify by deleting a product that has an order against it and confirming the order still renders.
- Image upload: drag-and-drop, client-side compression, progress, alt text, one primary enforced.
- Every table: server-side pagination, search, sortable columns, and an empty state telling the owner what to do first.
- Every stock edit writes an `inventory_movements` row with the admin as actor and a required note.
- Order rows show **payment type, advance paid, and balance due** at a glance. The owner needs to know what the courier is collecting.
- Optimistic UI with rollback, and a toast on every mutation.
- **Works on a tablet.** The owner will use this standing in the shop.
- Admin status changes reuse the Phase 5 state machine. Do not add another writer to `orders.status` that bypasses the compare-and-swap.

**Out of scope this phase:** `/admin/appearance` — homepage builder and banner scheduling — is Phase 7. Coupons and reviews are Phase 8.

---

## Part 2 — Shiprocket

### First, correct the credential

`.env.local` holds `SHIPROCKET_API_KEY`, unread by any code. **Verify what that value actually is before building against it.** Shiprocket's external API at `apiv2.shiprocket.in` does not authenticate with a static key:

1. Create an **API user** in the Shiprocket panel under Settings → API → Configure. It requires an email **different from the account's registered login**, plus a password.
2. `POST https://apiv2.shiprocket.in/v1/external/auth/login` with those credentials returns a **JWT valid for 240 hours (10 days)**.
3. Every other call sends `Authorization: Bearer <token>`.

So the code needs `SHIPROCKET_EMAIL` and `SHIPROCKET_PASSWORD`. If `SHIPROCKET_API_KEY` holds a token rather than credentials, it expires in ten days and every shipping call starts failing with no code change to explain it. Establish what the value is, name the variables correctly in `.env.example`, and state in the report exactly what I need to supply.

### Token handling

- One token service. Fetch once, cache, refresh proactively before expiry — **never log in per request**.
- On 401, re-authenticate once and retry; a second 401 is a real failure, surfaced not swallowed.
- The cache must survive a serverless cold start — not module memory alone.
- Never log the token or the password.

### Schema

- `shipments` — order_id (unique, so one order cannot spawn two), shiprocket_order_id, shipment_id, awb_code, courier_name, status, cod_collectable_amount, label_url, manifest_url, invoice_url, pickup_scheduled_at, **delivered_at**, raw payloads as jsonb, timestamps.
- `shipment_events` — shipment_id, event type, payload, created_at. Same idempotency discipline as `payment_events`.
- **Products need physical dimensions.** The adhoc order payload requires weight and dimensions. Add `weight_grams`, `length_cm`, `breadth_cm`, `height_cm` — on variants if they differ by size, otherwise products — with a configurable default in `site_settings` so existing rows aren't blocked. Expose them in the admin product form.

### The flows

**Serviceability — customer-facing, read-only**

`GET /v1/external/courier/serviceability/` with pickup postcode, delivery postcode, weight and COD flag returns available couriers, rates and estimated delivery days. Use it for exactly two things:

- A real delivery estimate on the checkout address step and the product page.
- **Gating Pay on Delivery by PIN code.** Phase 5 §8.8 recorded that `isAvailable()` is unconditionally true, with a hook waiting for this. If Shiprocket says COD isn't serviceable to that PIN, don't offer the method — and say why, rather than silently hiding it.

**Do not change what the customer is charged.** Shipping stays flat ₹99, free over ₹1,999, from `site_settings`. Show the real courier rate to the admin so I can see what each order actually costs; the customer-facing rate is my decision.

Serviceability fails soft: if Shiprocket is slow or down, checkout proceeds with the default estimate and prepaid payment remains available. **A logistics outage must never block a sale.** If COD serviceability can't be determined, fall back to offering prepaid only — never offer COD on an unverified PIN.

**Fulfilment — admin-triggered, never automatic**

From `/admin/orders/[id]`, as explicit confirmed actions:

1. Create shipment — `POST /v1/external/orders/create/adhoc`, with the COD amount set from `balance_due_on_delivery`, store `shiprocket_order_id` and `shipment_id`
2. Assign AWB — `POST /v1/external/courier/assign/awb`, store `awb_code` and courier
3. Schedule pickup — `POST /v1/external/courier/generate/pickup`
4. Generate label, manifest, invoice — store the returned PDF URLs
5. Track — `GET /v1/external/courier/track/awb/{awb_code}`, and **capture `delivered_at` when status reaches delivered** — the returns window depends on it

Each step is idempotent and shows its current state, so a double-click or a retry after a timeout cannot create two shipments.

**Customer-facing tracking:** AWB, courier and latest status on `/account/orders/[id]` and the confirmation page, plus the replacement-window countdown once delivered. Refresh on view — no background poller this phase.

**Why admin-triggered:** Shiprocket's API acts on the live account. Creating an order creates a real order in the panel and assigning an AWB can commit real money. Automatic fulfilment on payment means a bug ships real parcels. A human presses the button.

### Testing — the owner asked for this explicitly

- **Automated** (`npm run audit:shipping`), against a mocked API — never the live account in CI: token fetch and cache, proactive refresh, 401 re-auth, serviceability for a serviceable and a non-serviceable PIN, COD gating both ways, fail-soft when Shiprocket is unreachable, idempotency on every fulfilment step, and **an assertion that the COD collectable equals the balance and not the order total.**
- **Manual, once, against the real account:** create one shipment for a test order, assign an AWB, generate a label, fetch tracking, then **cancel it in the Shiprocket panel**. Write the exact click-path into `docs/admin-guide.md` so I can repeat it. Report every response.
- **First determine whether the account has a sandbox or test mode.** If it does, use it. If not, say so and make the one real test explicit and reversible.

### Owner tasks — list precisely in the report

Configure a pickup location in the Shiprocket panel (the adhoc payload needs its nickname), confirm or create the API user, and supply whichever credentials the real auth flow needs.

---

## Quality gates

- Lighthouse mobile ≥90 across all four categories, **on the Vercel preview**, for `/`, `/shop`, a product page, `/cart`, `/checkout`. Admin routes are exempt from the SEO gate, not from performance or accessibility.
- axe clean on every new admin route and overlay.
- Zero overflow, zero sub-44px targets, all routes × six widths, plus tablet portrait for the admin.
- Full keyboard path: add a product → add variants → upload an image → publish → see it on the storefront → order it with Pay on Delivery → fulfil it.
- `inventory_movements` reconciles against `stock_quantity` for every variant after the full test run.
- A Pay-on-Delivery order's advance, balance and total sum correctly, and the Shiprocket COD amount equals the balance. Assert it, don't eyeball it.
- No `any`, no `@ts-ignore`, no suppressed lint rules without a justifying comment.
- `no-unchecked-supabase-error` and the cached-shape gate stay green.
- Every gate result reported as a number, not an adjective.

---

## Done when

A customer can order a pair of shoes with Pay on Delivery, see plainly that they are paying ₹99 now and the rest to the courier, and pay that advance through Razorpay — and I can sign in with Google, open `/admin` on a tablet, add a new sandal with four sizes and two colours, publish it, take an order against it, adjust stock by hand and see the movement recorded with my name on it, then create a shipment that asks the courier to collect exactly the right amount, print a label, and watch the parcel tracked to delivery.
