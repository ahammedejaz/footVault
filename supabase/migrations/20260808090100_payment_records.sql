-- =============================================================================
-- 0016 · Payments — what a provider said, kept apart from what the order says
--
-- orders.payment_status is the customer-facing answer: unpaid, paid, refunded.
-- Three words, because three words is all a customer needs and all the order
-- state machine can act on. This table is the other half — one row per attempt
-- at moving money, with the provider's own vocabulary preserved verbatim, so a
-- support question six months from now ("they say they were charged twice") can
-- be answered from our database instead of from a dashboard login.
--
-- A separate table rather than more columns on orders, because the cardinality
-- is genuinely one-to-many: a customer whose first card is declined and whose
-- second succeeds has two payment attempts against one order, and squashing
-- them into orders would lose the declined one — which is the one they will
-- ring up about.
--
-- No customer ever reads this table. RLS (0018) enables it with an admin-read
-- policy and nothing else. A customer learns payment state from their order.
-- =============================================================================

-- Deliberately not the same enum as public.payment_status. That one is the
-- order's summary and belongs to the customer; this one is the provider's
-- lifecycle and belongs to us. Fusing them would mean a Razorpay 'authorized'
-- had to be spelled as either 'unpaid' (a lie by omission) or 'paid' (a lie).
create type public.payment_provider as enum ('cod', 'razorpay');

create type public.payment_txn_status as enum (
  'created',   -- a provider order exists; nobody has paid anything yet
  'pending',   -- authorised but not settled. Money is committed, not moved.
  'captured',  -- money moved. The only status that means paid.
  'failed',
  'refunded'
);

create table public.payments (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references public.orders (id) on delete cascade,
  provider            public.payment_provider not null,
  -- The provider's order handle (`order_...`). Present from the moment we
  -- create it, before any payment exists, which is what lets a webhook that
  -- arrives before the browser callback find the order it belongs to.
  provider_order_id   text,
  -- The provider's payment handle (`pay_...`). Null until an attempt is made.
  provider_payment_id text,
  amount              bigint not null check (amount >= 0),
  currency            text not null default 'INR',
  status              public.payment_txn_status not null default 'created',
  -- The provider's own word, stored as it arrived. Never parsed for control
  -- flow — `status` above is what the code branches on.
  raw_status          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create trigger payments_set_updated_at
  before update on public.payments
  for each row execute function public.set_updated_at();

comment on table public.payments is
  'One row per payment attempt. Written only by the server; no customer-facing policy exists. orders.payment_status is what a customer sees.';

-- Both unique indexes are the idempotency floor underneath the event log: even
-- if two webhook deliveries somehow raced past the event table, they could not
-- produce two rows for one provider payment. Partial, because a Razorpay order
-- that nobody ever paid has a null provider_payment_id and several of those are
-- not a conflict.
create unique index payments_provider_payment_idx
  on public.payments (provider, provider_payment_id)
  where provider_payment_id is not null;

create unique index payments_provider_order_idx
  on public.payments (provider, provider_order_id)
  where provider_order_id is not null;

create index payments_order_id_idx on public.payments (order_id, created_at desc);
