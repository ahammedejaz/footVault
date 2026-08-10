-- How many days the courier said this lane takes, frozen onto the order.
--
-- ## Why the order needs its own copy
--
-- `shipping_quotes.estimated_days` already holds the figure, but a quote is
-- keyed to a pin code and a basket rather than to an order, and it lapses. The
-- confirmation page and the account page are read days or weeks later, and both
-- have to say when the parcel is coming without making a live courier call on a
-- page load — which would put a Shiprocket round trip in front of a page a
-- customer opens from an email.
--
-- It sits beside `quoted_courier_id`, `quoted_courier_name`,
-- `quoted_forward_paise` and the rest, which are on `orders` for exactly the
-- same reason: what was true at the moment of ordering is what the customer was
-- promised, and re-deriving it later gets a different answer.
--
-- ## Why it is not written by create_order_with_stock
--
-- It could have been another `p_` parameter, and that would make it atomic with
-- the order. It is deliberately not, because `create_order_with_stock` is the
-- most load-bearing function in this system — it decrements stock, redeems
-- coupons and computes the advance in one transaction — and restating it for a
-- **display field** trades real risk for no correctness.
--
-- So `placeOrder` writes it immediately afterwards, best-effort, in the same
-- shape as the address-book save that already lives there ("a book that fails
-- to save must not cost somebody their checkout").
--
-- The failure mode is worth stating because it is what makes that trade sound:
-- if the write fails the column stays null, and null is a state
-- `deliveryEstimate()` already handles — the page says *"We could not reach the
-- courier for a date just now. We will confirm it when your parcel is
-- dispatched."* An order is never wrong because of this column; at worst a page
-- is vaguer than it could have been.
--
-- Nullable with no backfill. The 21 existing orders have no stored estimate and
-- inventing one would be exactly the "about 4 days" this batch exists to
-- remove; they render the honest sentence instead.
alter table public.orders
  add column quoted_estimated_days integer
    check (quoted_estimated_days is null or quoted_estimated_days > 0);

comment on column public.orders.quoted_estimated_days is
  'Shiprocket''s estimated_delivery_days for this lane at the moment of '
  'ordering. Null when the lookup did not answer, or for orders placed before '
  'Phase 10 — both render honest vagueness rather than a guessed date. Written '
  'best-effort by placeOrder after create_order_with_stock returns; read by '
  'deliveryEstimate() on the confirmation and account pages.';
