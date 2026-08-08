# Foot Vault — Phase 5 Brief

**Checkout, orders and payments. Multi-agent.**

> Save as `docs/PHASE_5.md` and tell Claude Code: *"Read docs/PHASE_5.md and begin."*

---

## Standing rules — these apply to every phase

**1. Execution report.** Write `claudeExecutionReport/phase-5-checkout-payments.md` covering: what was built with file paths; every autonomous decision with a one-line rationale; every bug found and fixed, root cause not symptom; every measurement with the actual number; **what you got wrong and caught in self-review**; **known imperfections**, honestly listed; what was deferred and to which phase; and anything blocked on the owner with exact steps. Write it for someone who wasn't watching.

**2. Documentation stays current.** No phase is done until `README.md`, `.env.example`, `docs/architecture.md`, `docs/database.md`, `docs/admin-guide.md` and `docs/rls-tests.md` match the code. A stale doc is a bug.

**3. Authority.** Full authority to fix any bug anywhere, refactor what's in your way, add migrations, change dependencies, and adjust tokens where measurement justifies it — including in earlier phases' code. Still mine to decide: business policy (pricing, shipping, returns, sizing, currency), destructive data or git operations, and scope beyond this phase.

**4. Skills.** Check what skills are available and use every one that applies. Load **frontend-design** before UI work.

---

## Multi-agent structure

Run this phase with sub-agents. The point is not speed — it is that **the person who wrote the payment code must not be the person who tries to break it.** Self-review has been catching a lot this project, but a fresh adversarial reader catches a different class of defect.

### Agent roster

| Agent | Owns | Must not touch |
|---|---|---|
| **A · Visual repair** | `src/components/storefront/product-card.tsx`, rail, cart and drawer layout | Anything under `src/lib/` |
| **B · Orders & data** | Migrations, `src/lib/orders/`, the checkout server action, stock transaction | Payment provider code, UI |
| **C · Payments** | `src/lib/payments/`, Razorpay adapter, webhook route, signature verification | Order state machine internals, UI |
| **D · Checkout UI** | `/checkout`, `/order/[orderNumber]`, `/account/orders`, address form | `src/lib/payments/`, migrations |
| **E · Adversarial security review** | Read-only until it finds something. Writes only tests and its findings file | Feature code — it reports, B and C fix |
| **F · QA & audit** | `scripts/audit-*`, Lighthouse and axe runs, browser harnesses | Feature code |
| **G · Docs & report** | `README.md`, `docs/**`, `claudeExecutionReport/**` | Everything else |

### Rules of engagement

- **One writer per file.** Two agents editing the same file is how this goes wrong. If two need the same file, the lead sequences them rather than running both.
- **Interfaces before implementations.** Agent B publishes the order-creation and state-transition signatures, and Agent C publishes the payment-adapter interface, *before* either writes a body. D and E build against those signatures.
- **Agent E starts after C and B have something to attack, and reports to the lead, not to the agent it is reviewing.** Its findings go in `claudeExecutionReport/phase-5-security-review.md` with a severity per finding. Nothing merges with an unresolved high finding.
- **The lead integrates.** Sub-agents do not merge each other's work. The lead reviews, resolves conflicts, and runs the full gate suite before the PR.
- **Every agent reports what it could not verify.** Silence is not a pass.

---

## Preflight

### P1 · Land the branch

PR #4 is not merged — the live site is still showing Phase 3. Merge it, confirm `main` builds, confirm Vercel auto-deploys on push to `main`, and branch Phase 5 from `main`.

### P2 · The hydration error is not our bug — confirm and move on

The reported mismatch shows `bis_register` and `__processed_<uuid>__` appearing on `<body>` on the client only. Those attributes are injected by a browser extension before React loads; they are not produced by our code. Reproduce once in an incognito window with extensions disabled to confirm it disappears, add `suppressHydrationWarning` to the `<body>` element in `src/app/layout.tsx` (that attribute is exactly what it exists for, and it only suppresses one level), and record it in the report. **Do not spend hours chasing this.** But do verify there is no *second*, real hydration mismatch hiding behind the noisy one — check with extensions off before declaring it clean.

