-- Without this the table grows one row per distinct bucket forever, and buckets
-- are keyed partly by IP. An hour is comfortably longer than the longest window
-- any policy uses, so a deleted row can never be a live counter.
select cron.schedule(
  'prune-rate-limits',
  '17 * * * *',
  $$delete from public.rate_limits where window_start < now() - interval '1 hour'$$
);
