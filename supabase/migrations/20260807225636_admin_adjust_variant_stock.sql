create or replace function public.adjust_variant_stock(
  p_variant_id uuid,
  p_delta integer,
  p_reason public.inventory_movement_reason,
  p_note text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_new   integer;
begin
  -- The authorization, in the database, where a forged request cannot reach
  -- around it. This function is granted to `authenticated` precisely so that
  -- the caller's own JWT is what auth.uid() reads; calling it with the service
  -- role would make auth.uid() null and be refused here, which is deliberate.
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = 'FVADM';
  end if;

  if p_delta = 0 then
    raise exception 'zero_delta' using errcode = 'FVZRO';
  end if;

  if p_note is null or btrim(p_note) = '' then
    raise exception 'note_required' using errcode = 'FVNOT';
  end if;

  if p_reason not in ('admin_adjustment', 'restock') then
    raise exception 'bad_reason' using errcode = 'FVRSN';
  end if;

  -- Attribution first, then the write, both inside this transaction. The GUCs
  -- are transaction-local, so they cannot bleed onto the next request sharing
  -- this pooled connection.
  perform pg_catalog.set_config('app.inventory_reason', p_reason::text, true);
  perform pg_catalog.set_config('app.inventory_actor', v_actor::text, true);
  perform pg_catalog.set_config('app.inventory_note', btrim(p_note), true);
  perform pg_catalog.set_config('app.inventory_reference', '', true);

  update public.product_variants
     set stock_quantity = stock_quantity + p_delta
   where id = p_variant_id
  returning stock_quantity into v_new;

  if not found then
    raise exception 'variant_not_found' using errcode = 'FVVAR';
  end if;

  return v_new;
end;
$$;

comment on function public.adjust_variant_stock(uuid, integer, public.inventory_movement_reason, text) is
  'The only way the admin panel changes stock. A delta rather than an absolute '
  'count on purpose: two people counting the same shelf at once would overwrite '
  'each other with absolutes, whereas two deltas both land. The note is required '
  'because a stock correction without a reason is the thing this ledger exists to '
  'stop. CHECK (stock_quantity >= 0) is what refuses a negative result.';

revoke execute on function public.adjust_variant_stock(uuid, integer, public.inventory_movement_reason, text) from public, anon;
grant execute on function public.adjust_variant_stock(uuid, integer, public.inventory_movement_reason, text) to authenticated;