### P3 · Visual repairs — Agent A

From the current live site. Fix each, then sweep for the same class.

1. **Brand names are being clipped on product cards.** "ADIDAS" renders as "IDAS", "WOODLAND" as "ODLAND", "ASICS" as "ICS". The wishlist heart is absolutely positioned over the label row and the brand text starts underneath it. Reserve real space for the heart instead of overlaying it — the label row should be a flex row where the heart is a sibling, not a layer. Then check every other absolutely-positioned overlay in the card for the same collision.
2. **The heart button is misaligned** with the label row it sits beside — different optical baseline, and its hit area extends below the row. Align it to the label, keep the 44px target via padding rather than box size.
3. **Product illustrations render at inconsistent scale.** The Camel Leather Boot fills far more of its frame than the Gazelle beside it, so the cards read as different sizes. Normalise: fixed aspect-ratio frame, consistent internal padding, image constrained by the smaller dimension so every product occupies comparable visual weight regardless of its source aspect ratio. This is the "cards look shrunk" symptom.
4. **The rail overflows its container** — the fourth card is clipped by the viewport edge rather than sitting inside a scroll boundary, and the arrow controls overlap card content. Fix the scroll container's padding and the control positioning so no card is ever half-visible at rest.
5. **The `3/4` badge is cryptic.** It means the three-quarter view, but to a customer it reads as "image 3 of 4". Either replace it with a clearer view indicator or remove it from the card and keep it in the gallery only.
6. **The cart page has a dead zone.** The line-item price sits stranded mid-row and a large empty column separates items from the summary. Tighten the grid so a one-item bag doesn't look broken, and add a "Continue shopping" route out.
7. **The bag drawer with one item is mostly empty space.** Not a bug, but it looks unfinished. Fill it usefully or let the content sit closer to the top.

Verify at 360, 390, 768, 1024, 1440, 1920, with a one-item bag, a five-item bag, a long product name, and a sold-out product.

### P4 · Two carried-over items

- **`SHAPE_VERSION` (imperfection §7.7)** is a manual discipline guarding the worst bug class in the codebase — silent wrongness with no error anywhere. Add a snapshot test over the cached types that fails the build when a field changes without a version bump. Do this before checkout starts caching anything.
- **The cart merge (§7.3)** is idempotent but not transactional, and checkout is about to lean on cart state. Harden it. **If you make it a `SECURITY DEFINER` function, note that this codebase has already been bitten by exactly that** — the Phase 1 `guard_profile_role()` bug where `current_user` resolved to the function owner and the guard was silently inert. So: derive the user from `auth.uid()` *inside* the function, never from a caller-supplied parameter; pin `search_path`; revoke execute from `anon` and `public`. Agent E reviews this specifically.

### P5 · Keep the store out of search results

`foot-vault.vercel.app` is publicly reachable and will get indexed with placeholder illustrations and a broken checkout. Add a site-wide `X-Robots-Tag: noindex` gated on an env flag, default noindex, with a documented one-line change to lift it on launch day.

---

## What Phase 5 builds

### Agent B — orders and stock

- `/checkout` server action is the single authority. It **recomputes every price from the database**, never trusting anything the browser sent. `getCart()` is a render-time read with no lock — treat it as a hint, not a source.
- **Stock decrement happens in one transaction** with the order write. Two customers buying the last unit: exactly one succeeds, the other gets a clear message naming the item and size that went out of stock, with their bag intact.
- Order creation writes `orders` and `order_items` with full snapshots — product name, size, colour, SKU, unit price, image — so order history survives a product being edited or deleted later.
- `order_number` via the existing `next_order_number()`, called through the service role.
- Set `carts.status` to `converted` on success. Nothing currently sets it.
- `order_status_history` gets a row on every transition, with who changed it.
- Guest orders: no account required. Capture email and phone, store them on the order, and offer account creation on the confirmation page.
- **The order state machine is explicit.** Write it down: which transitions are legal, which are terminal, what happens to stock on cancellation. Put the diagram in `docs/architecture.md`.

