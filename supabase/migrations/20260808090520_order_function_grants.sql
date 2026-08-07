-- =============================================================================
-- 0020c · Grants for the checkout functions
--
-- Postgres grants EXECUTE to PUBLIC on every new function, and Supabase's
-- default privileges add anon, authenticated and service_role on top — so
-- without this migration `create_order_with_stock` is a PostgREST endpoint at
-- /rest/v1/rpc/create_order_with_stock that any visitor can POST to. It is
-- SECURITY INVOKER, so RLS would still stop most of the damage, but "most" is
-- not a security model: an anonymous caller could still burn order numbers and
-- probe for cart ids, and a signed-in one could hand it their own cart id with
-- a shipping fee of zero.
--
-- Neither function is called from a policy, so nothing here is load-bearing for
-- RLS evaluation — the split in 0008 applies and both get revoked outright.
-- service_role is the only role that may call them, which is the same thing as
-- saying the checkout action is the only caller.
-- =============================================================================

revoke execute on function public.assert_cart_stock(uuid)
  from public, anon, authenticated;
grant execute on function public.assert_cart_stock(uuid)
  to service_role;

revoke execute on function public.create_order_with_stock(
  uuid, uuid, text, jsonb, text, text, text, text, bigint, bigint,
  public.order_status, public.payment_status
) from public, anon, authenticated;

grant execute on function public.create_order_with_stock(
  uuid, uuid, text, jsonb, text, text, text, text, bigint, bigint,
  public.order_status, public.payment_status
) to service_role;

comment on function public.create_order_with_stock(
  uuid, uuid, text, jsonb, text, text, text, text, bigint, bigint,
  public.order_status, public.payment_status
) is
  'Places an order from a cart in one transaction: locks the variants, recomputes every price from the catalog, decrements stock, writes orders + order_items snapshots + the first history row, and marks the cart converted. Takes no price as an argument. SECURITY INVOKER, service_role only.';
