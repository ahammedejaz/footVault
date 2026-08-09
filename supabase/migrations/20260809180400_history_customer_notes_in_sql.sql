-- The two SQL functions that close a customer's order learn to say so in the
-- customer's own words.
--
-- Both write an `order_status_history` row, and until 9C every one of those rows
-- was rendered on the customer's own order page. `release_abandoned_orders` told
-- them "Released automatically: unpaid and abandoned"; `restock_rto_order` told
-- them "Stock returned to the shelf from the RTO parcel" — the shop's inventory
-- vocabulary, describing the shop's inventory, on the customer's receipt.
--
-- `note` keeps both strings exactly as they were. What changes is that they are
-- now the *internal* column, and each row carries a second sentence written for
-- the person who will actually read it.
--
-- **Both bodies below are the previous migration's text, copied rather than
-- retyped**, with one statement changed in each. These are stock-moving
-- functions and their guard order, verdict strings and `rto_condition = 'ok'`
-- test are load-bearing; paraphrasing them while adding a comment column would
-- be a silent behaviour change in the two paths that put units back on a shelf.

create or replace function public.release_abandoned_orders(p_older_than_minutes integer default 30)
 returns integer
 language plpgsql
 set search_path to ''
as $function$
declare
  v_order  record;
  v_result text;
  v_freed  integer := 0;
  v_cutoff integer := greatest(coalesce(p_older_than_minutes, 30), 1);
begin
  for v_order in
    select o.id
      from public.orders o
     where o.status = 'pending'
       and o.payment_status = 'unpaid'
       and o.placed_at < now() - make_interval(mins => v_cutoff)
       -- Any payments row at all disqualifies the order from this sweep,
       -- whatever its status. The question "did this customer pay?" cannot be
       -- answered from our own tables once a payment has been initiated, and a
       -- function that cannot make an HTTP call must not pretend otherwise.
       and not exists (
         select 1
           from public.payments pm
          where pm.order_id = o.id
       )
     order by o.placed_at
     limit 500
  loop
    -- One order per statement, each taking its own row lock, so a capture
    -- landing mid-sweep contends with one order rather than with the batch.
    -- 'sweep' rather than 'cancellation' so the ledger distinguishes stock the
    -- machine reclaimed from stock a person released.
    v_result := public.cancel_order_with_restock(
      v_order.id,
      'Released automatically: unpaid and abandoned',
      null,
      true,
      false,
      'sweep',
      -- Only orders with no payment attempt at all reach this loop, so
      -- "nothing has been charged" is a fact about the set being swept rather
      -- than a reassurance somebody hopes is true.
      'We did not receive a payment for this order, so it was cancelled and the '
      'pairs went back on sale. Nothing has been charged.'
    );
    if v_result = 'cancelled' then
      v_freed := v_freed + 1;
    end if;
  end loop;

  return v_freed;
end;
$function$;

create or replace function public.restock_rto_order(
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

  insert into public.order_status_history (order_id, status, note, customer_note, changed_by)
  values (p_order_id, 'returned',
          'Stock returned to the shelf from the RTO parcel',
          -- What the shop does with the shoes afterwards is the shop's business.
          -- What the customer needs to know is that the parcel arrived.
          'Your parcel is back with us. Any refund due is on its way.',
          p_actor);

  return 'restocked';
end;
$function$;
