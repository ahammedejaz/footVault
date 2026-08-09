-- Phase 8 · P0-a2, second half: what calls the reconciler every ten minutes.
--
-- WHY NOT VERCEL CRON, which the plan assumed. The Vercel team is on the Hobby
-- plan, and Hobby's minimum cron interval is once per day — a sub-daily cron
-- expression does not degrade, it fails the deployment. Measured, not guessed:
-- GET /v2/teams/<id> returns billing plan "hobby". A reconciler whose job is to
-- rescue a charged customer before a 10-minute sweep cancels them is worth
-- nothing at one run a day, ±59 minutes.
--
-- WHY NOT A SUPABASE EDGE FUNCTION, which was the alternative offered. It works,
-- but it would mean reimplementing `recordAndApply` in Deno — the seam whose
-- unique constraint on (provider, event_id) is the only thing stopping a
-- reconciled payment and its later webhook from both applying. Two
-- implementations of "apply a payment to an order", in two languages, is how
-- they drift, and the failure mode is double-applying real money. It would also
-- put the live Razorpay key in a second secret store.
--
-- So: pg_cron schedules, pg_net calls, and the reconciler stays in the app
-- where it shares the exact seam the webhook uses. One implementation.
--
-- WHAT IS NOT IN THIS FILE: the secret. Migrations are committed to git. The
-- vault entries are created by hand, once, per environment — see the block at
-- the bottom.

-- No `with schema`, deliberately. pg_net is non-relocatable and its install
-- script creates its own `net` schema; naming a different one is how this line
-- fails at apply time. Verified against pg_available_extension_versions:
-- relocatable = false, schema = null.
create extension if not exists pg_net;

/**
 * Ask the app to reconcile abandoned orders.
 *
 * `security definer` because `vault.decrypted_secrets` and `net.http_post` are
 * not readable or callable by the roles PostgREST exposes, and they must stay
 * that way — this function is the only door, it takes no arguments, and there
 * is nothing a caller could pass to redirect where it posts.
 */
create or replace function private.trigger_order_reconciler()
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_secret text;
  v_origin text;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'cron_secret';
  select decrypted_secret into v_origin
    from vault.decrypted_secrets where name = 'cron_target_origin';

  -- Raised, not warned, and deliberately noisy. A missing secret means the
  -- reconciler is not running, which is the exact silent failure this whole
  -- change exists to remove. pg_cron records the exception in
  -- cron.job_run_details, so "it stopped working" becomes a query rather than a
  -- discovery six weeks later.
  if v_secret is null or v_origin is null then
    raise exception
      'trigger_order_reconciler: vault is missing cron_secret or cron_target_origin. '
      'The abandoned-order reconciler is NOT running. See the bottom of '
      'supabase/migrations/20260809030100_schedule_order_reconciler.sql.';
  end if;

  -- Fire and forget. pg_net queues the request and returns an id; the response
  -- lands in net._http_response and nothing here waits for it. That is the
  -- right shape for a reconciler — the work is idempotent, so a lost response
  -- costs one wasted tick — but it does mean this function returning cleanly
  -- proves only that the request was *queued*. Whether the route ran is
  -- answered by the webhook-liveness tile on the admin dashboard, not here.
  perform net.http_post(
    url := v_origin || '/api/cron/release-abandoned-orders',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_secret,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$function$;

revoke all on function private.trigger_order_reconciler() from public, anon, authenticated;

comment on function private.trigger_order_reconciler() is
  'Called by pg_cron every 10 minutes. POSTs to the app''s reconciler route with '
  'the bearer token from Vault. Raises if the Vault entries are missing, so a '
  'silently unconfigured reconciler shows up in cron.job_run_details.';

-- Every 10 minutes, matching the sweep it works alongside. `cron.schedule`
-- upserts on the job name, so re-running this migration re-points the job
-- rather than duplicating it — no unschedule needed, and adding one would be a
-- second statement that can fail for its own reasons.
select cron.schedule(
  'reconcile-abandoned-orders',
  '*/10 * * * *',
  $$select private.trigger_order_reconciler()$$
);

-- ---------------------------------------------------------------------------
-- MANUAL STEP, once per environment. Not in this file because it is committed.
--
--   select vault.create_secret('<the CRON_SECRET from Vercel>', 'cron_secret');
--   select vault.create_secret('https://www.footvault.in', 'cron_target_origin');
--
-- The same value must be set as CRON_SECRET in the Vercel project, because the
-- route compares against it. To rotate: change it in Vercel, redeploy, then
--
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'cron_secret'), '<new value>');
--
-- Rotate in that order. The reverse leaves every tick 401ing until the deploy
-- catches up, and the reconciler is the thing that stops paid orders being
-- cancelled.
-- ---------------------------------------------------------------------------
