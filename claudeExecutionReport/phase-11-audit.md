# Phase 11 · Stage 1 — Audit

Read-only. No feature code was written. No migration was applied, to any
database. Two scratch shell helpers were created outside the repository (in the
session scratchpad) to run read-only SQL against staging; the working tree is
unchanged apart from this file.

Everything below was read out of the two live databases — the production
project `ahumjhwqgmskjsitctcj` and the staging project `pblgpvcdappfpoxdascd` —
or out of the code, and every claim says which. Where I could only read and not
execute, the finding says so in its own words rather than in a footnote.

**One tool was blocked.** `psql` against the production pooler was refused by
the sandbox classifier. I did not work around it: production reads below went
through the Supabase MCP `execute_sql`, which is the sanctioned production read
path and was already in use. Staging reads went through `psql`, which is
permitted. Three staging queries were also refused (they named
`handle_new_user`, or aggregated `pg_policies.roles`); where that happened I say
what I used instead and what remains unverified.

---

## The short version

**Nothing in this shop has ever been delivered.** Production holds 21 orders:
4 confirmed, 1 packed, 16 cancelled. Zero shipped. Zero delivered. One shipment
row with no AWB. `order_status_history` has never recorded a `shipped` or a
`delivered`. `orders.delivered_at` is null on every row that exists.

That is the load-bearing finding the brief asked for, and the answer is worse
than "unreliable": the delivery signal is **untested**, and it is untested in a
specific way that matters. There are *two* independent delivery signals, they
are set by different mechanisms, and nothing keeps them in step:

| Signal | Set by | Runs when |
|---|---|---|
| `orders.status = 'delivered'` | the owner pressing a button | whenever he presses it |
| `orders.delivered_at` | Shiprocket tracking, inside `fetchTracking` | only when the owner presses **Refresh tracking**, and only if the courier's payload parses as Delivered |

No cron polls tracking — production `cron.job` holds four jobs and none of them
touches a parcel. So an order can be `delivered` with `delivered_at` null
forever (owner marks it by hand, never refreshes tracking), and an order can
carry `delivered_at` while its status is still `shipped` (tracking refreshed,
button never pressed). The code already knows this: `recordReplacement` prints
"*(No delivery timestamp on this order.)*" as a normal outcome.

Both features in this phase hang off "delivered". The plan has to pick one
signal and say why, and it cannot pick the one that only exists when somebody
remembers to press a button.

**Anyone can create an unlimited number of confirmed accounts on the live
shop, right now, without a Google account.** Production GoTrue reports
`"email": true`, `"disable_signup": false`, `"mailer_autoconfirm": true`. The
brief's premise — "Sign-in is Google-only" — describes the UI, not the door. 7
of the 11 accounts in production were made through that door.

**The reviews table is a real, correct, unused table — and `authenticated` can
already write to it over PostgREST with no purchase check.**

**Production and the migration set do not diverge**, contrary to what four
previous phases would predict. Every table, column, index and RLS policy
matches. Three function *bodies* differ, all three cosmetically.

| # | Finding | Severity |
|---|---|---|
| 11B.1 | Two delivery signals, neither authoritative, and no order has ever reached either | **P0** |
| 11B.2 | `delivered_at` is only ever written by a button an owner presses; no poller exists | **P0** |
| 11D.1 | Email signup is open and auto-confirmed on production — unlimited free accounts | **P0** |
| 11C.1 | `orders_discount_parts_sum` forbids a third discount part; every coin-paying order would violate it | **P0** (blocker for Batch C) |
| 11C.2 | Two surfaces derive the coupon line by subtraction, so coins would be mislabelled "Coupon" on the receipt and in the confirmation email | **P1** |
| 11A.1 | `authenticated` may INSERT a review for any product, no purchase required, over PostgREST | **P1** |
| 11E.1 | `npm run audit` cannot pass today: 9 gates are in neither `GATES` nor `EXCLUDED`, and drift exits 1 | **P1** |
| 11E.2 | `audit:reachability` and `audit:build-smoke` — both mandated by this brief — are two of those 9 | **P1** |
| 11A.2 | Reviewer names are unreadable: `profiles` is self-or-admin only, and the product page reads with the cookieless anon client | **P1** |
| 11B.3 | Coin reversal on `delivered → returned` has no SQL home; that transition is TypeScript only | **P1** |
| 11C.3 | Coupon atomicity is a row lock on `coupons`. Coins have no row to lock, and a guest has no `user_id` | **P1** |
| 11A.3 | The product page is `unstable_cache`d for an hour; a posted review would not appear | **P2** |
| 11D.2 | Guest orders are adopted by cookie token, never by email — a returning guest loses the order and any coins on it | **P2** |
| 11D.3 | Customer-facing actions rate-limit by hand; no wrapper, no lint rule, no policy that would cover a review endpoint | **P2** |
| 11D.4 | No index supports the abuse queries; the delivery address lives in unindexed jsonb, `profiles.phone` is empty on every row | **P2** |
| 11E.3 | `coupon_redemptions` grants full DML to `anon` and `authenticated`; only RLS stands there. `inventory_movements` does it right | **P2** |
| 11E.4 | Staging is one migration behind production | **P2** |
| 11E.5 | Three production function bodies differ from the migration set — all cosmetic | **P3** |
| 11E.6 | 7 `@example.com` fixture accounts are sitting in the production auth table | **P3** |
| 11E.7 | `site_settings.payment_methods` reads `{"online": false}` and nothing consumes it | **P3** |
| — | `typecheck` and `lint` are both clean. Admin authorisation is genuinely correct. `audit:coupons` already proves a concurrent race. | good news |

