-- =============================================================================
-- 0012 · Catalog schema for the storefront build
--
-- Three additions the Phase 3 screens need from the database rather than from
-- the client.
-- =============================================================================

-- A colourway's own photography. Until now every product had one hero and one
-- outsole regardless of how many colours it came in, so the swatches on the
-- product page could not change the gallery. NULL means "applies to every
-- colourway", which is what an owner's first upload will be.
alter table public.product_images add column if not exists color text;

create index if not exists product_images_color_idx
  on public.product_images (product_id, color, sort_order);

-- Search reaches the brand name too — "nike" has to find the Air Max, whose
-- name does not contain it — so the brand name needs the trigram support the
-- product name already has.
create index if not exists brands_name_trgm_idx
  on public.brands using gin (name extensions.gin_trgm_ops);

-- Facet counting groups variants by size and by colour within a product set.
create index if not exists product_variants_facet_idx
  on public.product_variants (product_id, size, color) include (stock_quantity)
  where is_active;
