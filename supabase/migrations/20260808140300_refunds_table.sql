create type public.refund_reason as enum (
  'cancelled_before_dispatch', 'rto', 'shop_error', 'other'
);

create type public.refund_status as enum (
  'created', 'pending', 'processed', 'failed'
);

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  payment_id uuid references public.payments(id) on delete set null,
  provider public.payment_provider not null default 'razorpay',
  -- The idempotency floor. A double-clicked refund cannot become two.
  razorpay_refund_id text unique,
  amount_paise bigint not null check (amount_paise > 0),
  reason public.refund_reason not null,
  -- Every deduction, itemised, so "why is this ₹281 short" is answerable.
  deduction_breakdown jsonb not null default '[]'::jsonb,
  note text,
  initiated_by uuid references public.profiles(id),
  status public.refund_status not null default 'created',
  failure_reason text,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index refunds_order_idx on public.refunds (order_id);
create index refunds_unsettled_idx on public.refunds (created_at)
  where status in ('created', 'pending');

create trigger refunds_set_updated_at
  before update on public.refunds
  for each row execute function public.set_updated_at();

comment on table public.refunds is
  'One row per refund attempt. Complete when the webhook says so, never when the API returns 200.';
