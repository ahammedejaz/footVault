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
       and not exists (
         select 1
           from public.payments pm
          where pm.order_id = o.id
            and pm.status in ('pending', 'captured', 'refunded')
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
      'sweep'
    );
    if v_result = 'cancelled' then
      v_freed := v_freed + 1;
    end if;
  end loop;

  return v_freed;
end;
$function$;
