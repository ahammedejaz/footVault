-- A customer could execute reconcile_inventory() and read every SKU and stock
-- level in the shop, plus any drift between the ledger and the counts.
--
-- The cause is a Postgres default that is easy to miss and was missed here
-- exactly once: CREATE FUNCTION grants EXECUTE to PUBLIC, and `anon` and
-- `authenticated` inherit that grant. Revoking from those two roles by name
-- removes a grant they never held individually and leaves the PUBLIC one
-- standing. `consume_rate_limit` and `cancel_order_with_restock` in this same
-- phase revoke `from public, anon, authenticated` and were unaffected; this one
-- said only `from anon, authenticated`.
--
-- Found by scripts/audit/admin-security.ts on its first run, which is the whole
-- argument for a dedicated adversarial pass: the function had a correct-looking
-- revoke line directly beneath it.
revoke execute on function public.reconcile_inventory() from public, anon, authenticated;
grant execute on function public.reconcile_inventory() to service_role;
