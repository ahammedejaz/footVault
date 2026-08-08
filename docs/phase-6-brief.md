# Foot Vault — Phase 6 Brief

**Admin panel and Shiprocket logistics. Single agent.**

> Save as `docs/PHASE_6.md` and tell Claude Code: *"Read docs/PHASE_6.md and begin."*

---

## Standing rules — every phase

**1. Execution report** at `claudeExecutionReport/phase-6-admin-shipping.md`: what was built with file paths; every autonomous decision with a one-line rationale; every bug found, root cause not symptom; every measurement as an actual number; **what you got wrong and caught in self-review**; **known imperfections**, honestly listed; what was deferred and to which phase; anything blocked on the owner with exact steps.

**2. Documentation stays current.** `README.md`, `.env.example`, `docs/architecture.md`, `docs/database.md`, `docs/admin-guide.md`, `docs/rls-tests.md`. A stale doc is a bug. `docs/admin-guide.md` matters most this phase — it is written for a non-technical shop owner and this is the phase that gives them something to use.

**3. Authority.** Full authority to fix any bug anywhere, refactor what's in your way, add migrations, change dependencies, adjust tokens where measurement justifies it — including earlier phases' code. Still mine: business policy (pricing, shipping rates, returns, sizing, currency), destructive data or git operations, scope beyond this phase.

**4. Skills.** Check what's available and use every one that applies. Load **frontend-design** before UI work.

**5. Single agent this phase.** No sub-agents. But Phase 5 showed what a separate adversarial reader is worth — E-1 was an anonymous, free, unbannable way to empty the shop's stock, and no amount of charitable self-review would have found it. So this phase runs a **dedicated adversarial pass as its own distinct step**, after the feature work is complete, written up separately in `claudeExecutionReport/phase-6-security-review.md`. Come to it cold, with the goal of breaking what you built, not confirming it.

---

## Preflight

### P1 · Confirm Phase 5 actually landed

Do not build on unverified ground. Report the state of each:

1. Is PR #5 merged and deployed?
2. Is `RAZORPAY_WEBHOOK_SECRET` set in Vercel for Preview **and** Production?
3. Has a real test-card payment completed end to end? Query for it: one order `confirmed`, one `payments` row `captured`, exactly one stock decrement, webhook event recorded. If it hasn't happened, say so plainly and treat the Razorpay path as unverified in everything that follows.

### P2 · Clear the debts Phase 5 named

These are prerequisites, not nice-to-haves.

- **§8.4 — build the stock movements ledger.** `product_variants.stock_quantity` is a single mutable integer, so a wrong count leaves no trace of how it got wrong. This phase hands a human the ability to edit stock by hand, which makes a ledger mandatory rather than optional. Create `inventory_movements` (variant_id, delta, reason enum — `order` / `cancellation` / `sweep` / `admin_adjustment` / `restock` / `shipment` — reference id, actor, note, created_at). **Every** path that mutates stock writes a movement row in the same transaction. Backfill current quantities as an opening balance so the ledger reconciles from day one, and add a check that sums movements against `stock_quantity`.
- **§8.5 — add rate limiting.** Nothing on this site is rate-limited: not the webhook, not the verify action, not checkout, and now not the admin mutations. Add it before an admin panel exists to attack.
- **§8.3 / E-8 — `abandonUnpaidOrder` is unregistered dead code.** Wire it or delete it. Do not leave a third path to order cancellation half-connected.
- **§8.14 — two suites disagree about guest-merge behaviour.** Agent E's §14 asserts pre-fix behaviour; `audit:checkout` §9 asserts the fix. A test suite that contradicts itself is worse than no suite. Reconcile them.
- **§8.11 — restore the colourway caption** to product cards, as a proper caption under the product name rather than baked into the image. Colourway is how people identify a specific shoe; it isn't glossary noise.
- **§8.13 — `isSupabaseConfigured()`** promises graceful degradation the render path doesn't deliver. Make the code honest or delete the promise; a contradiction in `docs/architecture.md` is not a fix.
- **§8.12 — the rail's peek card below `lg`** is the only scroll affordance for touch users. Give it a real one.

---

## Part 1 — The admin panel

Route group `/admin`, already 404'd in middleware for non-admins. Visually distinct from the storefront — denser, more utilitarian, same tokens — but built to the same quality. The shop owner will live in here, and they are not technical.

