create table public.shipments (
  id                   uuid primary key default gen_random_uuid(),
  -- One shipment per order, enforced by the database rather than by the action
  -- that creates it. A double-click, a retry after a timeout, or two admins on
  -- two tablets all reduce to the same 23505 here, which is the only reason
  -- "create shipment" can be safely idempotent.
  order_id             uuid not null unique references public.orders(id) on delete cascade,
  shiprocket_order_id  text,
  shipment_id          text,
  awb_code             text,
  courier_name         text,
  courier_id           text,
  status               text not null default 'created',
  label_url            text,
  manifest_url         text,
  invoice_url          text,
  pickup_scheduled_at  timestamptz,
  pickup_token         text,
  -- Whatever Shiprocket said, kept verbatim. When a courier dispute happens six
  -- weeks later, the parsed columns are what we believed and this is what we
  -- were told, and only one of those is evidence.
  raw_order            jsonb,
  raw_awb              jsonb,
  raw_pickup           jsonb,
  raw_tracking         jsonb,
  tracked_at           timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index shipments_awb_idx on public.shipments (awb_code) where awb_code is not null;
create index shipments_status_idx on public.shipments (status);

create trigger shipments_set_updated_at
  before update on public.shipments
  for each row execute function public.set_updated_at();

create table public.shipment_events (
  id            uuid primary key default gen_random_uuid(),
  shipment_id   uuid not null references public.shipments(id) on delete cascade,
  event_id      text not null,
  event_type    text not null,
  payload       jsonb,
  created_at    timestamptz not null default now(),
  -- The same discipline as payment_events: a unique key that an insert claims
  -- before any work is done, so a redelivered or double-submitted event loses
  -- with 23505 instead of being deduplicated by a check-then-act.
  unique (shipment_id, event_id)
);

create index shipment_events_shipment_idx on public.shipment_events (shipment_id, created_at desc);

comment on table public.shipments is
  'One row per order that has been handed to Shiprocket. Every fulfilment step '
  'writes to this row and reads it back before acting, which is what makes each '
  'step idempotent: the state is in the database, not in the button.';
comment on table public.shipment_events is
  'Every tracking update and fulfilment step we have recorded, keyed for idempotency.';
