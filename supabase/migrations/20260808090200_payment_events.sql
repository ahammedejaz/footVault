-- =============================================================================
-- 0017 · Payment events — the idempotency mechanism, written down
--
-- Razorpay retries webhooks. Not "may retry": will. A `payment.captured` for
-- one order arrives two, three, five times, in any order relative to the
-- browser's success callback, and every one of those deliveries is a valid,
-- correctly-signed request that a naive handler would act on.
--
-- `unique (provider, event_id)` is the whole defence, and it is a *constraint*
-- rather than a check-then-insert because a check-then-insert is a race. The
-- webhook route inserts here first, before it looks at an order; a 23505 means
-- some other delivery of this same event already owns the work, so this one
-- returns "duplicate" and does nothing. Two simultaneous deliveries cannot both
-- win, because Postgres will not let them.
--
-- The row is also the audit trail: received_at says we saw it, processed_at
-- says we finished acting on it, and a row with a null processed_at is a
-- handler that crashed mid-flight and is worth looking at.
--
-- No customer-facing policy, same as public.payments. See 0018.
-- =============================================================================

create table public.payment_events (
  id          uuid primary key default gen_random_uuid(),
  provider    public.payment_provider not null,
  -- The idempotency key, derived by the provider adapter as
  -- "<event type>:<entity id>" — payment.captured:pay_ABC. It names the state
  -- change rather than the delivery, so a manual resend from the provider
  -- dashboard collapses onto the same row instead of being reprocessed.
  -- (Comment corrected after the fact: an earlier version of this line said the
  -- key was Razorpay's x-razorpay-event-id header. It never was, and it must
  -- not become that — see 20260808090800_payment_event_id_meaning.sql, which
  -- carries the reasoning and sets the column comment in the database. Only
  -- this comment changed; the DDL is byte-identical to what was applied.)
  event_id    text not null,
  event_type  text not null,
  -- Nullable, and no foreign key: an event may arrive for an order we cannot
  -- resolve (a stale test key, another integration pointed at this endpoint),
  -- and that is a thing to record rather than a thing to reject with a 500 that
  -- makes the provider retry forever.
  order_id    uuid,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  -- What we decided. 'applied', 'duplicate', 'not_found', 'illegal_transition'
  -- or an error tag. Free text on purpose: this is a log, not a state machine.
  result      text,
  constraint payment_events_unique_per_provider unique (provider, event_id)
);

comment on table public.payment_events is
  'Every payment webhook we have seen. unique (provider, event_id) is the idempotency key: a 23505 on insert means the event is already being handled.';
comment on column public.payment_events.processed_at is
  'Set when handling finished. Null on a row with a result means the handler died mid-event.';

-- Support asks "what happened to this order"; the answer is this index.
create index payment_events_order_id_idx on public.payment_events (order_id, received_at desc)
  where order_id is not null;

-- Unprocessed events, newest first — the queue a human looks at after an outage.
create index payment_events_unprocessed_idx on public.payment_events (received_at desc)
  where processed_at is null;