---

# 11A · What already exists for reviews

## The table is real and it matches the migration, in both databases

Production, read from `information_schema.columns`, `pg_constraint` and
`pg_indexes`:

```
reviews
  id                   uuid      not null  gen_random_uuid()
  product_id           uuid      not null  → products(id)  ON DELETE CASCADE
  user_id              uuid      not null  → profiles(id)  ON DELETE CASCADE
  rating               smallint  not null  CHECK (rating between 1 and 5)
  title                text      null
  body                 text      null
  is_verified_purchase boolean   not null  default false
  is_approved          boolean   not null  default false
  created_at           timestamptz not null now()
  updated_at           timestamptz not null now()

  UNIQUE (product_id, user_id)                      reviews_one_per_customer
  INDEX  (product_id, created_at desc) WHERE is_approved
  INDEX  (created_at desc) WHERE NOT is_approved
  INDEX  (user_id)
```

Byte-identical to `supabase/migrations/20260807120300_commerce.sql:195-219`.
Staging's copy is identical too — I compared a per-table md5 of
`column_name || data_type || is_nullable || coalesce(column_default,'-')` across
both projects and `reviews` came back `31285ed30308c056e0e59c4b749c84d2` on
each.

**`reviews_one_per_customer` already gives you the brief's "one review per
customer per product, enforced by the database" for free.** No new constraint is
needed for that gate.

**Note the FK is `ON DELETE CASCADE` to `products`.** Combined with 11B's
finding on `admin_delete_product`, that is safe — see below — but it does mean a
hard product delete destroys review history silently.

## Nothing reads it and nothing writes it

`grep -rn "reviews" src scripts` returns exactly two kinds of hit: the generated
`src/lib/database.types.ts:1386`, and the word "reviews" inside prose comments
about security reviews. There is no query, no action, no component, no admin
page. Production holds 0 rows.

## 11A.1 — `authenticated` can already write reviews, for any product · P1

The live INSERT policy, read from `pg_policy` on production:

```sql
"customers write their own review"  INSERT to authenticated
  with check (user_id = (select auth.uid())
              and is_approved = false
              and is_verified_purchase = false)
```

There is **no purchase predicate**. And the grants are wide open:

```
reviews · anon          DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
reviews · authenticated DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
```

So RLS is the only thing between a signed-in caller and a row, and RLS only
asks that the row be *theirs* and *unapproved*. Any account can POST one review
per product to `/rest/v1/reviews` today. With 11D.1 — accounts are free and
instant — that is an unbounded write.

Impact **today** is noise: those rows are `is_approved = false`, nothing renders
them, and only the author can read one back. Impact **the day Batch A ships** is
the moderation queue, which is the one screen designed to make the owner look at
every row a stranger can create.

