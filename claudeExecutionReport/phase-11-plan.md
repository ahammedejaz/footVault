# Phase 11 · Stage 2 — Plan

Stage 1 approved 2026-08-11. This plan is written against
`claudeExecutionReport/phase-11-audit.md`; findings are cited by their audit
number rather than restated.

**No feature code has been written.** Nothing below has been built. This
document is the thing to argue with before anything is.

---

## Decisions already made, recorded so nobody re-opens them

**A coin is a TENDER, not a discount.** (Owner, 2026-08-11, revising the
earlier ceiling ruling.) A coin is a liability the shop already owes; redeeming
it *settles* that liability rather than reducing a price. Everything in Batch C
is built to that. It resolves audit finding 11C.1 in the direction that leaves
`orders_discount_parts_sum` untouched, and it dissolves the 20%-prepaid /
30%-ceiling squeeze the audit flagged — a customer with a large balance can now
spend it on a prepaid order, which is the order type the shop prefers.

**"Delivered" gets made real before either feature is built.** (Owner.) One
authoritative field, written by a background poller over the existing
pg_cron → pg_net → route path, with the manual admin button writing that same
field. That is Batch 0.4.

**Email signup is disabled in Supabase.** (Owner, done.) Audit finding 11D.1 is
closed at source. Batch 0.3 adds a gate so it stays closed, and deals with the
fallout: `scripts/audit/fixtures.ts` signs up with email and password, so every
browser gate depends on the door the owner just shut.

**Coins never count toward `max_total_discount_percent`.** Superseded by the
tender ruling. Two risks, two controls: `max_total_discount_percent` caps
*pricing*, `coin_max_percent_of_order` caps *settlement*. Brief decision 5 is
closed.

**No money line is ever derived by subtraction.** (Owner.) Every rendered money
figure reads a named field or does not render. Batch 0.5, and it has one
consequence the owner has not seen yet — see 0.5.

---

## The six decisions still open

Numbered as in the brief so the numbers stay stable across documents. My
recommendation and the reasoning for each; answer them together at approval.

### D1 · Who may review — **recommend: a delivered order containing that product, and nothing else**

Not "verified purchase" as a badge on top of open reviewing. As the entry
condition, so an unverified review cannot exist.

The reasoning is the audit's 11D.1, and it survives the owner closing email
signup. Even with Google-only sign-in, a Google account costs nothing and takes
forty seconds. The only thing in this system a fake reviewer cannot get cheaply
is a delivered parcel — roughly ₹1,500 in this catalogue, non-refundable after
delivery under the shop's own policy. That is the entire anti-fraud design, and
it is worth more than any moderation queue because it costs the owner no
attention at all.

It also makes the review count honest in a way that helps commercially: every
star on the site is attached to a real pair of shoes that really arrived.

**Cost of choosing this:** the shop has zero delivered orders (11B), so there
will be zero reviews on launch day, and there will be zero reviews until the
first parcel lands. The empty state is not a temporary embarrassment; it is the
state for a while. Batch A budgets for saying so plainly rather than showing
five grey stars.

### D2 · Moderation — **recommend: post-moderation**

A review from a delivered purchaser publishes immediately; the owner can remove
it afterwards, with a reason, and the row survives the removal.

Given D1, the expected volume of fakes is near zero, and pre-moderation's cost
is real and immediate: with a one-person shop, reviews sit invisible for days,
the customer who wrote one sees nothing happen, and they stop writing them. A
moderation queue that is never empty is a queue that gets rubber-stamped, which
is pre-moderation's worst outcome — the appearance of review with none of it.

Build it as a setting either way (`reviews_require_approval`), because the
mechanism costs almost nothing once the write path exists and reversing this
decision later should not need a migration.

**One thing to know:** the live RLS INSERT policy pins `is_approved = false`
(audit 11A.1), so a client-side insert can never publish under post-moderation.
The write must go through a server action holding the service role. That is the
right shape anyway — it is where the delivered-order check lives — but it means
the RLS policy is not the enforcement, the action is, and Batch A's gate has to
prove the action refuses rather than trusting the policy.

### D3 · What a coin is worth — **recommend: start at ₹1, and constrain the setting to whole rupees**

No recommendation on the *programme size* — that is margin and it is yours. But
two recommendations on the shape of the number, both of which have teeth:

**Start low and raise it later, never the reverse.** A coin's value is a
promise attached to coins already issued. Raising it is a gift customers
notice; lowering it devalues money people already hold and is the one change
that produces a complaint you cannot answer. At 1 coin per ₹100 spent, ₹1 a
coin is a 1% programme, ₹5 a coin is 5%. Set 1% now and you can move to 2% in
March; set 5% now and you are stuck with it.

**Constrain `coin_value_paise` to a multiple of 100.** This is structural, not
aesthetic. Shiprocket takes the courier collectable in whole rupees
(`fulfilment.ts:346`, `Math.round(balanceDueOnDelivery / 100)`), and
`audit:totals` asserts the balance is a multiple of 100 paise so a regression
fails in the gate rather than at a customer's door. If a coin is worth ₹0.50,
an odd number of coins settling a COD balance produces a fractional rupee that
someone has to round, and the shop finds out at the door. Whole-rupee coins
make that impossible by construction rather than by care.

**Worth seeing before you pick a number.** Under the tender model the ceiling
and the coin cap are independent, so the combined worst case is multiplicative:
30% off the price, then up to `coin_max_percent_of_order` of what remains
settled in coins. At a 50% coin cap that is a customer paying 35% of list in
actual money. That is the number to be comfortable with, not the 1%.

### D4 · Maximum share of an order payable in coins — **recommend: 50%, plus a structural rule the setting cannot override**

The setting is yours. The structural rule is not a setting and I recommend
building it as an invariant:

> **On a Pay-on-Delivery order, coins settle the balance due at the door
> first, and may never reduce the advance.**

The advance on a COD order is the round-trip freight — forward plus RTO — and
it exists so that a refused parcel is already paid for. Coins eating the
advance would hand back exactly the protection Phase 7 built, and it would do
it silently. Coins settle the cash at the door; the freight deposit stays in
real money.

