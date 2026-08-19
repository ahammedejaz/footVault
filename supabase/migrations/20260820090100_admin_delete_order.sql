-- Deleting an order outright, and the four questions it has to answer first.
--
-- The owner asked to be able to remove orders from the database permanently.
-- The panel had no such control at all: `setOrderStatus` can cancel, and a
-- cancelled order stays on the list forever. For test orders, duplicates and
-- abandoned checkouts that is a list that only ever grows.
--
-- ## What this refuses, and why the line is drawn at money
--
-- An order row is the shop's record that a sale happened. Once a rupee has
-- moved it is also a tax record, a customer's proof of purchase, and the only
-- thing a chargeback can be answered with. Nothing in this panel should be able
-- to destroy that, and the owner agreed the line goes there when this was
-- built: unpaid, failed and cancelled orders can go; anything that was paid or
-- dispatched cannot.
--
-- The four gates, in the order they are cheapest to answer:
--
--  1. `orders.payment_status <> 'unpaid'` — the shop's own answer to "did they
--     pay". Refuses immediately.
--
--  2. Any `payments` row at 'pending', 'captured' or 'refunded'. This is the
--     lesson of 20260809030000 restated: **the question "did this customer pay"
--     cannot be answered from our own tables once a payment has been
--     initiated.** A row at 'created' is a customer who may be typing their card
--     number right now, so it refuses too — the only payment state that is
--     safely dead is 'failed'. Reconcile it first (the release-abandoned cron
--     asks Razorpay and settles this), then delete.
--
--  3. Any `refunds` row. `refunds.order_id` is `on delete restrict`, so the
--     database would refuse anyway — this exists so the owner gets a sentence
--     instead of a foreign-key error.
--
--  4. A status past dispatch. Once a parcel is with a courier there is a thing
--     in the world that will keep generating events against this id, and an
--     inbound webhook arriving for an order that no longer exists is a silent
--     hole in reconciliation rather than an error anyone sees.
--
-- ## Stock, which is the part that would have leaked
--
-- Placing an order decrements stock in the same transaction that writes the
-- row. A `pending`, `confirmed` or `packed` order is therefore holding pairs
-- off the shelf, and deleting it directly would strand that decrement forever —
-- the shop would quietly believe it had fewer shoes than it does, with no row
-- left to explain why.
--
-- So this does not delete such an order. It **cancels it first**, through
-- `cancel_order_with_restock`, which is the function that owns stock and writes
-- the inventory movement — and only then removes the row. A `cancelled` order
-- has already been through that path and is deleted as-is.
--
-- ## The coin ledger, which cannot cascade and must not vanish
--
-- `coin_transactions.order_id` has no `on delete` clause, so it defaults to NO
-- ACTION and the delete would simply fail. Cascading would be worse than
-- failing: those rows are the customer's balance, `delta` is the only place a
-- balance exists (there is no balance column anywhere), and dropping them would
-- silently change what the shop owes a real person.
--
-- They are therefore **unlinked, not deleted** — `order_id` set null with the
-- order number appended to the note, so the sum is untouched and a human
-- reading the ledger can still see what the row was for.

create or replace function public.admin_delete_order(p_order_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status   public.order_status;
  v_payment  public.payment_status;
  v_number   text;
  v_restored timestamptz;
  v_result   text;
begin
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = 'FVADM';
  end if;

  select o.status, o.payment_status, o.order_number, o.stock_restored_at
    into v_status, v_payment, v_number, v_restored
    from public.orders o
   where o.id = p_order_id
     for update;

  if not found then return 'not_found'; end if;

  -- 1 · the shop's own answer.
  if v_payment <> 'unpaid' then return 'paid'; end if;

  -- 2 · every payment attempt that is not conclusively dead.
  if exists (
    select 1 from public.payments pm
     where pm.order_id = p_order_id
       and pm.status <> 'failed'
  ) then
    return 'payment_attempted';
  end if;

  -- 3 · belt and braces against the on-delete-restrict foreign key.
  if exists (select 1 from public.refunds r where r.order_id = p_order_id) then
    return 'refunded';
  end if;

  -- 4 · a parcel exists in the world.
  if v_status in ('shipped', 'delivered', 'returning', 'returned') then
    return 'dispatched';
  end if;

  -- Stock first, and through the function that owns it. `p_require_unpaid` is
  -- true because everything above has already established that — passing it
  -- makes the guarantee the cancel path's own rather than a property of this
  -- function's argument order.
  if v_restored is null and v_status <> 'cancelled' then
    v_result := public.cancel_order_with_restock(
      p_order_id,
      'Cancelled automatically before the order was deleted by an admin',
      null,
      true,
      false,
      'cancellation'
    );
    if v_result not in ('cancelled', 'already_cancelled') then
      -- Refuse rather than delete: an order whose stock could not be returned
      -- must keep its row, because the row is the only remaining record of the
      -- pairs that are missing from the shelf.
      return 'stock_stuck';
    end if;
  end if;

  -- The ledger keeps its rows and loses its pointer. See the note above.
  update public.coin_transactions
     set order_id = null,
         note = trim(both ' ' from
                  coalesce(note, '') || ' (order ' || v_number || ', deleted)')
   where order_id = p_order_id;

  -- order_items, order_status_history, payments, shipments, shipment_errors and
  -- coupon_redemptions all cascade; courier_events is `on delete set null`.
  delete from public.orders where id = p_order_id;

  return 'deleted';
end;
$$;

comment on function public.admin_delete_order(uuid) is
  'Permanently removes an unpaid order, restocking it through '
  'cancel_order_with_restock first if it is still holding stock. Refuses '
  'anything paid, refunded, dispatched, or carrying a payment attempt that is '
  'not conclusively failed — those rows are the shop''s sales record. Returns '
  'the reason it refused rather than raising, so the panel can say it in words.';

-- Restated here because a function created in this migration starts with
-- EXECUTE granted to PUBLIC. See the same note on admin_purge_product.
revoke execute on function public.admin_delete_order(uuid) from public, anon;
grant execute on function public.admin_delete_order(uuid) to authenticated;
