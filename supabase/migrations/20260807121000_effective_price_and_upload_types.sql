-- =============================================================================
-- 0011 · Sortable price, and tighter upload types
--
-- Two things the storefront work surfaced.
--
-- 1. "Sort by price" has to sort on what the customer actually pays, which is
--    sale_price when there is one and base_price otherwise. PostgREST cannot
--    order by an expression, and doing it in the client would mean sorting one
--    page of results rather than the whole catalog — the second page would
--    contain cheaper items than the first. A stored generated column makes the
--    real sort key a plain, indexable column.
--
-- 2. product-images accepted image/svg+xml. Combined with Next's
--    `dangerouslyAllowSVG` (which the seed's drawn assets need), an admin
--    upload could carry script. Photographs are never SVG, so the format comes
--    off the list for the two photographic buckets and stays only on
--    site-assets, where a vector logo is the whole point.
-- =============================================================================

alter table public.products
  add column effective_price bigint
  generated always as (coalesce(sale_price, base_price)) stored;

comment on column public.products.effective_price is
  'What the customer pays: sale_price when set, otherwise base_price. Generated, so it cannot drift from the two columns it derives from.';

-- Cheapest-first and dearest-first over the live catalog, which is the only
-- set the storefront ever sorts.
create index products_effective_price_idx
  on public.products (effective_price)
  where is_active and deleted_at is null;

update storage.buckets
   set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/avif']
 where id in ('product-images', 'category-images');
