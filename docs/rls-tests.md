# Row Level Security — verification checklist

Every table in `public` has RLS enabled and at least one policy. This document
is the proof: each check below is a query that was run against the live project
(`ahumjhwqgmskjsitctcj`), with the result it returned.

**Two findings came out of this pass, both fixed and re-verified.** They are
written up in §6, because a checklist that has never failed has not been run.
§6b re-runs the escalation check at the start of Phase 3; §7 covers the three
functions Phase 3 added.

## How to run it

The checks impersonate a role the way PostgREST does — `set local role`, plus
the JWT claims or request headers that role would arrive with. Wrap each block
in `begin` / `rollback` so nothing it writes survives.

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<user-uuid>","role":"authenticated"}';
-- ... the check ...
rollback;
```

Two things to keep in mind, both of which produced a false pass on the first
attempt at this document:

1. **RLS filters rows; it does not raise.** An `UPDATE` that matches no policy
   affects zero rows and reports success. Count the affected rows — `with x as
   (update ... returning 1) select count(*) from x` — rather than checking for
   an error. Only a `WITH CHECK` violation on `INSERT`/`UPDATE` raises `42501`.
2. **Fixtures must be committed outside the test transaction.** A `rollback` at
   the end of a batch discards the rows inserted earlier in the same batch, and
   the checks then pass against an empty table.

### Fixtures

```sql
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'rls-customer-a@example.test', '',
   now(), now(), now(), '{"provider":"email"}', '{"full_name":"RLS Customer A"}'),
  ('bbbbbbbb-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'rls-customer-b@example.test', '',
   now(), now(), now(), '{"provider":"email"}', '{"full_name":"RLS Customer B"}'),
  ('cccccccc-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'rls-admin@example.test', '',
   now(), now(), now(), '{"provider":"email"}', '{"full_name":"RLS Admin"}');

update public.profiles set role = 'admin'
 where id = 'cccccccc-0000-4000-8000-000000000003';
```

Then one order per customer, a coupon, a deactivated product, and two guest
carts with the tokens `guest-token-alpha` and `guest-token-beta`.

Tear down with the block in §8.

---

## 0 · Coverage

Every table has RLS on and is covered by at least one policy. A table with RLS
on and no policy denies everything, which is the safe failure — but an
uncovered table is still a bug, so this is checked first.

```sql
select t.tablename, t.rowsecurity,
       (select count(*) from pg_policies p
         where p.schemaname = 'public' and p.tablename = t.tablename) as policies
  from pg_tables t
 where t.schemaname = 'public'
 order by t.tablename;
```

**Result — 21 of 21 tables, `rowsecurity = true`, every one with ≥ 1 policy:**

| table | policies | table | policies |
|---|---|---|---|
| addresses | 2 | order_status_history | 2 |
| banners | 2 | orders | 3 |
| brands | 2 | pages | 2 |
| cart_items | 2 | product_images | 2 |
| carts | 3 | product_variants | 2 |
| categories | 2 | products | 2 |
| collection_products | 2 | profiles | 4 |
| collections | 2 | reviews | 6 |
| coupons | 1 | site_settings | 2 |
| homepage_sections | 2 | wishlist_items | 2 |
| order_items | 2 | | |

`supabase --advisors security` reports **no** missing-RLS or exposed-table
findings. Its remaining warnings are `SECURITY DEFINER` functions reachable
over RPC; those are addressed in migration `0008_function_grants`, which
revokes the ones nothing calls and documents why the four policy helpers keep
their grant (a policy expression runs with the *caller's* privileges, so
revoking `is_admin()` from `authenticated` would break every admin policy).

---

## 1 · Anonymous visitor

```sql
begin;
set local role anon;
select
  (select count(*) from public.products)          as products_visible,
  (select count(*) from public.product_variants)  as variants_visible,
  (select count(*) from public.pages)             as pages_visible,
  (select count(*) from public.site_settings)     as settings_visible,
  (select count(*) from public.homepage_sections) as sections_visible,
  (select count(*) from public.coupons)           as coupons_visible,
  (select count(*) from public.orders)            as orders_visible,
  (select count(*) from public.profiles)          as profiles_visible,
  (select count(*) from public.carts)             as carts_visible,
  (select count(*) from public.addresses)         as addresses_visible;
