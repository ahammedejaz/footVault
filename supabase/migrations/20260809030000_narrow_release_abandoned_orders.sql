-- Phase 8 · P0-a2, first half.
--
-- `release_abandoned_orders` cancels unpaid orders and puts their stock back.
-- It excluded orders whose payment row had reached 'pending', 'captured' or
-- 'refunded' — and that exclusion list is missing the only status a
-- Razorpay-backed order actually sits at while it waits.
--
-- `src/lib/actions/checkout.ts` writes the payments row at 'created' when it
-- initiates the payment. It becomes 'captured' when the webhook arrives. So
-- between "customer is typing their card number" and "webhook lands" the row
-- reads 'created', which this function did not exclude, and a customer who was
-- charged 45 seconds after placing the order could be cancelled and restocked
-- before the confirmation reached us.
--
-- For the whole period in which no live-mode webhook existed, that gap was not
-- 45 seconds. It was permanent: nothing would ever move the row off 'created',
-- so every paid Razorpay order was guaranteed to be swept.
--
-- The fix is not a longer exclusion list. A list of "statuses that mean paid"
-- has to be complete to be safe, and it was not complete. Instead the function
-- is narrowed to the set it can decide correctly **without asking anyone**:
-- orders with no payments row at all. That is pure Pay-on-Delivery abandonment,
-- where there is genuinely nothing to reconcile.
--
-- Everything else — every order with any payment attempt against it — is now
-- handled by `/api/cron/release-abandoned-orders`, which asks Razorpay before
-- deciding and never cancels on an unknown.
--
-- ORDERING, AND IT MATTERS: this migration removes behaviour that the route
-- replaces. Applying it before that route is deployed leaves orders with a
-- payment attempt swept by nothing at all, holding their stock indefinitely.
-- Apply this only once the deployment carrying the route is live.

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
      'sweep'
    );
    if v_result = 'cancelled' then
      v_freed := v_freed + 1;
    end if;
  end loop;

  return v_freed;
end;
$function$;

comment on function public.release_abandoned_orders(integer) is
  'Cancels and restocks abandoned orders that have NO payments row. Orders with '
  'any payment attempt are deliberately out of scope — they are decided by '
  '/api/cron/release-abandoned-orders, which asks Razorpay first. Widening this '
  'function to cover them again would reintroduce the bug where a paid order '
  'sitting at payments.status = ''created'' was cancelled and restocked.';
