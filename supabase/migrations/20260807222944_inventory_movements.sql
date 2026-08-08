create type public.inventory_movement_reason as enum (
  'opening_balance', 'order', 'cancellation', 'sweep',
  'admin_adjustment', 'restock', 'shipment', 'unspecified'
);

create table public.inventory_movements (
  id            uuid primary key default gen_random_uuid(),
  variant_id    uuid references public.product_variants(id) on delete set null,
  variant_sku   text not null,
  delta         integer not null check (delta <> 0),
  balance_after integer not null check (balance_after >= 0),
  reason        public.inventory_movement_reason not null,
  reference_id  uuid,
  actor         uuid references public.profiles(id) on delete set null,
  note          text,
  created_at    timestamptz not null default now()
);

comment on table public.inventory_movements is
  'Append-only ledger of every change to product_variants.stock_quantity. Written '
  'exclusively by the record_inventory_movement() trigger, so no path — including '
  'a hand edit in the Supabase table editor — can move stock without leaving a row. '
  'sum(delta) per variant must equal stock_quantity; reconcile_inventory() proves it.';
comment on column public.inventory_movements.variant_sku is
  'Snapshot, so the ledger stays readable after a variant is hard-deleted, the same '
  'way order_items snapshots its line.';
comment on column public.inventory_movements.balance_after is
  'stock_quantity as it stood after this movement. Makes a bypassed write visible as '
  'a discontinuity rather than only as a failed total.';
comment on column public.inventory_movements.reason is
  'opening_balance is the Phase 6 backfill. unspecified means a stock write did not '
  'declare itself via app.inventory_reason — a bug, and reconcile_inventory() reports it.';

create index inventory_movements_variant_idx
  on public.inventory_movements (variant_id, created_at desc);
create index inventory_movements_created_idx
  on public.inventory_movements (created_at desc);
create index inventory_movements_reference_idx
  on public.inventory_movements (reference_id) where reference_id is not null;
