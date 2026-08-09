# Database

Generated against the live Supabase project (`ahumjhwqgmskjsitctcj`) after the
Phase 6 migrations. Regenerate this whenever a migration lands.

Money is **integer paise** everywhere. ₹1,999 is `199900`. There is no float in
the schema and no rounding to argue about.

---

## Tables

**29 tables in `public`, and Row Level Security is enabled on every one.**
Twenty-six carry at least one policy. The three that carry none —
`integration_tokens`, `rate_limits` and `shipping_quotes` — are deliberate and
are the stricter posture rather than a gap: RLS is on, every grant is revoked
from `anon` and `authenticated`, and only `service_role` reaches them. They are
refused by the *absence* of a policy rather than by the wording of one, which is
one fewer sentence to get wrong. Counts below are from the live project.

| Table | Cols | Policies | What it is |
|---|---:|---:|---|
| `categories` | 10 | 2 | Self-referencing tree — Men → Sneakers |
| `brands` | 7 | 2 | |
| `products` | 20 | 2 | `effective_price` is generated: `coalesce(sale_price, base_price)` |
| `product_images` | 9 | 2 | Exactly one primary per product |
| `product_variants` | 12 | 2 | One row per size × colour. `price_override` beats the product price |
| `collections` | 9 | 2 | Curated rails the owner controls |
| `collection_products` | 6 | 2 | |
| `profiles` | 7 | 4 | One per `auth.users`. Carries `role` |
| `addresses` | 14 | 2 | At most one default per customer, by partial unique index |
| `carts` | 6 | 3 | `user_id` **xor** `guest_token`, by check constraint |
| `cart_items` | 7 | 2 | Unique on `(cart_id, variant_id)` |
| `wishlist_items` | 5 | 2 | Unique on `(user_id, product_id)` |
| `orders` | 29 | 4 | Phase 5 added `guest_token`, `cart_id`, `payment_reference`, `stock_restored_at`; Phase 6 added the advance/balance columns below |
| `order_items` | 15 | 2 | Snapshots name, size, colour, SKU, price — history cannot break |
| `order_status_history` | 6 | 2 | |
| `payments` | 11 | 1 | **Phase 5.** One row per provider order. Admin-read only |
| `payment_events` | 8 | 1 | **Phase 5.** The idempotency ledger. Admin-read only |
| `coupons` | 13 | 1 | Admin-only. Never readable by a customer |
| `reviews` | 10 | 6 | Phase 8 |
| `homepage_sections` | 9 | 2 | The homepage *is* this table, in `sort_order` |
| `banners` | 14 | 2 | |
| `pages` | 9 | 2 | About, Contact, policies |
| `site_settings` | 6 | 2 | Key/jsonb. Announcement, shipping, contact, social |
| `inventory_movements` | 10 | 1 | Append-only ledger of every change to `stock_quantity`. `sum(delta)` per variant must equal the stock; `reconcile_inventory()` proves it |
| `shipments` | 22 | 2 | One per order, `unique (order_id)` — which is the only reason "create shipment" can be idempotent |
| `shipment_events` | 6 | 1 | `unique (shipment_id, event_id)`, claimed by an insert. The same discipline as `payment_events` |
| `shipping_quotes` | 16 | **0** | The delivery fee a customer was *shown*, held server-side so the fee they are *charged* is the same row |
| `integration_tokens` | 4 | **0** | Cached third-party bearer tokens. In Postgres because a serverless instance is not a cache |
| `rate_limits` | 3 | **0** | Fixed-window counters for `consume_rate_limit()`. Per-instance counters reset on every cold start |

### The `private` schema

Not exposed to the Data API, and holding exactly one thing:
`private.promote_to_admin(email)`. Postgres grants `EXECUTE` on a new function
to `PUBLIC` by default and `anon`/`authenticated` inherit from `PUBLIC`, so a
`SECURITY DEFINER` function in `public` is a self-service privilege-escalation
endpoint unless every grant is remembered. A schema PostgREST cannot see is the
structural version of remembering. Confirmed unreachable: a POST to
`/rest/v1/rpc/promote_to_admin` answers `PGRST202`.

---

## What Phase 5 added

### New columns on `orders`

| Column | Type | Why |
|---|---|---|
| `guest_token` | `text` | A guest has no JWT, so `user_id = auth.uid()` cannot describe "my order". The same opaque cookie that names their cart names their order. Null once the order belongs to an account |
| `cart_id` | `uuid` | The double-submit guard. **Unique where not null**, so one cart converts to at most one order — enforced by the database rather than by hoping the browser only posts once. `ON DELETE SET NULL`, so purging old carts never takes orders with them |
| `payment_reference` | `text` | The provider payment id a customer reads off their bank statement, denormalised for support. Authoritative payment state lives in `payments` |
| `stock_restored_at` | `timestamptz` | Non-null means cancellation already gave the units back. Without a marker, a webhook and an admin cancelling seconds apart restock twice and invent inventory |

It **has to be the token and not the order number.** Order numbers come from a
sequence, so `FV-2026-00042` is one keystroke away from `FV-2026-00043`; a
policy of "you may read the order whose number you can name" is a policy of
"anyone may read every order".

