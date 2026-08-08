alter table public.products
  add column weight_grams integer check (weight_grams is null or weight_grams > 0),
  add column length_cm    numeric(6,2) check (length_cm is null or length_cm > 0),
  add column breadth_cm   numeric(6,2) check (breadth_cm is null or breadth_cm > 0),
  add column height_cm    numeric(6,2) check (height_cm is null or height_cm > 0);

comment on column public.products.weight_grams is
  'Shipped weight of one pair in its box. On the product rather than the variant: '
  'within a single model the difference between a UK 5 and a UK 12 is well inside '
  'a courier''s 500g slab, and asking a shop owner to type four numbers twelve '
  'times per product guarantees the fields stay empty. Null falls back to the '
  'shipping_defaults row in site_settings.';
comment on column public.products.length_cm is 'Box length. See weight_grams.';

-- Nothing is blocked on the owner filling these in: a null reads through to the
-- default below, so the first shipment can be created before anybody has
-- measured anything.
--
-- is_public = false deliberately. Nothing in a browser needs the shop's pickup
-- PIN, which is why src/lib/shipping/quote.ts reads this row with the service
-- role rather than through cachedSiteSettings() — that reader filters on
-- is_public and would silently return the hardcoded fallback forever.
insert into public.site_settings (key, value, description, is_public)
values (
  'shipping_defaults',
  jsonb_build_object(
    'weight_grams', 900,
    'length_cm', 33,
    'breadth_cm', 22,
    'height_cm', 13,
    'pickup_postcode', '560001'
  ),
  'Parcel weight and box size used when a product has none of its own, plus the pickup PIN code serviceability is quoted from.',
  false
)
on conflict (key) do nothing;
