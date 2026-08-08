-- The ledger did not record a variant's opening stock, so every variant created
-- after the Phase 6 backfill broke the reconciliation it was meant to guarantee.
--
-- `record_inventory_movement` was an AFTER UPDATE trigger. A variant inserted
-- with `stock_quantity = 10` therefore had ten units and no movement rows at
-- all, and `reconcile_inventory()` counted it as drifting by ten — for ever,
-- because nothing would ever go back and write the missing opening balance.
--
-- The 370 variants that existed when the ledger was built were backfilled by
-- hand, which is why this was invisible: it only bites on the *next* variant
-- anybody creates. `npm run audit:admin` caught it as one drifting variant
-- after its own fixtures ran, and Part 1 of this phase is about to hand a shop
-- owner a form that creates variants with stock in it.
--
-- P2 §8.4 asked that **every** path which mutates stock write a movement row.
-- Creation is such a path; it was simply not one anybody had listed.
alter type public.inventory_movement_reason add value if not exists 'replacement';

create or replace function public.record_inventory_movement()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_reason text;
  v_ref    text;
  v_actor  text;
  v_note   text;
  v_delta  bigint;
begin
  if tg_op = 'INSERT' then
    -- A variant created with no stock has nothing to open a balance with, and a
    -- zero-delta row would be noise in the one table that must stay readable.
    if coalesce(new.stock_quantity, 0) = 0 then
      return new;
    end if;
    v_delta := new.stock_quantity;
  else
    -- `after update of stock_quantity` still fires when the column is in the SET
    -- list but unchanged, so the real test is the value, not the statement.
    if new.stock_quantity is not distinct from old.stock_quantity then
      return new;
    end if;
    v_delta := new.stock_quantity - old.stock_quantity;
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
    v_delta,
    new.stock_quantity,
    coalesce(
      v_reason,
      case when tg_op = 'INSERT' then 'opening_balance' else 'unspecified' end
    )::public.inventory_movement_reason,
    v_ref::uuid,
    coalesce(v_actor::uuid, auth.uid()),
    coalesce(
      v_note,
      case when tg_op = 'INSERT' then 'Opening stock on creation' else null end
    )
  );

  return new;
end;
$function$;

create trigger product_variants_record_opening
  after insert on public.product_variants
  for each row execute function public.record_inventory_movement();
