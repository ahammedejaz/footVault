-- `create_order_with_stock` learns about the advance, and the file catches up
-- with the database.
--
-- Two things happen here, and the second one is a bug fix nobody filed.
--
-- **The advance.** A Pay-on-Delivery order now records what was charged online
-- and what the courier must collect. The caller passes the advance it showed the
-- customer; the **balance is derived here** as `grand_total - advance` rather
-- than passed in. That is deliberate: the subtotal is recomputed under a row
-- lock inside this function and can differ from what the checkout page saw if a
-- price moved, and two independently-supplied numbers would then fail the
-- `advance + balance = grand_total` check constraint and take the whole
-- checkout down with an opaque error. Deriving one from the other means the
-- invariant holds by construction, the customer is charged online exactly what
-- the modal showed them, and any drift lands where it belongs — on the amount
-- the courier collects.
--
-- **The drift.** The last migration to define this function
-- (20260808090750_create_order_optional_params) dropped the four `set_config`
-- calls that 20260807223233 had added, while the live database kept them. So
-- the files no longer reproduced the database, and replaying them into a fresh
-- environment would have produced a function that still moves stock but records
-- every movement as `unspecified` with no actor and no order reference — a
-- ledger that looks present and is useless, discovered only when someone asks
-- why a count is wrong. They are restored below, so this file is now the whole
-- truth about this function.
drop function if exists public.create_order_with_stock(
  uuid, jsonb, text, public.order_status, public.payment_status,
  bigint, bigint, uuid, text, text, text, text);

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
  p_customer_note       text default null,
  -- Null means "the whole order settles online", which is prepaid.
  p_advance_amount      bigint default null,
  -- The Pay-on-Delivery extra, as a breakdown of p_shipping_flat_fee.
  p_cod_handling_fee    bigint default 0
)
returns table (
  order_id     uuid,
  order_number text,
  subtotal     bigint,
  shipping_fee bigint,
  grand_total  bigint,
  item_count   integer,
  advance_amount bigint,
  balance_due  bigint
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
  v_total    bigint := 0;
  v_advance  bigint := 0;
  v_balance  bigint := 0;
  v_cod_fee  bigint := 0;
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
  v_total := v_subtotal + v_shipping;

  -- The COD extra is part of the shipping fee, never on top of it. Clamped so a
  -- caller cannot claim a handling fee larger than the delivery it breaks down.
  v_cod_fee := least(greatest(coalesce(p_cod_handling_fee, 0), 0), v_shipping);

  -- Clamped into [0, grand_total]: an advance larger than the order would leave
  -- the courier a negative amount to collect, and a negative advance is not a
  -- number this system has a meaning for.
  v_advance := least(greatest(coalesce(p_advance_amount, v_total), 0), v_total);
  v_balance := v_total - v_advance;

  insert into public.orders (
    user_id, guest_token, cart_id, status, payment_status, payment_method,
    subtotal, discount_total, shipping_fee, tax_total, grand_total,
    cod_handling_fee, advance_amount, balance_due_on_delivery,
    shipping_address, contact_email, contact_phone, customer_note
  ) values (
    p_user_id,
    case when p_user_id is null then p_guest_token else null end,
    p_cart_id, p_initial_status, p_payment_status, p_payment_method,
    v_subtotal, 0, v_shipping, 0, v_total,
    v_cod_fee, v_advance, v_balance,
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

  -- Attribution for record_inventory_movement(), transaction-local so it cannot
  -- survive into the next request on a pooled connection. Set immediately before
  -- the decrement it describes.
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
$$;

-- Re-granted, because dropping the function took its privileges with it.
-- service_role only: a customer who could reach this through PostgREST could
-- pass their own `p_advance_amount` and pay ₹1 for a ₹17,000 order.
revoke execute on function public.create_order_with_stock(
  uuid, jsonb, text, public.order_status, public.payment_status,
  bigint, bigint, uuid, text, text, text, text, bigint, bigint
) from public, anon, authenticated;

grant execute on function public.create_order_with_stock(
  uuid, jsonb, text, public.order_status, public.payment_status,
  bigint, bigint, uuid, text, text, text, text, bigint, bigint
) to service_role;
