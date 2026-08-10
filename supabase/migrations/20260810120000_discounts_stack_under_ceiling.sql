-- The coupon and the prepaid discount now COMBINE (owner's decision,
-- 2026-08-10, reversing the same day's no-stacking rule).
--
-- Additive, not compounding: each part is computed on the original goods
-- subtotal, never on the other's remainder, and the two are written to their
-- own columns so every receipt can draw two named lines.
-- `orders_discount_parts_sum` (discount_total = prepaid_discount +
-- coupon_discount) already binds the arithmetic and is untouched.
--
-- ## The ceiling
--
-- One new parameter, `p_max_total_discount_bps` — the owner's
-- `max_total_discount_percent` in basis points. When both parts are non-zero
-- the pair is capped at that share of the subtotal **this function computed
-- under the row lock**, not the one TypeScript saw: the coupon keeps its full
-- value first and the prepaid part absorbs the clamp, because the coupon is
-- the number the customer was promised by name.
--
-- ## Unset means refused, not uncapped
--
-- With both parts non-zero and no ceiling supplied, this function raises
-- (errcode DCUNS) rather than guessing. The checkout can never trip it — with
-- the setting unset, `computeOrderTotals` withholds stacking and sends one
-- winner — so reaching this exception means a caller drifted from the
-- TypeScript rule, and refusing loudly is the point. The owner's standing
-- instruction: business numbers stay theirs; mechanisms ship unset and fail
-- loudly.
--
-- Everything else — coupon validation order, the CPNRJ keywords, rounding UP
-- to a whole rupee then capping, the redemption ledger under the coupon's row
-- lock — is 20260810080100's verbatim. Restated in full because a partial
-- rewrite of the function that claims stock would be a silent behaviour
-- change.

drop function if exists public.create_order_with_stock(
  uuid, jsonb, text, public.order_status, public.payment_status, bigint, bigint,
  uuid, text, text, text, text, bigint, bigint, bigint, bigint, text, integer,
  bigint, bigint, bigint, text, text, text);

create function public.create_order_with_stock(
  p_cart_id uuid,
  p_shipping_address jsonb,
  p_payment_method text,
  p_initial_status public.order_status,
  p_payment_status public.payment_status,
  p_shipping_flat_fee bigint,
  p_free_shipping_above bigint default null,
  p_user_id uuid default null,
  p_guest_token text default null,
  p_contact_email text default null,
  p_contact_phone text default null,
  p_customer_note text default null,
  p_advance_amount bigint default null,
  p_cod_handling_fee bigint default 0,
  p_discount_total bigint default 0,
  p_prepaid_discount bigint default 0,
  p_quoted_courier_name text default null,
  p_quoted_courier_id integer default null,
  p_quoted_forward_paise bigint default null,
  p_quoted_rto_paise bigint default null,
  p_quoted_cod_fee_paise bigint default null,
  p_quote_source text default null,
  p_quoted_rate_mode text default null,
  p_coupon_code text default null,
  p_max_total_discount_bps integer default null
)
returns table(order_id uuid, order_number text, subtotal bigint, shipping_fee bigint,
  grand_total bigint, item_count integer, advance_amount bigint, balance_due bigint)
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
  insert into public.orders (
  user_id, guest_token, cart_id, status, payment_status, payment_method,
  subtotal, discount_total, prepaid_discount, coupon_discount, coupon_code,
  shipping_fee, tax_total, grand_total,
  cod_handling_fee, advance_amount, balance_due_on_delivery,
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

revoke all on function public.create_order_with_stock(
  uuid, jsonb, text, public.order_status, public.payment_status, bigint, bigint,
  uuid, text, text, text, text, bigint, bigint, bigint, bigint, text, integer,
  bigint, bigint, bigint, text, text, text, integer) from public, anon, authenticated;

grant execute on function public.create_order_with_stock(
  uuid, jsonb, text, public.order_status, public.payment_status, bigint, bigint,
  uuid, text, text, text, text, bigint, bigint, bigint, bigint, text, integer,
  bigint, bigint, bigint, text, text, text, integer) to service_role;