I read this out of the policy catalogue and the grant table. I did **not**
execute an insert — that needs a fixture account and a write to staging, which
Stage 1 is not. Verifying it through the real endpoint belongs in Stage 3, and
the brief already asks for exactly that gate ("*asserted through the real
endpoint, not the UI*").

Two smaller things in the same policy set, both consequences of the table having
been designed for pre-moderation:

- `customers write their own review` pins `is_approved = false`. Under
  **post-moderation** a client insert can therefore never publish, so the write
  has to go through a server action with the service role regardless of which
  moderation model the owner picks. That is the right answer anyway; it is worth
  knowing the RLS makes it the *only* answer.
- `customers delete their own review` has no approval guard, so a customer can
  delete a published review. Under post-moderation that is a
  publish/delete/republish loop around the unique constraint. Low harm, worth a
  sentence in the plan.

## 11A.2 — There is no way to render a reviewer's name · P1

`reviews.user_id → profiles(id)`, and `profiles` RLS is:

```sql
"customers read their own profile"  SELECT to authenticated  using (id = auth.uid())
"admins read every profile"         SELECT to authenticated  using (is_admin())
```

No anon policy, no "read anyone's display name" policy. Meanwhile
`src/lib/queries/catalog.ts:44` reads the catalog through
`createStaticClient()` — the **cookieless anon client**, deliberately, because
touching `cookies()` would make `/` and `/product/[slug]` dynamic and delay the
LCP image. That client cannot see a single `profiles` row.

So "individual reviews with … first name" as the brief specifies is not
reachable from the read path the product page uses. Three ways out, all of them
a decision rather than a detail: denormalise a display name onto `reviews` at
write time; add a narrow `SELECT` policy exposing only a name; or serve the
review list from a `SECURITY DEFINER` function that returns the name and nothing
else. The plan must choose one — denormalising is the only one that keeps the
product page on the anon static client.

## Aggregates: there is no rating column, and the listing path is already good

`products` carries 24 columns and none of them is rating-related (production
`information_schema`). The listing is **already** N+1-free and does not need
rescuing:

1. `catalog_query(...)` — one RPC returning `{ ids, total, facets }`
   (`src/lib/queries/catalog.ts:295`)
2. one PostgREST select of those ≤12 rows with embeds, via `PRODUCT_FIELDS`
   (`src/lib/queries/catalog.ts:58`)

Two queries, whatever the filters. **Trigger-maintained aggregate columns on
`products` cost zero extra round trips** — add `review_count` and
`rating_sum` (or `rating_average`) to the table and to the `PRODUCT_FIELDS`
string and the listing is done. A `reviews(...)` PostgREST embed would not work:
PostgREST cannot aggregate an embed into an average, and pulling every review
row for 12 products to average them in Node is the N+1 in a costume.

The reconciliation the brief asks for has an exact precedent —
`public.reconcile_inventory()`, which `audit:reconciler` already drives.

## 11A.3 — A posted review would not appear for an hour · P2

`cachedProductContent` is `unstable_cache(getProduct, …, { revalidate: 3600,
tags: [CATALOG_CACHE_TAG] })` (`src/lib/queries/cached.ts:210`). Stock is the
one thing read live, through `detailWithLiveStock`, precisely because an
hour-old availability was a lie.

A review is the same class of problem: post-moderation means "publishes
immediately", and immediately is not within the hour. Either the review list
joins stock on the live path, or the write revalidates `CATALOG_CACHE_TAG` —
which nukes the whole catalog cache for one review, on a shop where the product
page is the LCP path.

Whichever is chosen, **it cannot be proved under `next dev`**: dev re-renders
every request, so a missing `revalidateTag` passes. That is a recorded lesson in
this repo. The gate has to run against `build:stage`.

---

# 11B · What the shop knows about who received what

## No parcel has ever been delivered. Not one.

Production, right now:

```
status      orders  with delivered_at
confirmed        4                  0
packed           1                  0
cancelled       16                  0

shipments                       1
  … with an AWB                 0
  … with delivered_at           0
order_status_history 'shipped'  0
order_status_history 'delivered' 0
reviews                         0
order_items                    21
profiles                       11
```

The brief guessed `delivered_at` "may never have been exercised on a real
parcel". It has not been exercised on *any* parcel. The column has never held a
value, in production, since it was added.

## 11B.1 / 11B.2 — Two signals, one button, no poller · P0

**`orders.status = 'delivered'` is set by hand.** The only route is
`setOrderStatus` → `transitionOrder` (`src/lib/actions/admin/orders.ts:42`,
`src/lib/orders/transition.ts:139`), driven by the button at
`src/components/admin/orders/order-actions.tsx:100`. `ORDER_TRANSITIONS` allows
`shipped → delivered` and the owner presses it.

**`orders.delivered_at` is set by tracking, and tracking is polled on view.**
`fetchTracking` (`src/lib/shipping/fulfilment.ts:918`) reads the courier's own
timestamp, writes it to `shipments.delivered_at`, then mirrors it onto
`orders.delivered_at` — both guarded so a second poll cannot restart the clock
(`fulfilment.ts:964-995`). Its only caller is the admin action `trackOrder`
(`src/lib/actions/admin/shipping.ts:259`). The header says so plainly:

> Polled on view, never in the background — the brief was explicit that this
> phase does not build a poller.

Production `cron.job` confirms it. Four jobs, none of them a parcel:

```
*/10 * * * *  release-abandoned-orders     select public.release_abandoned_orders()
17   * * * *  prune-rate-limits            delete from public.rate_limits …
23   * * * *  prune-shipping-quotes        delete from public.shipping_quotes …
*/10 * * * *  reconcile-abandoned-orders   select private.trigger_order_reconciler()
```

Nothing sets `status = 'delivered'` from tracking either — `fetchTracking` acts
on exactly one courier status beyond caching, and it is RTO, not delivery
(`detectRtoFromTracking`, `src/lib/orders/rto.ts:92`).

**What this means for the phase.** Both features need an event, and the two
candidates fail differently:

- *Trigger on `status = 'delivered'`* — fires reliably, because the owner
  pressing the button is the one thing that definitely happens. But it is a
  human assertion, not evidence, and it is available to a mistaken click. For
  coins, an accidental press mints money.
- *Trigger on `delivered_at`* — is evidence from the courier, but only exists
  if somebody opened the order and pressed Refresh tracking. On present
  behaviour that is *never*: the column has zero non-null values across the
  shop's entire history.

Neither is usable as-is. The honest options are (a) build the poller this phase
and make `delivered_at` real, (b) trigger on the status transition and accept
the human as the source of truth, recording who pressed it, or (c) both —
credit on the status transition, and reconcile against `delivered_at` when it
arrives. My recommendation is (c), but this is a decision the plan must put in
front of the owner with its cost, because it is the difference between a loyalty
programme backed by courier evidence and one backed by a click.

## What happens on RTO, cancellation and refund

- **`delivered → cancelled` is impossible.** `ORDER_TRANSITIONS`
  (`src/lib/orders/types.ts:57-70`) allows `delivered → returned` and nothing
  else, and `cancel_order_with_restock` refuses independently — the live body
  returns `illegal_transition` for `delivered` and `returned`. Two locks on the
  same door.
- **RTO cannot follow delivery.** `detectRtoFromTracking` only swaps when
  `status = 'shipped'`, with a compare-and-swap on `rto_at is null`.
- **`delivered → returned` is the one exit**, and it is reached by
  `recordReplacement` (`src/lib/actions/admin/orders.ts:210`), which requires
  `status = 'delivered'` and records the 24-hour window without enforcing it.
- **`delivered_at` is never cleared.** No code path unsets it, and
  `stageFor` (`src/lib/orders/refund-policy.ts:260`) reads it *first* — an order
  that carries `delivered_at` is treated as delivered even after it becomes
  `returned`.
- **Money can still come back after delivery.** The `delivered` branch of
  `refundFor` returns `replacementOnly` and ₹0 — but the admin can select
  "our mistake" and refund the full amount.

### 11B.3 — Coin reversal has no SQL home · P1

Everything else money-shaped in this shop reverses inside a Postgres function:
stock and the coupon both come back inside `cancel_order_with_restock`, in one
transaction, idempotent on a null timestamp. **`delivered → returned` has no
such function.** It goes through `transitionOrder`, which is TypeScript issuing
a compare-and-swap UPDATE, and whose email hook is explicitly documented as
"never allowed to matter".

So the exploit the brief names — *order ₹10,000, earn 100 coins, get the money
back, keep the coins* — has to be closed on a path that today has no
transaction boundary, no ledger, and a best-effort side-effect convention. Add
the refund path (a "shop error" refund can be issued on a delivered order that
was never returned) and there are two reversal triggers, not one, and they can
both fire on the same order.

This is the single hardest piece of engineering in Batch B and the plan should
sequence it first, not last.

## Attribution survives a soft delete — this part is fine

`admin_delete_product` (`supabase/migrations/20260807225650`) counts
`order_items` for the product and **soft-deletes** if any exist, hard-deletes
only if none ever do. So:

- a product anyone could have a delivered order for is never hard-deleted;
- `order_items.product_id` (FK `ON DELETE SET NULL`) therefore keeps its link;
- and `order_items` carries a full snapshot anyway — `product_name`,
  `product_slug`, `size`, `color`, `sku`, `unit_price`, `quantity`,
  `line_total`, `image_url`.

A review or a coin credit can be attributed after a soft delete. Both by the
link and, failing that, by the snapshot. **No work needed here.**

The one edge: `reviews.product_id` cascades on delete, so if a product with
reviews were ever hard-deleted the reviews vanish. Under the delivered-purchase
entry condition that combination cannot arise (reviews imply order lines imply
soft delete). Under "anyone signed in may review" it can. One more reason the
entry condition is load-bearing rather than decorative.

---

# 11C · Where money is computed today

## The stack, and where it clamps

`computeOrderTotals` (`src/lib/orders/totals.ts:77`) is the one place, and the
file says why: three surfaces once computed delivery independently and orders
FV-2026-00487 and FV-2026-00488 carry identical subtotals and different
delivery.

The discount stack, as it runs today (`totals.ts:139-162`):

1. `couponDiscount` arrives already validated and rounded.
2. `prepaidCandidate` = 0 for COD, else `prepaidDiscountFor(...)` on the goods
   subtotal.
3. If **both** are positive:
   - ceiling **unset** → stacking is withheld, the larger single discount wins
     (ties to the coupon), and it logs at `console.error`;
   - ceiling **set** → `ceiling = floor(subtotal × pct / 100)`; the **coupon
     keeps its value first**, and the prepaid part absorbs the clamp.
4. `discountTotal = appliedCoupon + prepaidDiscount`.
5. `grandTotal = subtotal − discountTotal + shippingFee`.

**The live numbers matter for the owner's decision #5.** Production
`site_settings.shipping` holds:

```
prepaid_discount           { mode: "percent", value: 20 }
max_total_discount_percent 30
free_above_paise           159900
flat_shipping_fee_paise      1000
cod_minimum_order_value_paise 99900
```

So on a prepaid order, the prepaid incentive already consumes 20 of the 30
available points. **If coins clamp against the same ceiling, a customer paying
online can spend coins worth at most 10% of goods, no matter how many they
hold** — and prepaid is the order type the shop prefers. That is not an argument
against the brief's recommendation (coins *should* count, or the ceiling is
decorative); it is the number the owner needs in front of him when he agrees to
it, because it decides whether the programme feels usable.

