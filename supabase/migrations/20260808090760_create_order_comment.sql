-- =============================================================================
-- 0020e · The comment 0020d dropped along with the old signature
--
-- `drop function` takes the function's comment with it, and 0020c's comment was
-- attached to the twelve-argument signature that no longer exists. Left alone,
-- the one function in this schema that most needs a one-line description in
-- \df+ would have none.
--
-- It also records where the long-form reasoning lives. 0020d recreated the body
-- without its inline commentary to keep the migration payload inside the limit
-- that truncates silently; 0020b is the same logic with every decision written
-- out, and is the file to read before changing anything here.
-- =============================================================================

comment on function public.create_order_with_stock(
  uuid, jsonb, text, public.order_status, public.payment_status, bigint, bigint,
  uuid, text, text, text, text
) is
  'Places an order from a cart in one transaction: locks the variants via assert_cart_stock, recomputes every price from the catalog, decrements stock, writes orders + order_items snapshots + the first history row, and marks the cart converted. Takes no price as an argument — only the shipping policy. SECURITY INVOKER, service_role only. Raises MTCRT (empty cart), CNVRT (cart missing/not the caller''s/already converted) and OSTCK (out of stock, with an OutOfStockItem[] json DETAIL). Annotated source: supabase/migrations/20260808090510_create_order_with_stock.sql.';
