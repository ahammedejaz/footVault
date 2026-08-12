-- Phase 11 · Batch C — Vault Coins, the redeeming half. Coins are TENDER.
--
-- The owner's ruling (2026-08-11) dissolves audit blocker 11C.1:
-- `discount_total` keeps meaning reductions in PRICE, coins never enter it,
-- `orders_discount_parts_sum` and `orders_total_adds_up` survive untouched.
-- What changes is the SETTLEMENT identity — who pays which part:
--
--   before:  advance + balance                = grand_total
--   after:   advance + balance + coin_paid    = grand_total
--
-- Razorpay is charged `advance_amount` and Shiprocket collects
-- `balance_due_on_delivery`; neither module learns coins exist — both were
-- already reading the right field, which is the tender model's dividend.
--
-- TWO caps, whichever binds lower applies (owner, 2026-08-11):
--   coin_max_percent_of_order — % of grand_total payable in coins
--   coin_max_coins_per_order  — an absolute per-order coin count
-- They bind in different places: 100 coins is 3% of a ₹3,000 order and 33%
-- of a ₹300 one. The intent is that every order is part-paid in money.
-- Both are settings, both unset, both failing loudly.

-- ── 1 · the release reason ─────────────────────────────────────────────────

-- Coins REDEEMED on an order that cancels come back as 'released' — a
-- distinct reason from 'reversed' (which undoes an EARN when a delivered
-- sale comes undone), because the customer-facing history must tell "your
-- spend came back" from "your earnings were taken back".
alter type public.coin_reason add value if not exists 'released';

-- ── 2 · what the order records ─────────────────────────────────────────────

-- Both stored, because coin_paid / coin_value_paise reconstructed later is
-- a division that lies the moment the owner changes what a coin is worth.
alter table public.orders
  add column coin_paid bigint not null default 0
    check (coin_paid >= 0),
  add column coin_spent integer not null default 0
    check (coin_spent >= 0);

-- Whole rupees, structurally: Shiprocket takes the courier collectable in
-- whole rupees and audit:totals asserts the balance is a multiple of 100
-- paise. coin_value_paise is constrained to a multiple of 100 at the till
-- (below); this is the belt to that braces.
alter table public.orders
  add constraint orders_coin_paid_whole_rupees check (coin_paid % 100 = 0);

alter table public.orders drop constraint orders_advance_balance_sums;
alter table public.orders add constraint orders_settlement_sums
  check (advance_amount + balance_due_on_delivery + coin_paid = grand_total);

comment on column public.orders.coin_paid is
  'Paise settled by Vault Coins. Part of the settlement identity '
  '(advance + balance + coin_paid = grand_total), NEVER of discount_total — '
  'a coin is a tender, not a discount. Stored beside coin_spent because '
  'reconstructing either from the other breaks when the owner changes the '
  'coin value.';

-- ── 3 · create_order_with_stock learns to take coins ───────────────────────
--
-- Restated IN FULL, never patched — the standing rule for this function
-- (both prior migrations that touched it say why: a partial rewrite of the
-- function that claims stock is a silent behaviour change). The coin block
-- is new; every other line is the live 2026-08-10 body verbatim.
--
-- The atomicity (audit 11C.3): a balance is sum(delta) and cannot be
-- locked, so the redemption takes `coin_accounts` FOR UPDATE — the row
-- created for exactly this — then computes the balance UNDER that lock,
-- validates the floor and both caps, adjusts the settlement, and writes the
-- redeemed row in the same transaction that claims stock and redeems the
-- coupon. Two simultaneous checkouts serialise there precisely as two
-- coupon redemptions serialise on the coupon row. Lock order is constant
-- (cart → coupon → coin account), so no path can deadlock another.
--
-- The rules, all raised with errcode CNRJT so the checkout can translate:
--   guest          — a guest has no user_id, so the block REFUSES rather
--                    than silently no-ops: a null lock target that
--                    no-ops is how a limit becomes optional
--   coins_unset    — any of value/percent-cap/coin-cap/minimum unset:
--                    coins accrue but cannot be spent until the owner
--                    types the numbers (safe resting state, said in admin)
--   bad_coin_value — coin_value_paise not a positive multiple of 100
--   disabled       — the per-customer switch
--   below_minimum  — usable balance under coin_minimum_balance
--   insufficient   — spending more than the usable balance. The usable
--                    balance excludes any earned cohort past its
--                    expires_at even before the expiry sweep has written
--                    its row — conservative by design: an expired coin
--                    must never spend, and the sweep merely records what
--                    this rule already refuses
--   over_coin_cap  — the absolute cap; over_percent_cap — the % cap.
--                    Two raises, so whichever binds lower binds
--   over_balance   — on Pay on Delivery, coins settle the BALANCE and
--                    never the advance: the advance is the round-trip
--                    freight, and coins eating it would silently hand
--                    back Phase 7's protection
--   sliver         — on prepaid, a remainder of 1–99 paise: Razorpay
--                    throws under 100, initiatePayment rolls the order
--                    back, and a partial settlement landing there turns a
--                    good order into a self-cancelling one. Settle fully
--                    (the born-paid path) or leave at least ₹1