On a prepaid order there is only the advance, so coins reduce it — with one
hard edge: **Razorpay throws below 100 paise** (`razorpay.ts:745`,
`MIN_CHARGEABLE_PAISE`), and `initiatePayment` catches that and rolls the whole
order back. So a coin settlement must either leave at least ₹1 on the card or
settle the order *entirely*, in which case payment initiation is skipped and
the order is born paid. Anything between 1 and 99 paise is an order that
cancels itself after being created. Batch C treats this as a first-class case,
not an edge.

50% because it keeps every order carrying real money, and because a customer
who can pay for a whole pair in coins has been given a free pair by a
programme that was meant to encourage a second purchase.

### D5 · Expiry — **recommend: 12 months, oldest coins spent first**

Unexpiring coins are a liability whose only direction is up, and it is a
liability with no matching asset — every coin outstanding is a discount the
shop has already promised on a sale it has not made. Twelve months is long
enough that a customer who buys shoes even once a year never loses any, and
short enough that a dormant account clears itself.

Two mechanics that go with it, both cheap if decided now and expensive if
retrofitted:

- **FIFO.** Redemption consumes the oldest unexpired coins first, so a
  customer's balance never contains coins that will die before the ones they
  just spent. The alternative (LIFO, or an undifferentiated pool) means an
  active customer can still lose coins, which reads as a bug.
- **Expiry is a ledger row, not a filter.** A cron writes `expired` rows with a
  negative delta. Balance stays `sum(delta)` with no date arithmetic anywhere,
  the customer's history shows what expired and when, and the reconciliation
  gate keeps working unchanged.

If you would rather not expire coins at all, say so and I will build it — but
the plan should then include the outstanding-liability tile on the dashboard as
a **P0** rather than a Batch D nicety, because that number becomes the only
thing watching it.

### D6 · Minimum balance before redeeming — **recommend: 50 coins**

At 1 coin per ₹100 and ₹1 a coin, 50 coins is about ₹5,000 of spend — roughly
three orders in this catalogue. That is the right feel: reachable enough that a
returning customer gets there without trying, high enough that the ledger is
not churning ₹3 redemptions.

The failure mode to avoid is a floor high enough that most customers never
reach it. A programme nobody can spend from is not a loyalty programme, it is a
liability with good PR — and it is worse than no programme, because the balance
is visible in the account area and reads as a promise being withheld.

### D7 · Guests — **recommend: a guest order earns nothing, and signing up later does not backfill it**

Agreed with the brief, and the audit found the second half, which the brief did
not ask about. `adopt_guest_orders()` matches on the **guest cookie token, not
the email** (audit 11D.2) — deliberately, and correctly, because an email
address is not proof of anything. So a guest who checks out, clears their
cookies, and signs up a week later with the same address does not get the order
at all, let alone coins for it.

That is the right security answer and a bad surprise, so the plan makes it
visible rather than silent: the confirmation page's existing "create an
account" invitation gains a sentence saying that doing it *now* keeps the order
and earns coins on it, and doing it later does not. That is a copy change on a
page that already exists, and it converts a support email into a conversion
prompt.

---

# The batches, and why in this order

| Batch | What | Gate | Merge |
|---|---|---|---|
| **0** | Foundations — staging, gate registration, signup closure, **delivery**, the subtraction rule | every existing gate green | asks (migration + money path) |
| **A** | Ratings | new + `audit:reachability` | asks (production migration) |
| **B** | Coins, earning | new + reconciliation | **stops and asks** (money) |
| **C** | Coins, redeeming | new + concurrency | **stops and asks** (money) |
| **D** | Admin, abuse signals, liability | operate-and-assert | **stops and asks** (money) |

Batch 0 is not preamble. Three of its five items are blockers in the literal
sense — without them the later batches cannot be measured, cannot be merged, or
cannot be built at all. B cannot start before 0.4, because "credit on delivery"
has no event to hang on. Nothing can be *reported* before 0.1 and 0.2, because
the suite exits 1 for reasons unrelated to the work.

---

# Batch 0 — Foundations

## 0.1 · Bring staging level with production

**Finding:** 11E.4. Staging is at 100 applied migrations, production at 101.
The repository holds 101.

**Fix:** `npm run rebuild:stage`, which drops, replays all 101 and runs its own
seven assertions. Then re-run the audit's schema comparison — per-table column
signature, index signature, policy signature, function signature — across both
projects and confirm the only differences are the three cosmetic function
bodies from 11E.5.

**Files:** none. This is an operation, not a change.

**Test:** `supabase_migrations.schema_migrations` reports 101 on staging;
`rebuild:stage`'s own assertions pass; the four signature comparisons match.

**Risk:** low. `rebuild:stage` is structurally staging-only — the connection
string is built from `STAGING_PROJECT_REF` and there is no flag to point it
elsewhere. It destroys staging data, which is the point.

## 0.2 · Fix the gate registration drift

**Finding:** 11E.1 and 11E.2. Nine `audit:*` scripts are in neither `GATES` nor
`EXCLUDED`, and `checkForDrift()` makes that `exit 1`. Two of the nine —
`audit:reachability` and `audit:build-smoke` — are required by this brief.

**Fix:** each of the nine is either added to `GATES` in the right position or
added to `EXCLUDED` with a reason. My proposal, to be argued with:

| Script | Proposal | Why |
|---|---|---|
| `audit:reachability` | **GATES**, after `audit:links` | required by this brief; browser gate, belongs with the other crawls |
| `audit:settings-visibility` | **GATES**, with the pure gates | seconds to run, and it is what will police the new loyalty settings row |
| `audit:homepage-tokens` | **GATES**, pure | cheap, static |
| `audit:appearance` | **GATES**, browser | it is a real assertion about a real page |
| `audit:courier-choice` | **GATES**, after `audit:shipping` | same family |
| `audit:delivery-estimate` | **GATES**, after `audit:delivery` | same family |
| `audit:images` | **GATES**, pure | cheap |
| `audit:image-upload` | **GATES**, browser | operate-and-assert on an owner control |
| `audit:build-smoke` | **EXCLUDED**, with a reason | it runs a full production build against **production data** and serves it; it is the deploy gate, not a suite member, and putting it in the suite would add minutes to every run and point a build at the live database |