rollback;
```

| what | expected | got |
|---|---|---|
| `products_visible` | 32 — the catalog, **not** the deactivated 33rd | **32** ✅ |
| `variants_visible` | 384, including sold-out sizes | **384** ✅ |
| `pages_visible` | 7 published CMS pages | **7** ✅ |
| `settings_visible` | 9 public settings | **9** ✅ |
| `sections_visible` | 6 homepage sections | **6** ✅ |
| `coupons_visible` | 0 — codes must not be enumerable | **0** ✅ |
| `orders_visible` | 0 | **0** ✅ |
| `profiles_visible` | 0 | **0** ✅ |
| `carts_visible` | 0 without a guest token | **0** ✅ |
| `addresses_visible` | 0 | **0** ✅ |

Sold-out variants stay readable on purpose: the size-run strip shows the whole
run with unavailable sizes struck through, which it cannot do if the database
hides them.

---

## 2 · Signed-in customer reads their own data and nothing else

Customer A, with an order of their own and one belonging to customer B.

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';
select
  (select count(*) from public.profiles)   as profiles_visible,
  (select count(*) from public.orders)     as orders_visible,
  (select count(*) from public.orders
     where user_id = 'bbbbbbbb-0000-4000-8000-000000000002') as other_customer_orders,
  (select count(*) from public.order_items) as order_items_visible,
  (select count(*) from public.coupons)     as coupons_visible,
  (select public.is_admin())                as is_admin;
rollback;
```

| what | expected | got |
|---|---|---|
| `profiles_visible` | 1 — own row only, of 3 | **1** ✅ |
| `orders_visible` | 1 — own order only, of 2 | **1** ✅ |
| `other_customer_orders` | 0 — *the headline check from the brief* | **0** ✅ |
| `order_items_visible` | 1 — own line only | **1** ✅ |
| `coupons_visible` | 0 | **0** ✅ |
| `is_admin` | false | **false** ✅ |

---

## 3 · A customer cannot write outside their own lane

Row counts, not error codes — see the note at the top.

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';
with edit_other as (
  update public.profiles set full_name = 'hijacked'
   where id = 'bbbbbbbb-0000-4000-8000-000000000002' returning 1),
edit_own as (
  update public.profiles set full_name = 'Customer A'
   where id = 'aaaaaaaa-0000-4000-8000-000000000001' returning 1),
edit_catalog as (
  update public.products set name = name
   where slug = 'nike-air-max-90-mens' returning 1),
read_other_order as (
  select 1 from public.orders where id = '22222222-0000-4000-8000-000000000002')
select (select count(*) from edit_other)       as other_profile_rows_changed,
       (select count(*) from edit_own)         as own_profile_rows_changed,
       (select count(*) from edit_catalog)     as catalog_rows_changed,
       (select count(*) from read_other_order) as other_order_rows_read;
rollback;
```

| what | expected | got |
|---|---|---|
| `other_profile_rows_changed` | 0 | **0** ✅ |
| `own_profile_rows_changed` | 1 — a customer may edit their own name | **1** ✅ |
| `catalog_rows_changed` | 0 — the catalog is admin-only | **0** ✅ |
| `other_order_rows_read` | 0 | **0** ✅ |

Statements that must raise rather than silently affect nothing:

| attempt | expected | got |
|---|---|---|
| `insert into orders (...)` as a customer | blocked — there is no INSERT policy; checkout goes through the service role so it can revalidate price and stock | **`42501`** ✅ |
| `update profiles set role = 'admin'` on own row | blocked by the `profiles_guard_role` trigger | **`42501`** ✅ *(see §6.1)* |
| `insert into reviews (... is_approved = true)` | blocked — moderation is not the reviewer's to grant | **`42501`** ✅ |
| `insert into reviews (... is_verified_purchase = true)` | blocked — the server decides what is verified | **`42501`** ✅ |
| `insert into reviews (... user_id = <customer B>)` | blocked | **`42501`** ✅ |
| `insert into reviews (...)` honestly, as self | allowed, and readable back by its author while unapproved | **allowed, 1 visible** ✅ |

---

## 4 · Guest carts

A guest has no `auth.uid()`. The server issues an opaque token, keeps it in an
httpOnly cookie, and forwards it as the `x-guest-token` header;
`public.current_guest_token()` reads it inside the cart policies.

```sql
begin;
set local role anon;
set local request.headers = '{"x-guest-token":"guest-token-alpha"}';
with add_to_own as (
  insert into public.cart_items (cart_id, variant_id, quantity)
  select '33333333-0000-4000-8000-000000000003', id, 1
    from public.product_variants where sku = 'FV-NIKE-AIRMAX90-WHITEG-10'
  returning 1),
