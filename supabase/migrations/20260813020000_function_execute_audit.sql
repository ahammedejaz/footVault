-- Who can execute a given public function, derived from the catalog.
--
-- This exists so `audit:security-advance` can stop *naming* the signature it
-- probes. Section 3 of that gate called create_order_with_stock with a fixed
-- 25-argument shape and read any error as "refused". When 20260811140000
-- changed the arity to 26, PostgREST answered the old shape with PGRST202
-- ("no function matches") — a non-null error that the gate counted as a pass,
-- while the NEW function sat executable by anon because a new arity is a new
-- function that inherits no ACL. A not-found and a permission-denied were
-- indistinguishable, so the door reopened silently and stayed open on staging
-- for two days.
--
-- The fix is to ask the catalog what signatures actually exist right now and
-- whether anon or authenticated can execute each, rather than to hard-code a
-- shape that arity drift walks straight past. pg_proc is in pg_catalog, which
-- PostgREST does not expose, so the gate needs a function to reach it — the
-- same reason cron_health() exists for cron.job.
--
-- SECURITY DEFINER to read pg_proc and call has_function_privilege across
-- roles; service_role-only because it is diagnostic. Additive; touches no data.

create function public.function_execute_audit(p_proname text)
returns table (
  signature             text,
  anon_execute          boolean,
  authenticated_execute boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.oid::regprocedure::text,
         has_function_privilege('anon', p.oid, 'execute'),
         has_function_privilege('authenticated', p.oid, 'execute')
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = p_proname
     and p.prokind = 'f'
   order by 1;
$$;

comment on function public.function_execute_audit(text) is
  'Every public function of the given name, with whether anon/authenticated '
  'can execute it — derived from the catalog so a signature change cannot '
  'hide from the security gate. service_role only.';

revoke all on function public.function_execute_audit(text)
  from public, anon, authenticated;
grant execute on function public.function_execute_audit(text) to service_role;