## 11C.1 — A third discount part violates a live CHECK constraint · P0

Production `pg_constraint` on `orders`:

```sql
orders_discount_parts_sum      CHECK (discount_total = prepaid_discount + coupon_discount)
orders_discount_within_subtotal CHECK (discount_total <= subtotal)
orders_prepaid_discount_within_total CHECK (prepaid_discount >= 0 AND prepaid_discount <= discount_total)
orders_total_adds_up           CHECK (grand_total = subtotal - discount_total + shipping_fee + tax_total)
orders_advance_balance_sums    CHECK (advance_amount + balance_due_on_delivery = grand_total)
```

`orders_discount_parts_sum` is exhaustive by name. **Every order paid partly in
coins fails to insert** until a `coin_discount` column exists and that
constraint is rewritten to include it. This is a production migration on the
orders table, in the money path — which under the merge policy stops and asks,
and under the production-migration procedure needs a content-verified dump and
a dry run first.

It also forces a design decision the brief left implicit: **is a coin a discount
or a tender?**

- *Discount* — reduces `grand_total`, sits inside `discount_total`, clamps
  against the ceiling, and the four constraints above all extend cleanly. It
  also means coins reduce the shop's revenue line rather than its receivable.
- *Tender* — `grand_total` unchanged, coins reduce `advance_amount`. That breaks
  `orders_advance_balance_sums` unless a third term is added, and it puts coins
  outside the ceiling by construction, which is the thing recommendation #5
  exists to prevent.

Everything about the existing schema pushes toward *discount*. The plan should
say so explicitly and note what is being given up.

## 11C.2 — Coins would be labelled "Coupon" on the receipt · P1

Two surfaces do not read the coupon's own figure. They derive it by subtracting:

