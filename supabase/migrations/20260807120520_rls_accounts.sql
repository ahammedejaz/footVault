-- =============================================================================
-- 0006c · RLS — profiles and customer-owned data
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

-- Profiles: own row only. The role column is additionally guarded by the
-- profiles_guard_role trigger, because a customer legitimately updates their
-- own row and that row is where the role lives.

alter table public.profiles enable row level security;

create policy "customers read their own profile"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy "customers update their own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));
create policy "admins read every profile"
  on public.profiles for select to authenticated
  using ((select public.is_admin()));
create policy "admins update any profile"
  on public.profiles for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- No INSERT policy by design: rows are created by handle_new_user(), which runs
-- SECURITY DEFINER on the auth.users trigger. No DELETE policy either — a
-- profile dies with its auth.users row, via the cascade.

-- =============================================================================
-- Customer-owned data. Admins read but never write: the owner has no business
-- editing a customer's saved addresses or reaching into their bag.

alter table public.addresses      enable row level security;
alter table public.carts          enable row level security;
alter table public.cart_items     enable row level security;
alter table public.wishlist_items enable row level security;

create policy "customers manage their own addresses"
  on public.addresses for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "admins read addresses"
  on public.addresses for select to authenticated
  using ((select public.is_admin()));

create policy "customers manage their own cart"
  on public.carts for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "guests manage the cart their token names"
  on public.carts for all to anon, authenticated
  using (guest_token is not null and guest_token = (select public.current_guest_token()))
  with check (guest_token is not null and guest_token = (select public.current_guest_token()));
create policy "admins read carts"
  on public.carts for select to authenticated
  using ((select public.is_admin()));

create policy "cart items follow their cart"
  on public.cart_items for all to anon, authenticated
  using ((select public.can_access_cart(cart_id)))
  with check ((select public.can_access_cart(cart_id)));
create policy "admins read cart items"
  on public.cart_items for select to authenticated
  using ((select public.is_admin()));

create policy "customers manage their own wishlist"
  on public.wishlist_items for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "admins read wishlists"
  on public.wishlist_items for select to authenticated
  using ((select public.is_admin()));
