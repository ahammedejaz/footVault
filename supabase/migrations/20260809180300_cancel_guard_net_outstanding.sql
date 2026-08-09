-- The cancel guard compares **net outstanding**, not payment history.
--
-- A fully refunded order could never be cancelled. Both limbs of the old guard
-- fired on one:
--
--   if p_require_unpaid and (
--        v_payment <> 'unpaid'                     -- 'refunded' is not 'unpaid'
--        or exists (select 1 from public.payments pm
--                    where pm.order_id = p_order_id
--                      and pm.status in ('captured', 'refunded'))
--      ) then                                      -- 'refunded' named explicitly
--
-- Nothing anywhere subtracted refunds from captures, and because the second
-- limb names `'refunded'` on purpose there was no state the data could reach
-- that would let the order through. It was uncancellable by design.
--
-- FV-2026-00623 in production is the record of it: ₹135 captured, ₹135 refunded
-- and webhook-confirmed, net outstanding ₹0 — and `stock_restored_at` null, so
-- the pair on that order is still deducted from sellable inventory. The only
-- path that restocks is the cancel that is refused.
--
-- ## What replaces it
--
-- `captured − refunded`, per order, from the two tables that record money
-- moving. Above zero means the shop is still holding the customer's money and a
-- cancellation would be a refund — which is a decision, not a side effect. Zero
-- or below means nothing is owed back and the order can be closed.
--
-- This is robust to the second defect the audit found: FV-2026-00623's
-- `payments` row still reads `captured` even though the refund is `processed`.
-- Either bookkeeping gives the same answer — a payment left at `captured`
-- against a processed refund nets to zero, and one correctly moved to
-- `refunded` contributes nothing to the captured sum in the first place. The
-- guard does not depend on that row being repaired.
--
-- ## The three other callers must not loosen, and do not
--
-- `checkout.ts` rollback, `/api/cron/release-abandoned-orders` and
-- `release_abandoned_orders` all pass `p_require_unpaid => true` against orders
-- with nothing captured: zero minus zero is zero, so they still pass, and an
-- order with a live capture still blocks. That is the Phase 8 regression to
-- watch — the sweep cancelling paid orders — and it is preserved.
--
-- ## The one place it stays conservative
--
-- An order whose `payment_status` says paid or refunded but which has **no
-- payments row at all** is a row we cannot compute an answer for. Dropping the
-- `payment_status` limb outright would let it through on a sum over an empty
-- set. It is refused instead: no evidence is not the same as evidence of
-- nothing, and refusing costs an owner one support message while allowing costs
-- a customer their money.

drop function if exists public.cancel_order_with_restock(
  uuid, text, uuid, boolean, boolean, public.inventory_movement_reason);

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
  'Cancels an order and puts its stock back, once. With p_require_unpaid it '
  'refuses only while money is still outstanding — captured minus refunded — so '
  'a fully refunded order can be closed and a partially refunded one cannot.';

revoke execute on function public.cancel_order_with_restock(
  uuid, text, uuid, boolean, boolean, public.inventory_movement_reason, text)
  from public, anon, authenticated;

grant execute on function public.cancel_order_with_restock(
  uuid, text, uuid, boolean, boolean, public.inventory_movement_reason, text)
  to service_role;
