-- =============================================================================
-- 0013 · Admin bootstrap, and making the customer role explicit
--
-- Two things, both about the same invariant: a role is granted by the shop
-- owner and by nothing else.
--
-- 1. handle_new_user() now writes role = 'customer' as a literal rather than
--    leaning on the column default. The behaviour is identical; the point is
--    that the next person to read this function sees the decision instead of
--    an absence, and any edit that starts reading a role out of
--    raw_user_meta_data is then obviously wrong rather than merely new.
--
--    This matters more with Google in the picture. raw_user_meta_data is
--    populated from the provider's profile payload and is editable by the user
--    through the auth API, so it is exactly the wrong place to take an
--    authorisation decision from. name and avatar are cosmetic and are all it
--    is allowed to influence.
--
-- 2. private.promote_to_admin(email) is how the owner makes themselves an
--    admin without a developer.
--
--    It lives in `private`, not `public`. Postgres grants EXECUTE on a new
--    function to PUBLIC by default, and `anon`/`authenticated` inherit from
--    PUBLIC — so a SECURITY DEFINER function in `public` is a self-service
--    privilege-escalation endpoint reachable over PostgREST unless every grant
--    is remembered. A schema the Data API does not expose is the structural
--    version of remembering. The revokes below are belt and braces.
--
--    SECURITY DEFINER is required: profiles_guard_role rejects a role change
--    from anyone who is not already an admin, and the first admin by
--    definition is not.
-- =============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, avatar_url, role)
  values (
    new.id,
    -- Google OAuth sends `name`; nothing else populates `full_name` today.
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name'
    ),
    new.raw_user_meta_data ->> 'avatar_url',
    -- Never read from raw_user_meta_data. It is provider-supplied and
    -- user-editable; a role taken from it is a role the user can choose.
    'customer'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

comment on function public.handle_new_user() is
  'Creates the profile row for a new auth user. Always role = customer: raw_user_meta_data is user-editable and must never influence authorisation.';

-- --- the bootstrap ------------------------------------------------------------

create schema if not exists private;

comment on schema private is
  'Not exposed to the Data API. Holds privileged helpers that must never be reachable over PostgREST.';

revoke all on schema private from public, anon, authenticated;

create or replace function private.promote_to_admin(target_email text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_id uuid;
begin
  select id into target_id
  from auth.users
  where lower(email) = lower(trim(target_email))
  limit 1;

  if target_id is null then
    return format(
      'No account found for %s. Sign in with Google once first, then run this again.',
      target_email
    );
  end if;

  update public.profiles set role = 'admin' where id = target_id;

  return format('%s is now an admin.', target_email);
end;
$$;

comment on function private.promote_to_admin(text) is
  'Promotes an existing account to admin. Run from the Supabase SQL editor; see docs/admin-guide.md. Deliberately outside the public schema and not executable by anon or authenticated.';

revoke execute on function private.promote_to_admin(text) from public, anon, authenticated;
