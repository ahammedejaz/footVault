-- Phase 11 · Batch 0.4 — the poller that makes "delivered" real.
--
-- Until this job, `orders.delivered_at` was written by exactly one path: an
-- admin opening an order and pressing "Refresh tracking". On present
-- behaviour that is never — the column has zero non-null values across the
-- shop's entire history — which means the 24-hour damage window has been
-- unenforceable since it was written, and the two Phase 11 features (review
-- eligibility, coin credit) would hang off an event that does not fire.
--
-- Identical in shape to `trigger_order_reconciler`
-- (20260809030100_schedule_order_reconciler.sql), and for the same reasons,
-- recorded there at length: Vercel Hobby fails deployments carrying sub-daily
-- cron expressions, so pg_cron schedules and pg_net calls the app; and the
-- tracking logic stays in the app because `fetchTracking` is the single
-- implementation of "has this parcel arrived" — RTO detection included — and
-- a second implementation in Deno is how the two drift.
--
-- Every 30 minutes where the reconciler runs at 10: the reconciler rescues a
-- charged customer from a cancellation sweep, so minutes matter; a delivery
-- discovered 30 minutes late costs nothing. The batch size cap and the
-- "never act on an unknown" rule live in the route
-- (src/app/api/cron/poll-deliveries/route.ts).
--
-- The Vault entries (`cron_secret`, `cron_target_origin`) are the same two
-- the reconciler already uses — created by hand once per environment, see the
-- bottom of the reconciler migration. No new secret is introduced here.

create or replace function private.trigger_delivery_poll()
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

  -- Raised, not warned: a missing secret means parcels stop being noticed as
  -- delivered, reviews stop being invitable and coins stop being credited —
  -- silently. pg_cron records the exception in cron.job_run_details, where
  -- cron_health() (and so the admin health page) can see it.
  if v_secret is null or v_origin is null then
    raise exception
      'trigger_delivery_poll: vault is missing cron_secret or cron_target_origin. '
      'The delivery poller is NOT running. See '
      'supabase/migrations/20260809030100_schedule_order_reconciler.sql.';
  end if;

  -- Fire and forget, like the reconciler: pg_net queues the request; the work
  -- behind it is idempotent (fetchTracking writes delivered_at exactly once,
  -- transitionOrder is a compare-and-swap), so a lost response costs one tick.
  perform net.http_post(
    url := v_origin || '/api/cron/poll-deliveries',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_secret,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$function$;

revoke all on function private.trigger_delivery_poll() from public, anon, authenticated;

comment on function private.trigger_delivery_poll() is
  'Called by pg_cron every 30 minutes. POSTs to the app''s delivery-poll '
  'route with the bearer token from Vault. Raises if the Vault entries are '
  'missing, so a silently unconfigured poller shows up in cron.job_run_details.';

-- `cron.schedule` upserts on the job name, so re-running re-points rather
-- than duplicating — same trick as every other job in this shop.
select cron.schedule(
  'poll-deliveries',
  '*/30 * * * *',
  $$select private.trigger_delivery_poll()$$
);
