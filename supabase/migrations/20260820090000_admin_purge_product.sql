-- The owner's "delete it from the database for good", as a function that can
-- say no.
--
-- ## Why `admin_delete_product` was not enough
--
-- That function decides for the caller: a product that has never been ordered
-- is dropped, and one that appears on an order is soft-deleted, because the
-- order would otherwise lose its link back to the product and "what did we sell
-- of this" stops being answerable. That reasoning is still right, and it is
-- still the default — nothing about `admin_delete_product` changes here.
--
-- What it missed is that the owner is allowed to want the other thing. A
-- product created by mistake, a duplicate, a test row from a demo, a line the
-- shop no longer carries and does not want in its reports: for those, "hidden
-- forever, restorable, still counted" is not a kindness, it is a drawer full of
-- rubbish that cannot be emptied. The panel offered no way to empty it, and the
-- owner asked for one in as many words.
--
-- So this is the second door, and it is deliberately a *separate function*
-- rather than a boolean on the first. `admin_delete_product(id)` cannot be
-- made to do this by accident or by a forgotten argument; a caller that wants
-- destruction has to name it.
--
-- ## What survives, and why the orders are genuinely safe
--
-- `order_items.product_id` is `on delete set null` and every line carries its
-- own snapshot — `product_name`, `product_slug`, `size`, `color`, `sku`,
-- `unit_price`, `quantity`, `line_total`, `image_url`. So an old invoice still
-- renders exactly as it did: same name, same size, same price, same picture.
-- Not one rupee of order history moves.
--
-- What is lost is the *join*. `order_items.product_id` goes null, so a report
-- that groups sales by product can no longer attribute those lines, and
-- re-creating a product with the same name will not re-adopt them. That is a
-- real cost and it is the reason this asks a second time in the panel rather
-- than sitting next to the ordinary delete.
--
-- Everything else about the product cascades and should: variants, images,
-- reviews, and collection membership. `inventory_movements.variant_id` is
-- `on delete set null`, so the stock ledger keeps its rows and loses its
-- pointer, which is the same bargain as the order lines.
--
-- ## The return value
--
-- The image URLs come back with the verdict because the objects in the storage
-- bucket are the one thing the database cannot cascade. The caller removes
-- them; a failure there is a few orphaned kilobytes rather than a broken page,
-- which is the same trade `deleteProductImage` already makes.

create or replace function public.admin_purge_product(p_product_id uuid)
returns table (outcome text, order_lines integer, image_urls text[])
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lines  integer := 0;
  v_urls   text[]  := array[]::text[];
begin
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = 'FVADM';
  end if;

  if not exists (select 1 from public.products where id = p_product_id) then
    outcome := 'not_found';
    order_lines := 0;
    image_urls := array[]::text[];
    return next;
    return;
  end if;

  -- Read before the delete. Afterwards the rows are gone and the caller has
  -- nothing left to clean up in storage with.
  select coalesce(array_agg(pi.url), array[]::text[])
    into v_urls
    from public.product_images pi
   where pi.product_id = p_product_id;

  -- Reported so the panel can tell the owner what it cost, in the past tense,
  -- after the fact. The panel also quotes this figure *before* the fact, from
  -- its own read — this one is the number that was actually true at the moment
  -- the rows were unlinked.
  select count(*) into v_lines
    from public.order_items oi
   where oi.product_id = p_product_id;

  delete from public.products where id = p_product_id;

  outcome := 'purged';
  order_lines := v_lines;
  image_urls := v_urls;
  return next;
end;
$$;

comment on function public.admin_purge_product(uuid) is
  'Hard-deletes a product whatever its order history, unlinking (never '
  'deleting) the order lines that referenced it — every line keeps its own '
  'name/size/price snapshot, so old invoices still render. Returns the image '
  'URLs so the caller can clear the storage bucket. This is the deliberate '
  'second door; admin_delete_product remains the default and still soft-deletes '
  'anything that has been ordered.';

-- Grants restated in the same migration as the definition. A function created
-- here starts with EXECUTE granted to PUBLIC, and a `create or replace` at a
-- new arity is a *new* function rather than a replacement — so an ACL set in
-- some earlier migration would not carry over. This is the trap that shipped a
-- publicly-callable admin function once already.
revoke execute on function public.admin_purge_product(uuid) from public, anon;
grant execute on function public.admin_purge_product(uuid) to authenticated;
