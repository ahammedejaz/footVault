-- The two refund promises the database keeps, whatever the application does.
--
-- Batch 3's gate is written as behaviour: *a refund cannot exceed the captured
-- amount; a double-clicked button cannot issue two refunds*. Both are promises
-- about concurrent writes, and a check that lives only in TypeScript is a
-- check that holds only when exactly one server is running exactly one click.
-- So both live here, on the table, where every writer — the admin action, the
-- webhook import, a future reconciler — hits them by construction.
--
-- ## One refund in flight per order
--
-- The admin flow inserts a `created` row *before* calling Razorpay — the same
-- pre-insert serialisation the shipments table uses, and for the same reason:
-- two simultaneous presses must be decided by a constraint before either
-- reaches the provider, because no constraint can undo a second API call that
-- already happened. The second insert dies here and the second click reads
-- "a refund is already in progress", which is true.
--
-- `created` only: `pending` rows are already at Razorpay (double-processing is
-- then Razorpay's `rfnd_` uniqueness problem, held by `razorpay_refund_id
-- unique`), and several settled refunds per order is the partial-refund case
-- working as intended.
create unique index refunds_one_in_flight_per_order
  on public.refunds (order_id)
  where status = 'created';

-- ## Never more than was captured
--
-- `captured` is the sum of the order's captured payment rows — the only rows
-- that mean money actually moved (see payment_txn_status). Failed refunds do
-- not count against the ceiling; everything else does, including in-flight
-- rows, because an in-flight refund that later fails releases its amount by
-- moving to `failed`, and counting it until then is the conservative
-- direction.
--
-- The `for update` lock on the order row is what makes the sum trustworthy:
-- two concurrent inserts for the same order serialise on it, so the second
-- reads a total that includes the first. Without it the guard would hold for
-- every sequential write and fail for exactly the concurrent pair it exists
-- to stop.
create function public.refunds_guard()
returns trigger
language plpgsql
set search_path to ''
as $$
declare
  v_captured bigint;
  v_refunded bigint;
begin
  perform 1 from public.orders where id = new.order_id for update;
  if not found then
    raise exception 'refund_guard: order % does not exist', new.order_id;
  end if;

  if new.status <> 'failed' then
    select coalesce(sum(amount), 0) into v_captured
      from public.payments
     where order_id = new.order_id and status = 'captured';

    select coalesce(sum(amount_paise), 0) into v_refunded
      from public.refunds
     where order_id = new.order_id
       and status <> 'failed'
       and id <> new.id;

    if v_refunded + new.amount_paise > v_captured then
      raise exception
        'refund_exceeds_captured: % paise already refunded or in flight plus % requested exceeds % captured for order %',
        v_refunded, new.amount_paise, v_captured, new.order_id;
    end if;
  end if;

  return new;
end;
$$;

create trigger refunds_guard
  before insert or update on public.refunds
  for each row execute function public.refunds_guard();

-- Trigger machinery, not an API. Same treatment as every trigger function
-- since 20260807233100.
revoke execute on function public.refunds_guard() from public, anon, authenticated;
