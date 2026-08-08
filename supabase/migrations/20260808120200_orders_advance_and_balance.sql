-- Pay on Delivery: the order records what was paid online and what the courier
-- must still collect.
--
-- `shipping_fee` deliberately keeps holding the **total** delivery charge, so
-- `grand_total` arithmetic is unchanged and no existing row shifts by a paisa.
-- `cod_handling_fee` is a breakdown of that figure — how much of it is the
-- Pay-on-Delivery return-leg extra — recorded so the customer can be shown the
-- named line the owner asked for rather than an unexplained difference between
-- a prepaid total and a COD one.
alter table public.orders
  add column advance_amount bigint not null default 0
    check (advance_amount >= 0),
  add column balance_due_on_delivery bigint not null default 0
    check (balance_due_on_delivery >= 0),
  add column cod_handling_fee bigint not null default 0
    check (cod_handling_fee >= 0),
  -- Cash is marked collected by hand in the admin, never inferred from a
  -- Shiprocket "Delivered" status. Delivery usually means payment and
  -- occasionally does not, and the difference is the shop's money.
  add column cash_collected_at timestamptz,
  add column cash_collected_by uuid references auth.users(id) on delete set null;

-- Rows that predate the split, described honestly rather than uniformly:
-- a prepaid order settled its whole total online; a legacy cash-on-delivery
-- order paid nothing online and owed all of it at the door. Both satisfy the
-- invariant below, which is the point.
update public.orders
set advance_amount = case when payment_method = 'cod' then 0 else grand_total end,
    balance_due_on_delivery = case when payment_method = 'cod' then grand_total else 0 end;

-- The invariant the whole feature rests on, enforced by the database rather
-- than by hope. A courier collecting the wrong amount is discovered by customer
-- complaint, which is far too late and far too expensive.
alter table public.orders
  add constraint orders_advance_balance_sums
  check (advance_amount + balance_due_on_delivery = grand_total);

comment on column public.orders.advance_amount is
  'Charged through Razorpay at checkout, before the order is confirmed. For a '
  'prepaid order this is the whole grand_total; for Pay on Delivery it is the '
  'advance that secures the order. Never zero on a new order — an order with no '
  'money against it is the unsecured COD this model replaced.';

comment on column public.orders.balance_due_on_delivery is
  'What the courier collects in cash. This — never grand_total — is the COD '
  'collectable handed to Shiprocket. Passing the total would charge the customer '
  'the delivery fee a second time, having already paid it online.';
