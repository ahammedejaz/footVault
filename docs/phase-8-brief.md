# Foot Vault — Phase 8 Brief

**The shop is live with real money. Audit first, plan second, fix third.**

> Save as `docs/PHASE_8.md` and tell Claude Code: *"Read docs/PHASE_8.md and begin Stage 1. Do not write any feature code until I approve the plan."*

---

## What changed, and why this phase is different

`footvault.in` is live with **live Razorpay keys and live Shiprocket credentials**. Every bug from here costs real money belonging to real people. A failed webhook is a customer charged for an order that never confirms. A failed AWB is a paid order that never ships. A missing refund path is money the shop cannot give back.

So this phase runs in three stages, and **you do not write feature code until Stage 2 is approved.**

| Stage | Output | Gate |
|---|---|---|
| **1 · Audit** | `claudeExecutionReport/phase-8-audit.md` | Read-only. No code changes at all, except a fix for something actively losing money — and that gets flagged in chat first. |
| **2 · Plan** | `claudeExecutionReport/phase-8-plan.md` | Stop and wait for the owner's approval. |
| **3 · Fix** | Code, in the approved order, plus `claudeExecutionReport/phase-8-hardening.md` | |

---

## Standing rules

**1. Execution reports** as above: what was built with file paths; every autonomous decision with a one-line rationale; every bug found, root cause not symptom; every measurement as an actual number; **what you got wrong and caught in self-review**; **known imperfections**, honestly listed; what was deferred; anything blocked on the owner with exact steps.

**2. Documentation stays current.** `README.md`, `.env.example`, `docs/architecture.md`, `docs/database.md`, `docs/admin-guide.md`, `docs/rls-tests.md`. A stale doc is a bug.

**3. Authority.** Full authority to fix bugs, refactor, add migrations, change dependencies. **Business policy numbers are the owner's** — build the mechanism, never pick the value. Destructive data or git operations, and scope beyond this phase, come to the owner.

**4. Skills.** Check what's available and use every one that applies. Load **frontend-design** before UI work.

**5. At most two subagents.** Lead plus two, never more. Suggested split: one on **payments and refunds**, one on **Shiprocket and fulfilment**. One writer per file — if two need the same file, the lead sequences them. The lead integrates; subagents never merge each other's work. Reserve one subagent for a cold adversarial pass at the end if the work allows.

**6. DO NOT MERGE.** Phase 7 merged despite this rule, and two of its three PRs were fixes for problems found *after* deployment. `main` now auto-deploys to a shop taking real payments. Open the PR, report, stop. Merging is the owner's decision, every time.

**7. Do not create new bugs.** Every change ships with the test that proves it. If a fix cannot be tested, say so in the report rather than shipping it quietly.

---

# STAGE 1 — THE AUDIT

Read-only. Produce `claudeExecutionReport/phase-8-audit.md` with a severity per finding: **P0 losing money now**, **P1 will lose money soon**, **P2 broken but contained**, **P3 cosmetic**. Every finding needs evidence — a query result, a curl response, a log line — not an assertion.

## 1A · The live-mode cutover — check these first, they are the ones that fail silently

**Razorpay test mode and live mode are separate worlds.** Verify each and report what you find:

1. **Is there a live-mode webhook at all?** Razorpay's webhook configuration is per-mode. A webhook created in test mode does **not** exist in live mode. If live-mode webhooks were never configured, every live order captures the customer's money and never confirms — the sweep then cancels it. Check whether any live order has reached `confirmed` via webhook, and check the payment IDs (`pay_...`) against `payment_events`.
2. **`RAZORPAY_WEBHOOK_SECRET` in Vercel is whichever secret was set for the test webhook.** The live webhook has its own secret. If they differ, every live webhook fails signature verification and is rejected — correctly, and catastrophically.
3. **The webhook URL points where?** It must point at `footvault.in`, not `foot-vault.vercel.app`, and the subscribed events must include `payment.captured`, `payment.failed` and `order.paid`.
4. **`NEXT_PUBLIC_SITE_URL`** — is it the new domain? It drives OAuth redirects, order links and emails.
5. **Google OAuth** — is `footvault.in` in the Authorized JavaScript origins, and is the Supabase callback still correct? Is `footvault.in` in Supabase's Site URL and redirect allow-list? If not, sign-in breaks on the real domain.
6. **`NEXT_PUBLIC_RAZORPAY_KEY_ID`** was never in the Vercel list. Establish how the key ID reaches the browser and whether it is the live one.
7. **Is the site still `noindex`?** It was gated to default-noindex. If it is still on, `footvault.in` is invisible to Google.