`audit:build-smoke` staying out is the one I expect argument on, so the reason
is written into `EXCLUDED` rather than into this document: it is required
*before a deploy*, which is a different trigger from *before a merge*. Naming
it in `EXCLUDED` also makes it visible in the file rather than absent from it,
which is the drift check's whole purpose.

**Files:** `scripts/audit/run-all.ts`.

**Test:** `npm run audit` reaches its summary with `drift.length === 0`. Any
gate newly added that turns out to be red is a **finding**, reported before it
is fixed — several of these have not run inside the suite for some time and I
am not going to assume they pass.

**Risk:** low in code, unknown in outcome. Adding eight gates to a suite that
has not run them may surface real failures. That is the point, and the report
between batches will say what they were.

## 0.3 · Keep email signup closed, and unbreak the fixtures

**Finding:** 11D.1, closed at source by the owner.

**Fix, two parts.**

**The gate.** A pure assertion in `audit:fixtures-guard` (or its own tiny gate)
that fetches `/auth/v1/settings` from **production** and fails if
`external.email` is true, or `disable_signup` is false, or
`mailer_autoconfirm` is true. Read-only, no auth needed, one HTTP call. It
turns an owner action into a standing invariant, which is the difference
between fixed and fixed-until-somebody-clicks-something.

**The fallout, which is the larger half.** `scripts/audit/fixtures.ts` builds
its accounts with email and password. With the provider off, **every browser
gate stops working** — `audit:auth`, `audit:cart`, `audit:bag`,
`audit:signedin`, `audit:checkout`, `audit:admin`, `audit:admin-pages`,
`audit:reachability`, and the rest. This is not optional cleanup; it blocks
Batch A's first gate.

Two ways out:

1. **Leave email signup enabled on *staging* only**, and gate production. The
   fixtures point at staging by construction (`scripts/audit/clients.ts`
   refuses production), so this costs nothing and changes no harness code. The
   gate in the first half asserts against production specifically.
2. Move fixtures to `auth.admin.createUser()` with the service role, which
   works regardless of provider settings.

**I recommend (1)**, and it is close to free: staging is a database no customer
can reach, the fixtures already only run there, and (2) is a rewrite of the
file every browser gate depends on, undertaken in the same phase that adds two
features. Do (2) later if ever.

**Files:** `scripts/audit/fixtures-guard.ts`, and a line in `docs/staging.md`
recording that the two projects deliberately differ on this one setting and
why.

**Test:** the new assertion fails when pointed at a project with the provider
on (verify by pointing it at staging, where it must fail); passes against
production.

**Risk:** low, and it removes a P0.

## 0.4 · Make "delivered" real

**Finding:** 11B.1, 11B.2, 11B.3. This is the largest single piece of work in
the phase and everything in B and C depends on it.

**The 24-hour damage window has been unenforceable since it was written.**
`withinReplacementWindow` (`src/lib/actions/admin/orders.ts:295`) returns
`null` when `delivered_at` is null, and `delivered_at` is null on every order
that has ever existed. The shop's stated returns policy — a replacement for
damage in shipment reported within 24 hours — has never had a clock behind it.
`recordReplacement` prints "*(No delivery timestamp on this order.)*" and
proceeds. That is not a Phase 11 regression; it is a Phase 7 promise that was
never wired, and this batch is the first time anything has needed it enough to
notice.

### The design

**`orders.delivered_at` is the authoritative field.** It already exists, it is
already the evidence field, and `fetchTracking` already writes it correctly —
courier's own timestamp, never `now()`, written once and never moved
(`fulfilment.ts:942-995`). Nothing about that logic changes.

**What changes is who calls it, and what follows from it.**

1. **A poller calls `fetchTracking` on every in-flight shipment.** Not a second
   implementation — the same function, for the same reason the abandoned-order
   reconciler lives in the app rather than in a Deno edge function: two
   implementations of "has this parcel arrived" is how they drift, and RTO
   detection is wired into that function too.

2. **Reaching `delivered_at` transitions the order.** The poller, having
   stamped it, calls `transitionOrder(… to: "delivered")` — which writes the
   history row and sends the delivered email through the path that already
   exists. Status becomes a *consequence* of the authoritative field rather
   than a competing signal. This is the inversion the owner asked for.

3. **The manual button writes the same field.** `transitionOrder`, when moving
   to `delivered`, stamps `delivered_at = coalesce(delivered_at, now())` in the
   same compare-and-swap. The owner marking a parcel delivered no longer
   produces an order with no delivery timestamp.

4. **Provenance is recorded.** A new `orders.delivered_source text` — `'courier'`
   or `'admin'` — set beside the timestamp.

   *This is my judgment call and the owner should overrule it if he disagrees.*
   It is not a second delivery signal: there is still exactly one field that
   answers "when", and nothing branches on the source for correctness. It
   exists because two conversations need it. A customer disputing the damage
   window deserves to know whether the clock started when the courier said so
   or when the shop clicked; and a coin credit that turns out to be wrong
   should be traceable to the assertion that caused it. Without it, "delivered
   Tuesday" is unfalsifiable.

### The mechanism

Identical in shape to the reconciler, because that path is proven and the
project is on Vercel's Hobby plan where sub-daily cron expressions fail the
deployment outright:

```
pg_cron  ──▶  private.trigger_delivery_poll()   [SECURITY DEFINER, vault secrets]
              └─▶ net.http_post  ──▶  POST /api/cron/poll-deliveries
                                       Authorization: Bearer <cron_secret>
                                       └─▶ fetchTracking(shipment)  ×N
                                            └─▶ delivered_at, then transitionOrder
```

**Which shipments.** `awb_code is not null`, `delivered_at is null`,
`rto_at is null`, order status `shipped`, and `created_at > now() - interval
'45 days'`. The age cap matters: without it a parcel lost in 2027 is polled
forever, and Shiprocket's quota is finite.

**How often.** Every 30 minutes. The reconciler runs at 10 because a charged
customer is being cancelled; a delivery discovered 30 minutes late costs
nothing.

**Batch size.** Capped per tick, same reasoning as the reconciler's cap — an
unbounded batch after an outage is a self-inflicted rate-limit incident on the
API that moves the shop's parcels.

