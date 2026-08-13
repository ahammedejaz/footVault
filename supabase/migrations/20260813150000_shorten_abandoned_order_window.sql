-- The abandoned-order reclaim window: thirty minutes to ten.
--
-- ## Why
--
-- Placing an order reserves stock *before* payment. `checkout` is capped at ten
-- orders a minute per signed-in customer, or per IP for a guest — and guest
-- checkout is open, as it should be. So the cheapest attack on this shop is not
-- card testing and does not need a card at all: place orders, never pay, and
-- every unit in them is off the shelf for the length of this window. A rotating
-- IP pool takes a small catalogue to zero for real customers, for free.
--
-- Thirty minutes was chosen (2026-08-08) as generous headroom for 3-D Secure
-- and netbanking round trips, on the reasoning that a customer mid-payment must
-- never have their stock pulled out from under them. That reasoning is sound
-- and is *unaffected* by this change, because the narrowing in
-- 20260809030000 already removed every order with a payment attempt from this
-- function's scope. What remains here is orders with **no payments row at
-- all** — nobody has begun to pay, and nothing is in flight to protect.
--
-- Ten minutes is still four to five times the five-minute expiry a PSP puts on
-- a payment intent, so the safety margin for the case this window exists for is
-- untouched. What shrinks is the blast radius of the abuse: two thirds less
-- stock held per unit of attacker effort.
--
-- This is worth doing whether or not bot detection ever ships, which is the
-- whole argument for doing it first — it is one default value and it needs no
-- new dependency, no new failure mode, and nothing on the request path.
--
-- ## What this migration is, mechanically
--
-- `create or replace` at the **same arity**, so the ACL is preserved rather
-- than reset to the PUBLIC default that a new signature would acquire. The
-- grants are restated below anyway: this repo has been bitten by an implicit
-- ACL once already, and a migration that states its own grants is one that
-- cannot be read wrong later.
--
-- **The body is 20260809180400's text, copied rather than retyped**, with the
-- two `30`s changed. That file said the same thing about its own predecessor,
-- and for the same reason: this function moves stock, and its guard order and
-- verdict strings are load-bearing. Paraphrasing while changing a number would
-- be a silent behaviour change in a path that puts units back on a shelf.
--
-- The scheduler is not touched. `20260808100100` calls this with **no
-- argument** on purpose, so the default below is the only cutoff there is —
-- change it here and the sweep changes with it. The sweep already runs every
-- ten minutes, so a ten-minute window is reclaimed on the first tick after it
-- opens rather than sitting idle for two thirds of its life.
--
-- `src/app/api/cron/release-abandoned-orders/route.ts` carries the same number
-- for the orders this function deliberately does not touch — the ones with a
-- payment attempt, which it decides by asking Razorpay first. Its constant is
-- changed in the same commit; the two must not drift, because a customer whose
-- order sits in one set must not get a different deadline from the other.

create or replace function public.release_abandoned_orders(p_older_than_minutes integer default 10)
 returns integer
 language plpgsql
 set search_path to ''
as $function$
declare
  v_order  record;
  v_result text;
  v_freed  integer := 0;
  v_cutoff integer := greatest(coalesce(p_older_than_minutes, 10), 1);
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

comment on function public.release_abandoned_orders(integer) is
  'Cancels and restocks abandoned orders that have NO payments row. Default '
  'cutoff 10 minutes (was 30 until 2026-08-13; shortened to cut the window in '
  'which unpaid bot orders hold stock, safe because orders with a payment in '
  'flight are already out of scope). Orders with any payment attempt are '
  'decided by /api/cron/release-abandoned-orders, which asks Razorpay first. '
  'Bounded at 500 rows. SECURITY INVOKER, service_role only; scheduled by '
  'pg_cron as the owner.';

-- Restated, not assumed. Same arity means the ACL survives `create or replace`,
-- but a migration whose grants are implicit is one whose grants are invisible.
revoke execute on function public.release_abandoned_orders(integer)
  from public, anon, authenticated;
grant execute on function public.release_abandoned_orders(integer)
  to service_role;
