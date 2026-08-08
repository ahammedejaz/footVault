# Row Level Security — verification checklist

Every table in `public` has RLS enabled and at least one policy. This document
is the proof: each check below is a query that was run against the live project
(`ahumjhwqgmskjsitctcj`), with the result it returned.

**Two findings came out of this pass, both fixed and re-verified.** They are
written up in §6, because a checklist that has never failed has not been run.
§6b re-runs the escalation check at the start of Phase 3 and is **resolved in
§6b.1** by Phase 4, which runs it over real HTTP; §7 covers the three functions
Phase 3 added. §9 is Phase 5: how a guest reaches their own order, why the two
payment tables are readable by nobody, and the complete `SECURITY DEFINER`
surface with the reasoning for each entry, so the Supabase advisor's standing
warnings stop being re-investigated every phase.

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

**Result — 23 of 23 tables, `rowsecurity = true`, every one with ≥ 1 policy:**

| table | policies | table | policies |
|---|---|---|---|
| addresses | 2 | order_status_history | 2 |
| banners | 2 | orders | 4 |
| brands | 2 | pages | 2 |
| cart_items | 2 | payment_events | 1 |
| carts | 3 | payments | 1 |
| categories | 2 | product_images | 2 |
| collection_products | 2 | product_variants | 2 |
| collections | 2 | products | 2 |
| coupons | 1 | profiles | 4 |
| homepage_sections | 2 | reviews | 6 |
| order_items | 2 | site_settings | 2 |
| | | wishlist_items | 2 |

`payments` and `payment_events` carry one policy each and it is an **admin
read**. That is not an oversight in the "at least one policy" sense — see §9.2
for why a customer is meant to read nothing from either.

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
through the real client. `supabase.auth.signUp()` returned
`429 over_email_send_rate_limit` on this project — email confirmation was on and
the built-in SMTP allowance was exhausted — so no user could be created over
HTTP at all. What the HTTP path adds over the block above is GoTrue's own
handling of `options.data`, which is a verbatim copy into `raw_user_meta_data`;
the fixture above *is* that copy. It was a substitution, and it was recorded as
one.

---

### 6b.1 · Resolved in Phase 4 — the real HTTP path

**Status: resolved.** Email confirmation is now off (`mailer_autoconfirm: true`),
so `signUp()` succeeds and returns a session immediately. The substitution above
is retired; the escalation check now runs against the real attack surface — a
signed-in customer holding a JWT, talking to PostgREST — and it is a script
rather than a paste-in, so it can be re-run on demand:

```
npm run audit:auth        # scripts/audit/auth-rls.ts
```

Result, against the live database:

```
PASS  handle_new_user ignores a role in the provider payload   role = customer
PASS  handle_new_user still takes the display name              full_name = Escalation Test
PASS  customer cannot set their own role over PostgREST         42501: Only an admin can change a profile role
PASS  their role is still customer afterwards                   customer
PASS  is_admin() returns false for a customer                   false
PASS  customer reads zero rows of another customer's profile    0 rows
PASS  /admin is 404 for an anonymous visitor                    HTTP 404
PASS  /admin is 404 for a signed-in customer                    HTTP 404
PASS  /admin does not redirect, which would reveal it exists    HTTP 404
```

The account is created through the public signup endpoint with the anon key —
the same path a customer takes — and its `user_metadata` carries
`role: "admin"`, `user_role: "admin"` and `is_admin: true`. The session cookies
for the `/admin` checks are produced by `@supabase/ssr` itself rather than
hand-assembled, so the cookie format is the real one and not a guess.

**One caveat, now closed.** When this was written Google OAuth was not enabled on
the project, so these sessions were minted with a password grant. That never
weakened the test — PostgREST sees the same JWT shape whichever provider issued
it (`role: authenticated`, `sub: <uid>`) and no policy can tell them apart — and
the one genuinely provider-specific thing, what lands in `raw_user_meta_data`,
is the first check in the list. **Google is now enabled** and real accounts have
been created through it, so the substitution no longer stands between this
document and the real path. The harness still signs up with a password grant,
because a scripted consent screen is not a thing.

**Three checks were skipped at the time**, and reported as SKIP rather than
quietly not run: promoting to admin, `is_admin()` returning true, and `/admin`
returning 200 all need elevated access, and `SUPABASE_SERVICE_ROLE_KEY` was
empty in `.env.local`. **It now has a value**, so re-running `npm run audit:auth`
turns those three skips into checks. They were verified separately at the time
against the live database through the real bootstrap function:

```sql
select private.promote_to_admin('fv-test-other.msj6sfa7@example.com');
-- "fv-test-other.msj6sfa7@example.com is now an admin."
```

```
PASS  is_admin() returns true for the promoted account   returned true
PASS  /admin is 200 for an admin                         HTTP 200
PASS  the admin page actually rendered
```

The service-role key is now filled in, so those skips are checks on the next run.

### 6b.2 · The admin route now exists, so the 404 means something