Report each as: configured correctly / configured wrongly / not configured. Do not guess.

## 1B · Money correctness — every path, with real numbers

**Reconcile every live order that exists.** For each: goods, delivery charge, COD fee, order total, advance captured, balance due, what Razorpay actually captured, what Shiprocket was told to collect. Any row where these do not tie out is a P0.

**Specifically explain order FV-2026-00571.** Goods ₹1,499, delivery ₹199, pay-on-delivery fee ₹150, advance ₹349 — for a parcel going to Kadapa 516002, which is the shop's own local zone. Live quotes for that lane run around ₹95–115 forward and ₹92–114 RTO, so a round-trip advance should be roughly ₹190–230, not ₹349. And a ₹150 cash-handling fee on a ₹1,499 order is 10%, where the courier's own COD charge on that lane is ₹31.80–₹52. **Where do ₹199 and ₹150 come from?** Show the formula, the inputs, the courier chosen, and the quote stored on the order. If the customer was overcharged, say so plainly.

**Then check the same class everywhere:** does any customer-facing money figure come from anywhere other than the live quote and `site_settings`?

## 1C · Every Shiprocket failure mode

The owner hit an AWB failure and had to call the API themselves to learn why. Audit the whole integration for that pattern:

- Every Shiprocket call: what happens on failure? Is the provider's own message captured and stored, or discarded?
- Wallet balance: is it checked or surfaced anywhere? Insufficient funds blocks **all** shipping and there is currently nothing to warn the owner.
- Are product weights and dimensions actually populated? A missing weight is a common AWB rejection.
- The token service: confirm the credential-rejection latch works, and that nothing can re-lock the API user.
- What happens if Shiprocket is down at checkout? Confirm the fail-soft path and confirm a fallback quote is never presented as live.

## 1D · The refund hole

Cancelling a paid order tells the owner to refund in Razorpay by hand. Audit and report the full extent:

- How many live orders currently have money captured?
- What happens today if a customer cancels? If stock runs out after payment? If the sweep cancels an unpaid order that later captures?
- Does anything reconcile Razorpay's records against the orders table? If a refund is issued in the Razorpay dashboard, does the shop's own system ever learn about it?

## 1E · Everything else

- **Stock and ledger**: reconcile every variant. Any drift is a P1.
- **Auth and admin**: confirm the Phase 7 fixes still hold on the new domain — `/admin` 404 for anonymous, forged Server Actions refused, `is_admin()` checked server-side in every admin action.
- **Rate limiting**: Phase 6 required it. Establish whether it exists, on which routes, and whether the webhook is covered.
- **The quality gates that were never run**: `audit:overflow`, `audit:a11y`, `audit:lighthouse` and the six-width sweep. Run them now and report the numbers.
- **Data safety**: one Supabase project holds both real orders and old test-harness data. Report what backup and point-in-time recovery exist, and identify test rows that are now sitting next to real customers.
- **Errors in production**: where does a server error on the live site actually go? If the answer is nowhere, that is a finding.
- **Email**: there is still no SMTP. A live shop that sends no order confirmation is a support burden. Confirm the current behaviour.

---

# STAGE 2 — THE PLAN

Write `claudeExecutionReport/phase-8-plan.md` and **stop**. It must contain:

- Every finding from Stage 1, ordered by severity, each with the proposed fix, the files it touches, the test that will prove it, and the risk of the change itself.
- A sequence, with the reasoning for that order.
- Anything you propose to defer, and why.
- Anything that needs the owner to act.
- Where two fixes interact, say so — this codebase has already produced a case where fixing one bug would have activated another.

Wait for approval.

---

# STAGE 3 — THE FIXES