### Security — read this before writing a single admin route

**Middleware returning 404 is not authorization.** It protects page navigation. It does not protect server actions, route handlers or RPCs, which can be called directly with a valid session and the right payload. Every single admin mutation must independently verify `is_admin()` **server-side, inside the action**, before doing anything. Assume every admin action will be invoked by a signed-in customer who read your JavaScript bundle.

The adversarial pass must specifically attempt: calling each admin server action as a plain customer; escalating via a crafted form payload; reading admin-only data through PostgREST directly; and mutating another customer's order.

### Routes

```
/admin                      Dashboard — today's orders, revenue, low stock, unfulfilled shipments
/admin/products             Table: search, filter, bulk activate/deactivate
/admin/products/new         Create
/admin/products/[id]        Edit — details, images (drag to reorder), variants, SEO
/admin/categories           Tree view, drag to reorder and nest
/admin/brands               CRUD
/admin/inventory            Every variant, stock inline-editable, low-stock filter, movement history per variant
/admin/orders               Filter by status and date, search by order number, phone or email
/admin/orders/[id]          Full detail, status changes, notes, invoice, and the shipping panel (Part 2)
/admin/customers            List with order history per customer
/admin/media                Storage browser, upload, delete
/admin/settings             Store info, contact, social, shipping rules, policies
```

### Non-negotiables

- Every destructive action confirms, and names what is being deleted.
- **Deleting a product that appears in past orders soft-deletes it.** Order history never breaks. `order_items` already carries snapshots — verify that path actually holds by deleting a product that has an order against it and confirming the order still renders.
- Image upload: drag-and-drop, client-side compression, progress, alt text field, one primary enforced.
- Every table: server-side pagination, search, sortable columns, and an empty state that tells the owner what to do first.
- Every stock edit writes an `inventory_movements` row with the admin as actor and a required note.
- Optimistic UI with rollback, and a toast on every mutation.
- **Works on a tablet.** The owner will use this standing in the shop.
- Admin actions that change order state reuse the Phase 5 state machine. Do not add a fourth writer to `orders.status` that bypasses the compare-and-swap.

**Out of scope this phase:** `/admin/appearance` — the homepage builder and banner scheduling — is Phase 7. Coupons and reviews are Phase 8.

---

## Part 2 — Shiprocket

### First, correct the credential

`.env.local` currently holds `SHIPROCKET_API_KEY`, unread by any code. **Verify what that value actually is before building against it.** Shiprocket's external API documented at `apiv2.shiprocket.in` does not authenticate with a static API key. The flow is:

1. Create an **API user** in the Shiprocket panel under Settings → API → Configure. It requires an email **different from the account's registered login email**, plus a password.
2. `POST https://apiv2.shiprocket.in/v1/external/auth/login` with those API-user credentials returns a **JWT token valid for 240 hours (10 days)**.
3. Every other call sends `Authorization: Bearer <token>`.

So the code needs `SHIPROCKET_EMAIL` and `SHIPROCKET_PASSWORD`, not a key. If `SHIPROCKET_API_KEY` holds a token rather than credentials, it will expire in ten days and every shipping call will start failing with no code change to explain it — exactly the kind of silent, delayed failure this project has been careful to design out. Establish what the value is, name the variables correctly in `.env.example`, and tell me in the report what I need to provide.

### Token handling

- One token service. Fetch once, cache, refresh proactively before the 240-hour expiry — **never log in per request**.
- On a 401, re-authenticate exactly once and retry; a second 401 is a real failure, surfaced not swallowed.
- Cache survives a serverless cold start — store it where it persists, not in module memory alone.
- Never log the token or the password.

### Schema

- `shipments` — order_id (unique, so one order cannot spawn two shipments), shiprocket_order_id, shipment_id, awb_code, courier_name, status, label_url, manifest_url, invoice_url, pickup_scheduled_at, raw payloads as jsonb, timestamps.
- `shipment_events` — shipment_id, event type, payload, created_at. Same idempotency discipline as `payment_events`.
- **Products need physical dimensions.** The adhoc order payload requires weight and dimensions. Add `weight_grams`, `length_cm`, `breadth_cm`, `height_cm` — on variants if they differ by size, otherwise products — with a configurable default in `site_settings` so existing rows aren't blocked. Expose these fields in the admin product form.

