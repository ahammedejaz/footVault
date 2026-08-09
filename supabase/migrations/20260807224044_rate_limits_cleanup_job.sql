-- Without this the table grows one row per distinct bucket forever, and buckets
-- are keyed partly by IP. An hour is comfortably longer than the longest window
-- any policy uses, so a deleted row can never be a live counter.

-- This line was added on 2026-08-09, after the fact. As originally written this
-- migration assumed pg_cron, which nothing in the set had created — production
-- had the extension enabled by hand from the dashboard, so the assumption held
-- there and nowhere else. A replay from empty died right here, at migration 33
-- of 79, with `schema "cron" does not exist` — found the first time anybody
-- built a database from this directory alone (the staging build, Batch 2).
-- Databases that have already run this migration never run it again, so the
-- edit changes nothing for them; it exists so that the migration set states its
-- own prerequisites instead of remembering production's dashboard history.
create extension if not exists pg_cron;

select cron.schedule(
  'prune-rate-limits',
  '17 * * * *',
  $$delete from public.rate_limits where window_start < now() - interval '1 hour'$$
);
