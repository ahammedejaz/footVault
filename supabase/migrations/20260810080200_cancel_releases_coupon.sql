-- Cancelling an order gives the coupon back (§9F, owner's decision).
--
-- Redemption happens at order *creation*, before payment — so without this,
-- the thirty-minute sweep that cancels abandoned unpaid orders would burn the
-- customer's code on an order that never happened, and a cancellation the
-- *shop* makes would cost the customer their coupon. Implemented inside
-- `cancel_order_with_restock` because that is the one function every
-- cancellation path already calls: the sweep, the checkout rollback, and the
-- admin. A release bolted onto one caller would miss the others.
--
-- Idempotent by the same means as the restock: the release only touches rows
-- whose `released_at` is null, so cancelling twice gives nothing back twice.
-- `used_count` never goes below zero — `greatest` guards a counter that could
-- have been reset by hand.
--
-- The body is 20260809180300's verbatim plus the release block; restated in
-- full because a partial rewrite of the cancel path would be a silent
-- behaviour change in the function that restocks the shop.

drop function if exists public.cancel_order_with_restock(
  uuid, text, uuid, boolean, boolean, public.inventory_movement_reason, text);

create function public.cancel_order_with_restock(
  p_order_id uuid,
  p_reason text,
  p_changed_by uuid default null,
  p_require_unpaid boolean default false,
  p_release_cart boolean default false,
  p_movement_reason public.inventory_movement_reason default 'cancellation',
  p_customer_note text default null)
returns text
language plpgsql
set search_path to ''
as $function$
declare
  v_status      public.order_status;
  v_payment     public.payment_status;
  v_restored    timestamptz;
  v_cart        uuid;
  v_number      text;
  v_outstanding bigint;
  v_has_payment boolean;
  v_released_coupon uuid;
begin
  select o.status, o.payment_status, o.stock_restored_at, o.cart_id, o.order_number
    into v_status, v_payment, v_restored, v_cart, v_number
    from public.orders o
   where o.id = p_order_id
     for update;

  if not found then return 'not_found'; end if;
  if v_status = 'cancelled' then return 'already_cancelled'; end if;
  if v_status in ('delivered', 'returned') then return 'illegal_transition'; end if;

  if p_require_unpaid then
    -- Captured minus refunded. Zero means nothing is owed back.
    select
      coalesce((select sum(pm.amount) from public.payments pm
                 where pm.order_id = p_order_id and pm.status = 'captured'), 0)
      -
      coalesce((select sum(r.amount_paise) from public.refunds r
                 where r.order_id = p_order_id and r.status = 'processed'), 0)
      into v_outstanding;

    select exists (select 1 from public.payments pm where pm.order_id = p_order_id)
      into v_has_payment;

    if v_outstanding > 0 or (v_payment <> 'unpaid' and not v_has_payment) then
      return 'already_paid';
    end if;
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

  /*
    The coupon comes back with the stock, once. `released_at is null` is what
    makes a second cancellation a no-op here, exactly as `stock_restored_at`
    is for the shelves. The decrement pairs with the increment in
    `create_order_with_stock` and never drives the counter negative.
  */
  update public.coupon_redemptions
     set released_at = now()
   where order_id = p_order_id
     and released_at is null
  returning coupon_id into v_released_coupon;

  if v_released_coupon is not null then
    update public.coupons
       set used_count = greatest(used_count - 1, 0), updated_at = now()
     where id = v_released_coupon;
  end if;

  update public.orders
     set status            = 'cancelled',
         stock_restored_at = coalesce(stock_restored_at, now()),
         cart_id           = case when p_release_cart then null else cart_id end
   where id = p_order_id;

  /*
    Two audiences, two columns. `note` is `p_reason` exactly as it always was —
    'Released automatically: unpaid and abandoned' is the right thing for an
    audit trail and the wrong thing to show a customer. `p_customer_note` is
    what the caller wants the customer to read, and null is the safe default:
    the timeline then shows the status label alone, which is already good copy.
  */
  insert into public.order_status_history (order_id, status, note, customer_note, changed_by)
  values (p_order_id, 'cancelled', p_reason, p_customer_note, p_changed_by);

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

comment on function public.cancel_order_with_restock(
  uuid, text, uuid, boolean, boolean, public.inventory_movement_reason, text) is
  'Cancels an order, puts its stock back and releases its coupon redemption, '
  'each exactly once. With p_require_unpaid it refuses only while money is '
  'still outstanding — captured minus refunded — so a fully refunded order '
  'can be closed and a partially refunded one cannot.';

revoke execute on function public.cancel_order_with_restock(
  uuid, text, uuid, boolean, boolean, public.inventory_movement_reason, text)
  from public, anon, authenticated;

grant execute on function public.cancel_order_with_restock(
  uuid, text, uuid, boolean, boolean, public.inventory_movement_reason, text)
  to service_role;
