# Foot Vault — Phase 9 Brief

**Audit, plan, build. The money chain is proven; now make the shop usable and openable.**

> Save as `docs/PHASE_9.md` and tell Claude Code: *"Read docs/PHASE_9.md and begin Stage 1. No feature code until I approve the plan."*

---

## Where things stand

Order **FV-2026-00623** was paid with a real card and refunded ₹135 through the admin panel, with Razorpay's refund webhook confirming it. **The full money chain is proven on live keys for the first time.** That was the last untested link.

What remains is everything between "the money works" and "a shopkeeper can run this and a stranger can buy from it."

---

## Standing rules

**1. Three stages, with a stop between each.**

| Stage | Output | Gate |
|---|---|---|
| **1 · Audit** | `claudeExecutionReport/phase-9-audit.md` | Read-only. No feature code. |
| **2 · Plan** | `claudeExecutionReport/phase-9-plan.md` | Stop and wait for approval. |
| **3 · Build** | Code in the approved order, plus `claudeExecutionReport/phase-9-*.md` per batch | Report between batches. |

**2. A blocked tool means stop and report. Never switch tools to achieve the same effect.** This binds subagents exactly as it binds the lead — brief them on it explicitly. A subagent doing otherwise is a defect to report, not a workaround.

**3. Merge policy.** You may merge without asking when every gate is green against staging with real numbers, and the change touches no money computation, payments, refunds, auth, RLS or admin authorisation, applies no production migration, and needs no dashboard change by the owner. Otherwise stop and ask. Every merge: snapshot first if a migration is involved, verify the Vercel deployment actually succeeded, run the smoke check (`/`, `/shop`, a product, `/cart`, `/checkout` all 200; `/admin` 404 anonymous; reconciler cron scheduled), and revert rather than forward-fix if anything fails.

**4. The report is the only record.** The owner does not read diffs. Include what you built with file paths, every autonomous decision with a rationale, every bug with its root cause, every measurement as a number, **what you got wrong and caught**, and **known imperfections**.

**5. Documentation stays current.** `README.md`, `.env.example`, `docs/architecture.md`, `docs/database.md`, `docs/admin-guide.md`, `docs/rls-tests.md`.

**6. Business numbers stay the owner's.** Build mechanisms unset and failing loudly rather than inventing a value.

**7. At most two subagents.** One writer per file. Interfaces before implementations. You integrate.

**8. Do not create new bugs.** Every change ships with the test that proves it. Where two changes interact, say so before writing either.

---

# STAGE 1 — AUDIT

Read-only. Severity per finding: **P0 blocking the owner or a customer now**, **P1 needed before opening**, **P2 quality**, **P3 cosmetic**. Evidence, not assertion.

## 9A · Why is a built feature invisible? — answer this first

Batch 2 reported the **flat-rate shipping toggle** and the **Pay-on-Delivery on/off toggle** as built, with gates green. The owner cannot find either on `/admin/settings`. They have now asked for these three times across two phases.

Establish what is actually true, and be specific:

- Do the settings exist in the database? Are they written by a migration?
- Does the admin UI render controls for them? On which page, behind what condition?
- Do the gates that passed actually assert that a human can see and change them, or only that the underlying function honours the value?
- Is this a rendering bug, a missing form section, a page the owner isn't looking at, or a feature that was never wired to the UI at all?

**Then answer the process question:** how did a gate pass on something the owner cannot use? That answer matters more than the fix, because it tells you what other "built" features might be in the same state. Check the rest of Batch 2's and Batch 3's claimed UI against what is reachable in the admin.

## 9B · Cancel is blocked on a fully refunded order

The owner refunded ₹135 in full, the webhook confirmed it, the page says "Everything paid online has been returned" — and **Mark Cancelled** still refuses with "this order has been paid, so cancelling it would mean refunding it."

Find the guard. The likely shape is a check on *captured* rather than on *net outstanding* (captured minus refunded). Report the exact condition, every caller that shares it, and whether the same mistake exists anywhere else that reasons about "has this order been paid."

## 9C · The customer order page contradicts itself

On FV-2026-00623 — status **CONFIRMED**, payment **Refunded** — the page simultaneously says *"We have not seen your payment settle yet… reload this page rather than paying again."* Two problems:

1. That block is showing on an order that is confirmed and refunded. Establish what condition governs it and what it should be.
2. The customer-facing timeline uses internal language: *"It is complete when Razorpay's webhook confirms it."* Customers do not know what a webhook is. Audit **all** customer-facing copy for internal vocabulary — webhook, capture, reconcile, sweep, RPC, idempotent — and list every instance.

## 9D · Everything else

- **Address editing.** Customers cannot edit saved addresses. Report what exists today at checkout and in the account area (A5, open since Phase 7).
- **Email.** Nothing is sent to anyone. Report the current interface, what is stubbed, and exactly what the owner must do to connect a provider.
- **The logo.** Find every place a logo is rendered — storefront header, footer, admin, favicon, OG image, email templates, PDF or label output — and list them against `public/brand/logo-original.png`.
- **Add-to-cart latency.** The owner reports 1–2 seconds before the UI reflects an add. Measure it, find the cause — server round trip, revalidation, missing optimistic update — and report numbers.
- **Rate limiting.** Required since Phase 6 and never confirmed. State what exists on checkout, the webhook, the cron route and admin mutations.
- **Production error reporting.** Where does a server error on the live shop go today?
- **The settings page.** Assess it as a shopkeeper would: what is on it, what is unlabelled, what needs jargon to understand.
- **Anything still hardcoded.** Re-run the literals sweep including owner-editable content columns.

