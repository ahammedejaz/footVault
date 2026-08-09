-- =============================================================================
-- 0018 · Take the event-trigger function off the API surface
--
-- `rls_auto_enable()` is an event-trigger function: Postgres calls it when a
-- table is created, and nothing else can. Calling it outside an event-trigger
-- context raises, and PostgREST does not expose a function returning
-- `event_trigger` — so the security advisor's finding on it is conservative
-- rather than exploitable.
--
-- Revoking is free and removes the finding, which is the point: an advisor list
-- with known-benign entries on it is an advisor list nobody reads. What is left
-- there afterwards is the four policy helpers (0008 documents why they keep
-- their grant) and `discontinued_product_hint`, which is deliberate and written
-- up in docs/rls-tests.md §7.
--
-- ## The creation below was added on 2026-08-09, after the fact
--
-- As originally written this file revoked a grant on a function that **no
-- migration creates**. `rls_auto_enable` and its `ensure_rls` event trigger
-- were set up by hand in the SQL editor before Phase 5 — docs/rls-tests.md
-- lists them as pre-existing — so this revoke held on production and on any
-- database cloned from it, and stopped a replay from empty dead right here
-- with `function public.rls_auto_enable() does not exist`. The fourth
-- fresh-build defect, found by `npm run rebuild:stage` on the day it was
-- written; the first three are in the Batch 2 report.
--
-- The definition is production's own, read back via
-- `pg_get_functiondef` on 2026-08-09, not a reconstruction. Databases that
-- already ran this migration never re-run it, so for them the edit is inert;
-- a replay now produces the same objects production carries. `create or
-- replace` and a drop-then-create trigger pair keep it safe on any database
-- where the hand-made originals are still standing.
create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path to 'pg_catalog'
as $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

drop event trigger if exists ensure_rls;
create event trigger ensure_rls
  on ddl_command_end
  execute function public.rls_auto_enable();

revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
