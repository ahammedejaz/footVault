-- `create_order_with_stock` learns the pricing mode.
--
-- One new parameter and one new column on the insert. Everything else is the
-- Phase 7 body unchanged — it is restated in full because Postgres has no way to
-- add a parameter to a function without recreating it, and a partial rewrite
-- here would be a silent behaviour change in the one function that moves stock.
--
-- The drop takes the ACL with it, so the revoke and the service_role grant are
-- re-issued at the bottom. Without them this is a PostgREST endpoint any visitor
-- can POST to with their own advance and their own discount.

drop function if exists public.create_order_with_stock(
  uuid, jsonb, text, public.order_status, public.payment_status, bigint, bigint,
  uuid, text, text, text, text, bigint, bigint, bigint, text, integer, bigint,
  bigint, bigint, text);

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
  p_quoted_courier_name text default null,
  p_quoted_courier_id integer default null,
  p_quoted_forward_paise bigint default null,
  p_quoted_rto_paise bigint default null,
  p_quoted_cod_fee_paise bigint default null,
  p_quote_source text default null,
  p_quoted_rate_mode text default null
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
  v_shipping := case
  when p_free_shipping_above is not null and v_subtotal >= p_free_shipping_above then 0
  else greatest(coalesce(p_shipping_flat_fee, 0), 0) end;
  v_discount := least(greatest(coalesce(p_discount_total, 0), 0), v_subtotal);
  v_total   := v_subtotal - v_discount + v_shipping;
  v_cod_fee := least(greatest(coalesce(p_cod_handling_fee, 0), 0), v_shipping);
  v_advance := least(greatest(coalesce(p_advance_amount, v_total), 0), v_total);
  v_balance := v_total - v_advance;
  insert into public.orders (
  user_id, guest_token, cart_id, status, payment_status, payment_method,
  subtotal, discount_total, shipping_fee, tax_total, grand_total,
  cod_handling_fee, advance_amount, balance_due_on_delivery,
  shipping_address, contact_email, contact_phone, customer_note,
  quoted_courier_name, quoted_courier_id, quoted_forward_paise,
  quoted_rto_paise, quoted_cod_fee_paise, quote_taken_at, quote_source,
  quoted_rate_mode
  ) values (
  p_user_id,
  case when p_user_id is null then p_guest_token else null end,
  p_cart_id, p_initial_status, p_payment_status, p_payment_method,
  v_subtotal, v_discount, v_shipping, 0, v_total,
  v_cod_fee, v_advance, v_balance,
  p_shipping_address, p_contact_email, p_contact_phone, p_customer_note,
  p_quoted_courier_name, p_quoted_courier_id, p_quoted_forward_paise,
  p_quoted_rto_paise, p_quoted_cod_fee_paise,
  case when p_quote_source is null then null else now() end, p_quote_source,
  p_quoted_rate_mode
  )
  returning orders.id, orders.order_number into v_order_id, v_number;
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
  insert into public.order_status_history (order_id, status, note, changed_by)
  values (v_order_id, p_initial_status, 'Order placed', p_user_id);
  update public.carts set status = 'converted' where id = p_cart_id;
  return query select v_order_id, v_number, v_subtotal, v_shipping,
  v_total, v_units, v_advance, v_balance;
end;
$function$;

revoke all on function public.create_order_with_stock(
  uuid, jsonb, text, public.order_status, public.payment_status, bigint, bigint,
  uuid, text, text, text, text, bigint, bigint, bigint, text, integer, bigint,
  bigint, bigint, text, text) from public, anon, authenticated;

grant execute on function public.create_order_with_stock(
  uuid, jsonb, text, public.order_status, public.payment_status, bigint, bigint,
  uuid, text, text, text, text, bigint, bigint, bigint, text, integer, bigint,
  bigint, bigint, text, text) to service_role;
