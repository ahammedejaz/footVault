-- =============================================================================
-- 0017 · catalog_query() — a listing page in one round trip
--
-- Phase 1's listing issued two to four round trips and, whenever a size or
-- colour filter was on, pulled *every* matching product id into Node before
-- paginating — a list that grows with the catalog for a page that shows twelve.
-- It also had no facet counts, so "Black (12)" was unbuildable and a filter
-- leading nowhere looked identical to one leading somewhere.
--
-- This returns the ids for the requested page, the exact total, and the count
-- behind every facet option. The page then reads those twelve rows with their
-- embeds; two queries, whatever the filters.
--
-- Three rules the body encodes:
--
--   1. A facet is counted with its own selections lifted. Counting "Black"
--      while Black is selected would report the current result count against
--      every colour, which is how faceted search stops helping. `marked`
--      evaluates each predicate into a flag so every combination is one AND.
--
--   2. Picking a size means "sold to me, today" — size and in-stock narrow to
--      variants with stock. Colour does not: a customer browsing Brown should
--      see the sold-out tan pair struck through rather than not at all, which
--      is the same honesty the size run on every card is built on.
--
--   3. Search is AND over words, so "nike sandal" is not every sandal. A word
--      lands if it matches the name, brand, category, parent category, gender,
--      footwear type, material, description, a colourway, or the product's
--      search_keywords — by substring, by trigram, or, for brands only, within
--      two edits. Filler words ("shoes", "for", "my") are dropped, unless
--      filler is all that was typed.
--
-- SECURITY INVOKER on purpose: RLS runs inside, so this cannot return a row the
-- caller could not have read through PostgREST directly.
--
-- Note on history: `supabase_migrations.schema_migrations` on the live project
-- records several supersessions of this function from the Phase 3 build
-- (catalog_query_fn, _color_family, _token_search, _search_body, _keywords,
-- _stopwords, _color_gender_search). They are collapsed here because a reader
-- wants the function, not the eight drafts of it; this file is the state all of
-- them add up to.
-- =============================================================================