```ts
// src/components/checkout/totals.tsx:70
const otherDiscount = Math.max(0, totals.discountTotal - prepaidDiscount);

// src/lib/email/order-confirmation.ts:138
input.totals.discountTotal - prepaidDiscount
```

and then render it as `` `Coupon ${couponCode}` `` or, with no code, `Discount`.

Add a third part to `discountTotal` and both silently fold coins into that line.
The customer's confirmation email would say "Coupon SAVE10 −₹350" for a ₹100
coupon and 250 coins. This is exactly the failure mode `totals.ts` was written
to prevent — a difference that is an artefact of arithmetic rather than a named
line.

The fix is cheap and the type system will enforce it: `OrderTotals`
(`src/lib/orders/types.ts:277`) made `prepaidDiscount` **required** for this
precise reason, with a comment explaining that while it was optional "every read
site could omit the field and silently render a zero". A required
`coinDiscount: number` turns both of these into compile errors, and the brief's
"coins appear as their own named line on every total surface" becomes something
the build enforces rather than something a reviewer checks.

## 11C.3 — The coupon's atomicity does not transfer to coins · P1

`create_order_with_stock` (live body read from production) achieves coupon
atomicity with one move:

```sql
select * into v_coupon from public.coupons c
 where upper(c.code) = upper(p_coupon_code)
   for update;
```

Everything after that — active, window, `usage_limit`, `per_user_limit`,
`min_order_value`, the discount computation, the `coupon_redemptions` insert,
the `used_count` increment — runs under that row lock, in the order's own
transaction. Two checkouts racing one remaining use serialise on it.
`coupon_redemptions` has `unique (order_id)`, so a replay collides rather than
double-charging.

**Coins have no such row.** A ledger's balance is `sum(delta)`, and you cannot
`for update` a sum. Reusing "the pattern" therefore means inventing the row the
pattern locks. Two candidates, and the plan must choose:

- a `coin_accounts(user_id …)` row locked with `for update` — *not* a balance
  column, just the lock target and a place for the per-customer disable switch
  the brief asks for in Batch D;
- `pg_advisory_xact_lock(hashtextextended(user_id::text, 0))` — no table, but no
  place for the disable flag and harder to reason about.

I recommend the first: it gives Batch D's "disable coins for a specific
customer" somewhere to live, and a lock target that a reader can see.

Two further wrinkles the coupon path does not have:

- **A guest has no `user_id`.** `create_order_with_stock` takes `p_user_id uuid`
  and it is null for guests (production has 1 guest order of 21). If guests
  cannot earn — the brief's recommendation #8, which I agree with — then they
  also cannot redeem, and the redemption block simply does not run. Say it
  explicitly; a null lock target that silently no-ops is how a limit becomes
  optional.
- **Release on cancellation is only half the story.** The coupon comes back
  inside `cancel_order_with_restock`, guarded by `released_at is null`. Coins
  *redeemed* can reuse that exactly. Coins *earned* cannot — that function
  refuses `delivered` and `returned` outright, which is precisely the state in
  which coins exist. See 11B.3.

## Every surface that shows a total

Reading `grandTotal` / `grand_total`, 26 files. Grouped by what a coin line
would have to reach:

**Customer, live** — `src/components/checkout/totals.tsx` (the shared component;
cart, checkout and confirmation all render through it),
`src/components/checkout/checkout-flow.tsx`,
`src/components/checkout/checkout-failure.tsx`,
`src/app/(storefront)/checkout/page.tsx`,
`src/app/(storefront)/account/orders/page.tsx`, and
`src/app/(storefront)/account/orders/[id]/page.tsx`.

**Admin** — `src/app/admin/page.tsx` (dashboard),
`src/app/admin/orders/page.tsx`, `src/app/admin/orders/[id]/page.tsx`,
`src/app/admin/health/page.tsx`, plus the query layer
(`src/lib/queries/admin/{orders,customers,dashboard,health}.ts`).

**Email — six templates**, and only two carry money:

| Template | File | Money lines |
|---|---|---|
| Order confirmation | `email/order-confirmation.ts:100` | **yes** — subtotal, prepaid, coupon/discount, delivery, total |
| Refunded | `email/lifecycle.ts:211` | **yes** |
| Shipped | `email/lifecycle.ts:70` | no |
| Delivered | `email/lifecycle.ts:154` | no — and this is the one that must carry the review prompt *and* "you earned N coins" |
| Owner: new order | `email/lifecycle.ts:283` | yes |
| Incident | `email/incident.ts:65` | n/a |

**Server-side** — `src/lib/orders/{totals,transition,payment-state,refunds}.ts`,
`src/lib/payments/advance.ts`, `src/lib/actions/{checkout,shipping-quote}.ts`,
`src/lib/actions/admin/shipping.ts`, `src/lib/shipping/fulfilment.ts`.

---

# 11D · Abuse surface

## 11D.1 — Accounts are free, instant, and unlimited · P0

The brief's premise is that sign-in is Google-only. The UI is: the single auth
entry point in the codebase is `signInWithOAuth`
(`src/lib/actions/auth.ts:94`), and it is the only one — there is no
`signInWithPassword`, no `signUp`, no `signInWithOtp` anywhere in `src/`.

The **project** is not. Production GoTrue's public settings endpoint, fetched
with the anon key that ships in the browser bundle:

```json
{ "external": { "google": true, "email": true, … },
  "disable_signup": false,
  "mailer_autoconfirm": true }
```

Three facts, and it is the combination that matters:

- `email: true` — the email/password provider is on;
- `disable_signup: false` — anyone may sign up;
- `mailer_autoconfirm: true` — **no confirmation email**. The signup returns a
  confirmed session immediately, for an address the caller does not have to own.

So a script with the public anon key can mint confirmed accounts at whatever
rate GoTrue allows, against addresses it invents. This is not theoretical on
this project: 7 of the 11 production accounts came in that way
(`raw_app_meta_data->>'provider' = 'email'`, all `@example.com`, all with
`confirmation_sent_at` null).

**What it costs Phase 11.** Any per-account grant is free to farm — a signup
bonus, a referral credit, a per-account minimum-balance floor, a per-account
redemption cap. It also means "one review per customer per product" is one
review per *account*, and accounts are free.

**It is also the strongest possible argument for the brief's own review
design.** Requiring a delivered order makes a fake review cost the price of a
pair of shoes, and that is the only cost in the system that a free account
cannot avoid. The same logic says: **coins must only ever be created by a
delivered order.** No signup bonus, no referral, nothing that a new row in
`auth.users` can trigger.

Turning `mailer_autoconfirm` off, or the email provider off, is an owner action
in the Supabase dashboard and a candidate for the plan's first batch. It is not
free — the audit harnesses sign up with email and password
(`scripts/audit/fixtures.ts`), so switching the provider off breaks every
browser gate. That trade needs stating rather than assuming.

## 11D.2 — Guest orders are claimed by cookie, never by email · P2

`adopt_guest_orders()` (`supabase/migrations/20260808100200`) takes **no
parameters** — deliberately, and the header explains why at length. The user
comes from `auth.uid()`, the token from `current_guest_token()`, which reads the
`x-guest-token` request header forwarded from an httpOnly cookie.

```sql
update public.orders set user_id = v_user, guest_token = null
 where guest_token = v_token and user_id is null;
```

That is a good security design and it answers the brief's question in a way the
brief did not expect: **a guest who later signs in with the same email gets
nothing.** Adoption is per-browser-session. Clear the cookie, switch device,
come back a week later — the order stays orphaned, and any coins attached to it
stay unclaimable.

Matching on email instead would be a much bigger hole (11D.1: email addresses
are not proof of anything on this project), so the answer is not "match on
email". It is that the plan must state the consequence plainly: **a guest order
earns nothing, and signing up later does not retroactively earn it.** That is
consistent with recommendation #8 and it should be the copy on the confirmation
page too, or the shop will get the support email.

## 11D.3 — Nothing would make a review endpoint remember to rate-limit · P2

`RATE_LIMITS` (`src/lib/rate-limit.ts:41`) holds 13 policies: `webhook`,
`paymentVerify`, `checkout`, `orderCancel`, `adminMutation`, `adminBulk`,
`fulfilment`, `serviceability`, `imageProcessing`, `cartWrite`, `couponCheck`,
`errorReport`, `errorReportTotal`.

**None would cover a review write.** A new policy is needed — and more to the
point, *nothing enforces that one is used*. Compare the two halves of the app:

- **Admin actions**: `adminAction` (`src/lib/admin/guard.ts:112`) checks
  `is_admin()` against the database, *then* rate-limits keyed to the admin, and
  `eslint-rules/admin-actions-must-guard.mjs` **fails the build** on any exported
  action under `src/lib/actions/admin/` that does not go through it.
- **Customer actions**: each one calls `consumeRateLimit` by hand. See
  `src/lib/actions/coupon.ts:59`. There is no wrapper and no lint rule.

So the answer to the brief's fourth 11D question is: **yes, admin actions on
reviews and balances will be guarded by `is_admin()` inside the action** —
automatically, and the build enforces it, provided they live under
`src/lib/actions/admin/`. That is genuinely good and needs no work.

The customer side is where the gap is, and a review endpoint is the first
customer-facing *write* since the cart. Worth considering a `customerAction`
wrapper in this phase rather than one more hand-rolled call.

One more detail worth carrying into the plan: `consumeRateLimit` **allows on
error** (`ALLOWED_ON_ERROR`, `rate-limit.ts:160`). A dead limiter is an open
door. Correct for a cart; a decision for a coin redemption.

## 11D.4 — The abuse signals have nothing to query · P2

Batch D asks for accounts sharing a phone number or a delivery address. What
exists:

- **Phone.** `profiles.phone` is **null on all 11 production rows**. The real
  phone is `orders.contact_phone`, populated on all 21 orders and consistently
  10 plain digits (`~ '^[0-9]{10}$'` matches every row). Three distinct numbers
  across 11 accounts — the pattern the owner wants to detect is already present
  in the test data. **There is no index on `orders.contact_phone`**; the eight
  indexes on `orders` cover guest token, cart, order number, payment reference,
  pk, placed_at, status and user_id.
- **Address.** Lives in `orders.shipping_address` jsonb with keys
  `recipientName, phone, line1, line2, city, state, postalCode, country`. No
  index, no normalised form, and no canonicalisation — "12 MG Road" and
  "12, M.G. Road" are different strings. Address matching needs a normalised
  expression index or a generated column, and it needs the plan to say what
  "the same address" means before it can be one.
- **Balance vs orders placed** and **coins with no delivered order** fall out of
  the ledger and are cheap.
- **Redemption velocity** needs the ledger's `created_at`, also cheap.

---

# 11E · Everything else

## 11E.1 / 11E.2 — `npm run audit` cannot pass today · P1