steal_other as (
  update public.carts set guest_token = 'guest-token-alpha'
   where id = '44444444-0000-4000-8000-000000000004' returning 1)
select (select count(*) from add_to_own)  as own_cart_rows_added,
       (select count(*) from steal_other) as other_cart_rows_stolen,
       (select public.can_access_cart('33333333-0000-4000-8000-000000000003'::uuid)) as can_access_own,
       (select public.can_access_cart('44444444-0000-4000-8000-000000000004'::uuid)) as can_access_other,
       (select count(*) from public.carts) as carts_visible;
rollback;
```

| what | expected | got |
|---|---|---|
| `own_cart_rows_added` | 1 | **1** ✅ |
| `other_cart_rows_stolen` | 0 | **0** ✅ |
| `can_access_own` | true | **true** ✅ |
| `can_access_other` | false | **false** ✅ |
| `carts_visible` | 1 of 2 | **1** ✅ |

And with no token at all:

| what | expected | got |
|---|---|---|
| `current_guest_token() is null` | true | **true** ✅ |
| `carts_visible` | 0 | **0** ✅ |
| `cart_items_visible` | 0 | **0** ✅ |

---

## 5 · Admin

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-0000-4000-8000-000000000003","role":"authenticated"}';
select (select public.is_admin())                as is_admin,
       (select count(*) from public.products)    as products_visible,
       (select count(*) from public.orders)      as orders_visible,
       (select count(*) from public.profiles)    as profiles_visible,
       (select count(*) from public.coupons)     as coupons_visible,
       (select count(*) from public.addresses)   as addresses_visible;
rollback;
```

| what | expected | got |
|---|---|---|
| `is_admin` | true | **true** ✅ |
| `products_visible` | 33 — including the deactivated one a customer cannot see | **33** ✅ |
| `orders_visible` | 2 — every order | **2** ✅ |
| `profiles_visible` | 3 — every customer | **3** ✅ |
| `coupons_visible` | 1 | **1** ✅ |
| `addresses_visible` | 0 — none exist; admins may read but never write them | **0** ✅ |

The trigger on `auth.users` is verified in passing: inserting the three fixture
users produced three `profiles` rows, each defaulting to `customer`.

---

## 6 · What this pass caught

### 6.1 A customer could make themselves an admin

`guard_profile_role()` was created `SECURITY DEFINER`. Inside such a function
`current_user` is the function's *owner*, `postgres` — not the role that issued
the statement. `postgres` is on the trusted list the guard consults, so the
check passed for everybody:

```sql
-- as customer A, before the fix
update public.profiles set role = 'admin' where id = auth.uid();
select role, public.is_admin() from public.profiles where id = auth.uid();
-- => 'admin', true
```

RLS was working exactly as designed here — a customer *is* allowed to update
their own profile row, and that row is where the role lives. The trigger was
the only thing standing between a customer and the admin panel, and it was
inert.

Fixed in `20260807120800_fix_role_guard.sql` by making the function
`SECURITY INVOKER`, so `current_user` is the role PostgREST switched to:
`authenticated` for a customer, `service_role` for a server action, `postgres`
for a migration. Re-verified: the escalation now raises `42501`, editing one's
own name still works, and the role stays `customer`.

### 6.2 Every cart query could fail with a JSON parse error

