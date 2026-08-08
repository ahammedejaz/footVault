-- Phase 7. The advance is forward freight + RTO freight, quoted live from one
-- courier entry. Both legs and the courier that quoted them are frozen onto the
-- order so a variance against what actually shipped is answerable from our own
-- data rather than from the Shiprocket panel.

alter table public.shipping_quotes
  add column if not exists courier_id integer,
  add column if not exists freight_paise bigint,
  add column if not exists cod_fee_paise bigint,
  add column if not exists advance_paise bigint;

comment on column public.shipping_quotes.freight_paise is
  'Forward leg without the cash-collection fee. Half of the advance.';
comment on column public.shipping_quotes.cod_fee_paise is
  'Shiprocket''s cash-collection fee. The whole of the Pay-on-Delivery extra.';

alter table public.orders
  add column if not exists quoted_courier_name text,
  add column if not exists quoted_courier_id integer,
  add column if not exists quoted_forward_paise bigint,
  add column if not exists quoted_rto_paise bigint,
  add column if not exists quoted_cod_fee_paise bigint,
  add column if not exists quote_taken_at timestamptz,
  add column if not exists quote_source text;

comment on column public.orders.quoted_forward_paise is
  'Forward freight at quote time. With quoted_rto_paise this is the advance.';
comment on column public.orders.quote_source is
  'shiprocket | fallback | free. A fallback must never be read as a live rate.';
