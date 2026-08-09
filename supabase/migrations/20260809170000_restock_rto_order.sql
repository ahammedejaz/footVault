-- Batch 3.3. The stock coming back from a returned parcel — through a function,
-- because `adjust_variant_stock` refuses every reason except its own two, and
-- teaching it a third would blur what it is for: an admin fixing a count by
-- hand. This is not that. This is a parcel the shop has physically opened and
-- inspected, and the whole point of the `returning` interval is that stock
-- returns from *this* moment and from no tracking event.
--
-- The shape is `cancel_order_with_restock`'s, deliberately: lock the order row
-- first so two presses serialise, decide everything against the locked row,
-- attribute the movement through the same four transaction-local GUCs the
-- `record_inventory_movement()` trigger reads, and answer with a text verdict
-- the action can turn into a sentence. The stock update itself is one statement
-- joining `order_items`, so the trigger writes one `inventory_movements` row per
-- item with reason `rto_return` — the ledger says which units came back, from
-- which order, counted by whom.
--
-- Guards, in the order they answer:
--   not_found          no such order
--   already_restocked  `rto_restocked_at` is set — the second press, a no-op
--   wrong_status       not `returned`; a parcel still in a van has no stock
--   not_received       nobody has marked the box physically in hand
--   damaged            inspected and written off — damaged stock never restocks
--
-- `already_restocked` is checked before `wrong_status` on purpose: a restocked
-- order is `returned` today, but if a later phase ever adds a state after
-- `returned`, the honest answer to a second press is still "already done", not
-- "wrong status".

create function public.restock_rto_order(
  p_order_id uuid,
  p_actor uuid)
returns text
language plpgsql
set search_path to ''
as $function$
declare
  v_status    public.order_status;
  v_received  timestamptz;
  v_condition text;
  v_restocked timestamptz;
  v_number    text;
begin
  select o.status, o.rto_received_at, o.rto_condition, o.rto_restocked_at, o.order_number
    into v_status, v_received, v_condition, v_restocked, v_number
    from public.orders o
   where o.id = p_order_id
     for update;

  if not found then return 'not_found'; end if;
  if v_restocked is not null then return 'already_restocked'; end if;
  if v_status <> 'returned' then return 'wrong_status'; end if;
  if v_received is null then return 'not_received'; end if;
  -- `is distinct from` rather than `<>`: a null condition means the parcel was
  -- never inspected, and uninspected must refuse the same way damaged does.
  if v_condition is distinct from 'ok' then return 'damaged'; end if;

  -- Transaction-local (is_local = true), same as the cancel path — over a
  -- pooled connection anything longer-lived would attribute the *next*
  -- request's stock write to this order.
  perform pg_catalog.set_config('app.inventory_reason', 'rto_return', true);
  perform pg_catalog.set_config('app.inventory_reference', p_order_id::text, true);
  perform pg_catalog.set_config('app.inventory_actor', coalesce(p_actor::text, ''), true);
  perform pg_catalog.set_config('app.inventory_note',
    'RTO parcel from ' || coalesce(v_number, 'order') || ' received in good condition', true);

  update public.product_variants v
     set stock_quantity = v.stock_quantity + oi.quantity
    from public.order_items oi
   where oi.order_id = p_order_id
     and v.id = oi.variant_id;

  update public.orders
     set rto_restocked_at = now()
   where id = p_order_id;

  insert into public.order_status_history (order_id, status, note, changed_by)
  values (p_order_id, 'returned',
          'Stock returned to the shelf from the RTO parcel', p_actor);

  return 'restocked';
end;
$function$;

comment on function public.restock_rto_order(uuid, uuid) is
  'Puts an RTO order''s units back on the shelf, exactly once. Refuses unless the '
  'order is returned, physically received, inspected ok, and not yet restocked — '
  'the verdicts name which guard said no. One inventory_movements row per order '
  'item, reason rto_return, via the record_inventory_movement() trigger. A damaged '
  'parcel never reaches the stock update: its units left the ledger at sale and a '
  'write-off means they never re-enter, so the ledger stays reconciled without a row.';

revoke execute on function public.restock_rto_order(uuid, uuid) from public, anon, authenticated;
grant execute on function public.restock_rto_order(uuid, uuid) to service_role;
