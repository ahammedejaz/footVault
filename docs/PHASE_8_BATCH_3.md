# Foot Vault — Phase 8, Batch 3 onward

**New merge policy. Refunds first. Then the backlog that has been deferred since Phase 7.**

> Save as `docs/PHASE_8_BATCH_3.md` and tell Claude Code: *"Read docs/PHASE_8_BATCH_3.md and begin."*

---

## Decisions and corrections

**Box height is 10 cm.** The parcel default is **20 × 10 × 10 cm at 1000 g**, applied to every existing product and every product added in future. Set it, confirm the four settings are populated, and confirm Pay on Delivery is no longer refused shop-wide.

**Drop `public.shipment_errors` from production**, then let the migration create it on the next push. It is empty, so nothing is lost, and this project has already been bitten once by a table whose definition drifted from its migration — in Phase 6 a drifted `create_order_with_stock` would have stripped the stock ledger's attribution on any fresh deploy. Migrations must be the only truth about the schema.

**Merge PR #13** once CI is green.

---

## Standing rules

**1. A blocked tool means stop and report. Never switch tools to achieve the same effect.** In Batch 1 the lead hit a permission block on a migration and correctly handed the SQL to the owner. In Batch 2 a subagent hit the same block and ran the DDL through direct SQL against production instead. That must not happen again. **This rule binds subagents exactly as it binds the lead** — brief them on it explicitly before they start, and treat a subagent doing it as a defect to report, not a workaround that happened to work.

**2. Merge policy — changed.** The owner will no longer review PRs. You may merge your own work, but only within these limits.

**You may merge without asking when all of the following hold:**
- Every gate is green, run against staging, with real numbers in the report
- The change does not touch money computation, payments, refunds, auth, RLS, or admin authorisation
- It applies no migration to production
- It needs no dashboard change by the owner
- Every change carries the test that proves it

**You must stop and ask when any of these are true:**
- A production migration is involved
- The change touches how money is calculated, captured, refunded or collected
- It touches auth, RLS, `is_admin()`, or any admin action guard
- It requires the owner to change something in Razorpay, Shiprocket, Supabase, Google or Vercel
- A gate could not be run, or a change could not be tested
- You are unsure

**Every merge, without exception:**
- Take a production database snapshot first if any migration is involved
- Verify the Vercel production deployment actually succeeded — do not infer it from the merge
- Run a post-deploy smoke check and report the results: homepage 200, `/shop` 200, a product page 200, `/cart` 200, `/checkout` 200, `/admin` 404 anonymous, and the reconciler cron still scheduled
- If the smoke check fails, revert immediately and report. Do not attempt a forward fix on a live shop.

**3. The report is now the only record.** The owner is not reading diffs, so `claudeExecutionReport/` is the sole account of what happened. Keep it honest: what you built with file paths, every autonomous decision with a rationale, every bug with its root cause, every measurement as a number, **what you got wrong and caught**, and **known imperfections**. An empty imperfections list means you did not look hard enough.

**4. Documentation stays current.** `README.md`, `.env.example`, `docs/architecture.md`, `docs/database.md`, `docs/admin-guide.md`, `docs/rls-tests.md`. A stale doc is a bug.

**5. Business numbers stay the owner's.** Build mechanisms unset and failing loudly rather than inventing a value. This has already produced a live ₹150 charge derived from two settings constants, and a ₹6,499 threshold nobody chose.

**6. At most two subagents.** One writer per file. Interfaces before implementations. You integrate; subagents never merge each other's work.

**7. Do not create new bugs.** Where two changes interact, say so before writing either. Batch 2 found three real collisions that way.

---

## Batch 3 — Refunds and repair

### 3.1 · Refund mechanics — the last money hole

The shop can take money and cannot give it back. The policy matrix exists and is proven; build what actually moves the money.

- Razorpay Refunds API against the stored `razorpay_payment_id`; partial refunds supported.
- `refund.processed` and `refund.failed` webhooks — already subscribed on the live webhook — signature verified over the **raw body**, event ids stored, duplicates short-circuited. A refund is complete when the webhook says so, not when the API returns 200.
- Idempotency: unique constraint on `razorpay_refund_id`, a guard refusing to refund more than was captured, and a double-clicked button that cannot issue two refunds.
- Admin UI on the order page: choose a reason from the matrix, see the computed amount and the deduction breakdown, confirm. Never compute the amount on the client.
- Reconciliation: import refunds issued directly in the Razorpay dashboard, so anything done by hand before this shipped is not invisible forever.
- Every refund writes to `order_status_history` with amount, reason and who authorised it.
- Until this is live, the cancel path must state the exact amount, payment id and reason to refund by hand.

### 3.2 · The three fresh-build defects

Found by building staging from empty, which is the only reason anyone knows. **This is the disaster-recovery path — if production ever has to be rebuilt from migrations, it currently fails.** Fix all three and prove it by rebuilding staging from zero:

- `pg_cron` is used before it is created
- `cancel_order_with_restock` gets two overloads on a fresh replay
- `npm run seed` clobbers `site_settings.shipping`

Add a CI job, or a documented command, that builds a database from migrations and seeds it end to end. A migration set that cannot rebuild the schema is not a backup.

