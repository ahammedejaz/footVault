create or replace function public.reconcile_inventory()
returns table (
  variant_id      uuid,
  sku             text,
  stock_quantity  integer,
  ledger_total    bigint,
  drift           bigint,
  unspecified_rows bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select v.id,
         v.sku,
         v.stock_quantity,
         coalesce(sum(m.delta), 0)::bigint,
         (coalesce(sum(m.delta), 0) - v.stock_quantity)::bigint,
         count(*) filter (where m.reason = 'unspecified')::bigint
    from public.product_variants v
    left join public.inventory_movements m on m.variant_id = v.id
   group by v.id, v.sku, v.stock_quantity
  having coalesce(sum(m.delta), 0) <> v.stock_quantity
      or count(*) filter (where m.reason = 'unspecified') > 0
   order by abs(coalesce(sum(m.delta), 0) - v.stock_quantity) desc, v.sku;
$$;

comment on function public.reconcile_inventory() is
  'Returns one row per variant whose ledger disagrees with its stock, or that has '
  'an unattributed movement. An empty result is the pass condition — a quality gate '
  'this phase reports as a number. A non-empty result means either a write bypassed '
  'the trigger (impossible through Postgres, possible through a restore) or a caller '
  'failed to declare its reason.';

revoke execute on function public.reconcile_inventory() from anon, authenticated;
grant execute on function public.reconcile_inventory() to service_role;
