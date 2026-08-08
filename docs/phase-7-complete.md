# Foot Vault — Phase 7 Brief (complete)

**Correctness, the money model, admin usability, image pipeline, Shiprocket completion.**

> This is the single source for Phase 7. It supersedes the earlier Phase 7 brief and the money-model addendum — delete both.
> Save as `docs/PHASE_7.md` and tell Claude Code: *"Read docs/PHASE_7.md and begin."*

---

## Standing rules

**1. Execution report** at `claudeExecutionReport/phase-7-correctness-money-model.md`: what was built with file paths; every autonomous decision with a one-line rationale; every bug found, root cause not symptom; every measurement as an actual number; **what you got wrong and caught in self-review**; **known imperfections**, honestly listed; what was deferred and to which phase; anything blocked on the owner with exact steps.

**2. Documentation stays current.** `README.md`, `.env.example`, `docs/architecture.md`, `docs/database.md`, `docs/admin-guide.md`, `docs/rls-tests.md`. A stale doc is a bug.

**3. Authority.** Full authority to fix any bug anywhere, refactor what's in your way, add migrations, change dependencies, adjust tokens where measurement justifies it. Still the owner's: business policy numbers (advance rules, thresholds, discounts, deduction policy — build the mechanism, the owner sets the values), destructive data or git operations, scope beyond this phase.

**4. Skills.** Check what's available and use every one that applies. Load **frontend-design** before UI work.

**5. At most one subagent.** The lead plus one, never more. Spend it on the **adversarial and QA pass** — Phase 5 proved a reader who didn't write the code finds a different class of bug (E-1 was an anonymous, free, unbannable way to empty the shop's stock). The subagent comes in cold after the feature work, tries to break it, and writes `claudeExecutionReport/phase-7-security-review.md`. It does not write feature code.

**6. Do not merge.** Open the PR and leave it. `main` auto-deploys to a live store, so merging is the owner's decision.

---

## Preflight

Report the state of each before starting.

1. **`RAZORPAY_WEBHOOK_SECRET`** is now set in Vercel for Preview and Production. Confirm it, and query for evidence that an order has actually reached `confirmed` via webhook.
2. **Shiprocket is now configured.** The owner has created the API user, set the pickup address, funded the wallet, and confirmed the credentials work — a live serviceability call succeeded from the terminal. The pickup location nickname is **`warehouse`** (lowercase, exact). Confirm `SHIPROCKET_EMAIL`, `SHIPROCKET_PASSWORD` and `SHIPROCKET_PICKUP_LOCATION` are set locally and in Vercel, and that the app itself authenticates — every quote in Phase 6 came from the fallback, so nothing in this codebase has yet seen a real Shiprocket rate.
3. **Has a Pay-on-Delivery advance ever been captured for real?** If not, say so, and treat that path as unverified everywhere below.

**Critical constraint on the token service.** The API user was locked out during setup by repeated failed logins. Before any live call, verify the token service logs in **once**, caches the token for its 240-hour life, re-authenticates at most **once** on a 401, and on a 403 "user blocked" **stops entirely and surfaces the error to the admin** — never retries, never silently falls back to a cached rate as though nothing happened. Re-locking the account in production would take shipping down with no obvious cause.

---

## Part A — Correctness bugs

Ordered by severity. A1 is the one that costs money and trust.

### A1 · Orders can be placed against zero stock — **critical**

The owner placed an order for a variant showing zero stock in the admin. Phase 5 built a transactional decrement that was supposed to make this impossible.

Find the actual root cause before touching anything. Candidates, all to be checked rather than guessed between:

- Does `create_order_with_stock` verify availability, or only decrement? A decrement without a guard silently produces negative stock.
- Is there a `CHECK (stock_quantity >= 0)` on `product_variants`? If not, add it — the database should make the invalid state unrepresentable rather than relying on application code remembering.
- Does add-to-bag check stock, and does checkout re-check at the moment of order creation? The cart holds optimistically by design, so the guard has to be at order creation.
- Is the size-run strip reading a stale cached value? This codebase has been bitten by `unstable_cache` before — check stock isn't served from a cache with a stale shape version.

**Then fix the whole chain, customer-facing first:**