`current_guest_token()` defaulted the header GUC with
`coalesce(current_setting('request.headers', true), '{}')`. `coalesce` only
replaces `NULL`, and `current_setting(..., true)` returns `NULL` only while the
setting has *never* been set on that connection. After any transaction that set
it — which, on a pooled connection, means after the first request that carried
a guest token — it comes back as the empty string, and `''::json` raises
`22P02`. Because the function is called from the `carts` and `cart_items`
policies, that surfaced as every cart query erroring rather than as an empty
cart.

Found by running §4 twice on one connection: the first pass passed, the second
raised. Fixed in `20260807120900_fix_guest_token_parse.sql` with a `nullif`
ahead of the `coalesce`, so the `'{}'` default is actually reached.

---

## 6b · Phase 3 preflight — the escalation test, re-run

Re-run at the start of Phase 3 against a user created the way GoTrue creates
one, with a hostile `raw_user_meta_data`:

```sql
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
values ('dddddddd-0000-4000-8000-00000000000e',
        '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'preflight-escalation@example.test', '',
        now(), now(), now(), '{"provider":"email"}',
        '{"full_name":"Preflight Probe","role":"admin","is_admin":true,"user_role":"admin"}');

select p.role, u.raw_user_meta_data ->> 'role' as claimed
  from public.profiles p join auth.users u on u.id = p.id
 where p.id = 'dddddddd-0000-4000-8000-00000000000e';
```

| what | expected | got |
|---|---|---|
| `claimed` | `admin` — the payload the client controls | **admin** ✅ |
| `role` | `customer` — `handle_new_user()` never reads it | **customer** ✅ |

Then, as that user:

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"dddddddd-0000-4000-8000-00000000000e","role":"authenticated"}';
update public.profiles set role = 'admin' where id = auth.uid();
rollback;
```

| what | expected | got |
|---|---|---|
| the update | `42501` from `guard_profile_role()` | **`ERROR: 42501: Only an admin can change a profile role`** ✅ |
| editing own `full_name` | 1 row — the guard is targeted, not a blanket denial | **1** ✅ |
| `public.is_admin()` | false | **false** ✅ |
| `role` afterwards | `customer` | **customer** ✅ |

**What could not be checked this way.** The brief asks for the signup to go
through the real client. `supabase.auth.signUp()` returns
`429 over_email_send_rate_limit` on this project — email confirmation is on and
the built-in SMTP allowance is exhausted — so no user can be created over HTTP
at all. What the HTTP path adds over the block above is GoTrue's own handling of
`options.data`, which is a verbatim copy into `raw_user_meta_data`; the fixture
above *is* that copy. It is a substitution, and it is recorded as one. Re-run the
client-side version once SMTP is configured, or once "Confirm email" is off.

## 7 · New functions in Phase 3

| function | security | why it is safe |
|---|---|---|
| `catalog_query()` | INVOKER | RLS runs inside, so it can never return a row the caller could not have read through PostgREST directly. |
| `color_family()` | INVOKER, IMMUTABLE | Pure arithmetic on a hex string. No table access. |
| `discontinued_product_hint()` | **DEFINER** | Deliberately narrow: one slug in, three fields out (name, category slug, category name). No price, no stock, no id, and no way to enumerate — it answers only for a slug the caller already typed. It exists so a 404 on a discontinued product can offer the category it belonged to. |

`discontinued_product_hint` is revoked from `public` and granted explicitly to
`anon` and `authenticated`.

## 8 · Teardown

```sql
delete from public.order_items where sku in ('RLS-TEST-A', 'RLS-TEST-B');
delete from public.orders  where id in ('11111111-0000-4000-8000-000000000001',
                                        '22222222-0000-4000-8000-000000000002');
delete from public.carts   where guest_token in ('guest-token-alpha', 'guest-token-beta');
delete from public.coupons where code = 'RLSTEST10';
delete from public.products where slug = 'rls-hidden-product';
delete from auth.users where email like 'rls-%@example.test';
delete from auth.users where email = 'preflight-escalation@example.test';
```

Verified after teardown: 32 products, 384 variants, and zero rows in `orders`,
`carts`, `coupons`, `profiles` and `reviews` — the seeded catalog, and nothing
left over from the checks.