Expected priority, subject to what the audit finds.

## P0 — the money

### 1 · The live webhook chain
Whatever 1A found, make it right, and add a check that makes it impossible to be silently wrong again: a startup or health-check assertion that the webhook secret in use matches the mode the keys are in, and an admin dashboard indicator showing when the last webhook was received. A shop whose webhook is broken should be able to see it, not discover it through a customer complaint.

### 2 · Refunds — build the mechanics
The policy matrix exists and is proven. Build what issues the money:

- Razorpay Refunds API on the stored `razorpay_payment_id`; partial refunds supported.
- `refund.processed` and `refund.failed` webhooks, signature verified over the **raw body**, event ids stored, duplicates short-circuited. A refund is complete when the webhook says so.
- Idempotency: unique constraint on `razorpay_refund_id`, a guard refusing to refund more than was captured, and a double-click that cannot issue two refunds.
- Admin UI on the order page: refund with a reason from the matrix, showing the computed amount and the deduction breakdown before confirming.
- Every refund writes to `order_status_history` with amount, reason and who authorised it.
- **Reconciliation**: import refunds issued directly in the Razorpay dashboard, so manual action taken before this shipped is not invisible forever.
- Never compute a refund amount on the client.

Until this ships, cancelling a paid order should tell the owner **exactly** what to refund — the amount, the payment id, and the reason — not just that refunds do not exist.

### 3 · Order confirmation emails
Behind an interface, failing soft — a missing email must never fail an order. Order placed, payment captured, shipped with tracking, delivered. Provider setup is an owner task; put the exact steps in the report.

## P1 — the reported issues

### 4 · Free shipping must apply to Pay on Delivery — **the owner is right**
Today the threshold zeroes delivery for prepaid but not for Pay on Delivery, which makes the promise false for half your customers. Fix it so the threshold applies to **both**.

**But keep the deposit.** These are two different things that currently share one number:

- The **delivery charge** is what the customer pays for delivery. When the threshold is met, it is zero — for every payment method.
- The **advance** is a deposit against the shop's round-trip risk on a cash order. It is not a delivery charge, and it should still be collected when delivery is free.

So on a free-delivery Pay-on-Delivery order the customer's total is goods only, and it splits into deposit now plus the remainder at the door. The customer sees free delivery and pays nothing extra; the shop keeps its protection. The two must be separate fields in `computeOrderTotals`, separately labelled at checkout, and never derived from each other.

The **cash-handling fee** is a third, separate thing. Whether the threshold waives it too is the owner's decision — expose it as a setting (`waive_cod_fee_above_threshold`), default it to matching the delivery behaviour, and label it clearly either way.

### 5 · Flat-rate shipping toggle
`shipping_rate_mode`: `live` (Shiprocket) or `flat`. In flat mode, `flat_shipping_fee` from settings, no API call, and the customer sees a normal delivery charge. Requirements:

- The **advance still needs a round-trip figure** in flat mode. Either derive it from the flat fee via a configurable multiplier, or fall back to a configurable flat deposit. Do not silently collect nothing.
- The mode used is **frozen on the order**, alongside the quote, so the owner can later tell which orders were priced how.
- Switching modes never changes a price a customer has already been shown.
- The admin screen states plainly what each mode does and what happens to the deposit.

### 6 · Surface Shiprocket errors properly
When Shiprocket refuses, show **Shiprocket's own message** on the order page — insufficient balance, missing weight, COD not serviceable — with what to do about it, and a link to the Shiprocket panel. Store the raw error against the shipment. Add wallet-balance visibility on the admin dashboard with a low-balance warning, since an empty wallet stops all shipping. Log every call with its outcome.

### 7 · Pay-on-Delivery on/off toggle
`cod_enabled` in settings, honoured everywhere: checkout hides the method, the API refuses it, and the customer sees a clear message rather than a missing option. Assert both paths.

## P2 — the interface

### 8 · The search bar's black outline
A focus ring rendering as a hard black box. Fix it as part of a focus-style pass across the site — if one input is wrong, others will be. Keep focus **visible and accessible**; the brass composite ring from Phase 0 is the pattern. Do not remove focus styling to make it look tidy.

