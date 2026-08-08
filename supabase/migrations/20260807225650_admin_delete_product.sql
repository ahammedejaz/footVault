create or replace function public.admin_delete_product(p_product_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_orders integer;
begin
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = 'FVADM';
  end if;

  if not exists (select 1 from public.products where id = p_product_id) then
    return 'not_found';
  end if;

  -- order_items.product_id is ON DELETE SET NULL and every line carries its own
  -- snapshot, so a hard delete would not visibly break an old order today. It
  -- would still be wrong: the order would lose its link back to the product, so
  -- "what did we sell of this" stops being answerable, and re-creating the
  -- product would not restore it. Soft delete keeps the row and the link.
  select count(*) into v_orders
    from public.order_items oi
   where oi.product_id = p_product_id;

  if v_orders > 0 then
    update public.products
       set deleted_at = coalesce(deleted_at, now()),
           is_active  = false
     where id = p_product_id;
    return 'soft_deleted';
  end if;

  -- Never ordered, so there is no history to protect. Variants, images and
  -- collection memberships cascade.
  delete from public.products where id = p_product_id;
  return 'deleted';
end;
$$;

comment on function public.admin_delete_product(uuid) is
  'Deleting a product that has ever been ordered soft-deletes it; one that has '
  'never been ordered is removed outright. The caller does not choose — the '
  'decision is a property of the data and belongs where the data is.';

revoke execute on function public.admin_delete_product(uuid) from public, anon;
grant execute on function public.admin_delete_product(uuid) to authenticated;