create or replace function public.catalog_query(
  p_category_slug text default null, p_collection_slug text default null,
  p_gender public.gender_group default null, p_type public.footwear_type default null,
  p_brands text[] default null, p_sizes text[] default null, p_colors text[] default null,
  p_min_price bigint default null, p_max_price bigint default null,
  p_in_stock boolean default false, p_on_sale boolean default false,
  p_search text default null, p_sort text default 'newest',
  p_limit integer default 12, p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path = '' as $$
with args as (
  select nullif(p_sizes,'{}'::text[]) as sizes, nullif(p_colors,'{}'::text[]) as colors,
         nullif(p_brands,'{}'::text[]) as brands, nullif(btrim(coalesce(p_search,'')),'') as q,
         greatest(coalesce(p_limit,12),1) as lim, greatest(coalesce(p_offset,0),0) as off),
raw_tokens as (select lower(btrim(t)) as t
  from args a, unnest(string_to_array(coalesce(a.q,''), ' ')) as t where btrim(t) <> ''),
tokens as (
  select t from raw_tokens where t <> all (array['shoe','shoes','footwear','pair','pairs','for','and','the','with','of','in','a','an','my','me'])
  union all
  select t from raw_tokens where not exists (select 1 from raw_tokens r
    where r.t <> all (array['shoe','shoes','footwear','pair','pairs','for','and','the','with','of','in','a','an','my','me']))),
scope as (select c.id from public.categories c where p_category_slug is not null
  and (c.slug = p_category_slug or c.parent_id = (select id from public.categories where slug = p_category_slug and is_active))),
in_collection as (select cp.product_id from public.collection_products cp
  join public.collections col on col.id = cp.collection_id and col.is_active where col.slug = p_collection_slug),
candidate as (
  select p.id, p.brand_id, p.gender, p.footwear_type, p.effective_price, p.sale_price, p.created_at,
    case when a.q is null then 0::real
         when p.name ilike '%'||a.q||'%' then 1::real
         when coalesce(b.name,'') ilike '%'||a.q||'%' then 0.95::real
         else greatest(extensions.similarity(p.name, a.q),
                       extensions.word_similarity(a.q, p.name),
                       extensions.similarity(coalesce(b.name,''), a.q) * 0.9::real) end as rank
  from public.products p cross join args a
  left join public.brands b on b.id = p.brand_id
  left join public.categories c on c.id = p.category_id
  left join public.categories pc on pc.id = c.parent_id
  where p.is_active and p.deleted_at is null
    and (p_category_slug is null or p.category_id in (select id from scope))
    and (p_collection_slug is null or p.id in (select product_id from in_collection))
    and (p_type is null or p.footwear_type = p_type)
    and (a.q is null or not exists (
      select 1 from tokens tk where not (
        p.name ilike '%'||tk.t||'%'
        or coalesce(b.name,'') ilike '%'||tk.t||'%'
        or coalesce(c.name,'') ilike '%'||tk.t||'%'
        or coalesce(pc.name,'') ilike '%'||tk.t||'%'
        or p.footwear_type::text ilike '%'||tk.t||'%'
        or p.gender::text ilike '%'||tk.t||'%'
        or tk.t ilike p.gender::text || '%'
        or coalesce(p.description,'') ilike '%'||tk.t||'%'
        or coalesce(p.material,'') ilike '%'||tk.t||'%'
        or exists (select 1 from unnest(p.search_keywords) k where k ilike tk.t || '%')
        or exists (select 1 from public.product_variants v where v.product_id = p.id
                     and v.is_active and (v.color ilike '%'||tk.t||'%' or v.color_family ilike tk.t))
        or extensions.similarity(p.name, tk.t) > 0.28
        or extensions.word_similarity(tk.t, p.name) > 0.5
        or extensions.similarity(coalesce(b.name,''), tk.t) > 0.4
        or (length(tk.t) >= 4 and b.name is not null
            and extensions.levenshtein(lower(b.name), tk.t) <= 2)))))
,
by_size as (select distinct v.product_id from public.product_variants v, args a
  where v.is_active and v.stock_quantity > 0 and v.size = any(a.sizes)),
by_color as (select distinct v.product_id from public.product_variants v, args a
  where v.is_active and v.color_family = any(a.colors) and (not p_in_stock or v.stock_quantity > 0)),
by_stock as (select distinct v.product_id from public.product_variants v where v.is_active and v.stock_quantity > 0),
marked as (select c.*,
  (a.brands is null or c.brand_id in (select id from public.brands where slug = any(a.brands))) as ok_brand,
  (p_gender is null or c.gender = p_gender) as ok_gender,
  (not p_on_sale or c.sale_price is not null) as ok_sale,
  (a.sizes is null or c.id in (select product_id from by_size)) as ok_size,
  (a.colors is null or c.id in (select product_id from by_color)) as ok_color,
  (not p_in_stock or c.id in (select product_id from by_stock)) as ok_stock,
  ((p_min_price is null or c.effective_price >= p_min_price) and
   (p_max_price is null or c.effective_price <= p_max_price)) as ok_price
  from candidate c cross join args a),
hit as (select * from marked where ok_brand and ok_gender and ok_sale and ok_size and ok_color and ok_stock and ok_price),
no_size as (select * from marked where ok_brand and ok_gender and ok_sale and ok_color and ok_stock and ok_price),
no_color as (select * from marked where ok_brand and ok_gender and ok_sale and ok_size and ok_stock and ok_price),
no_brand as (select * from marked where ok_gender and ok_sale and ok_size and ok_color and ok_stock and ok_price),
no_gender as (select * from marked where ok_brand and ok_sale and ok_size and ok_color and ok_stock and ok_price),
no_avail as (select * from marked where ok_brand and ok_gender and ok_size and ok_color and ok_price),
no_price as (select * from marked where ok_brand and ok_gender and ok_sale and ok_size and ok_color and ok_stock),
page as (select h.id from hit h, args a order by
  case when p_sort = 'relevance' then h.rank end desc nulls last,
  case when p_sort = 'price-asc' then h.effective_price end asc nulls last,
  case when p_sort = 'price-desc' then h.effective_price end desc nulls last,
  case when p_sort not in ('relevance','price-asc','price-desc') then h.created_at end desc nulls last,
  h.id offset (select off from args) limit (select lim from args))
select jsonb_build_object(
 'total', (select count(*) from hit),
 'ids', coalesce((select jsonb_agg(id) from page), '[]'::jsonb),
 'facets', jsonb_build_object(
   'sizes', coalesce((select jsonb_agg(x) from (
     select jsonb_build_object('value', v.size, 'count', count(distinct s.id)) as x
     from no_size s join public.product_variants v on v.product_id = s.id and v.is_active and v.stock_quantity > 0
     group by v.size) t), '[]'::jsonb),
   'colors', coalesce((select jsonb_agg(x) from (
     select jsonb_build_object('value', v.color_family, 'count', count(distinct s.id)) as x
     from no_color s join public.product_variants v on v.product_id = s.id and v.is_active
     where v.color_family is not null and (not p_in_stock or v.stock_quantity > 0)
     group by v.color_family order by v.color_family) t), '[]'::jsonb),
   'brands', coalesce((select jsonb_agg(x) from (
     select jsonb_build_object('value', b.slug, 'label', b.name, 'count', count(s.id)) as x
     from public.brands b join no_brand s on s.brand_id = b.id
     where b.is_active group by b.slug, b.name order by b.name) t), '[]'::jsonb),
   'genders', coalesce((select jsonb_agg(x) from (
     select jsonb_build_object('value', s.gender, 'count', count(*)) as x
     from no_gender s group by s.gender order by s.gender) t), '[]'::jsonb),
   'in_stock', (select count(*) from no_avail s where s.id in (select product_id from by_stock)),
   'on_sale', (select count(*) from no_avail s where s.sale_price is not null),
   'price', jsonb_build_object('min', (select min(effective_price) from no_price),
                               'max', (select max(effective_price) from no_price))));
$$;

comment on function public.catalog_query is
  'Everything a listing page needs in one round trip: the ids for this page, the exact total, and the count behind every facet option. Each facet is counted with its own selections lifted, so a second tick widens the result set instead of emptying it.';

grant execute on function public.catalog_query(
  text, text, public.gender_group, public.footwear_type, text[], text[], text[],
  bigint, bigint, boolean, boolean, text, text, integer, integer) to anon, authenticated;
