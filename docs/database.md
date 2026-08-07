# Database

Generated against the live Supabase project (`ahumjhwqgmskjsitctcj`) after the
Phase 4 migrations. Regenerate this whenever a migration lands.

Money is **integer paise** everywhere. ₹1,999 is `199900`. There is no float in
the schema and no rounding to argue about.

---

## Tables

21 tables in `public`. **Row Level Security is enabled on every one**, and every
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
| `orders` | 19 | 3 | Phase 5 |
| `order_items` | 15 | 2 | Snapshots name, size, colour, SKU, price — history cannot break |
| `order_status_history` | 6 | 2 | |
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

## RLS, in one table

| Table group | Anonymous / customer | Admin |
|---|---|---|
| categories, brands, products, product_images, product_variants, collections, banners, homepage_sections, pages, site_settings | `SELECT` where active / published | Full CRUD |
| `profiles` | Read and update own row. **Cannot change `role`** — enforced by a trigger, not only by a policy | Full read; role changes admin-only |
| `addresses`, `carts`, `cart_items`, `wishlist_items` | Full CRUD where `user_id = auth.uid()`, or where `guest_token` matches the request header | Read only |
| `orders`, `order_items`, `order_status_history` | `SELECT` own only | Full read, status updates |
| `reviews` | `SELECT` approved; insert own; update own while unapproved | Full CRUD |
| `coupons` | No read at all | Full CRUD |

Every policy wraps `auth.uid()` and helper calls in `(select …)` so the planner
evaluates them once per query rather than once per row, and every column a
policy filters on is indexed.

---

## Functions

| Function | Security | Callable by | Why |
|---|---|---|---|
| `is_admin()` | definer | anon, authenticated | Called from policies, so the grant is load-bearing. Answers only "am I an admin" |
| `can_access_cart(uuid)` | definer | anon, authenticated | Same. Answers only about carts you can already reach |
| `owns_order(uuid)` | definer | anon, authenticated | Same |
| `product_is_live(uuid)` | definer | anon, authenticated | Same; the answer is public anyway |
| `current_guest_token()` | invoker | anon, authenticated | Reads `x-guest-token` from the request headers |
| `discontinued_product_hint(text)` | definer | anon, authenticated | Public catalog data |
| `handle_new_user()` | definer | **revoked** | Trigger only |
| `guard_profile_role()` | invoker | **revoked** | Trigger only. Invoker on purpose — the check reads `current_user` |
| `set_updated_at()` | — | **revoked** | Trigger only |
| `next_order_number()` | — | **revoked** | Advances a sequence; exposed, anyone could burn order numbers |
| `catalog_query(...)` | — | anon, authenticated | The one listing query |
| `private.promote_to_admin(text)` | definer | **postgres only** | The owner's bootstrap |

The four policy helpers show up in Supabase's security advisor as
`anon_security_definer_function_executable`. That is understood and accepted, not
missed: an RLS policy expression is evaluated with the privileges of the
querying role, so revoking `EXECUTE` would break the policies that call them. The
mitigation is scope — each answers a question about the caller, or about data
that is already public, so being callable leaks nothing the row itself would not.

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
