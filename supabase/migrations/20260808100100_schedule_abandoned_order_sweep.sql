-- =============================================================================
-- 0024 · Run the reclaim on a schedule, inside the database
--
-- pg_cron rather than a Vercel cron route. Four reasons, in order of weight.
--
--   1. **No HTTP surface to defend.** A cron route is a public URL that has to
--      authenticate a shared secret on every request, which is one more secret
--      to rotate, one more endpoint to rate-limit, and one more thing that
--      quietly stops working when the secret is set in Production but not in
--      Preview. pg_cron needs no caller and no credential: the job runs as the
--      job's owner, inside the database, and nothing outside can invoke it.
--
--   2. **It keeps running when the app does not.** The leak is database state.
--      A bad deploy, an exhausted build minute or a rolled-back release must
--      not also stop inventory from coming back — and a route-based sweep
--      stops exactly when the shop is already having a bad day.
--
--   3. **Granularity.** Vercel's Hobby plan runs a cron at most once a day.
--      A reclaim window of thirty minutes swept once a day is not a reclaim.
--
--   4. It is versioned here, in a migration, next to the function it calls,
--      rather than in a `vercel.json` that nothing in this repo cross-checks.
--
-- The cost, stated plainly: the schedule is invisible from the app. `select *
-- from cron.job` is where it lives, and docs/database.md is where a reader is
-- told to look. That is a worse discoverability story than a file in the repo,
-- and it is the trade being made.
--
-- Every ten minutes, with **no argument** — the window is the function's own
-- default and must not be restated here, or the two will disagree the first
-- time somebody changes one of them. `cron.schedule` upserts on the job name,
-- so re-running this migration re-points the job rather than duplicating it.
-- =============================================================================

create extension if not exists pg_cron;

select cron.schedule(
  'release-abandoned-orders',
  '*/10 * * * *',
  $job$select public.release_abandoned_orders()$job$
);
