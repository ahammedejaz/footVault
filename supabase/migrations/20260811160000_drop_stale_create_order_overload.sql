-- The 2026-08-09 lesson, relearned the same night it was reread.
--
-- 20260811140000 gave create_order_with_stock a new defaulted parameter
-- (p_coin_spend) via CREATE OR REPLACE — which, with a different arity, does
-- not replace anything: it creates an overload beside the old form, and
-- PostgREST answers every call with "Could not choose the best candidate
-- function". Exactly the shape 20260809130000 fixed for
-- cancel_order_with_restock, caught this time by audit:admin-pages within
-- the hour because the suite now runs.
--
-- Drop the old 25-argument form; the 26-argument one (whose p_coin_spend
-- defaults to 0) serves every existing caller unchanged.

drop function if exists public.create_order_with_stock(
  uuid, jsonb, text, public.order_status, public.payment_status,
  bigint, bigint, uuid, text, text, text, text, bigint, bigint, bigint,
  bigint, text, integer, bigint, bigint, bigint, text, text, text, integer
);
