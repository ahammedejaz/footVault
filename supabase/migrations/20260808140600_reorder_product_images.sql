-- Phase 7 · A4. "Make main" reported no change and reordering errored.
--
-- The cause is a partial unique index doing exactly its job at exactly the
-- wrong moment. `product_images_one_primary_idx` is
-- `unique (product_id) where is_primary`, and the admin action wrote the whole
-- gallery back as ONE multi-row upsert with `is_primary: index === 0`. Postgres
-- checks a unique index per row as it is written, not at statement end, so the
-- moment the new primary lands before the old one has been cleared there are
-- two rows with `is_primary` and the write is rejected 23505 — taking the
-- reorder down with it. Reproduced against this database:
--
--   set new primary, then clear old  -> BLOCKED 23505 product_images_one_primary_idx
--   clear all, then set new primary  -> succeeded
--
-- The code's own comment claimed "exactly one primary is not enforced by a
-- constraint, so it has to be enforced by construction". It is enforced by a
-- constraint, and has been since Phase 1. The comment was the bug.
--
-- Two statements in one transaction is the fix, and it has to be a function
-- rather than two PostgREST calls: between them the gallery has no primary at
-- all, and a failure in the gap would leave a product whose storefront card has
-- no photograph to lead with.
create or replace function public.reorder_product_images(
  p_product_id uuid,
  p_ids uuid[]
)
returns void
language plpgsql
security invoker
set search_path to ''
as $$
declare
  v_count integer;
begin
  -- Every id must belong to this product, and the array must be the whole
  -- gallery. A partial list would leave the omitted rows carrying stale
  -- positions, which is how two photographs end up sharing sort_order 3.
  select count(*) into v_count
    from public.product_images i
   where i.product_id = p_product_id;

  if v_count <> coalesce(array_length(p_ids, 1), 0) then
    raise exception 'gallery_mismatch'
      using errcode = 'GLRYM',
            detail = format('%s rows, %s ids', v_count, coalesce(array_length(p_ids, 1), 0));
  end if;

  if exists (
    select 1 from unnest(p_ids) as id
     where not exists (
       select 1 from public.product_images i
        where i.id = id and i.product_id = p_product_id)
  ) then
    raise exception 'gallery_mismatch' using errcode = 'GLRYM',
      detail = 'an id does not belong to this product';
  end if;

  -- Clear first. This is the whole fix.
  update public.product_images
     set is_primary = false
   where product_id = p_product_id and is_primary;

  update public.product_images i
     set sort_order = pos.ordinality - 1,
         is_primary = (pos.ordinality = 1)
    from unnest(p_ids) with ordinality as pos(id, ordinality)
   where i.id = pos.id and i.product_id = p_product_id;
end;
$$;

revoke all on function public.reorder_product_images(uuid, uuid[]) from public, anon;
-- `authenticated` only, and RLS still decides: the function is SECURITY INVOKER,
-- so the `admins manage product images` policy is re-checked on every row and a
-- signed-in customer calling this over PostgREST updates nothing.
grant execute on function public.reorder_product_images(uuid, uuid[]) to authenticated, service_role;
