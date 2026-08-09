-- `orders.prepaid_discount` — why money came off, kept beside how much.
--
-- The row has carried `discount_total` since Phase 3 and nothing else, and the
-- type comment in `src/lib/orders/types.ts` argued that was right: the reason a
-- discount was given "belongs to the moment of choosing rather than to the row".
-- That was defensible while the discount was zero everywhere. It stopped being
-- defensible on 2026-08-09 at 12:26 UTC, when a 20% prepaid discount went live
-- in `site_settings.shipping` — from that moment a customer opening their order
-- a week later, and the owner reconciling it, both need to know *why* the goods
-- total and the amount charged disagree.
--
-- Without this column every read-back surface can only draw a generic
-- "Discount": the confirmation page, the account order page, the admin order
-- page and the order email all lose the distinction between "we passed some back
-- for paying online" and "a coupon was used" — and Batch C adds coupons.
--
-- ## Nothing is backfilled, because nothing needs to be
--
-- Checked against production rather than assumed: all 16 orders carry
-- `discount_total = 0`, including the seven paid online, because the prepaid
-- discount was switched on *after* the most recent of them (FV-2026-00623,
-- 11:21 UTC, against a settings write at 12:26). So the default of 0 is not a
-- placeholder standing in for an unknown — it is the true value for every row
-- that exists, and the first order to carry a real one will be written by the
-- function this migration's sibling recreates.
--
-- ## The CHECK is the point of doing it this way
--
-- `prepaid_discount <= discount_total` means no read site has to trust that the
-- part and the whole were kept in step by whichever code path wrote them. It is
-- the same trick as `orders_advance_balance_sums`: the database refuses a row
-- that does not add up, so a display that subtracts one from the other cannot
-- produce a negative "other discount" line. Batch C tightens it to an equality
-- once `coupon_discount` exists and the two parts account for the whole.

alter table public.orders
  add column if not exists prepaid_discount bigint not null default 0;

comment on column public.orders.prepaid_discount is
  'How much of discount_total was given for paying online, in paise. Zero on '
  'Pay on Delivery and on any order placed before the discount existed. The '
  'remainder of discount_total is coupon or manual discount.';

alter table public.orders
  drop constraint if exists orders_prepaid_discount_within_total;

alter table public.orders
  add constraint orders_prepaid_discount_within_total
  check (prepaid_discount >= 0 and prepaid_discount <= discount_total);