create or replace function public.create_order_with_stock(
  p_cart_id uuid, p_shipping_address jsonb, p_payment_method text,
  p_initial_status public.order_status, p_payment_status public.payment_status,
  p_shipping_flat_fee bigint, p_free_shipping_above bigint default null,
  p_user_id uuid default null, p_guest_token text default null,
  p_contact_email text default null, p_contact_phone text default null,
  p_customer_note text default null, p_advance_amount bigint default null,
  p_cod_handling_fee bigint default 0, p_discount_total bigint default 0,
  p_prepaid_discount bigint default 0,
  p_quoted_courier_name text default null, p_quoted_courier_id integer default null,
  p_quoted_forward_paise bigint default null, p_quoted_rto_paise bigint default null,
  p_quoted_cod_fee_paise bigint default null, p_quote_source text default null,
  p_quoted_rate_mode text default null, p_coupon_code text default null,
  p_max_total_discount_bps integer default null,
  p_coin_spend integer default 0
)
returns table(order_id uuid, order_number text, subtotal bigint,
              shipping_fee bigint, grand_total bigint, item_count integer,
              advance_amount bigint, balance_due bigint)
language plpgsql
set search_path to ''
as $function$
#variable_conflict use_column
declare
  v_order_id uuid; v_number text;
  v_subtotal bigint := 0; v_units integer := 0;
  v_shipping bigint := 0; v_total bigint := 0;
  v_advance bigint := 0; v_balance bigint := 0;
  v_cod_fee bigint := 0; v_discount bigint := 0;
  v_prepaid bigint := 0;
  v_coupon record;
  v_coupon_discount bigint := 0;
  v_ceiling bigint;
  -- Scalars mirrored out of the record. The orders INSERT references the
  -- coupon's code and id in expressions that PL/pgSQL parses whether or not
  -- their CASE branch runs, and an unassigned record has no tuple structure —
  -- "record v_coupon is not assigned yet" on every couponless order.
  v_coupon_id uuid := null;
  v_coupon_code text := null;
  v_user_uses bigint;
  -- Coins. Scalars only, for the same parse-trap reason as the coupon's.
  v_coin_spend integer := 0;
  v_coin_paid bigint := 0;
  v_coin_value bigint;
  v_coin_pct integer;
  v_coin_cap integer;
  v_coin_floor integer;
  v_coin_balance bigint;
  v_coin_expired bigint;
  v_coins_disabled boolean;
