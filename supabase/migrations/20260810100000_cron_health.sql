-- What pg_cron is doing, readable from the admin panel.
--
-- The shop's four scheduled jobs — the abandoned-order sweep, the order
-- reconciler, the rate-limit cleanup and anything added since — run inside
-- Postgres, which is exactly why nothing outside Postgres can see them:
-- `cron.job` is not in the `public` schema and PostgREST does not expose it.
-- A job that silently stopped is invisible until its absence does damage,
-- and "the sweep has not run since Tuesday" is precisely the sentence the
-- health page exists to say.
--
-- SECURITY DEFINER because `cron.*` belongs to the superuser-adjacent owner;
-- service_role-only because job names and schedules are operational detail
-- nobody else has any business reading. Additive; touches no data.

create function public.cron_health()
returns table (
  jobname       text,
  schedule      text,
  active        boolean,
  last_status   text,
  last_started  timestamptz,
  last_finished timestamptz,
  last_message  text
)
language sql
stable
security definer
set search_path = ''
as $$
  select j.jobname,
         j.schedule,
         j.active,
         r.status,
         r.start_time,
         r.end_time,
         r.return_message
    from cron.job j
    left join lateral (
      select d.status, d.start_time, d.end_time, d.return_message
        from cron.job_run_details d
       where d.jobid = j.jobid
       order by d.start_time desc
       limit 1
    ) r on true
   order by j.jobname;
$$;

comment on function public.cron_health() is
  'Every pg_cron job with its last run, for the admin health page. '
  'service_role only.';

revoke all on function public.cron_health() from public, anon, authenticated;
grant execute on function public.cron_health() to service_role;
