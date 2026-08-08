-- =============================================================================
-- 0021 · cancel_order_with_restock — the reverse of the one transaction
--
-- Stock is claimed at order creation, so a placed order is already holding its
-- units. Cancelling has to give them back or the shop leaks inventory to every
-- abandoned Razorpay modal. This is the only thing that gives them back, and it
-- is the SQL half of RESTOCKS_ON_ENTRY in src/lib/orders/types.ts: `cancelled`
-- restocks, `returned` deliberately does not, because a returned pair has to be
-- inspected before it goes back on the shelf.
--
-- **Exactly once.** orders.stock_restored_at is the marker. A webhook and an
-- admin cancelling the same order seconds apart is not hypothetical, and two
-- restocks invent inventory that nobody ordered and nobody has. The row is
-- locked FOR UPDATE first so the check and the write cannot interleave.
--
-- **It returns a word rather than raising.** Every caller has to distinguish
-- "cancelled it" from "someone already did" from "you cannot cancel a delivered
-- order", and a caller that has to parse an error message to tell those apart
-- will eventually get it wrong.
--
-- **It does not own the transition table.** ORDER_TRANSITIONS lives in
-- src/lib/orders/types.ts and is enforced by applyPaymentOutcome; duplicating
-- all of it here would be the same rule in two places. What is enforced here is
-- only what must hold whoever calls: terminal orders stay terminal, and a
-- delivered order becomes `returned` or nothing.
--
-- p_release_cart is for the payment-init rollback. The order is cancelled but
-- the customer never got as far as paying, so their bag has to come back: the
-- cart is un-converted and the order lets go of cart_id, which is what frees
-- orders_one_per_cart_idx for the retry. If they have already started a new
-- bag, carts_one_active_per_*_idx rejects the revival and the new bag wins.
-- =============================================================================

create or replace function public.cancel_order_with_restock(
  p_order_id       uuid,
  p_reason         text,
  p_changed_by     uuid default null,
  p_require_unpaid boolean default false,
  p_release_cart   boolean default false
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status   public.order_status;
  v_payment  public.payment_status;
  v_restored timestamptz;
  v_cart     uuid;
begin
  select o.status, o.payment_status, o.stock_restored_at, o.cart_id
    into v_status, v_payment, v_restored, v_cart
    from public.orders o
   where o.id = p_order_id
     for update;

  if not found then return 'not_found'; end if;
  if v_status = 'cancelled' then return 'already_cancelled'; end if;
  if v_status in ('delivered', 'returned') then return 'illegal_transition'; end if;

  -- The rollback path asks for this: an order whose money has moved must never
  -- be quietly cancelled and restocked, because that is a refund and a refund
  -- is a decision, not a side effect.
  if p_require_unpaid and (
       v_payment <> 'unpaid'
       or exists (select 1 from public.payments pm
                   where pm.order_id = p_order_id
                     and pm.status in ('captured', 'refunded'))
     ) then
    return 'already_paid';
  end if;

  if v_restored is null then
    update public.product_variants v
       set stock_quantity = v.stock_quantity + oi.quantity
      from public.order_items oi
     where oi.order_id = p_order_id
       and v.id = oi.variant_id;
  end if;

  update public.orders
     set status            = 'cancelled',
         stock_restored_at = coalesce(stock_restored_at, now()),
         cart_id           = case when p_release_cart then null else cart_id end
   where id = p_order_id;

  insert into public.order_status_history (order_id, status, note, changed_by)
  values (p_order_id, 'cancelled', p_reason, p_changed_by);

  if p_release_cart and v_cart is not null then
    begin
      update public.carts set status = 'active'
       where id = v_cart and status = 'converted';
    exception when unique_violation then
      null;
    end;
  end if;

  return 'cancelled';
end;
$$;

comment on function public.cancel_order_with_restock(uuid, text, uuid, boolean, boolean) is
  'Cancels an order and returns its units to the catalog exactly once, guarded by orders.stock_restored_at. Returns cancelled | already_cancelled | already_paid | illegal_transition | not_found. SECURITY INVOKER, service_role only.';

revoke execute on function public.cancel_order_with_restock(uuid, text, uuid, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.cancel_order_with_restock(uuid, text, uuid, boolean, boolean)
  to service_role;