### Agent C — payments

Two methods: **Cash on Delivery** and **Razorpay**. Both behind the existing swappable interface — no Razorpay type may leak into order code.

Razorpay specifics, all non-negotiable:

- Amounts are already integer paise in this codebase, which is what Razorpay expects. Do not introduce a float anywhere in the money path.
- Server creates the Razorpay order via the Orders API and returns only the `order_id` to the client. **The amount is computed server-side from the cart, never accepted from the browser.**
- The browser's success callback is **not** authoritative. Verify the `razorpay_signature` HMAC on the server, and treat the **webhook** as the source of truth for payment state.
- Implement the webhook route with `x-razorpay-signature` verification using the **webhook secret**, which is a different secret from the API key secret. Reject unverified payloads with a 400 and log them.
- **Idempotency is mandatory.** Razorpay retries webhooks; the same event will arrive more than once. Every state transition must be safe to replay. Store the event id and short-circuit duplicates.
- Handle the ugly cases explicitly: payment captured but the browser never returned; webhook arriving before the client callback; user closing the modal mid-payment; payment failed then retried on the same order. None of these may produce a duplicate order or a double stock decrement.
- Never log a full payment payload, a key secret, or a webhook secret.
- Keys live in Vercel env vars, separately for Preview and Production. `.env.example` lists the names only.
- Test mode first. The code must not care which mode it is in.

### Agent D — checkout UI

- Address step: address book for signed-in users, new-address form for guests. Zod schema shared client and server. Indian address shape — PIN code validated as six digits, state as a select.
- Order summary with live totals: subtotal, shipping from `site_settings`, discount placeholder, grand total. Tax-inclusive note.
- Payment step: COD and Razorpay as clear choices with what each means in plain language.
- A visible, honest failure path. If checkout fails, the customer must know whether they were charged.
- `/order/[orderNumber]` confirmation: what was bought, where it is going, what happens next, order number prominent.
- `/account/orders` and `/account/orders/[id]` with status timeline from `order_status_history`.
- Mobile first. The checkout is where a cramped layout costs money.

### Emails

Build order-confirmation email behind an interface. If no SMTP is configured, log to the server and continue — a missing email must never fail an order. Setting up a real provider is an owner task; note it in the report with exact steps.

---

## Agent E — adversarial review checklist

Attack the implementation, do not read it charitably. At minimum:

- Tamper with the amount client-side and place an order. Does the server catch it?
- Replay a captured webhook ten times. Does stock decrement ten times?
- Forge a webhook with an invalid signature. Is it rejected?
- Place an order for a variant, then set that variant inactive mid-flow.
- Two concurrent checkouts on the last unit.
- Sign in as customer A and request customer B's order by order number, both via the API and the page.
- Guest order via `guest_token` — can another guest read it by guessing?
- Coupon field: does anything typed there affect the total? It shouldn't yet.
- Is `SUPABASE_SERVICE_ROLE_KEY` or any payment secret reachable in the client bundle? Grep the built output, not the source.
- Any new `SECURITY DEFINER` function: whose privileges does it actually run with, and can `anon` execute it?

Every finding gets a severity, a reproduction, and a regression test.

---

## Quality gates

- **Lighthouse on the Vercel preview, not localhost.** This finally settles the question open since Phase 3. Mobile ≥90 across all four categories on `/`, `/shop`, a product page, `/cart` and `/checkout`.
- axe clean on every new route and overlay.
- Zero overflow, zero sub-44px targets, all routes × six widths — including the repaired cards.
- Full keyboard path: browse → add to bag → checkout → address → payment method → place a COD order → view it in account orders.
- No `any`, no `@ts-ignore`, no suppressed lint rules without a justifying comment.
- `no-unchecked-supabase-error` stays green.
- Every quality gate result goes in the report as a number, not an adjective.