begin
  perform 1 from public.carts c
  where c.id = p_cart_id and c.status = 'active'
  and ((p_user_id is not null and c.user_id = p_user_id)
  or (p_user_id is null and p_guest_token is not null and c.guest_token = p_guest_token))
  for update;
  if not found then raise exception 'cart_unavailable' using errcode = 'CNVRT'; end if;
  perform public.assert_cart_stock(p_cart_id);
  select coalesce(sum(coalesce(v.price_override, p.effective_price, p.base_price) * ci.quantity), 0),
  coalesce(sum(ci.quantity), 0)
  into v_subtotal, v_units
  from public.cart_items ci
  join public.product_variants v on v.id = ci.variant_id
  join public.products p on p.id = v.product_id
  where ci.cart_id = p_cart_id;
  if v_units = 0 then raise exception 'empty_cart' using errcode = 'MTCRT'; end if;

  if p_coupon_code is not null then
    -- The lock that makes the limits real. Everything below reads and writes
    -- under it, so two orders racing on one code serialise here.
    select * into v_coupon
    from public.coupons c
    where upper(c.code) = upper(p_coupon_code)
    for update;

    if not found then
      raise exception 'unknown' using errcode = 'CPNRJ';
    end if;
    if v_coupon.audience = 'specific_customers' and (p_user_id is null or not exists (
      select 1 from public.coupon_customers cc
      where cc.coupon_id = v_coupon.id and cc.user_id = p_user_id
    )) then
      raise exception 'unknown' using errcode = 'CPNRJ';
    end if;
    if not v_coupon.is_active then
      raise exception 'unknown' using errcode = 'CPNRJ';
    end if;
    if v_coupon.starts_at is not null and now() < v_coupon.starts_at then
      raise exception 'unknown' using errcode = 'CPNRJ';
    end if;
    if v_coupon.expires_at is not null and now() >= v_coupon.expires_at then
      raise exception 'expired' using errcode = 'CPNRJ';
    end if;
    if v_coupon.usage_limit is not null and v_coupon.used_count >= v_coupon.usage_limit then
      raise exception 'limit' using errcode = 'CPNRJ';
    end if;
    if v_coupon.per_user_limit is not null and p_user_id is not null then
      select count(*) into v_user_uses
      from public.coupon_redemptions r
      where r.coupon_id = v_coupon.id and r.user_id = p_user_id
        and r.released_at is null;
      if v_user_uses >= v_coupon.per_user_limit then
        raise exception 'used' using errcode = 'CPNRJ';
      end if;
    end if;
    if v_subtotal < v_coupon.min_order_value then
      -- detail carries the floor so the checkout can name the number.
      raise exception 'minimum' using errcode = 'CPNRJ',
        detail = v_coupon.min_order_value::text;
    end if;

    -- Compute, round UP to a whole rupee, then cap — max_discount and the
    -- goods total, after the rounding, per src/lib/payments/discount.ts.
    v_coupon_discount := case v_coupon.type
      when 'percent' then ((v_subtotal * v_coupon.value + 9999) / 10000) * 100
      else ((v_coupon.value + 99) / 100) * 100
    end;
    if v_coupon.max_discount is not null then
      v_coupon_discount := least(v_coupon_discount, v_coupon.max_discount);
    end if;
    v_coupon_discount := least(greatest(v_coupon_discount, 0), v_subtotal);

    v_coupon_id := v_coupon.id;
    v_coupon_code := v_coupon.code;
  end if;

  -- The prepaid part survives a coupon now, and the old defensive bound
  -- survives the stacking: a caller may never write a prepaid part larger
  -- than the total discount it claims to be part of (p_discount_total), nor
  -- larger than the goods. Through the real checkout p_discount_total is
  -- coupon + prepaid, so the bound is exact with no coupon and conservative
  -- with one; a hostile caller passing a bare prepaid with no total gets
  -- zero, same as before this migration.
  v_prepaid := least(
    greatest(coalesce(p_prepaid_discount, 0), 0),
    greatest(coalesce(p_discount_total, 0), 0),
    v_subtotal);

  if v_coupon_discount > 0 and v_prepaid > 0 then
    if p_max_total_discount_bps is null then
      -- Unreachable through the checkout: with the ceiling unset,
      -- computeOrderTotals withholds stacking and sends a single winner.
      -- Reaching this means a caller drifted from that rule, and the safe
      -- answer to "combine these under no ceiling" is no.
      raise exception 'max_total_discount_percent is not set; a coupon and the prepaid discount cannot combine without it'
        using errcode = 'DCUNS';
    end if;
    v_ceiling := (v_subtotal * p_max_total_discount_bps) / 10000;
    -- The coupon keeps its value first; the prepaid part absorbs the clamp.
    v_coupon_discount := least(v_coupon_discount, v_ceiling);
    v_prepaid := least(v_prepaid, v_ceiling - v_coupon_discount);
  end if;

  -- Both parts are individually within the subtotal and a stacked pair is
  -- within the ceiling, so the sum needs no further clamp — and
  -- orders_discount_parts_sum holds by construction.
  v_discount := v_coupon_discount + v_prepaid;

  v_shipping := case
  when p_free_shipping_above is not null and v_subtotal >= p_free_shipping_above then 0
  else greatest(coalesce(p_shipping_flat_fee, 0), 0) end;
  v_total   := v_subtotal - v_discount + v_shipping;
  v_cod_fee := least(greatest(coalesce(p_cod_handling_fee, 0), 0), v_shipping);
  v_advance := least(greatest(coalesce(p_advance_amount, v_total), 0), v_total);
  v_balance := v_total - v_advance;

  -- ── coins, as tender ──────────────────────────────────────────────────
  v_coin_spend := greatest(coalesce(p_coin_spend, 0), 0);
  if v_coin_spend > 0 then
    if p_user_id is null then
      -- Refused, never silently no-opped: a null lock target that no-ops
      -- is how a limit becomes optional. Guests hold no coins (D7).
      raise exception 'guest' using errcode = 'CNRJT';
    end if;

    insert into public.coin_accounts (user_id)
    values (p_user_id) on conflict (user_id) do nothing;

    -- THE LOCK. Two checkouts racing one balance serialise here, exactly
    -- as two coupon redemptions serialise on the coupon row.
    select a.coins_disabled into v_coins_disabled
      from public.coin_accounts a
     where a.user_id = p_user_id
       for update;
    if v_coins_disabled then
      raise exception 'disabled' using errcode = 'CNRJT';
    end if;

    select nullif((s.value ->> 'coin_value_paise'), '')::bigint,
           nullif((s.value ->> 'coin_max_percent_of_order'), '')::integer,
           nullif((s.value ->> 'coin_max_coins_per_order'), '')::integer,
           nullif((s.value ->> 'coin_minimum_balance'), '')::integer
      into v_coin_value, v_coin_pct, v_coin_cap, v_coin_floor
      from public.site_settings s where s.key = 'loyalty';

    -- Every one of these is the owner's number, unset until typed. Until
    -- all four exist, coins accrue and cannot be spent.
    if v_coin_value is null or v_coin_pct is null
       or v_coin_cap is null or v_coin_floor is null then
      raise exception 'coins_unset' using errcode = 'CNRJT';
    end if;
    if v_coin_value <= 0 or v_coin_value % 100 <> 0 then
      -- Whole rupees by construction (D3): an odd-paise coin value makes a
      -- COD collectable fractional, and the shop finds out at the door.
      raise exception 'bad_coin_value' using errcode = 'CNRJT';
    end if;

    -- The balance, computed UNDER the account lock.
    select coalesce(sum(t.delta), 0) into v_coin_balance
      from public.coin_transactions t
     where t.user_id = p_user_id;

    -- Conservative expiry: an earned cohort past its expires_at cannot
    -- spend even before the expiry sweep records it. Full-cohort
    -- subtraction over-reserves when a cohort was partially spent — the
    -- safe direction: no expired coin ever settles an order.
    select coalesce(sum(t.delta), 0) into v_coin_expired
      from public.coin_transactions t
     where t.user_id = p_user_id
       and t.reason = 'earned'
       and t.expires_at is not null and t.expires_at < now();
    v_coin_balance := v_coin_balance - v_coin_expired;

    if v_coin_balance < v_coin_floor then
      raise exception 'below_minimum' using errcode = 'CNRJT',
        detail = v_coin_floor::text;
    end if;
    if v_coin_spend > v_coin_balance then
      raise exception 'insufficient' using errcode = 'CNRJT',
        detail = v_coin_balance::text;
    end if;

    -- The TWO caps. Independent raises: whichever binds lower binds.
    if v_coin_spend > v_coin_cap then
      raise exception 'over_coin_cap' using errcode = 'CNRJT',
        detail = v_coin_cap::text;
    end if;
    v_coin_paid := v_coin_spend * v_coin_value;
    if v_coin_paid > (v_total * v_coin_pct) / 100 then
      raise exception 'over_percent_cap' using errcode = 'CNRJT',
        detail = v_coin_pct::text;
    end if;

    if v_balance > 0 then
      -- Pay on Delivery: coins settle the cash at the door, never the
      -- advance. The advance is the round-trip freight — the thing that
      -- makes a refused parcel already paid for.
      if v_coin_paid > v_balance then
        raise exception 'over_balance' using errcode = 'CNRJT',
          detail = v_balance::text;
      end if;
      v_balance := v_balance - v_coin_paid;
    else
      -- Prepaid: coins reduce the advance, with Razorpay's floor as a hard
      -- edge — settle everything, or leave at least ₹1 on the card.
      if v_coin_paid > v_advance then
        raise exception 'insufficient' using errcode = 'CNRJT',
          detail = v_advance::text;
      end if;
      v_advance := v_advance - v_coin_paid;
      if v_advance > 0 and v_advance < 100 then
        raise exception 'sliver' using errcode = 'CNRJT';
      end if;
    end if;
  end if;

  insert into public.orders (
  user_id, guest_token, cart_id, status, payment_status, payment_method,
  subtotal, discount_total, prepaid_discount, coupon_discount, coupon_code,
  shipping_fee, tax_total, grand_total,
  cod_handling_fee, advance_amount, balance_due_on_delivery,
  coin_paid, coin_spent,
  shipping_address, contact_email, contact_phone, customer_note,
  quoted_courier_name, quoted_courier_id, quoted_forward_paise,
  quoted_rto_paise, quoted_cod_fee_paise, quote_taken_at, quote_source,
  quoted_rate_mode
  ) values (
  p_user_id,
  case when p_user_id is null then p_guest_token else null end,
  p_cart_id, p_initial_status, p_payment_status, p_payment_method,
  v_subtotal, v_discount, v_prepaid, v_coupon_discount,
  v_coupon_code,
  v_shipping, 0, v_total,
  v_cod_fee, v_advance, v_balance,
  v_coin_paid, v_coin_spend,
  p_shipping_address, p_contact_email, p_contact_phone, p_customer_note,
  p_quoted_courier_name, p_quoted_courier_id, p_quoted_forward_paise,
  p_quoted_rto_paise, p_quoted_cod_fee_paise,
  case when p_quote_source is null then null else now() end, p_quote_source,
  p_quoted_rate_mode
  )
  returning orders.id, orders.order_number into v_order_id, v_number;

  if v_coupon_id is not null and v_coupon_discount > 0 then
    -- The ledger row and the counter, still under the coupon's row lock.
    -- unique(order_id) makes a replay collide rather than double-charge.
    insert into public.coupon_redemptions
      (coupon_id, order_id, user_id, code, discount_paise)
    values
      (v_coupon_id, v_order_id, p_user_id, v_coupon_code, v_coupon_discount);
    update public.coupons
      set used_count = used_count + 1, updated_at = now()
      where id = v_coupon_id;
  end if;

  if v_coin_spend > 0 then
    -- Still under the account lock taken above; the same transaction that
    -- claims the stock. unique(order_id, 'redeemed') makes any replay of
    -- this transaction's effects collide rather than double-spend.
    insert into public.coin_transactions
      (user_id, delta, reason, order_id, note)
    values
      (p_user_id, -v_coin_spend, 'redeemed', v_order_id,
       'Spent at checkout — ' || v_number);
  end if;

  insert into public.order_items (
  order_id, variant_id, product_id, product_name, product_slug,
  size, color, sku, unit_price, quantity, line_total, image_url)
  select v_order_id, v.id, p.id, p.name, p.slug, v.size, v.color, v.sku,
  coalesce(v.price_override, p.effective_price, p.base_price), ci.quantity,
  coalesce(v.price_override, p.effective_price, p.base_price) * ci.quantity,
  (select i.url from public.product_images i where i.product_id = p.id
  order by i.is_primary desc, i.sort_order asc limit 1)
  from public.cart_items ci
  join public.product_variants v on v.id = ci.variant_id
  join public.products p on p.id = v.product_id
  where ci.cart_id = p_cart_id;
  perform pg_catalog.set_config('app.inventory_reason', 'order', true);
  perform pg_catalog.set_config('app.inventory_reference', v_order_id::text, true);
  perform pg_catalog.set_config('app.inventory_actor', coalesce(p_user_id::text, ''), true);
  perform pg_catalog.set_config('app.inventory_note', 'Order ' || v_number, true);
  update public.product_variants v
  set stock_quantity = v.stock_quantity - ci.quantity
  from public.cart_items ci
  where ci.cart_id = p_cart_id and v.id = ci.variant_id;
  insert into public.order_status_history (order_id, status, note, customer_note, changed_by)
  values (v_order_id, p_initial_status, 'Order placed',
          'Order placed. We have your order and will confirm it as soon as your payment settles.',
          p_user_id);
  update public.carts set status = 'converted' where id = p_cart_id;
  return query select v_order_id, v_number, v_subtotal, v_shipping,
  v_total, v_units, v_advance, v_balance;
