-- =============================================================================
-- 0008 · Function grants
--
-- Postgres grants EXECUTE on new functions to PUBLIC by default, and Supabase
-- exposes everything in `public` over PostgREST — so every function above is
-- reachable at /rest/v1/rpc/<name> unless the grant is taken back.
--
-- The split is not "revoke every SECURITY DEFINER function". An RLS policy
-- expression is evaluated with the privileges of the querying role, so a policy
-- that calls is_admin() breaks outright if `authenticated` cannot execute it.
-- The rule that actually applies:
--
--   * called from a policy  -> the grant is load-bearing, keep it, and make
--                              sure the function tells the caller nothing it
--                              does not already know about itself
--   * called from a trigger -> trigger execution does not check the invoking
--                              user's EXECUTE privilege, so revoke it
-- =============================================================================

-- --- trigger functions: nothing calls these directly -------------------------

revoke execute on function public.set_updated_at()     from public, anon, authenticated;
revoke execute on function public.handle_new_user()    from public, anon, authenticated;
revoke execute on function public.guard_profile_role() from public, anon, authenticated;

-- --- volatile helpers: server-side only --------------------------------------
-- next_order_number() advances a sequence. Exposed, any visitor could burn
-- order numbers in a loop and leave FV-2026-00001..00500 as gaps in the
-- owner's books. Orders are written by the checkout action through the service
-- role, which is unaffected by this revoke.

revoke execute on function public.next_order_number() from public, anon, authenticated;

-- --- policy helpers: the grant is required -----------------------------------
-- These four stay executable because the policies in 0006 call them. Each is
-- scoped so that being callable leaks nothing: they answer questions about the
-- caller ("am I an admin", "is this my cart", "is this my order") or about data
-- that is already public ("is this product live"). A caller who is not the
-- owner gets false, which is exactly what the row itself would have told them.

comment on function public.can_access_cart(uuid) is
  'True when the caller owns the given cart, by auth.uid() or by matching guest token. Called from the cart_items policies; returns false rather than raising for a cart the caller does not own.';

comment on function public.owns_order(uuid) is
  'True when the given order belongs to the calling user. Called from the order_items and order_status_history policies.';

comment on function public.product_is_live(uuid) is
  'True when the given product is active and not soft-deleted. Called from the product_images and product_variants policies so a child row is visible exactly when its parent is.';