### The flows

**Serviceability — customer-facing, read-only**
`GET /v1/external/courier/serviceability/` with pickup postcode, delivery postcode, weight and COD flag returns available couriers, rates and estimated delivery days.

Use it for two things, and only these two:
- A real delivery estimate on the checkout address step and the product page.
- **Gating COD by PIN code.** Phase 5 §8.8 recorded that `isAvailable()` on COD is unconditionally true, with a hook waiting for exactly this. If Shiprocket says COD isn't serviceable to that PIN, don't offer it.

**Do not change what you charge the customer.** Shipping stays flat ₹99, free over ₹1,999, from `site_settings`. Surface the real courier rate to the admin so I can see what each order actually costs, but the customer-facing rate is a business decision and it stays mine.

Serviceability must fail soft: if Shiprocket is down or slow, checkout proceeds with the default estimate and COD stays available. **A logistics outage must never block a sale.**

**Fulfilment — admin-triggered, never automatic**

From `/admin/orders/[id]`, as explicit actions with confirmation:
1. Create shipment — `POST /v1/external/orders/create/adhoc`, store `shiprocket_order_id` and `shipment_id`
2. Assign AWB — `POST /v1/external/courier/assign/awb`, store `awb_code` and courier name
3. Schedule pickup — `POST /v1/external/courier/generate/pickup`
4. Generate label, manifest, invoice — store the returned PDF URLs
5. Track — `GET /v1/external/courier/track/awb/{awb_code}`

Each step is idempotent and shows its current state, so a double-click or a retry after a timeout cannot create two shipments. Order status moves through the Phase 5 state machine as fulfilment progresses, and `order_status_history` records each transition.

**Customer-facing tracking:** AWB, courier and latest status on `/account/orders/[id]` and the order confirmation page. Poll or refresh on view — do not build a background poller this phase.

**Why admin-triggered:** Shiprocket's API acts on the live account. Creating an order creates a real order in the panel, and assigning an AWB may commit real money. Automatic fulfilment on payment would mean a bug ships real parcels. A human presses the button.

### Testing — the owner asked for this explicitly

- **Automated:** an audit script (`npm run audit:shipping`) covering token fetch and cache, proactive refresh, 401 re-auth, serviceability for a serviceable PIN and a non-serviceable one, COD gating both ways, fail-soft when Shiprocket is unreachable, and idempotency on every fulfilment step. Mock the API for these — do not hit the live account in CI.
- **Manual, once, against the real account:** create one shipment for a test order, assign an AWB, generate a label, fetch tracking, then **cancel it in the Shiprocket panel**. Write the exact click-path in `docs/admin-guide.md` so I can repeat it. Report every response you got.
- **First, determine whether the account has a sandbox or test mode.** If it does, use it. If it doesn't, say so, and make the one real test explicit and reversible.

### Owner tasks — list these precisely in the report

Configure a pickup location in the Shiprocket panel (the adhoc payload needs its nickname), confirm or create the API user, and supply whichever credentials the correct auth flow actually needs.

---

## Quality gates

- Lighthouse mobile ≥90 across all four categories, **on the Vercel preview**, for `/`, `/shop`, a product page, `/cart`, `/checkout`. Admin routes are excluded from the SEO gate but not from performance or accessibility.
- axe clean on every new admin route and overlay.
- Zero overflow, zero sub-44px targets, all routes × six widths, plus tablet portrait for the admin.
- Full keyboard path through: add a product → add variants → upload an image → publish → see it on the storefront → place an order against it → fulfil it.
- `inventory_movements` reconciles against `stock_quantity` for every variant after the full test run.
- No `any`, no `@ts-ignore`, no suppressed lint rules without a justifying comment.
- `no-unchecked-supabase-error` and the cached-shape gate stay green.
- Every gate result reported as a number, not an adjective.

---

## Done when

I can sign in with Google, open `/admin` on a tablet, add a new sandal with four sizes and two colours, upload photos, publish it, watch it appear on the live storefront, take an order against it, adjust stock by hand and see the movement recorded with my name on it, then create a shipment, print a label and track the parcel — without opening the database, editing a file, or asking anyone.
