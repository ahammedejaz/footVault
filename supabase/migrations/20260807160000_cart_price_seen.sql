-- =============================================================================
-- 0014 · The price the customer last saw
--
-- cart_items deliberately stores no price: the total is recomputed from the
-- catalog on every read, so a bag can never show a stale total and there is no
-- browser-supplied number anywhere near the arithmetic. That is the right
-- default and it stays.
--
-- What it cannot do is *notice*. "If a price changed, say so in plain language"
-- needs a before as well as an after, and with nothing recorded there is no
-- before — the cart would quietly show a different number than the one the
-- customer decided on, which is exactly the silence being designed out.
--
-- So: one column holding the effective price at the moment this line was last
-- added to or acknowledged. It is never used in a calculation. Its only job is
-- to be compared against the live price so the difference can be said out loud.
--
-- Nullable on purpose. A line with no snapshot — anything already in a bag
-- before this migration — means "no before to compare against", which reads as
-- no notice rather than a false one.
-- =============================================================================

alter table public.cart_items
  add column unit_price_seen bigint
  check (unit_price_seen is null or unit_price_seen > 0);

comment on column public.cart_items.unit_price_seen is
  'Effective price in paise when this line was last added to or acknowledged. Compared against the live price to report a change; never used to compute a total.';
