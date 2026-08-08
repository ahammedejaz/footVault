create or replace function public.record_inventory_movement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_ref    text;
  v_actor  text;
  v_note   text;
begin
  -- `after update of stock_quantity` still fires when the column is in the SET
  -- list but unchanged, so the real test is the value, not the statement.
  if new.stock_quantity is not distinct from old.stock_quantity then
    return new;
  end if;

  v_reason := nullif(current_setting('app.inventory_reason',    true), '');
  v_ref    := nullif(current_setting('app.inventory_reference', true), '');
  v_actor  := nullif(current_setting('app.inventory_actor',     true), '');
  v_note   := nullif(current_setting('app.inventory_note',      true), '');

  insert into public.inventory_movements
    (variant_id, variant_sku, delta, balance_after, reason, reference_id, actor, note)
  values (
    new.id,
    new.sku,
    new.stock_quantity - old.stock_quantity,
    new.stock_quantity,
    coalesce(v_reason, 'unspecified')::public.inventory_movement_reason,
    v_ref::uuid,
    coalesce(v_actor::uuid, auth.uid()),
    v_note
  );

  return new;
end;
$$;

comment on function public.record_inventory_movement() is
  'The only writer of inventory_movements. SECURITY DEFINER so it can write a table '
  'no role holds INSERT on. Attribution arrives through four transaction-local GUCs '
  'set by the caller: app.inventory_reason / _reference / _actor / _note. They MUST '
  'be set with set_config(..., true) — is_local = false would leak the last request''s '
  'attribution onto the next one over a pooled connection. An unset reason records '
  'itself as ''unspecified'' rather than failing the write, because refusing to move '
  'stock is worse than recording it as unattributed; reconcile_inventory() surfaces it. '
  'A malformed reason or reference does raise, so a typo is found the first time it runs.';

create trigger product_variants_record_movement
  after update of stock_quantity on public.product_variants
  for each row execute function public.record_inventory_movement();