- A zero-stock variant renders struck through in the size-run strip, is not selectable, and cannot be added to the bag.
- A product where **every** variant is out of stock shows a clear "Sold out" state on the card and the product page, with the add-to-bag control replaced rather than merely disabled.
- If stock runs out between add-to-bag and checkout, the customer is told exactly which item and size, with the rest of the bag intact.
- Negative stock is impossible at the database level.

Write a regression test that attempts to order a zero-stock variant through the real checkout path and asserts it is refused.

### A2 · `/admin/products` and `/admin/inventory` disagree about stock

The owner cannot tell which number is true, and does not know what the two pages are for. Both problems are real.

- **Find why they differ.** Likely: one reads a cached aggregate and the other live; one sums all variants including inactive, the other excludes them; one counts `stock_quantity` and the other derives from `inventory_movements`.
- **Make one authoritative.** The other reads the same function. If they must differ, label the difference on screen — "In stock (active variants)" versus "Total units including inactive".
- **Explain both pages in the UI**, one line under each page title: what it's for, when to use it.
- **Surface reconciliation.** If `sum(inventory_movements) ≠ stock_quantity` for any variant, show it in the admin rather than leaving it to a script.

### A3 · Free-shipping threshold is hardcoded in the returns banner

`Free shipping over ₹2,499` on `/page/returns` is a literal. Phase 6 deleted `shipping.flat_fee_paise` so it couldn't come back, but a hardcoded threshold survived.

Sweep the entire codebase for hardcoded money, thresholds and policy numbers — every rupee figure, every "24 hours", every "over ₹X". Each must resolve from `site_settings` or the totals function. Add a lint rule or test that fails on a currency literal in a component, so this cannot come back a third time.

### A4 · Image reordering and "Make main" do nothing

In `/admin/products/[id]`, "Make main" reports no change and up/down reordering errors. Diagnose properly — likely one of:

- the mutation succeeding but the cache not revalidating (this project uses `revalidateTag(tag, profile)` and `updateTag(tag)` for Server Actions, not the API in most training data — check `AGENTS.md`);
- `sort_order` values colliding, so a swap produces no visible change;
- the "exactly one primary" constraint rejecting the write because the new primary is set before the old is cleared, in a single statement.

Fix so reordering is drag-and-drop with optimistic feedback, "Make main" moves the image to position one, and the change appears on the storefront immediately. Assert end to end: upload two images, make the second primary, confirm the card on `/shop` shows it.

### A5 · Address edit and save controls are missing at checkout

No way to edit a saved address or save a new one. Build:

- Address book for signed-in customers: choose, edit, add, delete, set default.
- Guests: enter an address, with an offer to save it after sign-in.
- **Editing an address re-triggers the delivery quote** — the PIN code changes both the rate and the advance.
- Validation shared client and server, six-digit PIN, state as a select.

### A6 · No confirmation on sign-out

Signing out gives no feedback. Show a toast on success, redirect somewhere sensible, and confirm the header state updates (bag and wishlist badges, account icon).

### A7 · `/admin` returns 200 to anonymous visitors

Carried from two previous security reviews as **F-2**, still unfixed. A signed-in non-admin correctly gets 404 — that part works. The broken case is the anonymous visitor: `/admin` returns HTTP **200** with a not-found body, while a genuinely missing path returns 404. Nothing leaks, but the status difference discloses the route exists, which is the one thing the guard was written to hide. Fix it, and assert the status code, not the rendered body.

### A8 · No test posts to a Server Action endpoint from outside the app

Named the most valuable missing test in **two consecutive** security reviews and still absent. This phase closes it. Build a harness that posts a forged Server Action payload directly over HTTP — with a plain customer's session, and with no session — and asserts every admin action refuses. **This is the subagent's first task.**

---

## Part B — The money model

This replaces the current advance rule entirely.

### The core idea

**The Pay-on-Delivery advance is the full round trip — forward freight plus RTO freight — because on a refusal the shop pays both legs.**

But the customer must not pay twice when the parcel is accepted, so the advance is netted off the balance:

```
advance  = forward_freight + rto_freight            (quoted live per PIN, same courier)
balance  = goods_total + customer_delivery_fee − advance
```

