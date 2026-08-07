-- =============================================================================
-- 0016 · Where a discontinued product used to live
--
-- A 404 on a product that used to exist should send the customer to the shelf
-- it came off, not to a dead end. The row itself is hidden from anon by RLS —
-- that is the point of deactivating it — so this reaches past the policy to
-- return three fields and nothing else.
--
-- SECURITY DEFINER is doing real work here and the signature is scoped to
-- match: it answers only for a slug the caller already typed, returns no price,
-- no stock, no id, and cannot enumerate — there is no way to ask it "what else
-- is hidden".
-- =============================================================================

create or replace function public.discontinued_product_hint(p_slug text)
returns table (name text, category_slug text, category_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.name, c.slug, c.name
    from public.products p
    left join public.categories c on c.id = p.category_id and c.is_active
   where p.slug = p_slug
     and (p.is_active = false or p.deleted_at is not null)
   limit 1;
$$;

comment on function public.discontinued_product_hint is
  'Name and category for a product slug that is no longer on sale, so the 404 page can offer the category it belonged to. Deliberately narrow: one slug in, three fields out, no enumeration.';

revoke execute on function public.discontinued_product_hint(text) from public;
grant execute on function public.discontinued_product_hint(text) to anon, authenticated;