Until Phase 4 there was no `/admin` route at all, which made the guard
untestable: a missing route 404s on its own, so a working guard and a broken one
were indistinguishable. `src/app/admin/page.tsx` is a placeholder that exists
for exactly this reason. The three-way check above — anonymous 404, signed-in
customer 404, admin 200 — is only meaningful because of it.

### 6b.3 · The bootstrap function is not reachable over HTTP

```
POST /rest/v1/rpc/promote_to_admin          -> PGRST202, function not found
POST /rest/v1/rpc/private.promote_to_admin  -> PGRST202, function not found
```

It lives in the `private` schema, which the Data API does not expose, and
`EXECUTE` is revoked from `public`, `anon` and `authenticated`. Its ACL is
`postgres=X/postgres` and nothing else. It is also absent from Supabase's
security advisor output, where a `SECURITY DEFINER` function in `public` would
have appeared.

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

-- Phase 4: the scripted checks create and clean up their own accounts, but the
-- three that need elevated access cannot delete theirs. This sweeps anything
-- left behind by a run without a service-role key.
delete from auth.users where email like 'fv-test-%@example.com'
                          or email like 'fv-merge%@example.com';
delete from public.carts where user_id is null and guest_token is not null;
```

Verified after teardown: 32 products, 384 variants, and zero rows in `orders`,
`carts`, `coupons`, `profiles` and `reviews` — the seeded catalog, and nothing
left over from the checks.

**Phase 5** added two harnesses that write real orders, real payment rows and
real ledger rows against the live database (`npm run audit:checkout`,
`npm run audit:security`). Both sweep after themselves: every order is
cancelled, restocked and deleted, every cart and `payment_events` row is
removed, and every pinned stock level is put back, with the counts printed at
the end so the sweep can be checked rather than believed. `npm run audit:teardown`
(`scripts/audit/teardown.ts`) is the catch-all for anything a crashed run left
behind.

---

## 9 · Phase 5 — orders you do not need an account to read, and money nobody reads

### 9.1 A guest reads their own order, by token and never by number

A guest checkout produces an order with no `user_id`, so `user_id = auth.uid()`
cannot describe it and the Phase 4 policies leave it unreadable by the person
who placed it. The fix is the mechanism the cart already uses: the opaque token
in the httpOnly cookie, forwarded as `x-guest-token` and read by
`public.current_guest_token()`.

**The policy keys on the token, and it must never key on the order number.**
Order numbers come from a sequence, so `FV-2026-00042` tells you that
`FV-2026-00041` and `FV-2026-00043` both exist. "You may read the order whose
number you can name" is "anyone may read every order" written optimistically.
The token is 32 bytes of randomness in a cookie the page's own JavaScript cannot
see; guessing it is guessing a session.

The application side matches the policy rather than duplicating it.
`getOrderForViewer()` reads through the RLS client, so a `null` means "not
yours, **or** no such order" and the two are indistinguishable by construction.
`/order/[orderNumber]` turns that null into **404**, not 403: "you are not
authorised to view this order" confirms the order exists, which is the entire
prize for somebody walking the number space.

This is not a paste-in block. It is scripted, because it is the check in this
document most worth re-running: `npm run audit:checkout` §2 covers it against
the live database, and `npm run audit:security` attacks it again over real HTTP
through the pages themselves.

| what | expected | result |
|---|---|---|
| guest reads their own order by number, with the token | 1 row | **1** ✅ |
| guest reads it by id, with the token | 1 row | **1** ✅ |
| same order, no `x-guest-token` header | 0 rows | **0** ✅ |
| same order, a *different* guest's token | 0 rows | **0** ✅ |
| a signed-in customer reads a guest order they did not place | 0 rows | **0** ✅ |
| `/order/<somebody else's number>` over HTTP | HTTP 404 | **404** ✅ |
| order-number enumeration around a known order | nothing readable | **nothing** ✅ |

### 9.2 The payment tables are readable by nobody but an admin

`payments` and `payment_events` are RLS-enabled with an admin-read policy and
**nothing else**. There is no `anon` policy and no `authenticated` policy, so a
customer reading either gets zero rows, always.

