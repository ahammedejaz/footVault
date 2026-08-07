-- =============================================================================
-- 0009 · Fix the role-escalation guard
--
-- guard_profile_role() was created SECURITY DEFINER, which meant `current_user`
-- inside the function body was the function's owner — `postgres` — and not the
-- role that issued the UPDATE. `postgres` is on the trusted list, so the guard
-- passed for everybody and a customer could run
--
--   update profiles set role = 'admin' where id = auth.uid()
--
-- against their own row, which RLS legitimately lets them update, and become an
-- admin. Verified against the live database, then re-verified after this fix;
-- the checks are in docs/rls-tests.md.
--
-- SECURITY INVOKER is what the check actually wanted: `current_user` is then
-- the role PostgREST switched to — `authenticated` for a signed-in customer,
-- `service_role` for the server actions, `postgres` for a migration. The
-- function needs no elevated privilege of its own; it only reads NEW and OLD
-- and calls is_admin(), which is SECURITY DEFINER in its own right.
-- =============================================================================

create or replace function public.guard_profile_role()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.role is distinct from old.role
     -- Trusted server contexts: the service_role key (server actions,
     -- src/lib/supabase/admin.ts) and direct migration connections.
     and current_user not in ('service_role', 'postgres', 'supabase_admin')
     and not public.is_admin()
  then
    raise exception 'Only an admin can change a profile role'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.guard_profile_role() is
  'BEFORE UPDATE on profiles. Rejects a role change from anyone who is not already an admin or a trusted server context. SECURITY INVOKER on purpose: the check reads current_user, which a SECURITY DEFINER function would report as the owner rather than the caller.';

-- The revoke from 0008 does not survive create or replace on a function whose
-- signature is unchanged, but re-issuing it is free and keeps the grant state
-- explicit in one more place than the linter has to infer it.
revoke execute on function public.guard_profile_role() from public, anon, authenticated;
