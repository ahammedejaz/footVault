create table public.shipping_quotes (
  id              uuid primary key default gen_random_uuid(),
  cart_id         uuid not null references public.carts(id) on delete cascade,
  postal_code     text not null,
  payment_method  text not null,
  subtotal_paise  bigint not null,
  fee_paise       bigint not null check (fee_paise >= 0),
  deliverable     boolean not null,
  cod_available   boolean not null,
  estimated_days  integer,
  courier_name    text,
  -- What it actually costs us, for the admin. Never shown to a customer.
  cost_forward_paise bigint,
  cost_rto_paise     bigint,
  source          text not null,
  quoted_at       timestamptz not null default now(),
  -- One live quote per (bag, destination, method). A second lookup replaces it
  -- rather than accumulating, so `placeOrder` can never pick the wrong one.
  unique (cart_id, postal_code, payment_method)
);

create index shipping_quotes_quoted_at_idx on public.shipping_quotes (quoted_at);

alter table public.shipping_quotes enable row level security;
revoke all on public.shipping_quotes from anon, authenticated;

comment on table public.shipping_quotes is
  'The delivery fee a customer was SHOWN, held server-side so that the fee they '
  'are CHARGED is the same row rather than a second lookup that may have moved '
  'between the address step and the pay button. Charging a figure the customer '
  'never saw is the failure this table exists to prevent — so create_order_with_stock '
  'is passed the fee from here, and the browser still sends no number at all. '
  'Also records what the courier charges us, forward and return, which is how the '
  'admin can see the margin on every order.';

comment on column public.shipping_quotes.subtotal_paise is
  'The bag total the quote was made against. A bag that changes invalidates the '
  'quote — the free-delivery threshold and the COD percentage both move with it.';

-- Quotes are worthless once stale and the table would otherwise grow forever.
select cron.schedule(
  'prune-shipping-quotes',
  '23 * * * *',
  $$delete from public.shipping_quotes where quoted_at < now() - interval '6 hours'$$
);
