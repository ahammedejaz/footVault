# Database

Generated against the live Supabase project (`ahumjhwqgmskjsitctcj`) after the
Phase 5 migrations. Regenerate this whenever a migration lands.

Money is **integer paise** everywhere. ₹1,999 is `199900`. There is no float in
the schema and no rounding to argue about.

---

## Tables

23 tables in `public`. **Row Level Security is enabled on every one**, and every
one carries at least one policy — a table with RLS on and no policies is
invisible rather than safe, so both are checked.

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
| `orders` | 23 | 4 | Phase 5 added `guest_token`, `cart_id`, `payment_reference`, `stock_restored_at` |
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

**The cost, stated plainly:** the schedule is invisible from the repo. The
migration that created it (`20260808100100_schedule_abandoned_order_sweep.sql`)
is versioned, but the live state is not, and `cron.schedule` upserts on the job
name so re-running the migration re-points the job rather than duplicating it.
This paragraph is the pointer that makes that survivable.

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
| `create_order_with_stock(...)` | invoker | **service_role only** | The one checkout transaction. Takes no price as an argument — only the shipping policy. Raises `MTCRT`, `CNVRT`, `OSTCK` |
| `cancel_order_with_restock(...)` | invoker | **service_role only** | Cancels and returns the units exactly once, guarded by `orders.stock_restored_at`. Returns a word — `cancelled`, `already_cancelled`, `already_paid`, `illegal_transition`, `not_found` — rather than raising, because every caller has to tell those apart |
| `release_abandoned_orders(int)` | invoker | **service_role only** | The sweep. Default cutoff 30 minutes, bounded at 500 rows, skips anything with money in flight. Run by `pg_cron` as the job's owner |
| `merge_guest_cart(text, int)` | invoker | **authenticated only** | The bag merge, in one transaction. Invoker is correct: RLS already shows the `/auth/callback` client both bags |
| `adopt_guest_orders()` | **definer** | authenticated, service_role | Moves the caller's guest orders onto their account. Takes **no arguments** — see below |

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

### One known untidiness

**Migration filenames do not match the versions recorded by the MCP server.**
This is pre-existing and repo-wide, not new to Phase 5. The relative order is
identical in both, so nothing replays out of sequence; what it costs is that
matching a file to its recorded application is a manual step.
