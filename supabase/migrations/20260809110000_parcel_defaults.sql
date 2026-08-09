-- One box for the whole catalogue, and the literal that has to die for it.
--
-- The owner's decision (2026-08-09), replacing the per-product weights CSV that
-- Batch 1 prepared: *"There is one common box for the whole catalogue: roughly
-- 20cm x 10cm, about 1kg packed, and it should apply to every existing product
-- and every product added in future."* So the numbers live here, every product
-- inherits them, and `products.weight_grams` and its three siblings stay as an
-- optional override for anything bulky like boots.
--
-- The fields are renamed to the owner's own names. `weight_grams` inside this
-- row and `weight_grams` on `products` were two different things one word apart
-- — the default and the override — and reading a bug report about "the weight"
-- meant asking which one every time. `default_parcel_*` cannot be confused with
-- a column on a product.
--
-- **`default_parcel_height_cm` is deliberately null.** The owner has given the
-- footprint and the packed weight and has not yet given the height. It is left
-- unset rather than guessed, and `src/lib/shipping/quote.ts` refuses to build a
-- parcel without it — see the comment there for what that costs while it is
-- unset. A plausible height typed here would be indistinguishable from a
-- measured one the moment this migration scrolls out of view, and Shiprocket
-- prices on volumetric weight, so the guess would quietly misprice every parcel.
--
-- The 900g that used to be hardcoded in `quote.ts` is gone with this: there is
-- no longer any value a missing setting can fall through to.

update public.site_settings
set value = jsonb_build_object(
      'default_parcel_weight_grams', 1000,
      'default_parcel_length_cm', 20,
      'default_parcel_breadth_cm', 10,
      -- Unset, on purpose, and the only thing standing between this shop and a
      -- live quote. See the header.
      'default_parcel_height_cm', null,
      -- Unchanged in meaning, carried across from the old shape. Serviceability
      -- is quoted *from* somewhere and getting it wrong produces plausible
      -- estimates for the wrong city.
      'pickup_postcode', coalesce(value ->> 'pickup_postcode', '560001')
    ),
    description = 'The one parcel every product ships in unless it carries its own '
      || 'override, plus the pickup PIN serviceability is quoted from. Editable at '
      || '/admin/settings. Nothing falls back to a literal: an unset field stops '
      || 'quoting rather than being guessed.'
where key = 'shipping_defaults';

-- The row must exist even on a database seeded before Phase 6, because the
-- reader now has nothing to fall back to.
insert into public.site_settings (key, value, description, is_public)
select 'shipping_defaults',
       jsonb_build_object(
         'default_parcel_weight_grams', 1000,
         'default_parcel_length_cm', 20,
         'default_parcel_breadth_cm', 10,
         'default_parcel_height_cm', null,
         'pickup_postcode', '560001'
       ),
       'The one parcel every product ships in unless it carries its own override.',
       false
where not exists (select 1 from public.site_settings where key = 'shipping_defaults');

comment on column public.products.weight_grams is
  'Optional override. Null means this product ships in the common box described '
  'by site_settings.shipping_defaults — which is the case for almost everything. '
  'Set it only for something that genuinely does not fit, like boots. On the '
  'product rather than the variant: within one model the difference between a '
  'UK 5 and a UK 12 is well inside a courier''s 500g slab.';
