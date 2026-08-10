-- Phase 11 · Batch 0.4 — who asserted that this order was delivered.
--
-- `orders.delivered_at` answers "when". This column answers "on whose word":
-- 'courier' means the timestamp was parsed out of Shiprocket's own tracking
-- activity by `fetchTracking`; 'admin' means the owner pressed the button and
-- the clock started at that press.
--
-- It is NOT a second delivery signal — nothing branches on it for
-- correctness, and exactly one field still answers "when". It exists because
-- two conversations need it: a customer disputing the 24-hour damage window
-- deserves to know whether the clock started when the courier said so or when
-- the shop clicked, and a coin credit that turns out to be wrong (Batch B
-- hangs money on this event) must be traceable to the assertion that caused
-- it. Without it, "delivered Tuesday" is unfalsifiable.
--
-- Nullable, and null on every historical row honestly: no order in this
-- shop's history has ever been delivered (Phase 11 audit, 11B), so there is
-- nothing to backfill and a backfilled guess would be exactly the kind of
-- invented evidence the column exists to prevent.

alter table public.orders
  add column delivered_source text
  check (delivered_source in ('courier', 'admin'));

comment on column public.orders.delivered_source is
  'Who asserted delivery: ''courier'' (parsed from Shiprocket tracking by '
  'fetchTracking) or ''admin'' (the owner''s button, stamped by '
  'transitionOrder). Set beside delivered_at, never without it. Not a second '
  'signal: delivered_at alone answers "when".';