The courier collects `balance` in cash. The customer's total is identical either way — only the timing changes. What changes for the shop is that a refused parcel is already paid for.

### Worked example — ₹1,000 order, Cuddapah → Bangalore, 1 kg

| | Amount | Source |
|---|---|---|
| Goods | ₹1,000 | cart |
| Customer delivery fee | ₹149.16 | live COD rate |
| Forward freight (shop's cost) | ₹117.36 | quote |
| RTO freight (shop's cost) | ₹115.00 | quote |
| **Advance, paid online now** | **₹232.36** | forward + RTO |
| **Balance, collected by courier** | **₹916.80** | 1000 + 149.16 − 232.36 |
| Customer total either way | ₹1,149.16 | |

**If delivered:** shop receives ₹232.36 online + ₹916.80 cash = ₹1,149.16. Pays ₹117.36 freight and ₹31.80 COD fee. Nets ₹1,000 for the goods.

**If refused:** shop keeps ₹232.36. Pays ₹117.36 forward + ₹115 RTO (Shiprocket reverses the COD fee on an RTO). Net zero, goods back in stock.

Self-balancing, and the customer never overpays.

### Guard rails — implement all of these

- **`balance` must never be negative.** On a low-value order the advance can exceed the goods total. Enforce `cod_minimum_order_value` in `site_settings` and hide Pay-on-Delivery below it, with a clear message offering prepaid instead.
- **Cap the advance** with `cod_advance_maximum_paise` so a heavy or remote order doesn't demand an absurd deposit.
- **Floor at Razorpay's 100 paise minimum** — always satisfied by this model, but assert it.
- **Both legs come from the same courier entry** in the serviceability response. Never mix a forward rate from one courier with an RTO rate from another.
- **GST.** Shiprocket bills freight plus 18%. Add an `include_gst_in_advance` setting; when on, the advance is `(forward + rto) × 1.18`.
- **Freeze the quote with the order.** Store courier, both legs, COD fee and quote timestamp on the order. If the courier assigned at fulfilment differs from the one quoted, record the variance so the owner can see drift against reality.
- **Weight comes from the product, not a default.** Shoe boxes vary — boots and flip-flops are different tiers. Use the per-variant weight and dimensions; fall back to the `site_settings` default only when they're missing, and flag products missing real values in the admin.

### What the customer sees

Three numbers, always — payment step, confirmation page, confirmation email:

```
Pay now (delivery)              ₹232.36
Pay to the courier on delivery  ₹916.80
Order total                     ₹1,149.16
```

With one plain line beneath: *"The amount you pay now covers delivery. The rest is paid in cash when your order arrives."* Never a bare "COD" label with no advance disclosed.

### Prepaid should be visibly cheaper

Prepaid orders are refused far less often than cash orders, and that is worth money to the shop — so pass some back. A **prepaid discount**, settings-driven, shown as a named line on the payment step beside the Pay-on-Delivery option. Build it as a line item in `computeOrderTotals`; the owner sets the value.

### Cancellations and refunds

**The refund owed depends entirely on when the order stopped.** Build this as an explicit table in code, not scattered conditionals — every branch derivable from the order's state and the freight actually incurred.

| Stage | Freight incurred | Prepaid refund | Pay-on-Delivery refund |
|---|---|---|---|
| Cancelled before shipment created | none | **full** | **full advance** |
| Cancelled after AWB, before pickup | usually reversed by Shiprocket | **full** | **full advance** |
| Cancelled in transit → RTO | forward + RTO | total − actual freight | **nothing** (advance covers it) |
| Refused at the door → RTO | forward + RTO | total − actual freight | **nothing** |
| Undeliverable — bad address, unreachable | forward + RTO | total − actual freight | **nothing** |
| Delivered, then damage claim | n/a | **replacement only, per policy** | replacement only |
| **Shop's own error** — wrong item, wrong size, damaged on dispatch | shop's cost | **full, no deduction** | **full advance, no deduction** |

**That last row is not optional.** "Damage during shipment only" does not cover the shop shipping the wrong shoe, and it will happen. Give the admin a "shop error — refund in full" reason on every refund, as a first-class option rather than a workaround.

### Refund mechanics

- **Razorpay Refunds API**, keyed on the stored `razorpay_payment_id`. Partial refunds supported; money returns to the original method and takes several working days.
- **New `refunds` table**: order_id, razorpay_refund_id (unique), amount_paise, reason enum (`cancelled_before_dispatch` / `rto` / `shop_error` / `other`), deduction_breakdown jsonb, initiated_by, status, timestamps.
- **Webhook-driven, exactly like payments.** Subscribe to `refund.processed` and `refund.failed`, verify the signature over the **raw body**, store the event id, short-circuit duplicates. A refund is complete when the webhook says so, not when the API returns 200.
- **Idempotency mandatory.** A double-clicked refund must never issue two. Unique constraint on `razorpay_refund_id`, plus a guard refusing to refund more than was captured.
- **Never compute a refund on the client.** The server derives it from stored amounts and actual freight.
- **Admin-initiated only** — no customer-facing refund button, matching the no-online-returns policy.
- Every refund writes an `order_status_history` row with amount, reason and who authorised it.

### RTO handling — the physical side

1. Tracking reports RTO → order moves to `returning`, shown on the admin dashboard. **Do not restock yet.**
2. Parcel physically arrives → admin marks it received and inspects it.
3. **Only then** does stock return, with an `inventory_movements` row, reason `rto_return`, actor recorded. Parcels get lost and damaged on the way back; restocking on a tracking event alone silently corrupts inventory.
4. Damaged on return → do not restock; record the write-off with a note.
5. Record the **actual** RTO charge from Shiprocket against the shipment, beside the quoted estimate.

### An RTO ledger the owner can act on

- Which orders came back, from which PIN codes, at what cost.
- Monthly logistics cost and RTO loss on the dashboard.
- **Repeat-RTO customers** — flag phone numbers or emails with more than one refusal, and let the owner disable Pay-on-Delivery for a specific customer. The tail is where losses concentrate.

### Owner settings — surface in `/admin/settings` with plain-language labels

| Setting | What it does |
|---|---|
| `cod_minimum_order_value` | Below this, Pay-on-Delivery isn't offered |
| `cod_advance_maximum_paise` | Cap on the deposit |
| `include_gst_in_advance` | Recover the 18% or absorb it |
| `prepaid_discount` | Value, and flat versus percentage |
| `customer_delivery_fee_mode` | Pass the live rate through, or charge flat and absorb the difference |
| `rto_deduction_policy` | Deduct actual freight, deduct a flat amount, or refund in full |
| `cod_enabled` | Master switch |

Each with one line on what it does and what happens if it's set too high or too low. The owner is not technical, and these decide whether the shop makes money.

---

## Part C — Image pipeline

Uploaded images don't fit the card. Fix it so the owner never has to think about it.

**Normalise server-side.** Accept any reasonable upload and produce a canonical asset with `sharp`: fit into the card's aspect ratio with `contain`, pad with the card surface colour, strip EXIF, correct orientation, emit WebP at several widths for `next/image`. A crooked phone photo of a sandal must come out looking like the rest of the catalogue.

**Tell the owner what's ideal**, in the upload UI, not buried in docs:
- Recommended: **2000 × 2000 px, square, product centred, plain light background**
- Accepted: JPEG, PNG, WebP, up to 10 MB
- Two shots per product: three-quarter view and outsole

**Feedback before upload completes.** Live preview in the actual card frame so the owner sees exactly how it will look, with a warning if the source is under 800px on either side. Client-side compression, progress bar, required alt text.

---

## Part D — Admin usability

The owner's verdict: *"admin still needs clarity and improvement. It should not be complex for new admin users."* Treat that as a first-class requirement, not polish.

- **Every page opens with one line saying what it's for** and what the owner would typically do there.
- **Name things the way a shopkeeper would.** No "variant", "SKU", "slug" or "sort_order" without a plain-language label. "Variant" is "Size & colour". "Slug" is "Web address".
- **Empty states teach** — explain what goes there and offer the action that creates the first one.
- **A guided "Add your first product" flow** — name, price, photos, sizes, stock, weight, publish — with optional fields collapsed. The full form stays for editing.
- **Destructive actions look destructive** and are reversible where possible: soft-delete with an undo window rather than a confirm dialog the owner learns to click through.
- **A dashboard answering the owner's real questions:** what came in today, what needs shipping, what's running out, what money is outstanding on delivery, what's gone RTO, what this month's logistics cost.
- **Every error says what to do next**, and links to the fix. "Shiprocket is not configured" is the right instinct — apply it everywhere.
- **Test on a real tablet.** Phase 6 only tested a 768px browser viewport. The owner will use this standing in the shop, one-handed.

---

## Part E — Shiprocket completion

### Configuration

- Confirm authentication succeeds and quotes come from the API, not the fallback. **Log which one served each quote** — a fallback must never be presented silently as a live rate.
- `shiprocketPickupLocation()` currently falls back to `"Primary"`, which is not what this account's location is called (`warehouse`), so an unset variable fails when a real parcel is created rather than at boot. **Fail loudly at startup instead.**
- **Fetch pickup addresses from `/v1/external/settings/company/pickup`** rather than trusting the env var alone. There is one address today; when a second is added, the admin should pick it per shipment from a dropdown, not need a redeploy. Note that the pickup PIN determines the rate, so the pickup location must be chosen **before** the quote, not after.

### Courier selection

Shiprocket recommends the cheapest courier, but its response also carries `SLA_Adherence`, `rto_performance` and `tracking_performance` per courier per lane — and on the tested lanes the recommended courier scored worst on all three. Surface these scores to the admin at courier assignment, and add a `courier_selection_mode` setting: cheapest, Shiprocket-recommended, or best-rated within a price tolerance. **The owner decides; you build the choice.**

### Verification

- Run the full manual chain once against the real account: create shipment → assign AWB → schedule pickup → generate label → fetch tracking → **cancel it in the panel**. Report every response verbatim; write the click-path into `docs/admin-guide.md`.
- **Assert the COD collectable equals `balance`** — not the order total, and not `grand_total`. Still the most expensive single mistake available in this codebase.
- Capture `delivered_at` from tracking — the 24-hour replacement window depends on it and is currently unenforceable.
- Note in the report that Shiprocket's paid tiers lower the base rate. The owner has no volume yet, so nothing to do now — but when a plan changes, rates flow through automatically because everything is quoted live. Confirm that holds.

---

## Quality gates

- Lighthouse mobile ≥90 on all four categories, **on the Vercel preview**, for `/`, `/shop`, a product page, `/cart`, `/checkout`.
- axe clean on every route and overlay, storefront and admin.
- Zero overflow, zero sub-44px targets, all routes × six widths, **plus a real tablet**.
- `inventory_movements` reconciles to zero drift after the full run.
- A zero-stock variant cannot be ordered — asserted through the real checkout path.
- No currency literal anywhere in a component.
- Forged Server Action posts refused, with and without a session.
- `no-unchecked-supabase-error` and the cached-shape gate stay green.

**Money-model assertions — every one measured, not eyeballed:**

1. `advance + balance = goods + delivery fee`, across a range of order values, weights and PIN codes.
2. `balance ≥ 0` always; below the COD minimum, Pay-on-Delivery is not offered at all.
3. Shiprocket's COD collectable equals `balance`.
4. A refused Pay-on-Delivery order leaves the shop at net zero: advance retained equals forward plus RTO.
5. A prepaid RTO refunds total minus actual freight; a shop-error return refunds in full.
6. A refund webhook replayed ten times produces one refund.
7. A refund cannot exceed the captured amount.
8. Stock returns on physical receipt, not on the RTO tracking event, and the ledger reconciles afterwards.
9. Courier, both freight legs and the COD fee stored on the order match what was quoted.

---

## Out of scope

Coupons and reviews (Phase 8). `/admin/appearance` homepage builder and banner scheduling, if still outstanding. Background tracking poller. Shiprocket's RTO Prediction API — note it as a future option once there's order history to feed it.

---

## Done when

A shopkeeper who has never seen this admin can open it on a tablet, understand what each page is for without asking, add a product with photos that come out looking like the rest of the catalogue, and see one stock number that is the same everywhere — while a customer cannot buy something that isn't there, sees one delivery figure from cart to confirmation, is told plainly what they pay now and what they pay the courier, and gets the right money back if the order never reaches them.
