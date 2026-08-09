-- The box is 10 cm tall. The owner said so, which is the only way this number
-- was ever going to arrive.
--
-- `20260809110000_parcel_defaults.sql` left `default_parcel_height_cm` null on
-- instruction: the owner had given the footprint (20 × 10 cm) and the packed
-- weight (1000 g) but not the height, and a guessed height quietly misprices
-- every parcel because Shiprocket charges on volumetric weight too. While it
-- was null the shop refused Pay on Delivery entirely — no parcel, no quote, no
-- round-trip advance — which was the loud failure Batch 2 was told to build.
--
-- The Batch 3 brief (2026-08-09) closes it: "Box height is 10 cm. The parcel
-- default is 20 × 10 × 10 cm at 1000 g, applied to every existing product and
-- every product added in future." Existing and future products already inherit
-- this row — `products.weight_grams` and siblings are a per-product override,
-- null for almost everything — so writing the height here is the whole change.
--
-- A migration rather than only a dashboard edit so that a database rebuilt
-- from this directory ships the owner's box instead of reopening the hole:
-- height null again, Pay on Delivery refused again, and an audit failing for a
-- reason somebody already resolved.
--
-- `jsonb_set` on the one key, not a rebuilt object: `pickup_postcode` lives in
-- this row too, and this migration has no opinion about it. Unconditional
-- rather than only-if-null because the brief's sentence *is* the owner typing
-- the number — the newest statement of it wins, exactly as a settings-form
-- save would.
update public.site_settings
set value = jsonb_set(value, '{default_parcel_height_cm}', to_jsonb(10))
where key = 'shipping_defaults';