---

# STAGE 2 — PLAN

`claudeExecutionReport/phase-9-plan.md`, then **stop**. Findings by severity, each with the proposed fix, files touched, the test that proves it, and the risk of the change. Batches with a sequence and the reasoning. Interactions called out. What you would defer and why. What needs the owner.

---

# STAGE 3 — BUILD

Expected priority, subject to the audit.

## Batch A — Unblock the owner

1. **The cancel guard** (9B). Compare net outstanding, not captured. Fix every caller sharing the condition.
2. **The toggles** (9A) — visible, labelled, and working on `/admin/settings`, with a test that asserts a human can see and change them, not just that the value is honoured downstream.
3. **The contradictory order page** (9C) — correct the condition, and rewrite the customer-facing copy in plain language. "Refund on its way — it usually reaches your account in 5–7 working days" rather than anything mentioning webhooks. Sweep all customer copy for internal vocabulary.
4. **The logo** — `public/brand/logo-original.png` everywhere it appears, including favicon and OG image. List each place in the report.

## Batch B — Before the shop can open

5. **Order emails**, behind an interface, failing soft — a missing email must never fail an order.
   - **To the customer:** order placed, payment captured, shipped with tracking, delivered, refunded.
   - **To the owner:** a new order has arrived, so it can be processed promptly. Include what was bought, size, the delivery address, payment method, and what the courier collects.
   - Provider setup is an owner task. Put the exact steps in the report and in `docs/admin-guide.md`.
6. **Address book.** Customers can add, edit, delete and set a default address, in the account area and at checkout. Editing re-triggers the delivery quote, because the PIN changes the rate.
7. **Rate limiting**, completed across checkout, the webhook, the cron route and admin mutations.
8. **Production error reporting** — server errors must reach somewhere a human sees.

## Batch C — Running the shop

9. **A health page.** One admin screen: Razorpay connected and in which mode, when the last real webhook arrived, Shiprocket authenticating, wallet balance, orders stuck unpaid or unshipped, stock drift, reconciler cron running.
10. **Stuck-order detection** — captured but not confirmed, confirmed but not packed for days, shipped but not tracking.
11. **The settings page, simplified.** Grouped into sections a shopkeeper understands — Delivery & rates, Cash on delivery, Returns, Store details, Appearance. One line per setting saying what it does and what happens if it is set too high or too low. No jargon, no field names, no "paise". Show the effect inline where you can.
12. **Add-to-cart latency** — optimistic update so the bag reflects instantly, with rollback on failure.

## Batch D — The deferred work

13. **The homepage editor** (`/admin/appearance`). Promised in the very first brief and deferred every phase since. `homepage_sections` exists and the homepage already renders from it. Add, reorder by drag, hide, delete. Hero with separate mobile and desktop images, category grid, product rail, banner, promo strip, rich text. Announcement bar text and scheduling. Preview, publish, revalidate. Content tokens so a threshold typed here can never go stale.
14. **The image pipeline** — `sharp` normalisation into the card's aspect ratio, EXIF stripped, orientation corrected, WebP at several widths. Upload guidance in the UI, a live preview in the real card frame, a warning below 800px.
15. **Per-destination delivery estimates.** The site still promises "about 4 days" to Delhi, where the real ETD is seven. The number is already in the serviceability response.
16. **Courier selection** — surface `SLA_Adherence`, `rto_performance` and `tracking_performance` at assignment, with a `courier_selection_mode` setting: cheapest, Shiprocket-recommended, or best-rated within a price tolerance.
17. **Pickup addresses from the API**, chosen before the quote since the pickup PIN sets the rate.
18. **The search bar's black outline** — a focus-style pass across the site. Keep focus visible; do not delete the styling to tidy it.

---

## Before the shop is genuinely open — report on each

- **Real product photography** replacing the generated placeholders. Owner task; flag it as the largest remaining blocker to opening.
- **`site_settings.contact`** — real WhatsApp number and email. Contacting the shop is the only route to a replacement claim, and the current values are placeholders.
- **Policy pages** — shipping, returns, privacy, terms, contact — findable from the footer and linked at checkout.
- **Lift `noindex`** only after photography, emails and policy pages are done.
- Flag again that the no-refunds-except-replacement position is worth checking with someone who knows Indian consumer law before volume builds.

---

## Quality gates — every batch

- All gates against **staging**, with numbers: overflow, tap targets, six widths, axe (WCAG 2.2 A/AA), Lighthouse mobile ≥90 on `/`, `/shop`, a product page, `/cart`, `/checkout`.
- `inventory_movements` reconciles to zero drift.
- Advance + balance = order total; Shiprocket's COD collectable equals the balance — across live and flat modes, with and without free delivery.
- A refund cannot exceed the captured amount; a replayed refund webhook produces one refund; **a fully refunded order can be cancelled**.
- Every admin toggle is provably visible and changeable by a human, not merely honoured downstream.
- No currency literal in code or owner-editable content; no internal vocabulary in customer-facing copy.
- Forged Server Action posts refused, with and without a session.
- Staging rebuilds from migrations and seed, from empty, in one command.

---

## Done when

The owner gets an email the moment an order arrives, can cancel a refunded order, can find and flip every switch the shop has, and can rearrange their own homepage — while a customer can edit their address, gets an email at every step in language that means something to them, and sees an honest delivery date for their own city.