end;
$function$;

-- ── 4 · cancel_order_with_restock releases the coins ───────────────────────
--
-- Restated in full, same rule. New: coins REDEEMED on the order come back as
-- one 'released' row, guarded by unique(order_id, 'released') exactly as the
-- coupon's released_at guards its counter — a second cancellation gives
-- nothing back twice. Coins EARNED are deliberately not in play here: this
-- function refuses delivered and returned outright, which is the only state
-- earned coins exist in (their road back is reverse_order_coins).

create or replace function public.cancel_order_with_restock(
  p_order_id uuid, p_reason text, p_changed_by uuid default null,
  p_require_unpaid boolean default false, p_release_cart boolean default false,
  p_movement_reason public.inventory_movement_reason default 'cancellation',
  p_customer_note text default null
)
returns text
language plpgsql
set search_path to ''
as $function$
declare
  v_status      public.order_status;
  v_payment     public.payment_status;
  v_restored    timestamptz;
  v_cart        uuid;
  v_number      text;
  v_outstanding bigint;
  v_has_payment boolean;
  v_released_coupon uuid;
begin
  select o.status, o.payment_status, o.stock_restored_at, o.cart_id, o.order_number
    into v_status, v_payment, v_restored, v_cart, v_number
    from public.orders o
   where o.id = p_order_id
     for update;

  if not found then return 'not_found'; end if;
  if v_status = 'cancelled' then return 'already_cancelled'; end if;
  if v_status in ('delivered', 'returned') then return 'illegal_transition'; end if;

  if p_require_unpaid then
    -- Captured minus refunded. Zero means nothing is owed back.
    select
      coalesce((select sum(pm.amount) from public.payments pm
                 where pm.order_id = p_order_id and pm.status = 'captured'), 0)
      -
      coalesce((select sum(r.amount_paise) from public.refunds r
                 where r.order_id = p_order_id and r.status = 'processed'), 0)
      into v_outstanding;

    select exists (select 1 from public.payments pm where pm.order_id = p_order_id)
      into v_has_payment;

    if v_outstanding > 0 or (v_payment <> 'unpaid' and not v_has_payment) then
      return 'already_paid';
    end if;
  end if;

  if v_restored is null then
    perform pg_catalog.set_config('app.inventory_reason', p_movement_reason::text, true);
    perform pg_catalog.set_config('app.inventory_reference', p_order_id::text, true);
    perform pg_catalog.set_config('app.inventory_actor', coalesce(p_changed_by::text, ''), true);
    perform pg_catalog.set_config('app.inventory_note',
      'Restocked from ' || coalesce(v_number, 'order') || ': ' || coalesce(p_reason, 'cancelled'), true);

    update public.product_variants v
       set stock_quantity = v.stock_quantity + oi.quantity
      from public.order_items oi
     where oi.order_id = p_order_id
       and v.id = oi.variant_id;
  end if;

  /*
    The coupon comes back with the stock, once. `released_at is null` is what
    makes a second cancellation a no-op here, exactly as `stock_restored_at`
    is for the shelves. The decrement pairs with the increment in
    `create_order_with_stock` and never drives the counter negative.
  */
  update public.coupon_redemptions
     set released_at = now()
   where order_id = p_order_id
     and released_at is null
  returning coupon_id into v_released_coupon;

  if v_released_coupon is not null then
    update public.coupons
       set used_count = greatest(used_count - 1, 0), updated_at = now()
     where id = v_released_coupon;
  end if;

  /*
    Coins REDEEMED come back beside the coupon — one positive 'released' row
    mirroring the negative 'redeemed' one, idempotent on
    unique(order_id, 'released') so the second cancellation collides into a
    no-op. Written to the ledger like everything else: the customer's
    history reads "coins returned — order cancelled" with a receipt row
    behind it rather than a balance that silently grew.
  */
  insert into public.coin_transactions
    (user_id, delta, reason, order_id, actor, note)
  select t.user_id, -t.delta, 'released', p_order_id, p_changed_by,
         'Order cancelled — coins returned'
    from public.coin_transactions t
   where t.order_id = p_order_id and t.reason = 'redeemed'
  on conflict (order_id, reason) where order_id is not null
  do nothing;

  update public.orders
     set status            = 'cancelled',
         stock_restored_at = coalesce(stock_restored_at, now()),
         cart_id           = case when p_release_cart then null else cart_id end
   where id = p_order_id;

  /*
    Two audiences, two columns. `note` is `p_reason` exactly as it always was —
    'Released automatically: unpaid and abandoned' is the right thing for an
    audit trail and the wrong thing to show a customer. `p_customer_note` is
    what the caller wants the customer to read, and null is the safe default:
    the timeline then shows the status label alone, which is already good copy.
  */
  insert into public.order_status_history (order_id, status, note, customer_note, changed_by)
  values (p_order_id, 'cancelled', p_reason, p_customer_note, p_changed_by);

  if p_release_cart and v_cart is not null then
    begin
      update public.carts set status = 'active'
       where id = v_cart and status = 'converted';
    exception when unique_violation then
      null;
    end;
  end if;

  return 'cancelled';
end;
$function$;
