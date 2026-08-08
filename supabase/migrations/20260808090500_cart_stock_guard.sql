-- =============================================================================
-- 0020a · assert_cart_stock — hold the rows, then refuse or allow
--
-- The first half of the checkout transaction, split out because the MCP
-- migration channel truncates a payload over about 5KB *silently* and the
-- combined function is well past that. The split is not arbitrary: "prove this
-- bag can be filled and hold the units while we decide" is a different sentence
-- from "write the order", and this one is the sentence that has to be right.
--
-- It does two things that only mean anything together.
--
-- **It locks.** SELECT ... FOR UPDATE on every variant in the bag, in id order
-- so two checkouts over an overlapping bag queue instead of deadlocking. The
-- lock is held until the calling transaction commits, which is what closes the
-- window between "there are two left" and "take two".
--
-- **It refuses, by name.** A shortfall raises with the item and the size in a
-- json DETAIL shaped exactly like OutOfStockItem[] in src/lib/orders/types.ts,
-- so the checkout page can say "Gazelle, UK 9 — you asked for 2, we have 1"
-- instead of "something went wrong" to somebody who has just typed an address.
--
-- A withdrawn product reports available = 0 rather than its stock count: the
-- units may exist but they are not for sale, and telling a customer there is
-- one left of something they cannot buy is worse than telling them none.
-- =============================================================================

create or replace function public.assert_cart_stock(p_cart_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_short jsonb;
begin
  perform 1 from public.product_variants v
   where v.id in (select ci.variant_id from public.cart_items ci where ci.cart_id = p_cart_id)
   order by v.id
     for update;

  select jsonb_agg(jsonb_build_object(
           'productName', p.name,
           'size', v.size,
           'requested', ci.quantity,
           'available', case when v.is_active and p.is_active and p.deleted_at is null
                             then v.stock_quantity else 0 end))
    into v_short
    from public.cart_items ci
    join public.product_variants v on v.id = ci.variant_id
    join public.products p on p.id = v.product_id
   where ci.cart_id = p_cart_id
     and (not v.is_active or not p.is_active or p.deleted_at is not null
          or v.stock_quantity < ci.quantity);

  if v_short is not null then
    -- SQLSTATE from an unused class so the action branches on a code rather
    -- than on a message. See src/lib/orders/errors.ts.
    raise exception 'out_of_stock' using errcode = 'OSTCK', detail = v_short::text;
  end if;
end;
$$;

comment on function public.assert_cart_stock(uuid) is
  'Locks every variant in the cart FOR UPDATE and raises SQLSTATE OSTCK, with an OutOfStockItem[] json DETAIL, if any line cannot be filled. Called inside create_order_with_stock; the lock only means anything for the duration of that transaction.';
