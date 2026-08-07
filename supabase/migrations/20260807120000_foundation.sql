-- =============================================================================
-- 0001 · Foundation
--
-- Extensions, the enum vocabulary the rest of the schema is built from, and the
-- two helpers that carry no table dependencies:
--
--   public.set_updated_at()    trigger fn, attached to every table
--   public.next_order_number() human-readable, gap-tolerant order numbers
--
-- public.is_admin() and public.handle_new_user() both read public.profiles, and
-- Postgres validates function bodies at CREATE time, so they live in 0002.
--
-- Money is stored as integer paise throughout (₹8,995 -> 899500). Floats are
-- never used for currency; src/lib/format.ts converts at the UI boundary.
-- =============================================================================

create extension if not exists pg_trgm with schema extensions;

-- --- enums -------------------------------------------------------------------
-- Enums rather than text+check: they generate real union types in
-- src/lib/database.types.ts, so an invalid status is a compile error rather
-- than a runtime constraint violation.

create type public.gender_group   as enum ('men', 'women', 'unisex', 'kids');
create type public.footwear_type  as enum ('sneaker', 'formal', 'sandal', 'slide', 'boot', 'sports', 'flipflop');
create type public.user_role      as enum ('customer', 'staff', 'admin');
create type public.cart_status    as enum ('active', 'converted', 'abandoned');
create type public.order_status   as enum ('pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'returned');
create type public.payment_status as enum ('unpaid', 'paid', 'refunded');
create type public.coupon_type    as enum ('percent', 'fixed');
create type public.section_type   as enum ('hero', 'category_grid', 'product_rail', 'banner', 'promo_strip', 'testimonials', 'rich_text');

-- --- updated_at --------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'BEFORE UPDATE trigger. Stamps updated_at so callers cannot forget or forge it.';

-- --- order numbers -----------------------------------------------------------
-- A sequence, not count(*)+1: two concurrent checkouts must never be handed the
-- same number, and a rolled-back checkout burning a number is preferable to a
-- collision. Format: FV-2026-00147.

create sequence public.order_number_seq as bigint start with 1;

create or replace function public.next_order_number()
returns text
language sql
volatile
set search_path = ''
as $$
  select 'FV-' || to_char(now(), 'YYYY') || '-'
       || lpad(nextval('public.order_number_seq')::text, 5, '0');
$$;
