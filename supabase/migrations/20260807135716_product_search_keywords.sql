-- =============================================================================
-- 0015 · What a customer calls it
--
-- Searching "running" returned nothing. The copy for the Pegasus, the Nimbus
-- and the Adizero is written the way a runner talks — "trainer", "tempo",
-- "race", "daily kilometres" — and never uses the word. Loosening the matcher
-- until "running" reached them would have loosened it for everything else too.
--
-- A keyword list per product is the honest fix, and it is a column the owner
-- edits from /admin/products in Phase 6 rather than a synonym table baked into
-- a function nobody outside this repo can open. Seeded per footwear type;
-- "chappal" is in there because that is what half of India would type.
-- =============================================================================

alter table public.products
  add column if not exists search_keywords text[] not null default '{}';

comment on column public.products.search_keywords is
  'Words a customer might search that the product copy does not use — "running" for a trainer, "chappal" for a slide. Seeded per footwear type; editable per product.';

update public.products set search_keywords = case footwear_type
  when 'sports'   then array['running','runner','trainer','training','gym','jogging','workout','marathon']
  when 'sneaker'  then array['casual','trainers','lifestyle','everyday','street']
  when 'formal'   then array['office','dress','wedding','oxford','derby','business']
  when 'boot'     then array['ankle','hiking','outdoor','trekking','winter']
  when 'sandal'   then array['chappal','monsoon','summer','open','strappy']
  when 'slide'    then array['chappal','monsoon','pool','beach','slipper','sliders']
  when 'flipflop' then array['chappal','thong','beach','monsoon','slipper']
  end
where search_keywords = '{}';

create index if not exists products_search_keywords_idx
  on public.products using gin (search_keywords);