**Never act on an unknown.** A timeout, a 500, an unparseable payload leaves
the shipment exactly as it was for the next tick. Inherited verbatim from the
reconciler route's stated rule, and it matters more here because the action
this route triggers now mints money.

### Files

| File | Change |
|---|---|
| `supabase/migrations/<new>_delivered_source.sql` | `orders.delivered_source text`, CHECK in `('courier','admin')`, nullable |
| `supabase/migrations/<new>_schedule_delivery_poll.sql` | `private.trigger_delivery_poll()` + `cron.schedule` |
| `src/app/api/cron/poll-deliveries/route.ts` | new; mirrors `release-abandoned-orders/route.ts` |
| `src/lib/shipping/fulfilment.ts` | `fetchTracking` sets `delivered_source`; extract the in-flight selector |
| `src/lib/orders/transition.ts` | `to === 'delivered'` stamps `delivered_at` and `delivered_source = 'admin'` inside the CAS |
| `src/lib/queries/admin/health.ts`, `src/app/admin/health/page.tsx` | a liveness tile — last poll, parcels in flight |
| `scripts/audit/delivery-poll.ts` | new gate |

### Test

`audit:delivery-poll`, against staging, driving the real route:

- a shipment whose mocked tracking says Delivered gets `delivered_at` **equal
  to the courier's timestamp**, not `now()`
- its order reaches `delivered`, with a history row and the delivered email
  dispatched through the existing adapter
- **replaying the same tracking payload ten times produces one transition, one
  history row, one email** — the brief's idempotency requirement, proven here
  rather than in Batch B where it would be proven against coins
- a shipment whose tracking errors is untouched, and is picked up next tick
- an RTO payload still routes to `detectRtoFromTracking` and does **not** mark
  delivered
- the manual admin button produces `delivered_at` non-null and
  `delivered_source = 'admin'`
- `withinReplacementWindow` returns a real boolean for both

### Risk

**The highest in the phase, and it should be built first for that reason.**
It touches `transitionOrder`, which every status change in the shop goes
through, and it introduces an automated writer to a table that until now only
humans wrote to. The specific dangers:

- **A false delivery mints coins.** Mitigated by trusting only the courier's
  own parsed timestamp — the existing `deliveredTimestamp(tracking)` — and by
  never inferring delivery from a status string the parser does not recognise.
- **A duplicate transition sends a second email.** Mitigated by the CAS already
  in `transitionOrder` and proven by the ten-replay test.
- **Shiprocket quota.** Mitigated by the in-flight filter, the age cap and the
  batch size. Worth a number in the batch report: parcels in flight × 48 polls
  a day.
- **It runs against production the moment it merges.** The cron job is
  scheduled by a migration. The production migration procedure applies:
  content-verified dump, dry-run push, PostgREST gates.

---

## 0.5 · Every money line reads a named field

**Finding:** 11C.2. `totals.tsx:70` and `order-confirmation.ts:138` both
compute the coupon line as `discountTotal − prepaidDiscount`.

**Three mechanisms, because one is not enough.**

**1 · Remove today's two instances by typing them away.** `OrderTotals`
(`src/lib/orders/types.ts:277`) gains a required `couponDiscount: number`.
`CheckoutTotals` already carries one; the order read paths
(`src/lib/queries/orders.ts`, `src/lib/queries/admin/orders.ts`) populate it
from `orders.coupon_discount`, which has existed since Phase 9. Both
subtractions become a field read. This is the same move that made
`prepaidDiscount` required, and the comment explaining why is already in the
file.

**2 · Stop the next one with a lint rule.** `eslint-rules/no-derived-money-line.mjs`,
registered as `footvault/no-derived-money-line`, error. It flags binary `-` or
`+` where either operand is a member expression on an identifier named
`totals` / `order` / a value of type `OrderTotals`, inside `src/components/`
and `src/lib/email/`. Same posture as
`eslint-rules/admin-actions-must-guard.mjs`: make forgetting impossible rather
than unlikely. Three custom rules already exist; this is a fourth in the same
shape.

**3 · Assert the rendering.** Extend `audit:emails` and add to
`audit:checkout-discount`: build a totals object where **every part is
distinct and non-zero** — subtotal, prepaid, coupon, coins, delivery, COD
handling — render the confirmation email and the `Totals` component, and assert
each named line shows its own field's value. A subtraction bug survives a test
where two parts happen to be equal or zero; it cannot survive this one.

### The consequence the owner has not seen

Applied strictly, the rule also catches a line the codebase deliberately
derives:

```ts
// src/components/checkout/totals.tsx:59
const forwardLeg = totals.shippingFee - totals.codHandlingFee;
```

`shippingFee` is documented as "the total, of which `codHandlingFee` is the
Pay-on-Delivery part", and the comment says *"this is the only place that
subtraction happens"*. It is defensible and it has never been wrong.

It is also, structurally, exactly the shape that produced the ₹150. **I
recommend adding a named `forwardShippingFee` to `OrderTotals` and deleting the
subtraction**, so the rule is absolute and the lint rule needs no exemption
list. A rule with one blessed exception is a rule that acquires a second.

**Files:** `src/lib/orders/types.ts`, `src/lib/orders/totals.ts`,
`src/components/checkout/totals.tsx`, `src/lib/email/order-confirmation.ts`,
`src/lib/queries/orders.ts`, `src/lib/queries/admin/orders.ts`,
`eslint-rules/no-derived-money-line.mjs`, `eslint.config.mjs`,
`scripts/audit/emails.ts`, `scripts/audit/checkout-discount.ts`.

**Risk:** medium. It touches every totals read path, which is the money
display layer on six surfaces. It touches no arithmetic — `grandTotal` is
unchanged — and the type change makes every incomplete call site a compile
error rather than a silent zero. Doing it in Batch 0, before coins exist, means
the coin line lands in a codebase where the rule is already enforced.

---

# Batch A — Ratings

Depends on 0.4 (delivered is real) and 0.2 (`audit:reachability` runs).

## A.1 · The write path

