-- Signature changes by one parameter, so this is a drop-and-create rather than a
-- replace. Adding an overload instead would leave two functions of the same name
-- and let a five-argument call resolve to the old one that writes no ledger row.
drop function if exists public.cancel_order_with_restock(uuid, text, uuid, boolean, boolean);

create function public.cancel_order_with_restock(
  p_order_id uuid,
  p_reason text,
  p_changed_by uuid default null,
  p_require_unpaid boolean default false,
  p_release_cart boolean default false,
  p_movement_reason public.inventory_movement_reason default 'cancellation')
returns text
language plpgsql
set search_path to ''
as $function$
declare
  v_status   public.order_status;
  v_payment  public.payment_status;
  v_restored timestamptz;
  v_cart     uuid;
  v_number   text;
begin
  select o.status, o.payment_status, o.stock_restored_at, o.cart_id, o.order_number
    into v_status, v_payment, v_restored, v_cart, v_number
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
    perform pg_catalog.set_config('app.inventory_reason', p_movement_reason::text, true);
    perform pg_catalog.set_config('app.inventory_reference', p_order_id::text, true);
    perform pg_catalog.set_config('app.inventory_actor', coalesce(p_changed_by::text, ''), true);
    perform pg_catalog.set_config('app.inventory_note',
      'Restocked from ' || coalesce(v_number, 'order') || ': ' || coalesce(p_reason, 'cancelled'), true);

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
$function$;

revoke execute on function public.cancel_order_with_restock(uuid, text, uuid, boolean, boolean, public.inventory_movement_reason) from public, anon, authenticated;
grant execute on function public.cancel_order_with_restock(uuid, text, uuid, boolean, boolean, public.inventory_movement_reason) to service_role;
