-- =============================================================================
-- 0002 · Customers
--
-- profiles mirrors auth.users one-to-one and carries the role. addresses is the
-- customer's address book; checkout writes a jsonb *snapshot* onto the order
-- rather than a foreign key, so editing an address never rewrites history.
--
-- public.is_admin() lands here because it reads profiles, and Postgres
-- validates function bodies at CREATE time.
-- =============================================================================

create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text,
  phone       text,
  avatar_url  text,
  role        public.user_role not null default 'customer',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.profiles is
  'One row per auth user. Created automatically by handle_new_user(); role is only ever changed by an admin.';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- --- helpers that depend on profiles -----------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and role in ('admin', 'staff')
  );
$$;

comment on function public.is_admin() is
  'True when the calling user has role admin or staff. SECURITY DEFINER so profiles policies that call it do not recurse. Answers only "am I an admin", so it is safe to leave executable.';

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, avatar_url)
  values (
    new.id,
    -- Google OAuth sends `name`; the email/password form sends `full_name`.
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name'
    ),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- --- role escalation guard ---------------------------------------------------
-- RLS already stops a customer from writing another row, but a customer CAN
-- update their own row — and their own row is where the role lives. Column
-- privileges alone would not survive a future `grant update` so the invariant
-- is enforced here, where it cannot be worked around from the client.

create or replace function public.guard_profile_role()
returns trigger
language plpgsql
security definer
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

create trigger profiles_guard_role
  before update on public.profiles
  for each row execute function public.guard_profile_role();

-- --- addresses ---------------------------------------------------------------

create table public.addresses (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  label          text,
  recipient_name text not null,
  phone          text not null,
  line1          text not null,
  line2          text,
  city           text not null,
  state          text not null,
  postal_code    text not null,
  country        text not null default 'IN',
  is_default     boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger addresses_set_updated_at
  before update on public.addresses
  for each row execute function public.set_updated_at();

create index addresses_user_id_idx on public.addresses (user_id);

-- At most one default per customer. A partial unique index rather than a
-- trigger: the database rejects the second default instead of silently
-- demoting the first, so a buggy client cannot lose the customer's choice.
create unique index addresses_one_default_per_user_idx
  on public.addresses (user_id)
  where is_default;
