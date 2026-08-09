-- 0029 · A lease timestamp, so a retry cannot overtake a forward in progress
--
-- 0028 made `email_id` the idempotency key and treated the row's existence as
-- proof the message was handled. That was wrong in the way recorded in the
-- route: an idempotency key must record having *succeeded*, not having been
-- seen. Three real messages on 2026-08-09 were claimed, failed to forward while
-- the API key could not read message bodies, and could never be recovered —
-- every replay hit the duplicate branch and answered 200 without sending.
--
-- The fix lets a redelivery take over a claim whose forward never completed.
-- That needs an answer to "how long has this attempt been running", and
-- `received_at` cannot give it: it records when the *message* arrived and never
-- moves, so every delivery after the first five minutes would find the row
-- stale and take it — including one arriving while another request was still
-- mid-forward. Both would send. That is the double delivery the table exists to
-- prevent, reintroduced by the mechanism meant to fix the opposite bug. It was
-- caught in staging by redelivering twice in a row and watching the second take
-- a claim the first was still holding.
--
-- So the lease is its own column and the takeover advances it. `received_at`
-- keeps its meaning, which also keeps the support question ("when did this
-- arrive") answerable.
--
-- Backfilled to `received_at` rather than to now(): the rows that exist are the
-- three stuck ones, they are hours old, and they should be takeable by the
-- first replay rather than waiting out a fresh lease they never had.
-- =============================================================================

alter table public.inbound_emails
  add column last_attempt_at timestamptz;

update public.inbound_emails
  set last_attempt_at = received_at
  where last_attempt_at is null;

alter table public.inbound_emails
  alter column last_attempt_at set default now();

comment on column public.inbound_emails.last_attempt_at is
  'When a delivery last claimed this row and began forwarding. The lease: a redelivery may take the claim over only when this is older than the lease window AND forwarded_at is null. Distinct from received_at, which records when the message arrived and never moves — using that as the lease lets a retry overtake a forward still in progress and send twice.';

-- The queue a human reads after a mail outage, now ordered by the attempt
-- rather than by arrival: "what has been stuck longest without succeeding".
drop index if exists public.inbound_emails_unforwarded_idx;
create index inbound_emails_unforwarded_idx
  on public.inbound_emails (last_attempt_at desc)
  where forwarded_at is null;
