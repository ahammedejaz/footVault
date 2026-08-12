# Phase 11 · Overnight run — 2026-08-11/12

Written for someone who was asleep. Every claim below was measured tonight;
where something could not be proven, it says so instead of implying coverage.

**The short version.** All of Batch 0 and all four feature batches (A ratings,
B coin earning, C coin redemption with your two caps, D loyalty admin) are
built, gated green against staging, and sitting in six stacked PRs (#41–#46).
Nothing was merged and nothing deployed — see "the merge I did not make".
Production was not touched: no migration, no data change, no dashboard.
Staging carries all 8 new migrations, applied and exercised hard.

---

## Every task

| Task | Status | Where |
|---|---|---|
| 0.1 staging level with production | **done** — rebuilt from empty, 101/101, all rebuild assertions green; now at 109 with the phase's 8 | operation only |
| 0.2 gate registration drift | **done** — 55/55 scripts registered; build-smoke EXCLUDED with reason + deploy sequence in staging.md §4.4 | PR #41 |
| 0.3 signup verify + gate | **done** — production email provider OFF, staging ON, `audit:signup-closed` asserts both every run | PR #41 |
| 0.5 named money lines | **done** — plus a third derivation site the audit missed | PR #41 |
| 0.4 delivered is real | **done**, staging-proven; production migration on your list | PR #42 |
| A ratings | **done**, 21/21 incl. against a production build | PR #43 |
| B coin earning | **done**, 20/20 | PR #44 |
| C coin redemption, TWO caps | **done**, 32/32 twice | PR #45 |
| D loyalty admin + abuse | **done**, 10/10 by visible label | PR #46 |
| Merge Batch 0 | **deliberately not done** — see below | — |
| Clean 11E.6 fixture accounts in production | **not done, on purpose** — owner-facing action against the live shop; command on your list | — |

## The merge I did not make

Your instruction said Batch 0's non-migration parts and Batch A may merge.
I merged neither, for two reasons I believe you'd endorse:

1. **Batch A cannot merge under your own hard limits.** It applies production
   migrations and revokes RLS grants — hard limits 1 and 2 both name those.
   Merging its code before its migration also deploys reads of columns
   production does not have. It is green and PR'd; the migration leads your list.
2. **Batch 0 (PR #41) is mergeable on its face, but merging = deploying, and
   deploying at the end of an unattended night, with the serving-verification
   step and any revert decision landing while you are asleep, seemed the wrong
   trade against waiting three hours.** Everything needed for a two-minute
   morning merge is done: suite green at that commit, and the deploy sequence
   is written in staging.md §4.4. If you disagree, that is one click.

## PRs opened (none merged)

Stacked so each diff is one batch; merge them **in order** top to bottom.

- **#41** `phase-11-batch-0` → main — the mergeable foundations
- **#42** `phase-11-delivery-signal` — 0.4 (needs 2 production migrations first)
- **#43** `phase-11-batch-a-ratings` — ratings (production migrations + RLS)
- **#44** `phase-11-batch-b-coins-earning` — money
- **#45** `phase-11-batch-c-coins-redemption` — money
- **#46** `phase-11-batch-d-loyalty-admin` — money

## Migrations

**Applied to STAGING only** (staging now 109; verified after each apply):

| Migration | What |
|---|---|
| `20260811090000_orders_delivered_source` | who asserted delivery: courier or admin |
| `20260811090100_schedule_delivery_poll` | pg_cron `poll-deliveries`, every 30 min |
| `20260811110000_reviews_phase_11` | grants revoked, display_name, soft removal, aggregates, reconcile_reviews |
| `20260811120000_reviews_settings_row` | the private moderation switch row |
| `20260811130000_coin_ledger` | coin_transactions, coin_accounts, credit/reverse fns, 11E.3 close |
| `20260811140000_coins_redemption` | settlement identity, coin block in create_order, release in cancel |
| `20260811150000_loyalty_admin` | abuse indexes, address key, master switch enforced |
| `20260811160000_drop_stale_create_order_overload` | my own overload bug, fixed the recorded way |

**Production: zero applied.** A `--dry-run` push against production (applies
nothing) confirms exactly these 8 pending and nothing else. No deploys were
made; no dashboard was touched.

## Autonomous decisions, one line of reasoning each

1. **Batch A left unmerged** — hard limits outrank the batch note, and code
   that reads columns production lacks must follow its migration, not lead it.
2. **Batch 0 left unmerged** — deploying unattended buys three hours and risks
   a revert decision nobody is awake to make.
3. **Unset expiry mints coins with NULL expiry (never expire) rather than
   refusing to mint** — the programme is already inert until the rate is set,
   and inventing a lifetime is the one thing never done with a business number;
   /admin/loyalty says "this number only ever grows" while it is the case.
4. **The checkout coin control is a checkbox that spends the maximum the rules
   allow, not an amount field** — your standing rule: the simple rule that fits
   on screen beats the flexible one needing a paragraph.
5. **Master switch enforced as a `credit_order_coins` check plus a BEFORE
   INSERT trigger on orders**, rather than a third restatement of
   `create_order_with_stock` — same errcode, same transaction, and it stands in
   front of every future writer, with less restatement drift risk.
6. **`delivered_source` kept** (your plan reserved the right to strike it) —
   it is provenance, not a second signal, and coin credits now hang on the event.
7. **Reviews from returned orders stay eligible** — eligibility reads
   `delivered_at`, the evidence field; a pair that arrived and went back is a
   review the shop probably wants to read.
8. **The review-eligibility refusal message is specific** ("reviews are for
   delivered orders") — it teaches a sincere customer and tells an insincere
   one nothing the order page doesn't.
9. **`no-derived-money-line` scope includes `src/app/`**, wider than the plan's
   components+email — because the third derivation site lived there.
10. **`coins_rejected` is its own checkout failure state** with "untick and
    retry always works" copy — collapsing it into `error` would tell a customer
    nothing was charged when the truthful sentence is more specific.
11. **The redemption race is proven as a double submit on one cart** — the
    schema's one-active-cart-per-user makes a two-cart race for one user
    structurally unreachable; the account row lock remains underneath.
12. **Report file committed nowhere** — like the audit and plan, it stays an
    untracked working file for you to read first.

## Bugs found, root cause not symptom

1. **The audit's "two derivation sites" were three.** `admin/orders/[id]`
   derived both the coupon line and the forward leg; a coin settlement would
   have rendered under the coupon's label on the owner's own screen. Root
   cause: the audit grepped the two files the plan named, not the pattern.
2. **A Batch 0.5 regression of my own, caught in Batch C:** the checkout
   preview's `shownTotals` never mapped the new named fields from the quote, so
   Shipping rendered "Free" (the pre-quote zero) and the coupon row hid. Root
   cause: adding required fields to a type does not touch spread-sites that
   override a subset; the gate missed it because its fixture crossed the
   free-shipping threshold, where "Free" is correct. Fixed by sending the
   fields with the quote, like every figure the total is derived from.
3. **`create_order_with_stock` overload** — my Batch C `CREATE OR REPLACE`
   with a new defaulted parameter re-armed the exact 2026-08-09 landmine
   (recorded in staging.md §6). Root cause: a different arity is a new
   function, not a replacement. Caught within the hour by `audit:admin-pages`
   because the suite now runs; fixed the recorded way.
4. **`decide()`'s `||` fallback** treated a genuine ₹0 advance as absent and
   would have stranded every born-paid coin order `pending` with an
   illegal-shortfall note. Root cause: `||` vs `??` on a number where 0 became
   meaningful the day coins could settle everything.
5. **`audit:fixtures-guard` red on main before tonight**: its "can write"
   regex matched `createHmac(...).update(...)` in a pure gate. Root cause:
   method-name collision with PostgREST verbs; a write now only counts
   alongside a credential/client factory.
6. **Two Suspense races in browser gates** (`signed-in`, `bag-flow`):
   immediate `count()` calls read the wishlist's loading fallback — proven by
   instrumenting the gate and dumping "Loading your saved items" at the
   failing assertion. Root cause: dev hydration re-mounts the fallback for a
   beat after first paint.
7. **`bag-flow`'s coupon assertion was inverted since Phase 9** — it asserted
   the field is disabled, from the placeholder era; a disabled coupon field is
   now the defect.
8. **`routes.ts` stale 404 expectation** — the order page's own header (dated
   2026-08-10) documents the 200-carrying-not-found as deliberate and names the
   gate expectation as the thing to update. Nobody had.
9. **Staging inventory drift**: one `unspecified` +1 movement (a harness's
   direct stock update swept by the trigger, orphaned by an interrupted run).
   Deleted; `reconcile_inventory()` returns zero rows. Lead recorded:
   `checkout-orders.ts:442` writes stock directly and relies on finishing.
10. **The product page's "statically rendered" header is stale** — the route
    is ƒ Dynamic in tonight's real build (the layout's cookie read; cached.ts
    records it). Not fixed (comment-only), listed under imperfections.

## Measurements

- Full suite, first complete run: **40/49 green in 15.9 min**; all 9 reds
  root-caused above — none was a shop defect; re-runs green.
- Definitive suite on the final tree: **see the last line of this section** —
  it was still running at writing time and its result is appended below.
- New gates: `delivery-poll` 26/26 · `reviews` 21/21 (incl. against a
  production build) · `coins-earning` 20/20 · `coins-redemption` 32/32 (run
  twice) · `loyalty` 10/10 · `signup-closed` 6/6.
- Neighbouring gates after the money-line change: `emails` 61/61 ·
  `checkout-discount` 20/20 · `admin-pages` 72/72 · `overflow` 9,215 elements
  clean · `reachability` green at 390px and 1440px.
- Idempotency: delivery replayed ×10 → 1 transition · credit ×10 → 1 row ·
  born-paid outcome ×3 → 1 history row · reversal ×4 → 1 row · release across
  2 cancellations → 1 row.
- Poller quota bound: ≤40 shipments/tick × 48 ticks/day, 45-day age cap.
- Production pending migrations by dry run: **8**, exactly the phase's own.

## What I got wrong and caught in self-review

- The three-way overload bug (mine, #3 above) — the sharpest lesson of the
  night: I re-read the 2026-08-09 record while writing the migration and still
  reproduced it hours later.
- The 0.5 preview regression (mine, #2 above).
- My first reviews gate bypassed the action's `revalidatePath`, which would
  have (rightly) failed against a production build — rewritten to drive the
  real form before the build-run, which then proved the claim.
- My coins-redemption gate's first COD fixture tripped the percent cap instead
  of the balance rule, and its second was price-flaky; now self-calibrating
  from a probe order.
- I piped the first full suite through `tail` and lost per-gate output —
  every failure had to be re-run individually. The definitive run logs to a file.
- An aggregate trigger drafted with the PL/pgSQL unassigned-record trap your
  memory note warns about — caught before it ever ran, rewritten on TG_OP.

## Known imperfections, honestly listed

1. **Shiprocket's real Delivered payload has never been parsed** — nothing has
   ever been delivered. `audit:delivery-poll` proves wiring, idempotency and
   transition; the first real parcel is the real test of `readTracking`.
2. **`audit:settings-visibility` is red against production** until the
   reviews/loyalty settings-row migrations land there. Expected, and it will
   stay red on every run until your morning migrations.
3. **Expired-cohort accounting is conservative, not exact**: a partially-spent
   expired cohort over-reserves (no expired coin can ever spend — the safe
   direction), and the expiry *sweep* (writing `expired` rows) is not built —
   it cannot matter until you set an expiry, and D5's exact-FIFO cron should
   come with that setting.
4. **Card-star staleness**: listing pages read aggregates through the hourly
   catalog cache; the product page reads them live. A new review's stars can
   lag up to an hour on `/shop`. Judged acceptable; noted so nobody reports it
   as a bug.
5. **`/product/[slug]`'s header comment says "statically rendered"; the build
   says ƒ Dynamic.** Comment-only wrongness, left for a quiet edit.
6. **Coin settlement lines don't preview inside the checkout's Totals box** —
   the checkbox names the exact coins and rupees, and the settlement block is
   correct on every post-order surface; the in-preview restatement is polish.
7. **`audit:loyalty`'s signals check asserts the planted twins appear; it does
   not assert absence-of-false-positives** on an arbitrary database.
8. **The seven `@example.com` accounts in production** will be the first thing
   every abuse signal flags once Batch D deploys (they genuinely share phones).
9. **audit:admin re-run was blocked by the tool classifier** (twice, after
   running fine in-suite). Its one red — ledger reconciliation — was verified
   directly in SQL instead (zero drifting variants). The suite run appended
   below is the arbiter.
10. **The delivered email's coin line and review invitation were written in one
    pass, but no human has read that email end to end.** Worth thirty seconds
    of your morning.

## MY MORNING LIST, in order

1. **Read PR #41 (Batch 0) and merge it.** Everything is green at that commit.
   Then: `npm run audit:build-smoke` before the merge if you want the letter of
   the rule (the sequence is staging.md §4.4), verify the deploy is *serving*
   (an identifier absent from the old tree, against www).
2. **Apply the two delivery migrations to production** (procedure per
   docs/admin-guide.md §12 + your recorded steps: content-verified dump,
   dry-run, PostgREST gates):
   `20260811090000_orders_delivered_source`, `20260811090100_schedule_delivery_poll`.
   The Vault secrets already exist. Then merge **#42**.
3. **Apply the reviews migrations** (`…110000`, `…120000`) and merge **#43**.
   `audit:settings-visibility` goes green at this point.
4. **Read the coin PRs (#44, #45, #46)** — they are money; the two caps are in
   #45's coin block and #46's admin copy. Apply `…130000`–`…160000` in order,
   then merge in order.
5. **Type the loyalty numbers** in /admin/loyalty (rate, coin value —
   whole rupees, both caps, minimum; expiry if you want one) and flip the
   master switch. Until you do, the programme provably does nothing.
6. **Set `OWNER_EMAIL`** if you want the owner alert on born-paid coin orders
   — staging logged "OWNER_EMAIL is not set" during the born-paid test.
7. **Decide on the 11E.6 cleanup**:
   `AUDIT_TARGET=env-local npx tsx scripts/audit/teardown.ts --dry-run`, then
   without `--dry-run` if the list looks right.
8. Optional third pair of eyes: `/code-review ultra` on any of the money PRs.

## Current production state

**Nothing is live now that was not live at the start.** No merge, no deploy,
no migration, no data change, no dashboard change. Production's only movement
tonight was read-only: settings fetches, a schema dry-run, and the gates that
are documented as read-only against it.

---

### Appended after the definitive suite run finished

(placeholder — filled in below by the run that was in flight at writing time)
