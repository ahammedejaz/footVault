-- Phase 11 · Batch D — the owner's side of Vault Coins.
--
-- Three things: the queries the abuse signals need somewhere to stand
-- (audit 11D.4 found nothing to query), the master switch made REAL in the
-- two functions that move coins (a toggle the SQL ignores is the
-- reported-built-unreachable sin this shop already paid for twice), and
-- nothing else — the pages and actions live in the app.

-- ── 1 · what the abuse queries stand on ────────────────────────────────────

-- The REAL phone is orders.contact_phone (profiles.phone is null on every
-- production row — 11D.4). Ten plain digits on all 21 production orders.
create index orders_contact_phone_idx on public.orders (contact_phone)
  where contact_phone is not null;

-- "The same address", defined before it can be one: lowercased,
-- non-alphanumerics stripped, line1 + postal code. Crude — "12 MG Road" and
-- "12, M.G. Road" collide, "12 Mahatma Gandhi Road" does not — and better
-- than nothing; the signals page says so on screen rather than pretending
-- precision. A stored generated column so the expression lives in exactly
-- one place and the index serves it.
alter table public.orders add column shipping_address_key text
  generated always as (
    lower(regexp_replace(coalesce(shipping_address ->> 'line1', ''), '[^a-zA-Z0-9]', '', 'g'))
    || ':' || coalesce(shipping_address ->> 'postalCode', '')
  ) stored;

create index orders_shipping_address_key_idx
  on public.orders (shipping_address_key);

comment on column public.orders.shipping_address_key is
  'Canonicalised line1+postalCode for the shared-address abuse signal. '
  'Deliberately crude (see /admin/loyalty); never used for anything but '
  'grouping in the signals view.';

-- ── 2 · the master switch, enforced where the coins move ───────────────────

-- `loyalty.enabled` (absent = false, the safe resting state: the programme
-- is off until the owner turns it on). Checked FIRST in both directions —
-- earning answers 'programme_off' and mints nothing; redemption raises
-- CNRJT 'programme_off' so a checkout that raced the switch fails loudly
-- and spendlessly rather than spending under a rule the owner had just
-- revoked.

create or replace function public.credit_order_coins(p_order_id uuid)
returns text
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_order    record;
  v_enabled  boolean;
  v_disabled boolean;
  v_rate     integer;
  v_months   integer;
  v_coins    integer;
  v_expires  timestamptz;
begin
  select o.user_id, o.subtotal, o.discount_total, o.delivered_at
    into v_order
    from public.orders o
   where o.id = p_order_id;
  if not found then
    return 'not_found';
  end if;

  if v_order.delivered_at is null then
    return 'not_delivered';
  end if;

  -- Guests earn nothing (decision D7), and signing up later does not
  -- backfill: adoption is by cookie token, never by email.
  if v_order.user_id is null then
    return 'no_user';
  end if;

  -- The master switch, before anything else the owner can see move.
  select coalesce((s.value ->> 'enabled')::boolean, false) into v_enabled
    from public.site_settings s where s.key = 'loyalty';
  if not coalesce(v_enabled, false) then
    return 'programme_off';
  end if;

  insert into public.coin_accounts (user_id)
  values (v_order.user_id)
  on conflict (user_id) do nothing;

  select a.coins_disabled into v_disabled
    from public.coin_accounts a where a.user_id = v_order.user_id;
  if v_disabled then
    return 'disabled';
  end if;

  select nullif((s.value ->> 'earn_rupees_per_coin'), '')::integer
    into v_rate
    from public.site_settings s where s.key = 'loyalty';
  if v_rate is null or v_rate <= 0 then
    -- The owner has not set the rate. The programme earns nothing and the
    -- admin panel says so; crediting at a guessed rate is the one thing
    -- this shop never does with a business number.
    return 'rate_unset';
  end if;

  v_coins := floor((v_order.subtotal - v_order.discount_total)::numeric
                   / (v_rate * 100));
  if v_coins <= 0 then
    return 'nothing_to_credit';
  end if;

  -- Expiry runs from DELIVERY, not from whenever this function managed to
  -- run — a replay a week late must mint the same coins with the same
  -- lifetime. Unset months = no expiry on this cohort, and /admin/loyalty
  -- names that state; a lifetime is a business number nobody invents here.
  select nullif((s.value ->> 'coin_expiry_months'), '')::integer
    into v_months
    from public.site_settings s where s.key = 'loyalty';
  v_expires := case
    when v_months is null or v_months <= 0 then null
    else v_order.delivered_at + make_interval(months => v_months)
  end;

  insert into public.coin_transactions
    (user_id, delta, reason, order_id, expires_at,
     note)
  values
    (v_order.user_id, v_coins, 'earned', p_order_id, v_expires,
     'Earned on delivery')
  on conflict (order_id, reason) where order_id is not null
  do nothing;

  if not found then
    return 'already_credited';
  end if;
  return 'credited';
end;
$$;

revoke all on function public.credit_order_coins(uuid)
  from public, anon, authenticated;
grant execute on function public.credit_order_coins(uuid) to service_role;

-- The redemption side, as a trigger rather than a third restatement of
-- create_order_with_stock: it fires inside the same transaction (the
-- function's own orders INSERT), raises the same CNRJT the checkout already
-- translates, and — stronger than a block in one function — it stands in
-- front of ANY writer that ever tries to record a coin settlement while the
-- programme is off.
create or replace function public.orders_coins_require_programme()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_enabled boolean;
begin
  if new.coin_paid > 0 then
    select coalesce((s.value ->> 'enabled')::boolean, false) into v_enabled
      from public.site_settings s where s.key = 'loyalty';
    if not coalesce(v_enabled, false) then
      raise exception 'programme_off' using errcode = 'CNRJT';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.orders_coins_require_programme()
  from public, anon, authenticated;

create trigger orders_coins_require_programme
  before insert on public.orders
  for each row execute function public.orders_coins_require_programme();
