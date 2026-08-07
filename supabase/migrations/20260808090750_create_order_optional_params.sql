-- =============================================================================
-- 0020d · create_order_with_stock — make the optional arguments optional
--
-- Same body as 0020b, same security model, same errors. What changes is the
-- parameter list: everything that is genuinely absent for some callers now has
-- `default null` and has moved to the end, because Postgres requires defaulted
-- parameters to be trailing.
--
-- The reason is not tidiness. `supabase gen types` cannot express parameter
-- nullability — every `uuid` argument comes out as `string`, never
-- `string | null` — so under `strict` there was no type-clean way for the
-- checkout action to say "this is a guest, there is no user id". The options
-- were a cast, hand-editing a generated file that the next regeneration would
-- silently revert, or making the SQL say what is actually true. A guest order
-- has no user id and a signed-in order has no guest token; both are optional,
-- so they are declared optional and the generator emits `p_user_id?: string`.
--
-- DROP then CREATE rather than CREATE OR REPLACE: changing parameter names and
-- order produces an *overload*, not a replacement, and two functions differing
-- only in argument order is a live ambiguity waiting for a caller to trip on.
-- Safe to drop — nothing has been called against it outside a rolled-back
-- smoke test, and the grants are re-issued below.
-- =============================================================================

drop function if exists public.create_order_with_stock(
  uuid, uuid, text, jsonb, text, text, text, text, bigint, bigint,
  public.order_status, public.payment_status
);

create or replace function public.create_order_with_stock(
  p_cart_id             uuid,
  p_shipping_address    jsonb,
  p_payment_method      text,
  p_initial_status      public.order_status,
  p_payment_status      public.payment_status,
  p_shipping_flat_fee   bigint,
  p_free_shipping_above bigint,
  p_user_id             uuid default null,
  p_guest_token         text default null,
  p_contact_email       text default null,
  p_contact_phone       text default null,
  p_customer_note       text default null
)
returns table (
  order_id     uuid,
  order_number text,
  subtotal     bigint,
  shipping_fee bigint,
  grand_total  bigint,
  item_count   integer
)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_order_id uuid;
  v_number   text;
  v_subtotal bigint := 0;
  v_units    integer := 0;
  v_shipping bigint := 0;
begin
  perform 1 from public.carts c
   where c.id = p_cart_id
     and c.status = 'active'
     and (
       (p_user_id is not null and c.user_id = p_user_id)
       or (p_user_id is null and p_guest_token is not null and c.guest_token = p_guest_token)
     )
     for update;
  if not found then
    raise exception 'cart_unavailable' using errcode = 'CNVRT';
  end if;

  perform public.assert_cart_stock(p_cart_id);

  select coalesce(sum(coalesce(v.price_override, p.effective_price, p.base_price) * ci.quantity), 0),
         coalesce(sum(ci.quantity), 0)
    into v_subtotal, v_units
    from public.cart_items ci
    join public.product_variants v on v.id = ci.variant_id
    join public.products p on p.id = v.product_id
   where ci.cart_id = p_cart_id;

  if v_units = 0 then
    raise exception 'empty_cart' using errcode = 'MTCRT';
  end if;

  v_shipping := case
    when p_free_shipping_above is not null and v_subtotal >= p_free_shipping_above then 0
    else greatest(coalesce(p_shipping_flat_fee, 0), 0)
  end;

  insert into public.orders (
    user_id, guest_token, cart_id, status, payment_status, payment_method,
    subtotal, discount_total, shipping_fee, tax_total, grand_total,
    shipping_address, contact_email, contact_phone, customer_note
  ) values (
    p_user_id,
    case when p_user_id is null then p_guest_token else null end,
    p_cart_id, p_initial_status, p_payment_status, p_payment_method,
    v_subtotal, 0, v_shipping, 0, v_subtotal + v_shipping,
    p_shipping_address, p_contact_email, p_contact_phone, p_customer_note
  )
  returning orders.id, orders.order_number into v_order_id, v_number;

  insert into public.order_items (
    order_id, variant_id, product_id, product_name, product_slug,
    size, color, sku, unit_price, quantity, line_total, image_url
  )
  select v_order_id, v.id, p.id, p.name, p.slug,
         v.size, v.color, v.sku,
         coalesce(v.price_override, p.effective_price, p.base_price),
         ci.quantity,
         coalesce(v.price_override, p.effective_price, p.base_price) * ci.quantity,
         (select i.url from public.product_images i
           where i.product_id = p.id
           order by i.is_primary desc, i.sort_order asc
           limit 1)
    from public.cart_items ci
    join public.product_variants v on v.id = ci.variant_id
    join public.products p on p.id = v.product_id
   where ci.cart_id = p_cart_id;

  update public.product_variants v
     set stock_quantity = v.stock_quantity - ci.quantity
    from public.cart_items ci
   where ci.cart_id = p_cart_id and v.id = ci.variant_id;

  insert into public.order_status_history (order_id, status, note, changed_by)
  values (v_order_id, p_initial_status, 'Order placed', p_user_id);

  update public.carts set status = 'converted' where id = p_cart_id;

  return query select v_order_id, v_number, v_subtotal, v_shipping,
                      v_subtotal + v_shipping, v_units;
end;
$$;

revoke execute on function public.create_order_with_stock(
  uuid, jsonb, text, public.order_status, public.payment_status, bigint, bigint,
  uuid, text, text, text, text
) from public, anon, authenticated;

grant execute on function public.create_order_with_stock(
  uuid, jsonb, text, public.order_status, public.payment_status, bigint, bigint,
  uuid, text, text, text, text
) to service_role;
