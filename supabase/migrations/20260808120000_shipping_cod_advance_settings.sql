-- Delivery pricing settings become admin-tunable, and the flat fee goes away.
--
-- The owner's rule (2026-08-08): delivery charges are always fetched from the
-- Shiprocket API and never hardcoded; the *thresholds* are the shop's decision
-- and belong in the admin panel. So `flat_fee_paise` is removed — it was the
-- source of a real drift, where the cart promised a flat fee and checkout
-- charged a live courier rate — and the tunable numbers arrive here instead.
--
-- `fallback_fee_paise` is not a price list. It is only reached when Shiprocket
-- is unreachable, because refusing to sell during a courier outage is a worse
-- outcome than mispricing a handful of orders. It is a setting rather than a
-- constant so the owner can correct it without a deploy.
update site_settings
set value = (value - 'flat_fee_paise')
  || jsonb_build_object(
       'cod_enabled', true,
       -- shipping_fee | fixed | greater_of
       'cod_advance_mode', 'greater_of',
       -- Never let a computed advance fall below this, and never below
       -- Razorpay's own 100-paise floor. ₹99.
       'cod_advance_minimum_paise', 9900,
       'cod_advance_fixed_paise', 9900,
       'fallback_fee_paise', jsonb_build_object('razorpay', 19900, 'cod', 34900)
     )
where key = 'shipping';