**Server action, service role, delivered-order check inside the action.** Not
RLS — audit 11A.1 established that the live INSERT policy has no purchase
predicate and that `authenticated` holds full DML grants on `reviews`. The
policy cannot express "has a delivered order containing this product" without a
subquery on `orders`, and under post-moderation the policy's `is_approved =
false` pin makes client insert useless anyway.

So: `src/lib/actions/reviews.ts`, and **revoke the client's write grants
entirely** —

```sql
revoke insert, update, delete on public.reviews from anon, authenticated;
```

— which closes 11A.1 at source rather than out-guarding it. The four customer
write policies become dead letters; drop them in the same migration so the next
reader is not misled about where enforcement lives.

**Rate limiting.** A new `reviewWrite: [5, 60]` policy. Audit 11D.3 found that
customer actions rate-limit by hand with nothing enforcing it, and this is the
first customer-facing write since the cart. Note that `consumeRateLimit` allows
on error — correct for a bag, and I am leaving it, because a dead limiter
blocking a review is worse than a dead limiter allowing one.

**Eligibility**, resolved server-side in one query: an order with
`delivered_at is not null` and `user_id = auth.uid()` carrying an `order_item`
whose `product_id` matches. Audit 11B confirmed `order_items.product_id`
survives a soft delete, so this holds for discontinued products.

## A.2 · The reviewer's name

**Finding:** 11A.2. `profiles` is self-or-admin only, and the product page
reads through the cookieless anon static client.

**Fix: denormalise.** `reviews.display_name text not null`, written by the
action from `profiles.full_name` at the moment of writing, first name only. It
is the only one of the three options that keeps the product page on
`createStaticClient()` — and that client is not an implementation detail, it is
why `/product/[slug]` does not wait on cookies before the LCP image.

Snapshotting rather than joining is also the honest model: a review is a
statement made at a time by a person with a name then, in the same way
`order_items` snapshots what was bought.

## A.3 · Aggregates

Trigger-maintained columns on `products`: `review_count integer not null
default 0` and `rating_sum integer not null default 0`. The average is derived
where it is rendered; storing a sum and a count keeps the trigger exact
integer arithmetic with no float drift.

Both go into `PRODUCT_FIELDS` (`src/lib/queries/catalog.ts:58`), which means
**zero additional round trips** on the listing — audit established it is
already two queries whatever the filters.

`public.reconcile_reviews()` mirroring `reconcile_inventory()`, driven by a
gate, exactly as the brief asks.

## A.4 · Cache

**Finding:** 11A.3. `cachedProductContent` is `unstable_cache`d for an hour;
post-moderation means a review publishes immediately, and immediately is not
within the hour.

**Fix:** the review list joins the live path, like stock. `cachedProduct`
already composes cached content with `detailWithLiveStock` for exactly this
reason. Reviews get the same treatment: content cached, reviews and aggregate
read live, one indexed query on `reviews_product_approved_idx`.

The alternative — `revalidateTag(CATALOG_CACHE_TAG)` on every review write —
drops the entire catalog cache for one review, on the LCP path.

**This cannot be proved under `next dev`.** Dev re-renders every request, so a
missing revalidation passes. The gate runs against `build:stage`.

## A.5 · Surfaces

- Product card and product page: average, count, and the five-bar distribution
- Review list: rating, title, body, first name, date, verified-purchase mark;
  sort by recent or rating; paginated
- **Empty state that says there are no reviews yet**, never five grey stars —
  and given D1 this is the state for a while
- `/account/orders/[id]`: a prompt to review, once delivered
- The delivered email gains the prompt
- `AggregateRating` in the existing `Product` JSON-LD
  (`src/app/(storefront)/product/[slug]/page.tsx:95`) **only when
  `review_count > 0`** — never emitted with zero, never fabricated
- `/admin/reviews`: list, filter by rating and product, read, remove with a
  required reason, see who wrote it. Removal is soft — `removed_at`,
  `removed_reason`, `removed_by` — so a pattern of removals stays visible

## Files

`supabase/migrations/<new>_reviews_phase_11.sql` (grants, policies,
`display_name`, soft-removal columns, aggregate columns, trigger,
`reconcile_reviews`), `src/lib/actions/reviews.ts`,
`src/lib/queries/reviews.ts`, `src/lib/queries/admin/reviews.ts`,
`src/lib/queries/catalog.ts`, `src/lib/queries/cached.ts`,
`src/components/storefront/reviews/*`, `src/components/storefront/product-card.tsx`,
`src/app/(storefront)/product/[slug]/page.tsx`,
`src/app/(storefront)/account/orders/[id]/page.tsx`,
`src/app/admin/reviews/page.tsx`, `src/lib/actions/admin/reviews.ts`,
`src/components/admin/nav.ts`, `src/lib/email/lifecycle.ts`,
`src/lib/rate-limit.ts`.

## Test — `audit:reviews`

- **a customer with no delivered order for a product cannot review it, asserted
  through the real Server Action, not the UI** (brief requirement)
- an `anon`/`authenticated` PostgREST INSERT is refused after the revoke —
  this is 11A.1 proven closed, and it is the one I most want to see red before
  it goes green
- one review per customer per product, enforced by the database — the existing
  `reviews_one_per_customer` unique index, asserted by a duplicate insert
- aggregates reconcile against the underlying rows, before and after a removal
- a removed review disappears from the storefront and survives in the table
  with its reason
- JSON-LD carries no `AggregateRating` at zero reviews and a correct one at N
- the product page shows a new review **immediately**, under `build:stage`
- `audit:reachability` green — the new customer-facing surfaces are reachable
  by clicking, at 390px and 1440px
- every `/admin/reviews` control operate-and-asserted by visible label

## Merge

**Asks.** It applies a production migration.

---

# Batch B — Coins, earning

Depends on 0.4. **Stops and asks.**

## B.1 · The ledger

```
coin_transactions
  id            uuid pk
  user_id       uuid not null → profiles(id)
  delta         integer not null            -- signed; never zero
  reason        coin_reason not null        -- earned|redeemed|reversed|expired|adjusted
  order_id      uuid null → orders(id)
  actor         uuid null                   -- the admin, for `adjusted`
  note          text null
  expires_at    timestamptz null            -- set on `earned` only, for FIFO
  created_at    timestamptz not null default now()

  unique (order_id, reason) where order_id is not null
```

**No balance column anywhere.** Balance is `sum(delta)`.

**The unique index is the idempotency.** `(order_id, reason)` means a delivery
event replayed ten times inserts one `earned` row and collides nine times —
the same trick `coupon_redemptions.unique(order_id)` uses, and the reason the
brief's "credit exactly once, proven by replaying the delivery event ten times"
is a database guarantee rather than an application one.

**Grants follow `inventory_movements`, not `coupon_redemptions`** (audit
11E.3): revoke `insert, update, delete` from `anon` and `authenticated`, RLS
policy `SELECT` only. Two customer-facing policies — a customer reads their own
rows, an admin reads all — and no write policy for anyone. Rows are written by
`SECURITY DEFINER` functions and the service role. The `ensure_rls` event
trigger enables RLS automatically but does **not** revoke the default DML
grants; that is how `reviews` came to have them, and the migration must be
explicit.

**While in the neighbourhood:** revoke `coupon_redemptions`' write grants from
`anon` and `authenticated` too. One line, closes 11E.3.

**`coin_accounts`** — one row per customer, holding the per-customer disable
switch Batch D needs and, more importantly, **the row Batch C locks**. Not a
balance. See C.1.

## B.2 · Earning

- **Rate is a setting, built unset and failing loudly.** `coin_earn_per_rupee`
  or its inverse; no default, no guessed value. Until set, delivery credits
  nothing and says so in the admin — an owner opening `/admin/loyalty` sees
  "the programme is not earning" rather than silence.
- **Goods only.** The base is `orders.subtotal`, never `shipping_fee`, never
  `cod_handling_fee`.
- **Net of what was actually paid for the goods** — `subtotal −
  discount_total`. Under the tender ruling `discount_total` is coupon plus
  prepaid and nothing else, so this stays a clean two-term expression. Coins
  spent on the order do **not** reduce the earn base: coins settled a debt, they
  did not reduce the price. That falls straight out of the tender model and it
  is one of the reasons the model is cleaner.
- **Credited on delivery** — hooked to the transition Batch 0.4 makes real, in
  the same transaction as the status change wherever that is possible.
- **Guests earn nothing** (D7). `user_id` is null; the credit does not run.
  Logged, not silent.
- `expires_at` set from `coin_expiry_months` at credit time (D5), so expiry is
  a property of the coins rather than a query written later.

## B.3 · Reversal

**Finding:** 11B.3 — the hardest piece in the phase, and it has no SQL home
today.

Three triggers, and they can overlap on one order:

| Trigger | Path today | Reversal hook |
|---|---|---|
| `delivered → returned` | `transitionOrder`, TypeScript | new SQL function, called inside the transition |
| A refund on a delivered order | `recordAndApplyRefund` | the same function, at the existing idempotent seam |
| RTO after delivery | cannot happen — `detectRtoFromTracking` requires `shipped` | n/a, verified |

`cancel_order_with_restock` is **not** a reversal hook for earned coins: it
refuses `delivered` and `returned` outright, which is exactly the state earned
coins live in. It *is* the hook for redeemed coins — see C.3.

**`public.reverse_order_coins(p_order_id, p_reason, p_actor)`** — SECURITY
DEFINER, idempotent on `unique (order_id, reason)`, writing a `reversed` row
whose delta is the negative of the `earned` row for that order. Called from
both paths. One implementation, for the reason the reconciler route states at
length: two implementations of "undo this money" is how they drift.

**The balance may go negative on reversal, and that is correct** — a customer
who earned 100, spent 100, then got a refund genuinely owes 100. The constraint
in C.2 forbids a *redemption* that would take the balance below zero; it does
not forbid the ledger reaching a negative balance through a reversal. Those are
different rules and conflating them would either allow the exploit or block the
honest reversal. Batch D surfaces negative balances as an abuse signal.

## B.4 · What the customer sees

Balance in the account area; history in plain language ("Earned 90 coins —
order FV-2026-00712"); what a coin is worth, stated on a findable page. The
delivered email says how many coins the parcel earned.

## Test — `audit:coins-earning`

- reconciliation: every balance equals the sum of its ledger
- **a delivered order credits exactly once, proven by replaying the delivery
  event ten times** — and note this is now a *second* proof of the same
  property, because 0.4 already proves the transition is idempotent. Both are
  worth having: 0.4 proves one transition, this proves one credit
- earn base excludes delivery and the COD fee — asserted on an order carrying
  both
- earn base is net of coupon and prepaid — asserted on an order carrying both,
  with the ceiling engaged
- a refunded / cancelled / returned order reverses its credit, exactly once,
  through each of the two hooks
- a guest order credits nothing
- an unset rate credits nothing and logs
- the ledger's grants: an `authenticated` PostgREST insert is refused

## Merge

**Stops and asks.** Money.

---

# Batch C — Coins, redeeming, as tender

Depends on B. **Stops and asks.**

## C.0 · What "tender" means in the schema

The audit's 11C.1 blocker dissolves. `discount_total` keeps meaning *reductions
in price*; `orders_discount_parts_sum` survives unchanged; coins never enter
the discount parts.

What changes instead is the settlement identity:

```sql
-- today
orders_advance_balance_sums  CHECK (advance_amount + balance_due_on_delivery = grand_total)

-- with coins as tender
orders_settlement_sums       CHECK (advance_amount + balance_due_on_delivery + coin_paid = grand_total)
```

`orders.coin_paid bigint not null default 0`, plus `coin_spent integer not null
default 0` — the money settled and the coins that settled it, both stored,
because `coin_paid / coin_value_paise` reconstructed later is a division that
lies the moment the owner changes what a coin is worth.

**`orders_total_adds_up` is untouched.** `grand_total` is still
`subtotal − discount_total + shipping_fee + tax_total`. Coins do not change
what the order costs; they change who pays which part of it. That is the whole
point of the ruling and it is visible in the fact that only one constraint
moves.

**The two downstream amounts follow automatically**, which is the tender
model's other dividend:

- **Razorpay** is charged `advance_amount` (`checkout.ts:557`,
  `amountPaise: advance`) — reduce the advance and the charge follows with no
  code change in the payments layer
- **Shiprocket's collectable** is `balance_due_on_delivery`
  (`fulfilment.ts:398`) — reduce the balance and the courier collects less,
  with no code change in the shipping layer

Neither module learns that coins exist. Both were already reading the right
field.

## C.1 · Atomicity

**Finding:** 11C.3. The coupon's atomicity is `select … from coupons … for
update` — a lock on the row the limit lives on. A balance is a `sum()` and
cannot be locked.

**`coin_accounts` is the row to lock.** Inside `create_order_with_stock`,
before anything is computed:

```sql
select * into v_account from public.coin_accounts
 where user_id = p_user_id for update;
```

Then compute the balance under that lock, validate the floor and the cap, write
the `redeemed` ledger rows, and insert the order — all in the transaction that
already holds the cart lock and the stock decrement. Two simultaneous checkouts
serialise there exactly as two coupon redemptions serialise on the coupon row.

Not an advisory lock: `coin_accounts` also holds Batch D's per-customer disable
switch, so the lock target is a row a reader can see and reason about rather
than a hash of a uuid.

**A guest has no `user_id`, so the block does not run** — stated explicitly in
the function rather than left to fall out of a null comparison, because a null
lock target that silently no-ops is how a limit becomes optional.

**FIFO consumption** (D5): oldest unexpired `earned` rows first. The `redeemed`
rows record which cohort they consumed so expiry stays exact.

## C.2 · The rules the database enforces

- **Balance may never go negative through a redemption.** Not application care
  — the redemption path asserts the post-redemption balance under the lock and
  raises. Reversals may still drive it negative (B.3); these are different
  rules and the code says so.
- **`coin_max_percent_of_order`** caps `coin_paid` against `grand_total`.
- **`coin_minimum_balance`** gates whether redemption is offered at all.
- **On a Pay-on-Delivery order, coins settle the balance first and never reduce
  the advance** (D4). The advance is the round-trip freight and it stays in real
  money.
- **Whole rupees.** With `coin_value_paise` constrained to a multiple of 100
  (D3), every settlement is a whole number of rupees, and `audit:totals`'
  existing assertion that the balance is a multiple of 100 paise keeps holding.
- **Never 1–99 paise on the advance.** Razorpay throws below its floor
  (`razorpay.ts:745`) and `initiatePayment` rolls the order back. A prepaid
  order settled entirely in coins **skips payment initiation** and is born paid;
  a partial settlement must leave at least `MIN_CHARGEABLE_PAISE`. This is a
  branch in `placeOrder`, not a clamp.
- **Every setting unset and failing loudly.** Until they are set, coins accrue
  and cannot be spent — a safe resting state and a bad surprise, so
  `/admin/loyalty` says so in a sentence rather than showing empty fields.
- **Never computed on the client.** The checkout previews; the function under
  the lock decides, exactly as it does for coupons.

## C.3 · Release on cancellation

Inside `cancel_order_with_restock`, beside the coupon release, guarded the same
way — a `released_at`-equivalent so a second cancellation gives nothing back
twice. Coins *redeemed* come back; coins *earned* are not in play, because that
function refuses `delivered` and `returned`.

## C.4 · The receipt

The owner's shape, on every surface and in the two emails that carry money:

```
Goods                    ₹4,998
Coupon SAVE10             −₹500
Paying online             −₹899
Order total              ₹3,599
  Paid by coins            ₹250
  Paid by card           ₹3,349
```

Discounts above the total, settlement below it. That is the visual difference
between a discount and a tender, and it is worth getting right because it is
the only place the model is explained to a customer.

Under Batch 0.5's rule, **every one of those lines reads a named field**:
`subtotal`, `couponDiscount`, `prepaidDiscount`, `grandTotal`, `coinPaid`,
`advanceAmount` / `balanceDueOnDelivery`.

## Files

`supabase/migrations/<new>_coins_redemption.sql` (columns, the constraint
swap, `coin_accounts`, the redemption block inside `create_order_with_stock`,
the release inside `cancel_order_with_restock`),
`src/lib/orders/totals.ts`, `src/lib/orders/types.ts`,
`src/lib/actions/checkout.ts`, `src/components/checkout/*`,
`src/lib/email/order-confirmation.ts`, `src/lib/email/lifecycle.ts`,
`src/lib/queries/orders.ts`, `src/lib/queries/admin/orders.ts`.

**The two SQL functions are rewritten in full, not patched.** Both migrations
that last touched them restate the entire body for a stated reason — a partial
rewrite of the function that restocks the shop is a silent behaviour change.

## Test — `audit:coins-redemption`

- **two simultaneous checkouts cannot spend the same coins**, proven under
  concurrent load. `audit:coupons` §5 (line 516) is the pattern: `Promise.all`,
  two HTTP requests, two transactions racing. Exactly one wins; the ledger
  holds one `redeemed` row; the balance is right
- balance cannot go negative through redemption, under the race
- `advance + balance + coin_paid = grand_total` on every order the suite places
- **coins do not enter `discount_total`** — the tender ruling, asserted
- **coins, coupon and prepaid together never exceed the ceiling** — the brief's
  requirement, which under the tender model means the *discount* parts never
  exceed it while coins sit outside; both halves asserted, because the point is
  that the ceiling still binds what it was meant to bind
- a COD order's advance is untouched by coins; its collectable falls by exactly
  the coins spent, and is a whole number of rupees
- a prepaid order settled entirely in coins never calls Razorpay and is not
  rolled back
- a prepaid order cannot be left with 1–99 paise on the advance
- cancellation releases redeemed coins, exactly once
- every setting unset ⇒ redemption is not offered, and the admin says why
- `audit:totals` still green — the balance is still a multiple of 100 paise

## Merge

**Stops and asks.** This is where money leaves the shop.

---

# Batch D — Admin, and watching for abuse

Depends on C. **Stops and asks.**

- **`/admin/loyalty`**: the earn rate, every redemption setting with a
  plain-language note on what happens if it is set too high or too low, and a
  master switch. Every control operate-and-asserted by its visible label —
  `audit:settings-controls` exists because two toggles were reported built and
  proved for two phases while the owner could not find them.
- **Settings live in their own `site_settings` row**, not in `shipping`.
  Finding 11E.7: `shipping` is `is_public = true` and RLS grants per *row*, so
  every key inside it is published to `anon`. `coin_value_paise` is margin.
  Classified in `SETTINGS_VISIBILITY` with a reason at the moment it is added —
  the registry rejects an unclassified key and `audit:settings-visibility`
  (newly in the suite, 0.2) enforces it. A public sub-row for what the
  storefront must print, a private one for the rest.
- **Every customer's balance**, sortable, with full transaction history.
- **Manual adjustment** with a required reason, written to the ledger as
  `adjusted` like everything else.
- **Abuse signals.** Audit 11D.4 found these have nothing to query yet:
  - *shared phone* — from `orders.contact_phone`, **not** `profiles.phone`,
    which is null on every production row. Consistently 10 plain digits across
    all 21 orders. Needs an index.
  - *shared address* — inside `orders.shipping_address` jsonb, unindexed and
    uncanonicalised. Needs a normalised generated column and an expression
    index, and it needs "the same address" defined before it can be one. I
    propose lowercased, whitespace-collapsed, punctuation-stripped
    `line1 + postalCode` — crude, and better than nothing, and the report will
    say which pairs it misses.
  - *balance large relative to orders placed*, *coins with no delivered order*,
    *negative balance* (from B.3), *unusual redemption velocity* — all fall out
    of the ledger cheaply.
  - Surfaced, never acted on automatically.
  - **The seven `@example.com` fixture accounts in production (11E.6) will be
    the first thing every one of these flags** — they genuinely share three
    phone numbers between eleven accounts. Cleaning them is
    `AUDIT_TARGET=env-local npx tsx scripts/audit/teardown.ts`, an owner-facing
    action against the live shop. Proposed in this batch's report, not
    performed.
- **Total outstanding coin liability in rupees, on the dashboard.** If D5 comes
  back as "no expiry", this is a P0 rather than a nicety.
- **Disable coins for a specific customer** — the flag on `coin_accounts`.

---

# Interactions, called out

**Coins and the discount ceiling.** Under the tender ruling they do not
interact arithmetically, and the combined exposure is multiplicative rather
than additive: 30% off the price, then up to `coin_max_percent_of_order` of
what remains settled in coins. Two controls, two risks — and the number the
owner should hold in his head is the product, not either factor. See D3.

**Coins and the advance.** The single most dangerous interaction in the phase.
The advance on a Pay-on-Delivery order is the round-trip freight; if coins can
eat it, a refused parcel is no longer paid for and Phase 7's protection is
gone. D4 makes it a structural invariant rather than a setting, because a
setting can be typed wrong at 11pm.

**Coins and Razorpay's floor.** Below 100 paise the provider throws, the
initiation returns null, and `rollBackUnpaidOrder` cancels an order that was
successfully created. A partial settlement landing in that window turns a good
order into a self-cancelling one.

**Reviews and the delivered signal.** Both features consume 0.4's output. If
0.4 is wrong in the direction of false positives, Batch A gives away review
eligibility and Batch B gives away money. If it is wrong in the direction of
false negatives, both features simply never fire — which is the safe direction
and the one to bias toward.

**The delivered email is getting crowded.** It gains a review prompt (A) and a
coin credit line (B), and it is the only email either feature touches. Worth
one deliberate pass on the copy rather than two independent additions.

**Reviews and the product cache.** A.4. The gate has to run against
`build:stage`; a dev-driven gate cannot see the failure.

**`coin_paid` and the six total surfaces.** Batch 0.5's required field makes
every read site a compile error until it is updated, which is the mechanism
rather than the risk.

---

# Sequence, and why

```
0.1 staging level ─┐
0.2 gate drift ────┼─▶ nothing can be measured or reported before these
0.3 signup gate ───┘
        │
0.5 no-subtraction ──▶ lands before coins, so the coin line arrives
        │               into a codebase where the rule is enforced
0.4 delivered is real ──▶ the event both features need
        │
        ├──▶ A · Ratings ────────┐
        │                        │  independent of each other;
        └──▶ B · Coins, earning ─┤  A can run alongside B
                    │            │
                    └──▶ C · Coins, redeeming
                                 │
                                 └──▶ D · Admin and abuse
```

**0.4 before everything** because it is the highest-risk change and the one
most likely to send the plan back for redrafting. Discovering in Batch B that
the poller cannot be made reliable would invalidate the earning design; finding
that out first costs a batch, finding it out last costs three.

**0.5 before C** because the coin line is a new money line, and it should land
in a codebase where the rule and the lint rule already exist rather than being
the thing that motivates them retroactively.

**A and B in parallel if the day allows**, single writer per file — they share
only the delivered event and the delivered email.

**C strictly after B**, because redeeming coins that cannot be earned is
untestable, and because the reversal design in B.3 constrains the redemption
design in C.

**D last**, because abuse signals need something to watch.

---

# What I expect to go wrong

Stated now so the batch reports can be honest about it.

**The eight gates added in 0.2 have not run inside the suite for some time and
some of them will be red.** I will report what they were before fixing them,
and a red gate that predates this phase gets said out loud rather than quietly
repaired.

**The delivery poller cannot be fully proved without a real parcel.** Staging
has no live Shiprocket shipments; the gate drives mocked tracking payloads
through the real route. That proves the wiring, the idempotency and the
transition. It does not prove that Shiprocket's actual Delivered payload parses
— `deliveredTimestamp(tracking)` has never seen one, because no parcel has ever
been delivered. **The first real delivery is the real test**, and the batch
report will say so rather than claiming coverage it does not have.

**`orders.delivered_source` is my addition, not the owner's instruction.** If
he reads it as a second signal creeping back in, it comes out and the plan
loses only the ability to distinguish courier evidence from a click.

**The `forwardShippingFee` change in 0.5 touches a line that has never been
wrong**, to satisfy a rule absolutely rather than with one exception. That is a
judgment call about rules, not about that line, and it is worth being overruled
on.

---

# Ready for Stage 3

Answer D1–D7 (D3 needs a number; the rest have recommendations to accept or
overrule), tell me whether `delivered_source` stays, and whether
`audit:build-smoke` belongs in `EXCLUDED` with a reason or in `GATES`.

Then I start with Batch 0.1 and 0.2, and report before touching 0.4.