That is deliberate rather than unfinished. A customer needs to know one thing
about money — whether their order is paid — and `orders.payment_status` says it
in a word they can act on. Everything in these two tables is provider
vocabulary, attempt history and internal identifiers; exposing it would leak the
shape of failed attempts (a declined card is nobody else's business, including
the customer's other devices) and hand an attacker a way to enumerate provider
order ids.

The **grants** are tightened alongside the policies, and the distinction matters:
RLS decides which rows, a `GRANT` decides whether the verb exists at all, so a
future policy added in haste cannot resurrect a privilege that was revoked here.

| role | `payments` / `payment_events` |
|---|---|
| `anon` | everything revoked |
| `authenticated` | `SELECT` only — kept because the admin policy is *evaluated as* this role, so revoking it would mean admins read nothing. `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER` all revoked |
| `service_role` | untouched. This is how the server writes both tables |

### 9.3 The `SECURITY DEFINER` surface, verified independently

Queried from `pg_proc` directly rather than taken on trust, and cross-checked
against Supabase's own advisor. **Phase 5 added exactly one new `SECURITY
DEFINER` function.** It modified one other: `owns_order(uuid)`, widened to accept
a guest token as well as `auth.uid()` — `create or replace` preserves grants, so
it kept its Phase 1 ACL.

| Function | Owner | `search_path` | Who may execute | Why it is correct |
|---|---|---|---|---|
| `can_access_cart(uuid)` | postgres | `""` pinned | anon, authenticated | Called from the `carts` and `cart_items` policies. A policy expression runs as the *calling* role, so the grant is load-bearing — revoke it and anonymous carts stop working entirely. Answers one boolean about the caller |
| `owns_order(uuid)` | postgres | `""` pinned | anon, authenticated | Same, for `order_items` and `order_status_history`. Widened in Phase 5; still answers only "is this row mine", and a non-owner gets `false`, which is what the row itself would have told them |
| `is_admin()` | postgres | `""` pinned | anon, authenticated | Same, for every admin policy in the schema |
| `product_is_live(uuid)` | postgres | `""` pinned | anon, authenticated | Same; the answer is public catalog data anyway |
| `discontinued_product_hint(text)` | postgres | `""` pinned | anon, authenticated | Deliberately narrow: one slug in, three public fields out. No price, no stock, no id, no way to enumerate — it answers only for a slug the caller already typed |
| `handle_new_user()` | postgres | `""` pinned | **postgres, service_role only** | Trigger on `auth.users`. Pins `role = 'customer'` as a literal |
| `rls_auto_enable()` | postgres | `pg_catalog` | **postgres, service_role only** | Event trigger. Turns RLS on for any new table, so a forgotten `alter table` cannot leave one open |
| **`adopt_guest_orders()`** | postgres | `""` pinned | **authenticated, service_role** — not `anon`, no `PUBLIC` | New in Phase 5. See below |
| `private.promote_to_admin(text)` | postgres | pinned | **postgres only** | Outside the Data API entirely; ACL is `postgres=X/postgres` and nothing else |

The five `anon`-executable entries are all flagged by the advisor as
`anon_security_definer_function_executable`. **All five are correct as written
and the grant is load-bearing.** Confirmed behaviourally as well as by ACL:
`owns_order()` returns `false` for another guest's order and `true` only for the
token that placed it, and `is_admin()` returns `false` for `anon` and for a
fresh account that has just tried to `PATCH` its own `profiles.role`.

Every **non**-definer Phase 5 function has `EXECUTE` revoked from `public`,
`anon` and `authenticated` and granted only to `service_role`. Verified live —
`42501` on all four: `create_order_with_stock`, `assert_cart_stock`,
`cancel_order_with_restock`, `next_order_number`. `merge_guest_cart` is
`authenticated`-only and correctly refuses a `p_guest_token` that does not match
the request header; parameter spoofing returns `42501` and the victim's cart is
untouched.

#### Why `adopt_guest_orders()` is `DEFINER`, and why that is not a repeat of §6.1

§6.1 is the reason to be suspicious of `SECURITY DEFINER` in this codebase:
`guard_profile_role()` was created definer, `current_user` inside it resolved to
the function's *owner* rather than the role that issued the statement, and the
guard was silently inert for everybody. So the bar for a new definer function is
high, and this one clears it for a specific structural reason.

The problem it solves: `authenticated` has **no UPDATE policy on `orders`, and
must not get one.** A policy letting a customer PATCH their own order rows over
PostgREST would be a much larger hole than the one being closed — order status,
totals and addresses all live on that row. So the write happens inside a
function that owns the privilege, and the function is built so the privilege
cannot be aimed:

- **It takes no parameters at all.** There is nothing to spoof. The user comes
  from `auth.uid()` and the token from `public.current_guest_token()`, which
  reads the `x-guest-token` request header — the same header the cart policies
  key on, forwarded from an httpOnly cookie the browser's own JavaScript cannot
  read.
- **Both of those are *request* facts, not *role* facts**, so `DEFINER` does not
  change what they return. That is precisely the difference from
  `guard_profile_role()`, which read `current_user` — a role fact, and therefore
  exactly the thing `DEFINER` rewrites.
- **It grants no capability the caller did not already have.** Holding the token
  already grants read access to those orders through the guest `SELECT` policy;
  this converts one form of ownership into another. Somebody who could not read
  an order before cannot adopt it now.
- **`and user_id is null`** means it can never take an order off an account that
  already owns one.

Verified independently against the live database: `prosecdef = true`,
`pronargs = 0`, `search_path = ""`, granted to `authenticated` and
`service_role` only — not `anon`, and no `PUBLIC`.

This adds one advisor line,
`authenticated_security_definer_function_executable` on `adopt_guest_orders`.
It is expected, it is listed here, and it does not need re-investigating.
