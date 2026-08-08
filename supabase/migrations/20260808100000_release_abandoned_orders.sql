-- =============================================================================
-- 0023 · release_abandoned_orders — give back what nobody is going to pay for
--
-- Security review E-1, rated high. Stock is claimed when the order row is
-- written, so a `pending` Razorpay order holds its units from the instant it
-- exists. `payment.failed` deliberately does not cancel — Razorpay lets a
-- customer retry a declined card inside the same modal, and cancelling on the
-- first failure would restock units out from under the second attempt. That
-- reasoning still holds. What was missing is the other end: nothing ever
-- released an order that simply stopped.
--
-- So an anonymous visitor could start a checkout, close the tab, repeat with a
-- fresh cookie, and show the whole shop as sold out. No account, no payment
-- method, no cost, nothing to ban. This function is the reclaim.
--
-- **Thirty minutes**, and it lives in exactly one place: the default below. The
-- scheduler calls this with no argument on purpose, so the window cannot be
-- set in two places and disagree.
--
-- Why thirty. The longest legitimate gap between "order written" and "money
-- moves" is a UPI collect request the customer approves on a different device;
-- PSPs expire those in five minutes, and 3-D Secure and netbanking round trips
-- are shorter still. Thirty is roughly six times the slowest honest path, which
-- is enough slack for a customer who wanders off mid-payment and comes back,
-- and short enough that the denial-of-inventory attack costs a sustained loop
-- rather than one pass. It is a business number: the owner may raise it if real
-- traffic shows slow settlements, and this default is the only line to change.
--
-- **An order with money in flight is never touched.** A `payments` row in
-- `pending` means the provider has authorised but not settled — real money,
-- committed, just not moved — and cancelling that would restock goods somebody
-- has already paid for. `cancel_order_with_restock(p_require_unpaid => true)`
-- refuses those anyway; the `not exists` below means we do not even ask.
--
-- Bounded at 500 rows a run so a scheduled tick can never turn into a long
-- transaction holding row locks across the catalog.
-- =============================================================================

create or replace function public.release_abandoned_orders(
  p_older_than_minutes integer default 30
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
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
    v_result := public.cancel_order_with_restock(
      v_order.id,
      'Released automatically: unpaid and abandoned',
      null,
      true,
      false
    );
    if v_result = 'cancelled' then
      v_freed := v_freed + 1;
    end if;
  end loop;

  return v_freed;
end;
$$;

comment on function public.release_abandoned_orders(integer) is
  'Cancels and restocks orders left pending and unpaid past the cutoff (default 30 minutes), skipping any with an authorised or settled payment. Returns how many were released. SECURITY INVOKER, service_role only; scheduled by pg_cron as the owner.';

revoke execute on function public.release_abandoned_orders(integer)
  from public, anon, authenticated;
grant execute on function public.release_abandoned_orders(integer)
  to service_role;