`scripts/audit/run-all.ts` lists 39 gates in `GATES` and 6 deliberate omissions
in `EXCLUDED`. `package.json` defines **54** `audit:*` scripts. Nine are in
neither, and `checkForDrift()` makes that an exit code, not a warning:

```
process.exit(failed.length > 0 || drift.length > 0 ? 1 : 0);
```

The nine:

```
audit:courier-choice      audit:delivery-estimate   audit:image-upload
audit:settings-visibility audit:images              audit:reachability
audit:homepage-tokens     audit:appearance          audit:build-smoke
```

The file's own comment is the right verdict on this: *"A gate nobody runs is
worse than no gate: it reads as coverage."*

Two of the nine are named as requirements by this very brief — *"every new
customer-facing page must pass `audit:reachability`"* and *"every deploy runs
`audit:build-smoke` first"*. A third, `audit:settings-visibility`, is the gate
that will police the new loyalty settings rows.

This has to be fixed before Stage 3 produces a single number, or every "gates
green against staging" claim in this phase is measured against a suite that
exits 1 for reasons unrelated to the work.

## What the existing gates already give Phase 11

Good news, and it shortens the plan:

- **The concurrency proof already exists.** `audit:coupons` §5 (line 516) fires
  two orders at one remaining use with `Promise.all`, two HTTP requests, two
  transactions racing, and asserts exactly one wins, `used_count == 1`, and the
  ledger holds exactly one row. That is the shape of the brief's "two
  simultaneous checkouts cannot spend the same coins", ready to copy.
- **The reconciliation precedent exists.** `reconcile_inventory()` plus
  `audit:reconciler`.
- **The literals gate is clean and would catch a hardcoded coin rate.**
  `npm run audit:literals` passes: 163 files with no rupee literal, 328 with no
  paise literal beyond three named and justified constants
  (`RUPEE_IN_PAISE`, `MIN_CHARGEABLE_PAISE`, `ROUND_UP_TO_PAISE`), and no
  currency literal in owner-edited content. A guessed `coin_value_paise` would
  fail it.
- **`typecheck` and `lint` are both clean** as of this audit.

## 11E.3 — The ledger grant pattern to copy, and the one not to · P2

Two existing ledgers, two different postures:

```
inventory_movements · anon          REFERENCES,SELECT,TRIGGER,TRUNCATE
inventory_movements · authenticated REFERENCES,SELECT,TRIGGER,TRUNCATE
  policy: inventory_movements_admin_read   SELECT to authenticated  using (is_admin())

coupon_redemptions  · anon          DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
coupon_redemptions  · authenticated DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
  policy: Admins manage coupon redemptions  ALL  using (is_admin())
```

`inventory_movements` revokes the write grants, so RLS is a second line rather
than the only one, and its policy is `SELECT` only — even an admin cannot PATCH
a movement over PostgREST. `coupon_redemptions` keeps every default DML grant
and gives admins `ALL`.

Nothing is exploitable today — RLS holds in both cases — but **`coin_transactions`
must follow `inventory_movements`**, and it will not do so by accident. The
`ensure_rls` event trigger (confirmed live in `pg_event_trigger`) auto-enables
RLS on new tables, which is genuinely helpful, but Supabase's default privileges
still grant `anon` and `authenticated` full DML on any new public table — that
is exactly how `reviews` came to have them. The migration has to revoke
explicitly.

While it is open: `coupon_redemptions`' write grants are a one-line revoke and
this phase is already in that file's neighbourhood.

## 11E.4 — Staging is one migration behind · P2

```
staging     100 applied, latest 20260810160000  (shipments_courier_selection)
production  101 applied, latest 20260810170000  (site_video_bucket)
```

`supabase/migrations/` holds 101 files. The missing one only creates a storage
bucket, so no `public` table differs — but the brief asks for findings "as a
fresh `rebuild:stage` produces them", and staging is not currently that. A
`rebuild:stage` should be the first thing Stage 3 does, before any measurement.

## 11E.5 — Three production function bodies differ, all cosmetically · P3

I compared `md5(pg_get_functiondef(oid))` for all 28 `public` functions across
both projects. 25 match exactly. Three do not:

| Function | Staging | Production | Difference |
|---|---|---|---|
| `consume_rate_limit` | 994 chars | 994 chars, sig differs | production declares an unused `v_expired boolean` |
| `handle_new_user` | 536 chars | **315 chars** | production's body has the SQL comments stripped |
| `record_inventory_movement` | 1589 chars | **1270 chars** | same — comments stripped |

I read both bodies in full for `record_inventory_movement` and `consume_rate_limit`
and the executable statements are identical. For `handle_new_user` the staging
read was refused by the classifier, so I compared production's live body against
`supabase/migrations/20260807150000_auth_admin_bootstrap.sql:34-57` instead:
identical statements, including the `role` literal `'customer'` and the
`on conflict (id) do nothing` — the migration's two explanatory comments are
what is missing from production's stored copy.

**No semantic drift.** But comment-stripped bodies in production and
comment-bearing bodies in staging means those three functions reached production
through a path that normalises the text — most likely `apply_migration` over the
MCP rather than the migration file. That is worth knowing because the *next*
such application might not be cosmetic, and nothing currently compares the two.
A schema-signature diff between production and a fresh rebuild would be a
genuinely cheap gate, and this audit is most of its implementation.

The wider comparison, for the record — every one of these matched exactly across
both projects:

- 34 tables, 379 columns, same per-table column signature
- every index on every table (`md5(string_agg(indexdef, …))`)
- every RLS policy on all 30 policied tables (name, cmd, qual, with_check)
- RLS enabled on all 34 tables; `inbound_emails`, `integration_tokens`,
  `rate_limits` and `shipping_quotes` carry zero policies, which with RLS on
  means closed to `anon` and `authenticated`, which is correct
- all 13 enums, including `order_status` carrying `returning`

**Four previous phases found production and the migrations diverging. Today
they do not.** That is worth saying out loud because the plan should not budget
for reconciliation work that is not needed.

## 11E.6 — Fixture accounts in the production auth table · P3

Seven `@example.com` accounts, provider `email`, all created 2026-08-09, all
with `confirmation_sent_at` null — created through the service-role admin API,
which is what `scripts/audit/fixtures.ts` does. They are in the **live shop's**
`auth.users`, alongside four real Google accounts. Most of the 16 cancelled
orders and 20 of the 21 order rows belong to that cohort.

`scripts/audit/fixtures-guard.ts` exists to prevent exactly this and
`audit:teardown` knows how to clean it (it deletes only rows whose email carries
a known QA prefix at `@example.com`). These predate the guard or were made
before it ran. They are harmless, and they will pollute every Batch D abuse
signal — "accounts sharing a phone number" will flag the QA cohort first,
because they genuinely share three phone numbers between them.

Cleaning them is `AUDIT_TARGET=env-local npx tsx scripts/audit/teardown.ts`,
which is an owner-facing action against production and should be proposed
rather than performed.

## 11E.7 — A settings row that looks authoritative and is not · P3

`site_settings.payment_methods` holds `{"cod": true, "online": false}` in
production. The only reference to that key anywhere in `src/` is its entry in
`SETTINGS_VISIBILITY` (`src/lib/settings-visibility.ts:69`). **Nothing reads it
to decide anything** — the checkout is governed by `shipping.cod_enabled`, the
COD minimum, the deposit rule and the fallback behaviour.

It says online payment is off. Online payment is not off. Worth deleting or
wiring, and worth naming here because the loyalty settings are about to land in
the same table and the plan must not add a second one.

**Where the coin settings should live.** Not in `shipping`. That row is
`is_public = true`, and RLS on `site_settings` grants per **row**, not per field
— so every key inside it is published to `anon`, which the visibility registry
documents at length as a decision that "does not survive the next key". The
brief's five redemption settings include `coin_value_paise`, which is the
owner's margin. They want their own row, classified in
`SETTINGS_VISIBILITY` with a reason, and split public/private if the storefront
needs to print what a coin is worth (it does — "what a coin is worth stated
somewhere findable").

---

## What I could not establish, and what I did not do

- **I did not execute the review INSERT** described in 11A.1. It is read from
  the live policy catalogue and the live grant table, which I consider strong,
  but it is not the same as a 201 from PostgREST. Stage 3 should prove it
  through the real endpoint, which the brief already requires.
- **I did not run `rebuild:stage`.** It drops and replays staging, which is a
  mutation, and Stage 1 is read-only. The comparison above uses staging *as it
  currently stands* (one migration behind); the column, index, policy and
  function comparisons are therefore against a 100-migration replay rather than
  a 101-migration one. The missing migration creates a storage bucket only.
- **I did not run the browser gates or `npm run audit`.** The drift finding
  (11E.1) is read from `run-all.ts` and `package.json` and is deterministic, but
  I have not watched the suite exit 1. `typecheck` and `lint` I did run; both
  clean.
- **Staging's `handle_new_user` body** I could not read directly — the query was
  refused. I compared production's live body against the migration file instead
  and reported that.
- **`psql` against production** was blocked by the classifier. I did not retry
  it or route around it; production reads went through the Supabase MCP.

## What I got wrong on the way

I expected production and the migration set to have diverged, because the brief
said this project has found them diverging four times and told me to assume
nothing. I built the comparison to find drift. It found essentially none — three
comment-stripped function bodies — and the honest report of that is that the
brief's prior was wrong for this phase, not that I should keep looking until
something turned up.

I also initially wrote down `orders.status = 'delivered'` and
`orders.delivered_at` as one signal, because the code mirrors one onto the other
in `fetchTracking`. It does not: the mirror runs in one direction, from tracking
to the order, and the button runs in the other, from the owner to the status.
They are two signals and the whole of 11B turns on that.

---

## Ready for Stage 2

The plan will need decisions on eight things before it can be written, six of
which are the owner's and two of which are mine to propose:

**His** — the brief's own list, plus one the audit added:

1. Who may review (recommend: delivered purchasers only — 11D.1 is the argument)
2. Moderation model (recommend: post-moderation, given 1)
3. `coin_value_paise` — his margin, no recommendation
4. `coin_max_percent_of_order`
5. Whether coins clamp against `max_total_discount_percent` (recommend: yes —
   and note the 20%-prepaid/30%-ceiling arithmetic in 11C leaves 10 points)
6. `coin_expiry_months` and `coin_minimum_balance`
7. Guests earn nothing (recommend: agreed — and 11D.2 means signing up later
   does not backfill)
8. **New:** whether to close email signup on production, accepting that it
   breaks every browser gate until the fixtures move to a different mechanism

**Mine, to propose with reasoning in Stage 2** — which delivery signal a coin
credit fires on (11B.1), and whether a coin is a discount or a tender (11C.1).

Say the word and I will write `claudeExecutionReport/phase-11-plan.md`.