### New tables

**`payments`** — one row per attempt at moving money, with the provider's own
vocabulary preserved verbatim, so a support question six months from now ("they
say they were charged twice") is answered from our database rather than from a
dashboard login. A separate table rather than more columns on `orders` because
the cardinality is genuinely one-to-many. Two partial unique indexes,
`(provider, provider_payment_id)` and `(provider, provider_order_id)`, are the
idempotency floor underneath the event log: even if two deliveries raced past
the event table, they could not produce two rows for one provider payment.

**`payment_events`** — every payment webhook we have ever seen.
`unique (provider, event_id)` is the whole idempotency mechanism, and it is a
*constraint* rather than a check-then-insert because a check-then-insert is a
race. `received_at` says we saw it; `processed_at` says we finished acting on
it; a row with a null `processed_at` is a handler that died mid-flight and is
worth looking at — there is a partial index for exactly that queue.

`event_id` is **not** Razorpay's delivery id. It is derived by the adapter as
`<event type>:<entity id>` (`payment.captured:pay_ABC`), so it names the state
change rather than the delivery and a manual resend from the provider dashboard
collapses onto the same row. `20260808090800_payment_event_id_meaning.sql`
carries the reasoning and sets the column comment; the migration whose header
got it wrong is left byte-identical to what was applied, with the correction
recorded rather than rewritten.

### New enums

| Enum | Values |
|---|---|
| `payment_provider` | `cod`, `razorpay` |
| `payment_txn_status` | `created`, `pending`, `captured`, `failed`, `refunded` |

`payment_txn_status` is deliberately **not** the same enum as `payment_status`.
That one is the order's summary and belongs to the customer — three words,
because three words is all a customer needs and all the order state machine can
act on. This one is the provider's lifecycle and belongs to us. Fusing them
would mean a Razorpay `authorized` had to be spelled as either `unpaid` (a lie
by omission) or `paid` (a lie).

For reference, the order-side enums are unchanged: `order_status` is
`pending, confirmed, packed, shipped, delivered, cancelled, returned` and
`payment_status` is `unpaid, paid, refunded`.

### `pg_cron`

The abandoned-order sweep is scheduled **inside the database**. The reasoning is
in `docs/architecture.md`; what belongs here is where to look.

| | |
|---|---|
| Extension | `pg_cron` 1.6.4, installed into **`pg_catalog`** (the Supabase default) |
| Job table | `cron.job` — `select * from cron.job` |
| History | `cron.job_run_details` |
| Job | id **1**, `release-abandoned-orders`, `*/10 * * * *`, `select public.release_abandoned_orders()`, active |
| Job | id **2**, `prune-rate-limits`, `17 * * * *` |
| Job | id **3**, `prune-shipping-quotes`, `23 * * * *` — deletes at 6 hours, which caps any "recent quote" reuse window |
| Job | `reconcile-abandoned-orders`, `*/10 * * * *`, `select private.trigger_order_reconciler()` — **added in Phase 8, not yet applied** |

**The cost, stated plainly:** the schedule is invisible from the repo. The
migration that created it (`20260808100100_schedule_abandoned_order_sweep.sql`)
is versioned, but the live state is not, and `cron.schedule` upserts on the job
name so re-running the migration re-points the job rather than duplicating it.
This paragraph is the pointer that makes that survivable.

### `pg_net`, and the one job that leaves the database

`release_abandoned_orders` was narrowed in Phase 8 to orders with **no
`payments` row at all**. It previously skipped rows whose payment status was
`pending`, `captured` or `refunded` — a list that omitted **`created`**, which
is the status a Razorpay order actually sits at while it waits for its webhook.
Every paid Razorpay order was therefore eligible for cancellation. The full
account is in `docs/architecture.md`.

Deciding the orders it no longer covers means asking Razorpay, and Postgres
cannot make an HTTP call — so `pg_net` does it:

| | |
|---|---|
| Extension | `pg_net` 0.20.4, into `extensions`. **Not enabled until the migration is applied** |
| Caller | `private.trigger_order_reconciler()`, `security definer`, no arguments |
| Target | `POST <cron_target_origin>/api/cron/release-abandoned-orders` |
| Credentials | `vault.decrypted_secrets` — `cron_secret` and `cron_target_origin` |

The two Vault entries are **created by hand, once per environment**, because a
migration is committed to git and a bearer token must not be. The function
raises if either is missing, so an unconfigured reconciler appears as a failed
row in `cron.job_run_details` rather than as silence.

`net.http_post` is asynchronous: the function returns once the request is
*queued*, and the response lands in `net._http_response`. A clean return is
therefore not evidence that the route ran — the webhook-liveness tile on the
admin dashboard is what answers that.

---

## What Phase 6 added

Pay on Delivery. The customer pays an **advance** through Razorpay at checkout
and the courier collects the **balance** in cash, so an order now has to record
both — and the database, not the application, is what guarantees they agree.

### New columns on `orders`

| Column | Type | Why |
|---|---|---|
| `advance_amount` | `bigint` | Charged through Razorpay at checkout, before the order is confirmed. The whole `grand_total` for a prepaid order. **Never zero on a new order** — an order with no money against it is the unsecured COD this model replaced |
| `balance_due_on_delivery` | `bigint` | What the courier collects in cash. This — never `grand_total` — is the COD collectable handed to Shiprocket |
| `cod_handling_fee` | `bigint` | How much of `shipping_fee` is the Pay-on-Delivery return-leg extra. A breakdown, not an addition |
| `cash_collected_at`, `cash_collected_by` | `timestamptz`, `uuid` | Marked by hand in the admin, never inferred from a Shiprocket "Delivered". Delivery usually means payment and occasionally does not, and the difference is the shop's money |
| `delivered_at` | `timestamptz` | When the courier recorded delivery. The 24-hour window for reporting shipment damage runs from this instant, so it is evidence rather than decoration |

**`shipping_fee` deliberately still holds the *total* delivery charge**, so
`grand_total` arithmetic is unchanged and no existing row shifted by a paisa.
`cod_handling_fee` breaks that figure down rather than adding to it — which is
what lets every read site keep reading one column.

The invariant the whole feature rests on is a **check constraint**, enforced by
the database rather than by hope:

```sql
alter table public.orders add constraint orders_advance_balance_sums
  check (advance_amount + balance_due_on_delivery = grand_total);
```

A courier collecting the wrong amount is discovered by customer complaint, which
is far too late and far too expensive. Rows that predate the split were
backfilled *honestly* rather than uniformly — a prepaid order settled its whole
total online, a legacy cash-on-delivery order paid nothing online and owed all of
it at the door — so every existing row satisfies the constraint, which is the
point of writing it that way.

### New columns on `shipments` and `shipping_quotes`

| Table | Column | Why |
|---|---|---|
| `shipments` | `cod_collectable_amount` | What Shiprocket was actually told to collect, recorded when the shipment is created so a discrepancy is answerable from our own data instead of from the Shiprocket panel. Equals the order's `balance_due_on_delivery` |
| `shipments` | `delivered_at` | Taken from tracking when the status first reaches delivered, and mirrored onto the order so the account page can count down without a join |
| `shipping_quotes` | `shipping_fee_paise` | The forward leg a prepaid order would have paid |
| `shipping_quotes` | `cod_handling_paise` | The Pay-on-Delivery extra covering the return leg on a refused parcel. Always `0` for prepaid |

`shipping_quotes.fee_paise` is untouched and still means the total charged for
delivery, so nothing that reads it changed meaning — and a second check
constraint holds the split to it:

```sql
check (shipping_fee_paise + cod_handling_paise = fee_paise)
```

The split is *stored on the quote the customer was shown* rather than recomputed
later from a rate that has since moved. That was the owner's condition for
keeping the surcharge at all: a customer comparing prepaid against Pay on
Delivery has to be able to see the extra and point at it, which is only possible
if it is a named line rather than the difference between two totals. Rows that
predate the split had their whole fee attributed to `shipping_fee_paise` rather
than to an invented boundary.

### `create_order_with_stock` learns about the advance

Two new parameters, both trailing and defaulted, and one new pair of returned
columns:

| | |
|---|---|
| Added in | `p_advance_amount bigint default null`, `p_cod_handling_fee bigint default 0` |
| Returns | `advance_amount`, `balance_due`, alongside what it already returned |
| Unchanged | `SECURITY INVOKER`, `search_path = ''`, **`service_role` only** |

`p_advance_amount` null means "the whole order settles online", which is
prepaid. Both inputs are clamped inside the function rather than trusted: the
handling fee cannot exceed the delivery charge it breaks down, and the advance is
clamped into `[0, grand_total]`.

**The balance is derived inside the function as `grand_total - advance`, never
passed in.** The subtotal is recomputed under the cart's row lock and can differ
from what the checkout page saw if a price moved; two independently-supplied
numbers would then fail the check constraint above and take the whole checkout
down with an opaque error at the pay button. Derived, the invariant holds by
construction, the customer is charged online exactly what the modal showed them,
and any drift lands on the amount the courier collects.

Dropping the function took its privileges with it, so
`20260808120300_create_order_records_advance.sql` re-issues the revoke and the
`service_role` grant. That is not ceremony: Postgres grants `EXECUTE` to
`PUBLIC` on every new function, and a customer who could reach this over
PostgREST could pass their own `p_advance_amount` and pay ₹1 for a ₹17,000
order. Verified live — see `docs/rls-tests.md` §10.

**A migration-vs-live drift was repaired in the same file.** The previous
migration to define this function (`20260808090750_create_order_optional_params`)
had dropped the four `set_config('app.inventory_*')` calls that attribute stock
movements, while the live database still had them. The files therefore no longer
reproduced the database: replaying them into a fresh environment would have
produced a function that still moves stock but records every movement as
`unspecified`, with no actor and no order reference — a ledger that looks
present and is useless, discovered only when somebody asks why a count is wrong.
They are restored, and that file is now the whole truth about this function.

### The ledger learned about new variants

`record_inventory_movement()` was an `AFTER UPDATE` trigger, so a variant
inserted with `stock_quantity = 10` had ten units and **no movement rows at
all** — and `reconcile_inventory()` counted it as drifting by ten, for ever,
because nothing would ever go back and write the missing opening balance. The
370 variants that existed when the ledger was built were backfilled by hand,
which is exactly why this was invisible: it only bites on the *next* variant
anybody creates, and Phase 6 is about to hand the owner a form that creates
variants with stock in them.

There are now two triggers on `product_variants` calling the same function:

| Trigger | Fires | Writes |
|---|---|---|
| `product_variants_record_opening` | `after insert` | An `opening_balance` row for the starting stock. Skipped when the variant is created with zero, because a zero-delta row is noise in the one table that has to stay readable |
| `product_variants_record_movement` | `after update` | The delta, as before. Still tested on the *value* rather than the statement, because `after update of stock_quantity` fires even when the column is in the `SET` list unchanged |

`inventory_movement_reason` also gained `replacement`, so a replacement leaves a
named row rather than an `admin_adjustment` nobody can interpret later. Live
values: `opening_balance, order, cancellation, sweep, admin_adjustment, restock,
shipment, unspecified, replacement`.

### `site_settings.shipping`

**`flat_fee_paise` was deleted, not corrected**, so it cannot come back. It was
the cause of a real drift — the cart read the flat fee and showed ₹199 while
checkout charged a live courier rate, which is `FV-2026-00487` against
`FV-2026-00488`: identical ₹1,499 subtotals, ₹199 and ₹220 of delivery. The
owner's rule is that rates always come from the Shiprocket API and never from
this codebase, and that the *thresholds* are the shop's decision, so what
replaced it is a set of admin-tunable numbers:

| Key | Live value | What it decides |
|---|---|---|
| `free_above_paise` | `249900` | Prepaid delivery is free at or above this. `0` disables the free tier |
| `cod_enabled` | `true` | Master switch for Pay on Delivery, independent of PIN-code serviceability |
| `cod_advance_mode` | `greater_of` | One of `shipping_fee`, `fixed`, `greater_of` |
| `cod_advance_minimum_paise` | `9900` | The advance never falls below this, nor below Razorpay's own 100-paise floor |
| `cod_advance_fixed_paise` | `9900` | Used only when the mode is `fixed` |
| `fallback_fee_paise` | `{"razorpay": 19900, "cod": 34900}` | Used **only** when Shiprocket is unreachable. Not a price list |

`return_window_days` is now **`1`**: the policy is 24 hours, replacement only,
for shipment damage, and there are no refunds and no online returns.

---

## RLS, in one table

| Table group | Anonymous / customer | Admin |
|---|---|---|
| categories, brands, products, product_images, product_variants, collections, banners, homepage_sections, pages, site_settings | `SELECT` where active / published | Full CRUD |
| `profiles` | Read and update own row. **Cannot change `role`** — enforced by a trigger, not only by a policy | Full read; role changes admin-only |
| `addresses`, `carts`, `cart_items`, `wishlist_items` | Full CRUD where `user_id = auth.uid()`, or where `guest_token` matches the request header | Read only |
| `orders`, `order_items`, `order_status_history` | `SELECT` own only — own by `auth.uid()`, or by `guest_token` matching the request header | Full read, status updates |
| `payments`, `payment_events` | **Nothing.** No anon or authenticated policy exists, so a customer reads zero rows, always | Read only |
| `reviews` | `SELECT` approved; insert own; update own while unapproved | Full CRUD |
| `coupons` | No read at all | Full CRUD |

Every policy wraps `auth.uid()` and helper calls in `(select …)` so the planner
evaluates them once per query rather than once per row, and every column a
policy filters on is indexed — including the new `orders_guest_token_idx`.

### The four `orders` policies

`orders` carries four now rather than three, and they OR together:

| Policy | Roles | What it adds |
|---|---|---|
| `customers read their own orders` | authenticated | `user_id = auth.uid()` |
| `guests read the order their token names` | anon, authenticated | `guest_token = current_guest_token()` |
| `admins read every order` | authenticated | `is_admin()` |
| `admins update orders` | authenticated | the only UPDATE policy on the table |

There is deliberately **no INSERT policy on `orders` for anybody**. Checkout goes
through the service role so it can revalidate price and stock; a customer who
could insert an order could name its total.

The child tables ask the parent one question rather than repeating the
condition. `public.owns_order(uuid)` was widened in Phase 5 to accept a guest
token as well as `auth.uid()`, and the `order_items` and `order_status_history`
policies were dropped and recreated to call it. The alternative was the same
sentence written three times, and the day somebody tightens one of them is the
day the other two disagree.

### Why customers read nothing from the payment tables

Not stinginess. A customer needs to know one thing about money — whether their
order is paid — and `orders.payment_status` says it in a word they can act on.
Everything in `payments` and `payment_events` is provider vocabulary, attempt
history and internal ids. Exposing it would leak the shape of failed attempts (a
declined card is nobody else's business, including the customer's other devices)
and hand an attacker a way to enumerate provider order ids.

The **grants** are tightened as well as the policies. RLS decides which rows; a
`GRANT` decides whether the verb is available at all, so a future policy added
in haste cannot resurrect a privilege that was revoked. `anon` has everything
revoked on both tables; `authenticated` keeps `SELECT` — because the admin
policy is evaluated as that role, and taking the grant away means admins read
nothing — and loses `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES` and
`TRIGGER`. Both tables are written by the server through the service role, which
none of that touches.

---

## Functions

| Function | Security | Callable by | Why |
|---|---|---|---|
| `is_admin()` | definer | anon, authenticated | Called from policies, so the grant is load-bearing. Answers only "am I an admin" |
| `can_access_cart(uuid)` | definer | anon, authenticated | Same. Answers only about carts you can already reach |
| `owns_order(uuid)` | definer | anon, authenticated | Same. Widened in Phase 5 to answer for a guest token as well as `auth.uid()` |
| `product_is_live(uuid)` | definer | anon, authenticated | Same; the answer is public anyway |
| `current_guest_token()` | invoker | anon, authenticated | Reads `x-guest-token` from the request headers |
| `discontinued_product_hint(text)` | definer | anon, authenticated | Public catalog data |
| `handle_new_user()` | definer | **revoked** | Trigger only |
| `guard_profile_role()` | invoker | **revoked** | Trigger only. Invoker on purpose — the check reads `current_user` |
| `rls_auto_enable()` | definer | **revoked** | Event trigger (`ensure_rls`) only. Turns RLS on for any new table so a forgotten `alter table` cannot leave one open |
| `set_updated_at()` | — | **revoked** | Trigger only |
| `next_order_number()` | — | **revoked** | Advances a sequence; exposed, anyone could burn order numbers |
| `catalog_query(...)` | — | anon, authenticated | The one listing query |
| `color_family(text)` | invoker, immutable | anon, authenticated | Pure arithmetic on a hex string. No table access |
| **Phase 5** | | | |
| `assert_cart_stock(uuid)` | invoker | **service_role only** | Locks every variant in the cart `FOR UPDATE` in id order and raises `OSTCK` with an `OutOfStockItem[]` json DETAIL. The lock only means anything inside the caller's transaction |
| `create_order_with_stock(...)` | invoker | **service_role only** | The one checkout transaction. Takes no *item* price as an argument; the delivery total, the free-above threshold and the advance go in and are clamped. Raises `MTCRT`, `CNVRT`, `OSTCK` |
| `cancel_order_with_restock(...)` | invoker | **service_role only** | Cancels and returns the units exactly once, guarded by `orders.stock_restored_at`. Returns a word — `cancelled`, `already_cancelled`, `already_paid`, `illegal_transition`, `not_found` — rather than raising, because every caller has to tell those apart |
| `release_abandoned_orders(int)` | invoker | **service_role only** | The sweep. Default cutoff 30 minutes, bounded at 500 rows, skips anything with money in flight. Run by `pg_cron` as the job's owner |
| `merge_guest_cart(text, int)` | invoker | **authenticated only** | The bag merge, in one transaction. Invoker is correct: RLS already shows the `/auth/callback` client both bags |
| `adopt_guest_orders()` | **definer** | authenticated, service_role | Moves the caller's guest orders onto their account. Takes **no arguments** — see below |
| **Phase 6** | | | |
| `create_order_with_stock(...)` | invoker | **service_role only** | Re-declared with `p_advance_amount` and `p_cod_handling_fee`. The `drop` took its ACL with it, so the revoke and grant are re-issued in the same migration |
| `record_inventory_movement()` | **definer** | **revoked** | Trigger only, on `product_variants`. Now `AFTER INSERT` as well as `AFTER UPDATE`, so a new variant's opening stock reaches the ledger |

**Why the Phase 5 write functions are `SECURITY INVOKER`.** The checkout action
reaches them through `createAdminClient()`, which already bypasses RLS, so
`DEFINER` would buy nothing and would cost the trap Phase 1 was bitten by:
`current_user` resolving to the function owner rather than the caller. Their
`search_path` is pinned to `''` and every name is schema-qualified regardless,
because a function that is safe only because of who calls it is safe until that
changes.

**Why the grants had to be written down at all.** Postgres grants `EXECUTE` to
`PUBLIC` on every new function, and Supabase's default privileges add `anon`,
`authenticated` and `service_role` on top. Without the revokes,
`create_order_with_stock` is a PostgREST endpoint at
`/rest/v1/rpc/create_order_with_stock` that any visitor can POST to. It is
`SECURITY INVOKER`, so RLS would still stop most of the damage — but "most" is
not a security model: an anonymous caller could burn order numbers and probe for
cart ids, and a signed-in one could hand it their own cart id with a shipping
fee of zero.

**`adopt_guest_orders()` is the one new `SECURITY DEFINER` function, and it
needs to be.** `authenticated` has no UPDATE policy on `orders` and must not get
one — a policy letting a customer PATCH their own order rows over PostgREST
would be a far larger hole than the one being closed. So the write happens
inside a function that owns the privilege, built so the privilege cannot be
aimed: it takes no parameters at all, the user comes from `auth.uid()` and the
token from `current_guest_token()`, and `and user_id is null` means it can never
take an order off an account that already owns one. The full reasoning, and why
this is not a repeat of Phase 1's `guard_profile_role()` mistake, is in
`docs/rls-tests.md` §9.

**Five** definer functions show up in Supabase's security advisor as
`anon_security_definer_function_executable` — the four policy helpers plus
`discontinued_product_hint`. That is understood and accepted, not missed: an RLS
policy expression is evaluated with the privileges of the querying role, so
revoking `EXECUTE` would break the policies that call them. The mitigation is
scope — each answers a question about the caller, or about data that is already
public, so being callable leaks nothing the row itself would not.

Phase 5 adds one more advisor line,
`authenticated_security_definer_function_executable` on `adopt_guest_orders`.
Both are enumerated with their reasoning in `docs/rls-tests.md` §9, so the
warning stops being re-investigated every phase.

---

## Phase 4 migrations

| File | What it does |
|---|---|
| `20260807150000_auth_admin_bootstrap.sql` | `handle_new_user()` pins `role = 'customer'` as a literal; creates the `private` schema and `promote_to_admin` |
| `20260807160000_cart_price_seen.sql` | Adds `cart_items.unit_price_seen` |

### Why `handle_new_user` pins the role

`raw_user_meta_data` is populated from the OAuth provider's profile payload and
is editable by the user through the auth API. A role read from it is a role the
user can choose. The behaviour is unchanged from the column default; writing it
as a literal makes the decision visible, so an edit that starts reading a role
out of metadata is obviously wrong rather than merely new.

Proved rather than asserted — `npm run audit:auth` creates an account whose
metadata claims `role: "admin"`, `user_role: "admin"` and `is_admin: true`, then
checks the profile row:

```
PASS  handle_new_user ignores a role in the provider payload  — role = customer
PASS  handle_new_user still takes the display name from the payload
```

### Why `unit_price_seen` exists

`cart_items` deliberately stores no price: the total is recomputed from the
catalog on every read, so a bag can never show a stale total. What that cannot
do is *notice*. "If a price changed, say so in plain language" needs a before as
well as an after. This column is that before, and it is never used in a
calculation — only compared. Nullable, so a line with no snapshot means "nothing
to compare against" and produces no notice rather than a false one.

---

## Phase 5 migrations

Sixteen, each applied through the Supabase MCP server and verified with a
follow-up query rather than assumed.

| File | What it does |
|---|---|
| `20260808090000_orders_guest_and_cart.sql` | The four new `orders` columns, the guest-token index, and `orders_one_per_cart_idx` |
| `20260808090100_payment_records.sql` | `payment_provider`, `payment_txn_status`, `payments` and its indexes |
| `20260808090200_payment_events.sql` | `payment_events` and `unique (provider, event_id)` |
| `20260808090300_rls_payments.sql` | RLS on both payment tables: admin read, and revokes on everything else |
| `20260808090400_rls_guest_orders.sql` | `owns_order()` widened for guests; the guest `orders` policy; child policies recreated |
| `20260808090500_cart_stock_guard.sql` | `assert_cart_stock()` |
| `20260808090510_create_order_with_stock.sql` | `create_order_with_stock()` — **the annotated source; read this one first** |
| `20260808090520_order_function_grants.sql` | Revokes and `service_role` grants for both |
| `20260808090600_cancel_order_with_restock.sql` | `cancel_order_with_restock()` |
| `20260808090700_merge_guest_cart.sql` | The bag merge, moved into one transaction |
| `20260808090750_create_order_optional_params.sql` | Re-declares `create_order_with_stock` with the genuinely-optional parameters defaulted and trailing |
| `20260808090760_create_order_comment.sql` | Restores the comment that the `drop function` above took with it |
| `20260808090800_payment_event_id_meaning.sql` | Corrects what `payment_events.event_id` holds, in the database |
| `20260808100000_release_abandoned_orders.sql` | The sweep (security review E-1) |
| `20260808100100_schedule_abandoned_order_sweep.sql` | `pg_cron`, every ten minutes |
| `20260808100200_adopt_guest_orders.sql` | `adopt_guest_orders()` (security review E-3) |

### Why the checkout transaction is two functions

**The MCP migration channel truncates a payload over roughly 5KB, silently.**
Not with an error — the migration reports success and the function that lands is
the first few kilobytes of the one that was sent. `create_order_with_stock` with
its commentary is well past that, so the stock check was split out into
`assert_cart_stock`. The seam was put where it reads as a sentence rather than
wherever the byte count fell, so the constraint cost nothing structural. The
same limit is why `20260808090750` recreated the function body without its
inline commentary, and why `20260808090510` is named as the file to read.

### Why `20260808090750` drops rather than replaces

`supabase gen types` cannot express parameter nullability — every `uuid`
argument comes out as `string`, never `string | null` — so under `strict` there
was no type-clean way for the checkout action to say "this is a guest, there is
no user id". The options were a cast, hand-editing a generated file that the
next regeneration would silently revert, or making the SQL say what is actually
true. A guest order has no user id and a signed-in order has no guest token;
both are optional, so they are declared optional and the generator emits
`p_user_id?: string`.

It is a `drop` and not a `create or replace` because changing parameter names
and order produces an **overload**, not a replacement, and two functions
differing only in argument order is a live ambiguity waiting for a caller to
trip on.

---

## Phase 6 migrations

Six, each applied through the Supabase MCP server and verified with a follow-up
query rather than assumed.

| File | What it does |
|---|---|
| `20260808120000_shipping_cod_advance_settings.sql` | Deletes `shipping.flat_fee_paise`; adds `cod_enabled`, the three advance keys and `fallback_fee_paise` |
| `20260808120100_shipping_quotes_cod_split.sql` | `shipping_fee_paise` and `cod_handling_paise` on `shipping_quotes`, plus the check that they sum to `fee_paise` |
| `20260808120200_orders_advance_and_balance.sql` | The advance/balance/handling columns, the cash-collection markers, the honest backfill, and `orders_advance_balance_sums` |
| `20260808120300_create_order_records_advance.sql` | `create_order_with_stock` gains the advance — **and the file catches up with the database.** Read this one first |
| `20260808120400_ledger_covers_new_variants.sql` | `replacement` on the reason enum; `record_inventory_movement()` fires on insert; the `product_variants_record_opening` trigger |
| `20260808120500_shipments_collectable_and_delivery.sql` | `shipments.cod_collectable_amount`, `shipments.delivered_at`, `orders.delivered_at` |

### Why `20260808120300` is the file to read

The same 5KB truncation that split the checkout transaction in Phase 5 still
applies, and this file is close to it. It is nonetheless the annotated one,
because it carries two things that cannot be recovered from the schema: why the
balance is derived rather than passed, and the record of the drift it repaired —
the four `set_config('app.inventory_*')` calls that a previous migration had
dropped while the live database kept them. A file that produces a different
function from the one running in production is worse than no file, because it
will be trusted.

### One known untidiness

**Migration filenames do not match the versions recorded by the MCP server.**
This is pre-existing and repo-wide, not new to Phase 5. The relative order is
identical in both, so nothing replays out of sequence; what it costs is that
matching a file to its recorded application is a manual step.

---

## What Phase 7 added

### `returning`, and why `returned` was not enough

`order_status` gained **`returning`**, between `shipped` and `returned`.
Tracking reports RTO hours or days before the parcel is physically back, and
parcels are lost, stolen and crushed on the way. Going straight to `returned`
would mean the only place to restock is a tracking event, which silently invents
inventory the shop does not have.

| From | May now also go to |
|---|---|
| `shipped` | `returning` |
| `returning` | `returned` — and nothing else |

`returning` cannot be cancelled (cancelling restocks, and the units are in a
van) and cannot become `delivered` (that would be a second delivery of the same
parcel). Neither `returning` nor `returned` restocks. Stock returns from an
explicit admin action on **physical receipt**, writing an `inventory_movements`
row with reason `rto_return` and a named actor.

`inventory_movement_reason` gained `rto_return` and `rto_writeoff`. Live values:
`opening_balance, order, cancellation, sweep, admin_adjustment, restock,
shipment, unspecified, replacement, rto_return, rto_writeoff`.

### New columns

| Table | Column | Why |
|---|---|---|
| `orders` | `quoted_courier_name`, `quoted_courier_id` | Which courier quoted. A variance against the one actually assigned is answerable from our own data |
| `orders` | `quoted_forward_paise`, `quoted_rto_paise` | The two legs the advance is made of. **Both from one courier entry** |
| `orders` | `quoted_cod_fee_paise` | Shiprocket's cash-collection fee, the whole of the Pay-on-Delivery extra |
| `orders` | `quote_taken_at`, `quote_source` | `shiprocket` or `fallback`. A fallback must never be read back as a live rate |
| `orders` | `rto_at`, `rto_received_at`, `rto_received_by`, `rto_restocked_at`, `rto_condition`, `rto_actual_charge_paise` | The physical side of a return, and what Shiprocket actually billed beside what it quoted |
| `shipments` | `rto_at`, `rto_charge_paise` | |
| `shipping_quotes` | `courier_id`, `freight_paise`, `cod_fee_paise`, `advance_paise` | The split stored on the quote the customer was shown, rather than recomputed later from a rate that has moved |
| `profiles` | `cod_blocked_at`, `cod_blocked_reason` | Repeat refusals concentrate the loss. The owner can withdraw Pay on Delivery from one customer without withdrawing it from the shop |

### `refunds`

| | |
|---|---|
| Rows | one per refund attempt |
| Idempotency | `razorpay_refund_id` is **unique**. A double-clicked refund cannot become two |
| `reason` | `cancelled_before_dispatch` / `rto` / `shop_error` / `other` |
| `deduction_breakdown` | jsonb, itemised, so "why is this ₹281 short" is answerable |
| `status` | `created` / `pending` / `processed` / `failed`. Complete when the **webhook** says so, never when the API returns 200 |
| RLS | one policy: admins read. `anon` has everything revoked; `authenticated` keeps only `SELECT`, because the admin policy is evaluated as that role |

Same posture as `payments`, for the same reason: a customer needs to know one
thing about money — whether their order is refunded — and `orders.payment_status`
says it in a word. Everything here is provider vocabulary and the shop's own
deduction arithmetic.

### `create_order_with_stock` learns two more things

| | |
|---|---|
| Added | `p_discount_total`, and six frozen-quote parameters |
| Changed | `p_free_shipping_above` gained an explicit `default null` |
| Unchanged | `SECURITY INVOKER`, `search_path = ''`, **`service_role` only** |

**`p_discount_total` is not optional politeness.** The function hardcoded
`discount_total = 0`, which was harmless while nothing discounted anything. The
prepaid discount changes that: `computeOrderTotals` subtracts it, so a function
that ignored it would write a `grand_total` higher than the figure the customer
was shown and charge the difference. Clamped into `[0, subtotal]` like every
other number that arrives from outside.

`p_free_shipping_above` was already passed null by its only caller — the quote
has applied every threshold before that point — but without an explicit default
the generated TypeScript typed it non-nullable, which would have forced a `0`.
`0` means "free above ₹0", which is free delivery on everything.

The drop took the ACL with it, so the revoke and the `service_role` grant are
re-issued in the same migration. Verified live: `proacl` is
`{postgres=X/postgres,service_role=X/postgres}`.

### `site_settings.shipping`

`cod_advance_mode`, `cod_advance_minimum_paise` and `cod_advance_fixed_paise`
were **deleted**, along with the rule they configured.

| Key | What it decides |
|---|---|
| `free_above_paise` | Delivery is free at or above this, **both** methods since Batch 2 |
| `prepaid_estimate_fee_paise` | What a prepaid customer pays when Shiprocket is unreachable, labelled an estimate. Batch 2 renamed it from `fallback_fee_paise.razorpay`; the COD counterpart was deleted, not renamed — see `fallback_behaviour` |
| `cod_enabled` | Master switch for Pay on Delivery |
| `cod_minimum_order_value_paise` | Below this the method is withdrawn. Optional; absent or `0` means no minimum |
| `cod_advance_maximum_paise` | Cap on the deposit. `0` means no cap |
| `include_gst_in_advance` | Recover Shiprocket's 18%, or absorb it |
| `prepaid_discount` | `{mode: flat\|percent, value}` — a percentage is stored as a percentage, a flat amount as paise |
| `shipping_rate_mode` | `live` quotes Shiprocket per PIN; `flat` charges `flat_shipping_fee_paise` and makes **no** Shiprocket call. Renamed from `customer_delivery_fee_mode` in Batch 2 |
| `flat_cod_deposit_mode` (+ `_multiplier` / `_paise`) | What secures a cash order in flat mode. **Unset refuses Pay on Delivery in flat mode** rather than collecting nothing |
| `waive_cod_fee_above_threshold` | Owner's decision: `false`. The cash-handling fee survives free delivery |
| `fallback_behaviour` | `refuse_cod` (owner's decision) or `allow_all`. With no live quote there is no round trip to secure |
| `rto_deduction_policy` | `actual_freight` / `flat` / `none` |
| `wallet_low_balance_paise` | Warn on the dashboard below this Shiprocket balance. Null means the owner has not chosen |

The table above is the Batch 2 shape. `fallback_fee_paise` and the three dead
`cod_advance_*` keys are gone — `20260809110100` deletes them, and the seed no
longer knows the key exists at all: `20260809140000` creates the row with the
owner's confirmed numbers on any database that lacks it, which is what makes a
rebuild from empty open at the right threshold instead of one from two phases
ago.

### The Shiprocket auth latch

`integration_tokens` gained a second row, keyed `shiprocket:auth_lockout`. It is
not a token: `token` holds the reason and `expires_at` is when sign-in may be
attempted again. See `src/lib/shipping/token.ts` — this account's API user was
locked out during setup by repeated failed logins, and the code as it stood
would have done it again at one login attempt per request.

## What Batch 3 added

### The migration set became a backup

Four defects stopped a replay from empty — `pg_cron` scheduled before it
existed, a stale five-argument `cancel_order_with_restock` resurrected by
timestamp order, `rls_auto_enable` revoked by a migration and created by
nothing, and a seed that un-migrated `site_settings.shipping`. All four are
fixed in the files themselves (see `docs/staging.md` §6 for each one's story),
and `npm run rebuild:stage` rebuilds staging from zero and verifies the result
on every run. `20260809150000` writes the owner's box height, so a rebuilt
database quotes Pay on Delivery instead of reopening the hole Batch 2 left by
instruction.

### The refund guards

Two promises moved into the schema, where every writer meets them:

| | |
|---|---|
| `refunds_one_in_flight_per_order` | Partial unique index on `(order_id) where status = 'created'`. The admin flow inserts before calling Razorpay, so a double click is decided by this index, not by the API being fast |
| `refunds_guard()` + trigger | Locks the order row, then refuses any insert/update that would take non-failed refunds past the sum of captured payments. Holds under concurrency; `scripts/audit/refunds.ts` proves it against staging |

`refunds.status` semantics are unchanged and load-bearing: `processed` is
written only by the webhook (`refund.processed`), never by the API call
returning 200. A refund Razorpay knows and the database does not — issued from
their dashboard — becomes a row the moment its webhook or the order page's
import runs; `payment_events` dedupes deliveries under the derived
`refund.processed:rfnd_x` key, so a replay is one refund, also proven.
