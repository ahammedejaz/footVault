-- =============================================================================
-- 0006a · RLS helpers
--
-- Part of the single RLS pass split across four migrations so each applies as
-- one reviewable unit. Together they cover every table in `public`.
--
-- Two performance rules are followed throughout, per Supabase's RLS guidance:
--   1. auth.uid() and helper calls are wrapped in (select ...) so the planner
--      evaluates them once per query instead of once per row.
--   2. Every column a policy filters on is indexed (see the table migrations).
--
-- Coverage is proved by docs/rls-tests.md, which runs against the live database.
-- =============================================================================

-- --- guest identity ----------------------------------------------------------
-- A guest has no JWT, so there is nothing in auth.uid() to key a cart on. The
-- server issues an opaque random token, stores it in an httpOnly cookie, and
-- forwards it to PostgREST as the x-guest-token header. The token is a bearer
-- secret with exactly the security properties of a session cookie: unguessable,
-- never rendered into HTML, and scoped to one cart.

create or replace function public.current_guest_token()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(
    coalesce(current_setting('request.headers', true), '{}')::json ->> 'x-guest-token',
    ''
  );
$$;

comment on function public.current_guest_token() is
  'The x-guest-token request header, or null. Identifies an anonymous cart owner.';

-- --- ownership helpers -------------------------------------------------------
-- SECURITY DEFINER so a policy on a child table can consult the parent without
-- the caller needing to be able to read the parent directly. Each one checks
-- the caller's own identity internally, so none of them can be used to reach
-- another customer's rows.

create or replace function public.can_access_cart(cart uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.carts c
    where c.id = cart
      and (
        (c.user_id is not null and c.user_id = (select auth.uid()))
        or (c.guest_token is not null and c.guest_token = (select public.current_guest_token()))
      )
  );
$$;

create or replace function public.owns_order(order_ref uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.orders o
    where o.id = order_ref
      and o.user_id is not null
      and o.user_id = (select auth.uid())
  );
$$;

create or replace function public.product_is_live(product_ref uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.products p
    where p.id = product_ref
      and p.is_active
      and p.deleted_at is null
  );
$$;
