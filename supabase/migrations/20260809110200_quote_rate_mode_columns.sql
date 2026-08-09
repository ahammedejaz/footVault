-- Which pricing mode was in force, frozen onto the quote and onto the order.
--
-- The owner's requirement for the flat-fee toggle: *"Freeze the mode used on
-- each order alongside the quote. Switching modes must never change a price a
-- customer has already been shown."*
--
-- The second half already holds and holds for a reason worth restating.
-- `shipping_quotes` is keyed by (cart, postcode, method) with a fifteen-minute
-- life, and `placeOrder` charges that stored row rather than re-quoting. So an
-- owner flipping the toggle while a customer is on the payment step does not
-- move that customer's price; they are charged the row they were shown. The
-- mode only applies to quotes taken after the flip.
--
-- The first half is what these columns add. `quote_source` cannot answer it:
-- a free-delivery order reads `free` in both modes, so without this there is no
-- way to look at an order and say which pricing regime produced it. That
-- question gets asked exactly once — the day after a festival sale, about a
-- refund.
--
-- `source` also gains a vocabulary. `shiprocket` becomes `live`, so the four
-- values line up with the four ways a fee can be arrived at, and `unavailable`
-- replaces `fallback` for the case where the courier could not be reached —
-- "fallback" described the number we substituted, not the thing that happened.

alter table public.shipping_quotes
  add column if not exists rate_mode text not null default 'live'
    check (rate_mode in ('live', 'flat'));

alter table public.orders
  add column if not exists quoted_rate_mode text
    check (quoted_rate_mode is null or quoted_rate_mode in ('live', 'flat'));

-- Every row that exists predates the toggle, so every one of them was quoted
-- live. Stated rather than left to the column default, which a later reader
-- cannot distinguish from "never set".
update public.shipping_quotes set rate_mode = 'live' where rate_mode is null;
update public.orders set quoted_rate_mode = 'live' where quote_source is not null;

update public.shipping_quotes set source = 'live' where source = 'shiprocket';
update public.shipping_quotes set source = 'unavailable' where source = 'fallback';
update public.orders set quote_source = 'live' where quote_source = 'shiprocket';
update public.orders set quote_source = 'unavailable' where quote_source = 'fallback';

comment on column public.shipping_quotes.rate_mode is
  'live | flat — which pricing regime produced this quote. In flat mode no '
  'Shiprocket call was made at all, so cost_forward_paise, cost_rto_paise and '
  'cod_fee_paise are null by design rather than by failure.';

comment on column public.orders.quoted_rate_mode is
  'The shipping_rate_mode in force when this order was priced. Frozen, so '
  'switching the toggle afterwards cannot change what this order says it cost.';

comment on column public.orders.quote_source is
  'live | flat | free | unavailable. `unavailable` means Shiprocket could not be '
  'reached and the customer was shown an estimate, and it must never be read '
  'back as a live rate.';