### 9 · Admin settings, simplified
It has grown clumsy. Group into sections a shopkeeper understands — Delivery & rates, Cash on delivery, Returns, Store details, Appearance. One line per setting saying what it does and what happens if it is too high or too low. Plain language throughout: no "paise", no "threshold", no field names. Show the effect of a setting inline where possible ("On a ₹1,500 order to Bangalore, the customer would pay ₹X now and ₹Y at the door").

### 10 · The homepage editor — the original promise, still unbuilt
This was in the very first brief and has been deferred every phase since. `homepage_sections` exists and the homepage already renders from it. Build `/admin/appearance`:

- Add, reorder by drag, hide and delete sections.
- Per section type: hero (separate mobile and desktop images), category grid, product rail (pick products or a collection), banner, promo strip, rich text.
- Announcement bar text and scheduling.
- Preview before publish; publish revalidates the affected paths.
- Content-token support so a threshold typed here can never go stale.

### 11 · Order page clarity
`PACKED · PAID ONLINE · PAY ON DELIVERY` reads as a contradiction. Rename so the deposit is obviously a deposit — "Deposit paid" — and make the two payment amounts unmistakable at a glance.

## P3 — carried debt worth clearing if there is room

Address book at checkout (A5, reported by the owner two phases ago and still open). Image pipeline with `sharp` normalisation and upload guidance. RTO admin flow — mark received, inspect, restock on physical receipt, RTO ledger, repeat-RTO flagging. Courier selection UI using the scores already captured. Pickup addresses from the API. Per-destination delivery estimates, since the site still promises "about 4 days" to Delhi where the real ETD is seven.

---

## Improvements the owner did not ask for — include these

These come out of the state of the shop rather than a bug report. Raise them in the plan with your recommendation:

- **A health page for the owner.** One admin screen answering: is Razorpay connected and in which mode, when did the last webhook arrive, is Shiprocket authenticating, what is the wallet balance, are there orders stuck unpaid or unshipped, is any stock drifting. The owner should not need a developer to know the shop is working.
- **Stuck-order detection.** Orders captured but not confirmed, confirmed but not packed for days, shipped but not tracked. Surface them; do not wait for a complaint.
- **Production error reporting.** Server errors on a live shop must go somewhere a human sees.
- **A safe backup and recovery story**, and a plan to separate real data from the old test-harness rows now sitting beside it.
- **Rate limiting** on checkout, the webhook and admin mutations, if Stage 1 finds it missing.
- **A "first live order" runbook** in `docs/admin-guide.md`: what the owner does, in order, when a real order arrives — including what to check if a step fails.
- **Legal and policy pages** appropriate to a live Indian store: shipping, returns, privacy, terms, contact. Razorpay expects these, and the store's own returns policy needs to be findable. Flag to the owner that the no-refunds position is worth checking with someone who knows Indian consumer law before volume builds.

---

## Quality gates

- Every gate that Phase 7 skipped, actually run, with numbers: Lighthouse mobile ≥90 on `/`, `/shop`, a product page, `/cart`, `/checkout` — **on the live domain**; axe clean; zero overflow and zero sub-44px targets across all routes × six widths; a real tablet for the admin.
- `inventory_movements` reconciles to zero drift.
- Advance + balance = order total, and Shiprocket's COD collectable equals the balance, across live and flat rate modes, with and without free delivery.
- A refund cannot exceed the captured amount; a replayed refund webhook produces one refund.
- Free delivery applies identically to both payment methods, asserted.
- `cod_enabled: false` is honoured at the UI **and** the API.
- No currency literal in code or in any owner-editable content column.
- Forged Server Action posts refused, with and without a session.
- `no-unchecked-supabase-error`, the literals gate and the cached-shape gate all green.

---

## Done when

The owner can open one screen and see that payments, shipping and stock are all healthy; can refund a customer from the order page without touching Razorpay; is told exactly why Shiprocket refused when it refuses; can switch to a flat delivery fee for a festival sale and back again; can turn cash on delivery off for a week; and can rearrange the homepage — while every customer, on either payment method, is charged one delivery figure that matches what the shop was promised on the page they arrived from.
