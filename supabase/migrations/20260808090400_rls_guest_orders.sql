-- =============================================================================
-- 0019 · RLS — a guest reads their own order
--
-- A guest checkout produces an order with no user_id, so `user_id = auth.uid()`
-- cannot describe it and the Phase 4 policies leave it unreadable by the person
-- who placed it. The fix is the mechanism the cart already uses: the opaque
-- token in the httpOnly cookie, forwarded as the x-guest-token header and read
-- by public.current_guest_token().
--
-- **It keys on the token, never on the order number.** Order numbers come from
-- a sequence, so FV-2026-00042 tells you FV-2026-00041 and FV-2026-00043 both
-- exist. A policy of "you may read the order whose number you can name" is a
-- policy of "anyone may read every order". The token is 32 bytes of randomness
-- in a cookie JavaScript cannot see; guessing it is guessing a session.
--
-- **owns_order() is extended rather than joined by sibling policies.** The
-- alternative was three new policies — one each for orders, order_items and
-- order_status_history — which is the same sentence written three times, and
-- the day someone tightens one of them is the day the other two disagree.
-- owns_order() already exists precisely so the child tables can ask the parent
-- one question, and "is this order mine" now has one definition covering both
-- ways an order can be yours. It is the same shape as can_access_cart(), which
-- has answered the same question about carts since Phase 1.
--
-- It stays SECURITY DEFINER for the reason it always was: a child-table policy
-- must be able to consult orders without the caller holding a read on it. It
-- leaks nothing — it answers only "is this row mine", and a caller who is not
-- the owner gets false, which is what the row itself would have told them.
-- =============================================================================

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
      and (
        (o.user_id is not null and o.user_id = (select auth.uid()))
        or (o.guest_token is not null and o.guest_token = (select public.current_guest_token()))
      )
  );
$$;

comment on function public.owns_order(uuid) is
  'True when the given order belongs to the caller — by auth.uid() for a signed-in customer, or by matching x-guest-token for a guest. Called from the orders, order_items and order_status_history policies.';

-- The parent. The existing "customers read their own orders" policy stays as
-- it is; policies OR together, so this only ever adds reach for a guest whose
-- token matches a row.
create policy "guests read the order their token names"
  on public.orders for select to anon, authenticated
  using (guest_token is not null and guest_token = (select public.current_guest_token()));

-- The children. Dropped and recreated rather than ALTER POLICY ... TO, so the
-- policy name still describes what it does now that "customers" includes
-- somebody without an account.
drop policy "customers read their own order items"   on public.order_items;
drop policy "customers read their own order history" on public.order_status_history;

create policy "the order owner reads its items"
  on public.order_items for select to anon, authenticated
  using ((select public.owns_order(order_id)));

create policy "the order owner reads its history"
  on public.order_status_history for select to anon, authenticated
  using ((select public.owns_order(order_id)));
