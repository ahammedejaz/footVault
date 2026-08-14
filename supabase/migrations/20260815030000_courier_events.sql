-- Everything a courier has ever told us about a parcel, including the things we
-- could not interpret.
--
-- ## Why this table exists
--
-- Until now there was exactly one inbound courier path: a 30-minute poller that
-- examined orders already `shipped`, asked Shiprocket for tracking, and acted on
-- two patterns — /delivered/i and /rto/i. No order in this shop's history has
-- ever reached `shipped`, so it has never had a candidate and has run on
-- fixtures only. Everything else Shiprocket can say — a cancellation in their
-- portal, a lost parcel, an NDR — arrived nowhere and changed nothing.
--
-- FV-2026-00668 is what that costs: paid, packed, AWB assigned, cancelled in the
-- Shiprocket portal on 2026-08-14, and still showing a bookable pickup here with
-- the customer's money held. Nothing was broken. Nothing was told.
--
-- ## The property this table is for
--
-- **An unrecognised status is recorded and raised, never dropped.** That is the
-- whole design. We confidently understand two things a courier can say —
-- "delivered", with the timestamp that starts the 24-hour damage window, and
-- "RTO", which is the parcel coming back. Everything else is written down with
-- `needs_attention` set, appears on the dashboard, and waits for a human. A
-- status map invented from memory is how the next cancellation gets missed
-- politely instead of loudly.
--
-- ## Why it is not `shipment_events`
--
-- That table is `not null references shipments(id)`, so it structurally cannot
-- hold the row that matters most: a payload that matched no order. An event we
-- could not attribute is precisely the one somebody has to look at, and a
-- receiver that had nowhere to put it would have to choose between dropping it
-- and 500ing at the courier — which, on a webhook, means retries until the
-- portal disables the subscription.
--
-- `shipment_events` also carries no interpretation and no resolution: it is the
-- append-only record of what *we* did to a shipment. This is the record of what
-- was done *to us*, what we made of it, and whether anyone has dealt with it.

create table if not exists public.courier_events (
  id uuid primary key default gen_random_uuid(),

  -- 'webhook' for the push receiver, 'sweep' for the reconciliation cron.
  -- Text rather than an enum: both spellings are defined in TypeScript and a
  -- second definition here is a second thing to keep in step.
  source text not null,

  /**
    The idempotency key, and the reason the two inbound paths cannot disagree.

    Derived from the *normalised* transition — the parcel, the status text and
    the courier's own timestamp — and deliberately NOT from the source or from
    the raw body. A webhook retry produces the same key. A reconciliation sweep
    that discovers the same transition an hour later produces the same key and
    is absorbed as a duplicate rather than raising a second alert about the same
    parcel. Two paths, one row, one alert.
   */
  event_key text not null unique,

  -- As the courier gave them. `awb` arrives from Shiprocket as a JSON *number*
  -- and is stored here as the text we matched with — see inbound.ts.
  awb text,
  channel_order_id text,
  courier_order_id text,

  status_text text,
  status_id integer,

  /**
    The courier's own moment, resolved to an instant.

    Shiprocket sends `2021-07-02 16:41:59` with no offset and means IST. Parsed
    as UTC that is five and a half hours early, and the 24-hour damage window —
    the only remedy this shop offers — is measured from it. `timestamptz`
    because the resolution happens once, at the edge, and everything downstream
    should be reading an instant rather than re-deciding what the string meant.
   */
  status_at timestamptz,

  order_id uuid references public.orders(id) on delete set null,

  -- Which identifier actually matched: 'awb', 'channel_order_id',
  -- 'courier_order_id', or null when nothing did.
  matched_by text,

  -- What we made of it: 'delivered', 'rto', 'unknown', 'unmatched', 'stalled'.
  interpretation text not null,

  -- What we did about it: 'applied', 'no_change', 'raised'.
  outcome text not null,

  /**
    The queue. `needs_attention and resolved_at is null` is the dashboard's
    whole predicate, and the partial index below is that predicate.
   */
  needs_attention boolean not null default false,
  attention_reason text,
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,

  -- What we were actually sent. The interpretation above is what we believed it
  -- said; this is the evidence when the support ticket comes back a fortnight
  -- later, and it is the only way to write the status map we refuse to guess at.
  payload jsonb,

  received_at timestamptz not null default now()
);

comment on table public.courier_events is
  'Every inbound courier signal — webhook push and reconciliation sweep alike — '
  'with what we made of it. Deduplicated by event_key across both paths so the '
  'two can never raise two alerts about one transition. An unrecognised status '
  'is recorded with needs_attention set rather than dropped.';

create index if not exists courier_events_order_idx
  on public.courier_events (order_id, received_at desc);

-- The dashboard reads exactly this predicate, and on a healthy shop it matches
-- nothing — which is what a partial index is for.
create index if not exists courier_events_attention_idx
  on public.courier_events (received_at desc)
  where needs_attention and resolved_at is null;

alter table public.courier_events enable row level security;

-- Admins only. There is deliberately no customer policy: an unmatched payload
-- is by definition not attributable to a customer, and a raw courier body
-- carries another shop's data as readily as ours.
drop policy if exists "admins manage courier events" on public.courier_events;
create policy "admins manage courier events" on public.courier_events
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

revoke all on public.courier_events from anon, authenticated;
grant select, insert, update, delete on public.courier_events to authenticated;
