# Foot Vault — Phase 11 Brief

**Ratings, and Vault Coins. Audit first, plan second, build third.**

> Save as `docs/PHASE_11.md` and tell Claude Code: *"Read docs/PHASE_11.md and begin Stage 1. No feature code until I approve the plan."*

---

## What this phase adds

**1 · Ratings and reviews on products**, in the shape a customer recognises from any large store — a star average, a count, individual reviews, and an admin who can remove a fake one.

**2 · Vault Coins**, a loyalty programme. The customer earns coins on money actually spent, credited once a parcel is delivered. The owner sets the earn rate, sees every balance, and can spot abuse.

Both are fully controllable from the admin panel. Neither ships until it is safe.

**Vault Coins is a financial obligation, not a feature.** Every coin issued is money the shop owes against a future order. It gets the same discipline as payments and refunds: a ledger rather than a balance column, atomic redemption, and reversal when an order comes undone.

---

## Standing rules

**Three stages, with a stop between each.**

| Stage | Output | Gate |
|---|---|---|
| **1 · Audit** | `claudeExecutionReport/phase-11-audit.md` | Read-only. No feature code. |
| **2 · Plan** | `claudeExecutionReport/phase-11-plan.md` | Stop and wait for approval. |
| **3 · Build** | Code in the approved order, a report per batch | Report between batches. |

**Merge policy.** Merge without asking when every gate is green against staging with real numbers, and the change touches no money computation, payments, refunds, auth, RLS or admin authorisation, applies no production migration, and needs no dashboard change. **Vault Coins touches money by definition — all of it stops and asks.**

**Every deploy runs `audit:build-smoke` first.** A build-time outage must fail the build rather than ship routes that 500. That gate exists because it didn't.

**A blocked tool means stop and report.** Never switch tools. This binds subagents.

**At most two subagents.** One writer per file. Interfaces before implementations.

**Business numbers stay the owner's.** Build mechanisms unset and failing loudly. This project has already produced a live charge derived from two constants nobody chose.

**Every owner-facing control needs an operate-and-assert test**, and every new customer-facing page must pass `audit:reachability`.

**Reports are the only record** — the owner does not read diffs. What was built with file paths, every autonomous decision with a rationale, every bug with its root cause, every measurement as a number, what you got wrong and caught, known imperfections honestly listed.

---

# STAGE 1 — AUDIT

Read-only. Severity per finding. Evidence, not assertion.

## 11A · What already exists for reviews

A `reviews` table was created in Phase 1 and **never built into any interface**. Establish what is actually there rather than what the migration says:

- Columns, constraints, indexes as they exist in production **and** as a fresh `rebuild:stage` produces them. This project has found production and migrations diverging four times; assume nothing.
- The RLS policies on it, and whether they still say what they were written to say.
- Whether anything reads or writes it today.
- Whether `products` carries any rating aggregate, and how a listing page would get one without an N+1.

## 11B · What the shop already knows about who bought what

Vault Coins and verified reviews both depend on the same question: **can we prove this customer received this product?**

- What `orders`, `order_items` and `shipments` record, and whether `delivered_at` is populated in practice — it was added for the 24-hour damage window and may never have been exercised on a real parcel.
- How an order reaches `delivered`, and whether anything sets it automatically from tracking or only by hand.
- What happens to that state on RTO, cancellation and refund.
- Whether `order_items` retains enough after a product is soft-deleted to attribute a review or a coin credit.

**This is the load-bearing finding of the audit.** If `delivered` is unreliable, both features are built on sand and the plan has to say so.

## 11C · Where money is computed today

Coins spend like money, so they enter `computeOrderTotals` alongside the coupon and the prepaid discount.

- How the discount stack works now, and where `max_total_discount_percent` clamps.
- How coupon redemption achieves atomicity inside `create_order_with_stock`, since coin redemption must do the same and should reuse the pattern rather than invent one.
- How coupon release-on-cancellation works, since coins need the same.
- Every surface that displays a total: cart, checkout, confirmation, account, admin, and the six email templates.

## 11D · Abuse surface

