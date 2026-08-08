-- =============================================================================
-- 0022 · merge_guest_cart — the merge, in one transaction
--
-- Phase 4's merge was idempotent but not atomic: eight lines meant eight round
-- trips, and a failure at line five left the bag split across two carts. That
-- was survivable while a cart was only a display. Checkout now converts a cart
-- and decrements stock from it, so a half-merged bag is a half-placed order.
--
-- One function, one transaction: either the whole bag moves and the guest cart
-- is gone, or nothing happened and the next sign-in tries again.
--
-- **SECURITY INVOKER, and it needs nothing more.** RLS already lets exactly one
-- client see both bags — the /auth/callback client carries the new session (so
-- the account cart policy matches) and the x-guest-token header it was built
-- with (so the guest cart policy matches). DEFINER would remove the very check
-- that makes this safe. The precedent is Phase 1's guard_profile_role(), where
-- SECURITY DEFINER made current_user resolve to the owner and left the guard
-- silently inert; reaching for DEFINER because a query "needs" to see two rows
-- is how that happens again.
--
-- **The user comes from auth.uid(), never from a parameter.** The token comes
-- from the request header, never from a parameter either. p_guest_token exists
-- only to be *compared* against the header: a mismatch means the client was
-- constructed without the guest cookie, and merging some other bag quietly is
-- worse than failing loudly. p_max_line_quantity is passed because
-- MAX_LINE_QUANTITY is defined in src/lib/validations/cart.ts and a copy in SQL
-- is a copy that drifts.
-- =============================================================================

create or replace function public.merge_guest_cart(
  p_guest_token       text,
  p_max_line_quantity integer
)
returns table (merged integer, dropped integer, guest_cart_consumed boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user    uuid := (select auth.uid());
  v_token   text := (select public.current_guest_token());
  v_guest   uuid;
  v_account uuid;
  v_merged  integer := 0;
  v_lines   integer := 0;
begin
  if v_user is null then
    raise exception 'merge_guest_cart: no signed-in caller' using errcode = '42501';
  end if;
  if v_token is null or p_guest_token is distinct from v_token then
    raise exception 'merge_guest_cart: guest token does not match the request header'
      using errcode = '42501';
  end if;

  select c.id into v_guest
    from public.carts c
   where c.guest_token = v_token and c.status = 'active'
     for update;

  -- A token with no bag behind it is a stale cookie. Say it is spent so the
  -- caller stops sending it.
  if not found then
    return query select 0, 0, true;
    return;
  end if;

  select c.id into v_account
    from public.carts c
   where c.user_id = v_user and c.status = 'active'
     for update;
  if not found then
    insert into public.carts (user_id) values (v_user) returning id into v_account;
  end if;

  select count(*) into v_lines from public.cart_items ci where ci.cart_id = v_guest;

  -- One statement. Quantities sum with whatever the account bag already held,
  -- capped at live stock and at the per-line ceiling; anything withdrawn or
  -- sold out while they were signing in simply does not appear in `sellable`
  -- and is counted as dropped below.
  with sellable as (
    select gl.variant_id,
           gl.quantity,
           gl.unit_price_seen,
           least(v.stock_quantity, greatest(p_max_line_quantity, 1)) as ceiling,
           coalesce(v.price_override, p.effective_price, p.base_price) as unit_price
      from public.cart_items gl
      join public.product_variants v on v.id = gl.variant_id
      join public.products p on p.id = v.product_id
     where gl.cart_id = v_guest
       and v.is_active and p.is_active and p.deleted_at is null
       and v.stock_quantity > 0
  )
  insert into public.cart_items (cart_id, variant_id, quantity, unit_price_seen)
  select v_account,
         s.variant_id,
         least(coalesce(existing.quantity, 0) + s.quantity, s.ceiling),
         -- The price they last saw as a guest travels with the line, so a
         -- change during sign-in is still reported on the cart page.
         coalesce(s.unit_price_seen, s.unit_price)
    from sellable s
    left join public.cart_items existing
      on existing.cart_id = v_account and existing.variant_id = s.variant_id
  on conflict (cart_id, variant_id) do update
     set quantity        = excluded.quantity,
         unit_price_seen = excluded.unit_price_seen;

  get diagnostics v_merged = row_count;

  -- The guest bag is gone once its contents have a home. Keyed by a token that
  -- is about to be thrown away, so nothing could reach it again; cart_items
  -- cascades. Same transaction as the insert, which is the whole point.
  delete from public.carts where id = v_guest;

  return query select v_merged, greatest(v_lines - v_merged, 0), true;
end;
$$;

comment on function public.merge_guest_cart(text, integer) is
  'Folds the guest bag named by the x-guest-token header into the calling user''s active cart, atomically. SECURITY INVOKER: both bags are visible to the caller under RLS and no elevated privilege is used. The user comes from auth.uid() and the token from the request header; neither is taken from a parameter.';

revoke execute on function public.merge_guest_cart(text, integer) from public, anon;
grant execute on function public.merge_guest_cart(text, integer) to authenticated;
