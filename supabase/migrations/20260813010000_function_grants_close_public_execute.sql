-- Two functions were executable by anon and authenticated when neither should
-- be, both through the same mechanism: Postgres grants EXECUTE to PUBLIC on
-- every new function by default, and a revoke that names roles but not PUBLIC
-- revokes nothing a role only held *through* PUBLIC.
--
-- 1. create_order_with_stock — 20260811140000 changed its arity, which makes
--    a NEW function, and new functions do not inherit the old one's ACL. The
--    25-argument form carried `revoke all ... from public; grant ... to
--    service_role` (visible in the 2026-08-13 00:31 pre-push schema dump,
--    lines 4498–4499); the 26-argument form was created bare, so the default
--    PUBLIC grant stood and anyone with the URL could invoke order creation
--    with fee and discount figures of their choosing. Found by the post-push
--    privilege gate, present on staging since 2026-08-11 (the overnight suite
--    never asserts anon refusal on this function — recorded as a gate hole).
--
-- 2. reconcile_reviews — 20260811110000 revoked it `from anon, authenticated`
--    but not `from public`, so both roles kept EXECUTE through PUBLIC. Its
--    sibling in the same migration (reviews_refresh_aggregate) named public
--    and is closed; this one missed the word.
--
-- The rule the codebase already follows elsewhere (130000's credit_order_coins
-- and friends): revoke from public AND the client roles, then grant the one
-- caller that needs it.

revoke all on function public.create_order_with_stock(
  uuid, jsonb, text, public.order_status, public.payment_status,
  bigint, bigint, uuid, text, text, text, text, bigint, bigint, bigint,
  bigint, text, integer, bigint, bigint, bigint, text, text, text, integer,
  integer
) from public, anon, authenticated;

grant execute on function public.create_order_with_stock(
  uuid, jsonb, text, public.order_status, public.payment_status,
  bigint, bigint, uuid, text, text, text, text, bigint, bigint, bigint,
  bigint, text, integer, bigint, bigint, bigint, text, text, text, integer,
  integer
) to service_role;

revoke all on function public.reconcile_reviews()
  from public, anon, authenticated;

grant execute on function public.reconcile_reviews() to service_role;
