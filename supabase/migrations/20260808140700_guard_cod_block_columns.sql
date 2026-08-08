-- Phase 7 · G-2, from the third adversarial review.
--
-- `profiles.cod_blocked_at` was added so the owner could withdraw Pay on
-- Delivery from one customer who keeps refusing parcels. It shipped as a column
-- with no lock on it: `profiles` carries an UPDATE policy letting a customer
-- edit their own row, `guard_profile_role()` froze only `role`, and so a
-- blocked customer could clear their own block with a single PostgREST PATCH.
-- Reproduced end to end by the review, and again here before and after the fix.
--
-- A control the person it constrains can switch off is not a control. The
-- trigger is widened rather than a second one added, because "which columns on
-- this row may a customer change" is one question and answering it in two
-- places is how the two come to disagree.
create or replace function public.guard_profile_role()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if (new.role is distinct from old.role
      or new.cod_blocked_at is distinct from old.cod_blocked_at
      or new.cod_blocked_reason is distinct from old.cod_blocked_reason)
     -- Trusted server contexts: the service_role key (server actions,
     -- src/lib/supabase/admin.ts) and direct migration connections.
     and current_user not in ('service_role', 'postgres', 'supabase_admin')
     and not public.is_admin()
  then
    raise exception 'Only an admin can change a profile role or a payment block'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;