Integrate Razorpay Standard Web Checkout into this codebase.

=== CREDENTIALS ===

RAZORPAY_KEY_ID: rzp_test_TMyzJsAbGiBQ4T
RAZORPAY_KEY_SECRET: QzBIVBe6ivBkitDc4stQ57Tf

=== TASK ===

Detect the project stack and implement Razorpay Standard Checkout with:
1. Backend endpoint to create orders
2. Frontend checkout button with payment modal
3. Backend endpoint to verify payment signature

=== IMPLEMENTATION DETAILS ===

STEP 1: BACKEND - Create Order
- Endpoint: POST /api/create-order (or framework equivalent)
- Call Razorpay API: POST https://api.razorpay.com/v1/orders
- Request: { amount (paise), currency, receipt }
- Return: { order_id, amount, currency }
- Minimum amount: 100 paise

STEP 2: FRONTEND - Checkout
- Script: <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
- On button click: call create-order, then open Razorpay modal with order_id
- On success: receive razorpay_payment_id, razorpay_order_id, razorpay_signature
- Send all three to verify endpoint

STEP 3: BACKEND - Verify Signature
- Endpoint: POST /api/verify-payment (or framework equivalent)
- Algorithm: HMAC-SHA256(order_id + "|" + payment_id, KEY_SECRET)
- Compare generated signature with razorpay_signature
- Return success only if signatures match

=== ENVIRONMENT SETUP ===

Create .env file:
RAZORPAY_KEY_ID=rzp_test_TMyzJsAbGiBQ4T
RAZORPAY_KEY_SECRET=QzBIVBe6ivBkitDc4stQ57Tf

Frontend framework prefixes (KEY_ID only, never KEY_SECRET):
- Next.js: NEXT_PUBLIC_RAZORPAY_KEY_ID
- Vite: VITE_RAZORPAY_KEY_ID
- CRA: REACT_APP_RAZORPAY_KEY_ID

Add .env to .gitignore.

=== SDK INSTALLATION ===

Node.js: npm install razorpay
Python: pip install razorpay
PHP: composer require razorpay/razorpay
Ruby: gem install razorpay
Go: go get github.com/razorpay/razorpay-go

=== OPERATION ORDER ===

Execute in this sequence:
1. Install dependencies first
2. Create .env file
3. Create or modify code files
4. Verify setup

=== ERROR HANDLING ===

Backend - Create Order:
- Validate amount >= 100 paise
- Handle Razorpay API errors (return 500)
- Handle auth failures (return 401)

Backend - Verify Signature:
- Signature mismatch: return 400, do NOT mark as paid
- Missing fields: return 400

Frontend:
- Handle modal dismiss (user cancelled)
- Handle payment.failed event
- Show error messages to user

=== EDGE CASES ===

If no backend framework detected:
- Stop and explain that Razorpay requires a backend for order creation
- Suggest serverless functions (Vercel/Netlify) or Razorpay Payment Links

If Razorpay already integrated:
- Do not duplicate code
- Only fix or complete missing parts

If static site only:
- Suggest adding serverless API routes
- Or suggest Razorpay Payment Links as alternative

=== REQUIREMENTS ===

- Never hardcode credentials in source files
- KEY_SECRET must never reach frontend code
- Use environment variables everywhere
- Follow existing code style in the project
- Do not create database tables unless project already has a database

=== REFERENCE ===

Documentation: https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/

=== OUTPUT ===

After completing integration:
1. List files created or modified
2. Explain how to test (e.g., start server, click pay button)
3. Note any manual steps required

Begin integration now.

---

## Out of scope

Admin panel (6–7) — orders are visible in the database and via `/account`, not yet in an admin UI. Coupon validation and reviews (8). Refunds — note what Phase 8 will need.

## Done when

A customer can add shoes to a bag on a phone, check out as a guest with COD, and get an order number — and a second customer can pay with a Razorpay test card and end up with exactly one order, one payment record, and one stock decrement, no matter how many times the webhook fires or how they abuse the back button.