### 3.3 · RTO handling

Parcels will come back and there is nowhere to record it.

- Tracking reports RTO → order moves to `returning`, shown on the dashboard. **Do not restock yet.**
- Admin marks the parcel physically received and inspects it.
- **Only then** stock returns, with an `inventory_movements` row, reason `rto_return`, actor recorded.
- Damaged on return → do not restock; record the write-off with a note.
- Record the **actual** RTO charge from Shiprocket beside the quoted estimate.
- An RTO view: which orders came back, from which PIN codes, at what cost, and which phone numbers have done it more than once.

---

## Batch 4 — Operational safety

The owner runs this shop alone and is not technical. These are the things that stop a silent failure becoming a lost customer.

- **A health page.** One admin screen: is Razorpay connected and in which mode, when did the last real webhook arrive, is Shiprocket authenticating, what is the wallet balance, are there orders stuck unpaid or unshipped, is any stock drifting, is the reconciler cron running. The owner should never need a developer to know the shop is working.
- **Stuck-order detection.** Captured but not confirmed. Confirmed but not packed for days. Shipped but not tracking. Surface them; do not wait for a complaint.
- **Production error reporting.** Server errors on a live shop must reach somewhere a human sees. Today they reach nowhere.
- **Rate limiting.** Required since Phase 6 and never confirmed built. Establish what exists on checkout, the webhook, the cron route and admin mutations, and complete it.
- **Order emails.** Behind an interface, failing soft — a missing email must never fail an order. Order placed, payment captured, shipped with tracking, delivered. Provider setup is an owner task; put the exact steps in the report.

---

## Batch 5 — The deferred customer and admin work

All of this was requested and has slipped for several phases.

- **The homepage editor** (`/admin/appearance`). Promised in the very first brief and deferred every phase since. `homepage_sections` already exists and the homepage already renders from it. Add, reorder by drag, hide, delete. Per type: hero with separate mobile and desktop images, category grid, product rail, banner, promo strip, rich text. Announcement bar text and scheduling. Preview, then publish and revalidate. Content tokens so a threshold typed here can never go stale.
- **Admin settings, simplified.** Group into sections a shopkeeper understands — Delivery & rates, Cash on delivery, Returns, Store details, Appearance. One line per setting saying what it does and what happens if it is too high or too low. No "paise", no field names. Show the effect inline where you can.
- **The checkout address book** (A5, open since Phase 7). Choose, edit, add, delete, set default. Editing an address re-triggers the delivery quote, because the PIN changes the rate.
- **The image pipeline.** `sharp` normalisation into the card's aspect ratio, EXIF stripped, orientation corrected, WebP at several widths. Upload guidance in the UI — 2000 × 2000, square, plain background — a live preview in the real card frame, and a warning below 800px.
- **Per-destination delivery estimates.** The site still promises "about 4 days" to Delhi, where the real ETD is seven. The number is already in the serviceability response.
- **Courier selection.** Surface `SLA_Adherence`, `rto_performance` and `tracking_performance` at assignment, with a `courier_selection_mode` setting: cheapest, Shiprocket-recommended, or best-rated within a price tolerance.
- **Pickup addresses from the API** rather than a single env var, chosen before the quote since the pickup PIN sets the rate.
- **The search bar's black outline** — a focus ring rendering as a hard box. Fix it as a focus-style pass across the site. Keep focus visible; do not delete the styling to tidy it.
- **Order page clarity.** `PACKED · PAID ONLINE · PAY ON DELIVERY` reads as a contradiction. Make the deposit obviously a deposit.

---

## Before the shop is genuinely open

Report on each; several need the owner.

- One **real payment** end to end on live keys, then refunded through the new admin flow. Nothing else proves the chain.
- **Lift `noindex`** — only after the real payment works and refunds exist.
- **Real product photography** replacing the generated placeholders.
- **Order emails** working.
- **Legal and policy pages** appropriate to a live Indian store: shipping, returns, privacy, terms, contact. Flag again that the no-refunds position is worth checking with someone who knows Indian consumer law.
- **`site_settings.contact`** — confirm the WhatsApp number and email are real, since contacting the shop is the only route to a replacement claim.

---

## Quality gates — every batch

- All gates run **against staging**, with numbers in the report: overflow, tap targets, six widths, axe (WCAG 2.2 A/AA), Lighthouse mobile ≥90 on `/`, `/shop`, a product page, `/cart`, `/checkout`.
- `inventory_movements` reconciles to zero drift.
- Advance + balance = order total, and Shiprocket's COD collectable equals the balance — across live and flat modes, with and without free delivery.
- A refund cannot exceed the captured amount; a replayed refund webhook produces one refund.
- No currency literal in code or in owner-editable content.
- Forged Server Action posts refused, with and without a session.
- `no-unchecked-supabase-error`, the literals gate, the cached-shape gate and `audit:parcel` all green.
- Staging can be rebuilt from migrations and seed, from empty, in one command.

---

## Done when

The owner can see at a glance that payments, shipping and stock are healthy; can refund a customer from the order page; can rearrange their own homepage; and can rebuild the entire system from migrations if it ever comes to that — while every customer sees one delivery figure, one honest delivery estimate, and gets their money back when the shop cannot deliver.
