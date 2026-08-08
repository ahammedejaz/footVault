alter table public.orders
  add column if not exists rto_at timestamptz,
  add column if not exists rto_received_at timestamptz,
  add column if not exists rto_received_by uuid references public.profiles(id),
  add column if not exists rto_restocked_at timestamptz,
  add column if not exists rto_condition text,
  add column if not exists rto_actual_charge_paise bigint;

comment on column public.orders.rto_received_at is
  'Set by hand when the parcel is physically back. Stock returns from here, never from a tracking event.';
comment on column public.orders.rto_actual_charge_paise is
  'What Shiprocket actually billed for the return, beside quoted_rto_paise.';

alter table public.shipments
  add column if not exists rto_at timestamptz,
  add column if not exists rto_charge_paise bigint;

-- Repeat refusals concentrate the loss. The owner can withdraw Pay on Delivery
-- from one customer without withdrawing it from the shop.
alter table public.profiles
  add column if not exists cod_blocked_at timestamptz,
  add column if not exists cod_blocked_reason text;

comment on column public.profiles.cod_blocked_at is
  'Non-null means Pay on Delivery is not offered to this customer. Set by an admin.';
