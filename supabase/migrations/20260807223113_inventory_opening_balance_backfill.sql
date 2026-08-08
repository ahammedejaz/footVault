-- The ledger has to reconcile from its first day, so every variant's stock as it
-- stands right now becomes an opening balance. This is deliberately a direct
-- insert and not a stock movement: nothing physically moved, we are only
-- recording where the count started. Variants at zero get no row — sum(delta)
-- over the empty set is 0, which already reconciles, and delta <> 0 forbids it.
insert into public.inventory_movements
  (variant_id, variant_sku, delta, balance_after, reason, actor, note)
select v.id, v.sku, v.stock_quantity, v.stock_quantity, 'opening_balance', null,
       'Phase 6 backfill: stock as counted when the ledger was created'
  from public.product_variants v
 where v.stock_quantity <> 0;