Report what a determined customer could do today and what these features would add:

- What stops one person holding several accounts. Sign-in is Google-only; orders carry a phone number and an address.
- Whether guest checkout can earn coins at all, and what happens when a guest later signs in with the same email.
- What the rate limits cover, and whether a review endpoint would be covered.
- Whether admin actions on reviews and balances would be guarded by `is_admin()` inside the action, not merely by middleware.

## 11E · Everything else

Current gate coverage; whether `npm run audit` runs clean today; anything hardcoded that these features would touch.

---

# STAGE 2 — PLAN

`claudeExecutionReport/phase-11-plan.md`, then **stop**. Findings by severity, each with the proposed fix, files touched, the test that proves it, and the risk of the change. Batches with a sequence and reasoning. Interactions called out — coins and coupons both clamp against the same ceiling, and getting that wrong gives away margin.

---

# STAGE 3 — BUILD

## Batch A — Ratings

### Who may review

**Only a customer with a delivered order containing that product.** Not "anyone signed in with a badge for verified buyers" — verified purchase is the *entry condition*.

That is the whole anti-fraud design. Moderation catches fakes one at a time and costs the owner attention he does not have; requiring a delivered order makes a fake review cost the price of a pair of shoes. One review per customer per product.

### Moderation

The `reviews` table defaults `is_approved` to false. With a one-person shop, pre-moderation means reviews sit invisible for days and customers stop writing them.

**Recommend post-moderation:** a review from a verified purchaser publishes immediately, and the owner can remove it. Combined with the entry condition above, the volume of fakes should be near zero. **This is the owner's call** — build the mechanism so either is a setting, and default to whichever he chooses.

### What the customer sees

- Star average and review count on the product card and the product page.
- A rating distribution — the five bars everyone recognises.
- Individual reviews with rating, title, body, first name, date, and a "verified purchase" mark.
- Sort by recent or by rating. Paginate.
- A prompt to review from `/account/orders/[id]` once delivered, and in the delivered email.
- Where there are no reviews yet, say so plainly rather than showing an empty five stars.

### Aggregates

A listing page showing an average for thirty products must not issue thirty queries. Maintain the aggregate as data — trigger-maintained columns or a materialised view — and reconcile it in a gate, the same way `inventory_movements` reconciles against stock.

### Admin

`/admin/reviews`: list, filter by rating and product, read, remove with a reason recorded, and see who wrote it. Removal is soft — a deleted review's row survives with its reason, so a pattern of removals is visible later.

### SEO

`AggregateRating` in the existing `Product` JSON-LD, once there are real reviews. Never emit it with zero or fabricated ratings.

### Not in scope

Photographs in reviews, replies to reviews, helpfulness voting, incentivised reviews.

## Batch B — Vault Coins, earning

### The ledger

**No balance column anywhere.** `coin_transactions` with: customer, delta, reason enum (`earned` / `redeemed` / `reversed` / `expired` / `adjusted`), reference to the order it came from, actor, note, created_at. Balance is the sum. Same discipline as `inventory_movements`, and for the same reason: a mutable integer has no history, and when it goes wrong nothing says how.

Add a reconciliation check to the gates from day one.

### Earning

- **Rate is a setting.** Default shape: one coin per ₹100 spent. The owner edits it; build it unset and failing loudly rather than shipping a guessed rate.
- **Earn on goods only.** Never on delivery, never on the cash-handling fee. A customer must not earn coins on freight.
- **Earn on what was actually paid**, net of coupon and prepaid discount. Otherwise stacking discounts inflates earning.
- **Credit on delivery, not on payment.** The trigger is the order reaching delivered, which depends on 11B being solid.
- **Reverse on anything that undoes the sale.** A refund, a replacement, an RTO after a delivered state, an admin cancellation. Order ₹10,000, earn 100 coins, then get the money back and keep the coins is the obvious exploit and it must be closed in the design, not patched later.
- Credit exactly once per order. Idempotent, and proven by replaying the delivery event.
- Guests: decide explicitly whether a guest order earns anything, and what happens when that email later signs in.

### What the customer sees

