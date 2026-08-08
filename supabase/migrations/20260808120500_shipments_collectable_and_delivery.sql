-- Two columns the brief specified that the table never got.
--
-- **cod_collectable_amount** — what the courier was actually asked to collect.
-- Recorded at the moment the shipment is created so a discrepancy can be
-- answered from our own data instead of from the Shiprocket panel, and so the
-- admin can see it next to the order it belongs to.
--
-- **delivered_at** — without it the 24-hour replacement window is unenforceable
-- and unprovable, and the returns policy is decorative. It is taken from
-- Shiprocket tracking when the status first reaches delivered, and mirrored
-- onto the order so the account page can count down from it without a join.
alter table public.shipments
  add column cod_collectable_amount bigint not null default 0
    check (cod_collectable_amount >= 0),
  add column delivered_at timestamptz;

alter table public.orders
  add column delivered_at timestamptz;

comment on column public.shipments.cod_collectable_amount is
  'What Shiprocket was told to collect at the door, in paise. Equals the '
  'order''s balance_due_on_delivery, never its grand_total — a Pay-on-Delivery '
  'customer has already paid the advance online, and collecting the total again '
  'takes that money twice.';

comment on column public.orders.delivered_at is
  'When the courier recorded delivery. The 24-hour window for reporting '
  'shipment damage runs from this instant, so it is evidence rather than '
  'decoration: without it the replacement policy cannot be enforced or proved.';
