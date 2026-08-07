-- =============================================================================
-- 0006d · RLS — orders, reviews and coupons
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

-- Orders. Customers read their own and nothing else. There is deliberately no
-- INSERT or UPDATE policy for anon or authenticated: an order is created only
-- by the checkout server action, which revalidates every price and stock level
-- and decrements stock in one transaction. A client that could insert an order
-- row directly could name its own grand_total.

alter table public.orders               enable row level security;
alter table public.order_items          enable row level security;
alter table public.order_status_history enable row level security;

create policy "customers read their own orders"
  on public.orders for select to authenticated
  using (user_id is not null and user_id = (select auth.uid()));
create policy "admins read every order"
  on public.orders for select to authenticated
  using ((select public.is_admin()));
create policy "admins update orders"
  on public.orders for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "customers read their own order items"
  on public.order_items for select to authenticated
  using ((select public.owns_order(order_id)));
create policy "admins read every order item"
  on public.order_items for select to authenticated
  using ((select public.is_admin()));

create policy "customers read their own order history"
  on public.order_status_history for select to authenticated
  using ((select public.owns_order(order_id)));
create policy "admins manage order history"
  on public.order_status_history for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- =============================================================================
-- Reviews: read what is approved, plus your own while it waits.

alter table public.reviews enable row level security;

create policy "approved reviews are publicly readable"
  on public.reviews for select to anon, authenticated
  using (is_approved);
create policy "customers read their own pending review"
  on public.reviews for select to authenticated
  using (user_id = (select auth.uid()));
-- is_verified_purchase and is_approved are set by the server, never by the
-- client: the with check pins both to their safe values on insert.
create policy "customers write their own review"
  on public.reviews for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and is_approved = false
    and is_verified_purchase = false
  );
create policy "customers edit their review until it is approved"
  on public.reviews for update to authenticated
  using (user_id = (select auth.uid()) and not is_approved)
  with check (user_id = (select auth.uid()) and not is_approved);
create policy "customers delete their own review"
  on public.reviews for delete to authenticated
  using (user_id = (select auth.uid()));
create policy "admins moderate reviews"
  on public.reviews for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- =============================================================================
-- Coupons. RLS is enabled and no policy grants anon or authenticated anything,
-- so a customer cannot enumerate codes or read the usage counter. Redemption is
-- validated server-side by the checkout action through the service role.

alter table public.coupons enable row level security;

create policy "admins manage coupons"
  on public.coupons for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