Balance in the account area, a transaction history in plain language ("Earned 90 coins — order FV-2026-00712"), and what a coin is worth stated somewhere findable.

## Batch C — Vault Coins, redeeming

**This is where money leaves the shop, and it is the part the brief you gave me did not specify.**

Earning without redeeming is a number in a database. Redemption needs decisions, all of them the owner's:

| Setting | Question |
|---|---|
| `coin_value_paise` | What is one coin worth at checkout? |
| `coin_max_percent_of_order` | How much of an order may be paid in coins? |
| `coin_minimum_balance` | How many must a customer hold before spending any? |
| `coin_expiry_months` | Do coins expire, or accrue forever as an open liability? |
| `coins_count_toward_discount_ceiling` | Do coins clamp against `max_total_discount_percent`, or sit outside it? |

**Build every one of these unset and failing loudly.** Until they are set, coins accrue and cannot be spent — which is a safe resting state and a bad surprise, so say so in the admin.

### Mechanics

- Redemption is **atomic inside `create_order_with_stock`**, reusing the coupon pattern rather than inventing one. A read-then-write balance passes every single-threaded test and lets two simultaneous checkouts spend the same coins.
- **Release on cancellation**, inside `cancel_order_with_restock`, exactly as coupons do.
- Never let a balance go negative. Database constraint, not application care.
- Coins appear as their own named line on every total surface, and in the emails.
- Rounding in the customer's favour, consistent with existing policy.
- Never compute a redemption on the client.

## Batch D — Admin, and watching for abuse

- `/admin/loyalty`: the earn rate, every redemption setting with a plain-language explanation of what happens if it is set too high or too low, and a master switch.
- **Every customer's balance**, sortable, with their full transaction history.
- **Manual adjustment** with a required reason, written to the ledger like everything else — for goodwill and for correcting mistakes.
- **Abuse signals**, which is what the owner asked for: accounts sharing a phone number or delivery address, balances large relative to orders placed, accounts with coins and no delivered orders, unusual redemption velocity. Surface them; do not act automatically.
- **Total outstanding coin liability**, in rupees, on the dashboard. That number is what the shop owes, and the owner should never have to work it out.
- Disable coins for a specific customer.

---

## The decisions the owner must make

Recommendations attached; he changes any of them.

1. **Who may review** — recommend delivered purchasers only.
2. **Moderation** — recommend post-moderation, given (1).
3. **Coin value in rupees** — no recommendation, this is his margin. Note that at ₹100 per coin earned, a coin worth ₹1 is a 1% programme and a coin worth ₹5 is 5%.
4. **Maximum share of an order payable in coins** — recommend a cap, so no order can be paid entirely in coins while the shop still pays freight.
5. **Do coins count toward the 30% discount ceiling** — recommend yes, or coins become a way around a limit he set deliberately.
6. **Expiry** — recommend a window, since unexpiring coins are a liability that only grows.
7. **Minimum balance before redeeming.**
8. **Guest orders** — recommend no earning without an account.

---

## Quality gates

- All gates against **staging**, with numbers. Lighthouse against the **live domain**, never staging.
- `coin_transactions` reconciles: every balance equals the sum of its ledger.
- A delivered order credits exactly once, proven by replaying the delivery event ten times.
- A refunded, cancelled or returned order reverses its credit, and the balance cannot go negative.
- Two simultaneous checkouts cannot spend the same coins — proven under concurrent load, not sequentially.
- Coins, coupon and prepaid discount together never exceed the ceiling.
- A customer without a delivered order for a product cannot review it — asserted through the real endpoint, not the UI.
- One review per customer per product, enforced by the database.
- Review aggregates reconcile against the underlying rows.
- Every admin control operate-and-asserted; `audit:reachability` green.
- Forged Server Action posts refused, with and without a session.
- `audit:build-smoke` green before any deploy.

---

## Done when

A customer who received their shoes can rate them, sees coins appear when the parcel arrives, and can spend them on the next order — while the owner can set what a coin is worth, remove a review that isn't real, see what the programme is costing him in rupees, and find the account that is gaming it.
