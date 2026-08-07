-- =============================================================================
-- 0005 · Site content
--
-- The tables that make the admin panel real. The homepage is not a React file
-- the owner cannot open — it is whatever homepage_sections says it is, in that
-- order. Everything the owner can change without a developer lives here.
-- =============================================================================

create table public.homepage_sections (
  id           uuid primary key default gen_random_uuid(),
  section_type public.section_type not null,
  title        text,
  subtitle     text,
  -- Shape depends on section_type and is validated by the matching Zod schema
  -- in src/lib/validations/ before it is ever written. jsonb rather than a
  -- table per section type: the owner adds section types by configuration.
  payload      jsonb not null default '{}'::jsonb,
  sort_order   integer not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger homepage_sections_set_updated_at
  before update on public.homepage_sections
  for each row execute function public.set_updated_at();

-- The homepage's only query: live sections, in the owner's order.
create index homepage_sections_live_order_idx
  on public.homepage_sections (sort_order) where is_active;

create table public.banners (
  id               uuid primary key default gen_random_uuid(),
  placement        text not null default 'home_hero',
  image_url        text,
  -- A desktop hero crop letterboxes badly on a 390px phone, so the owner
  -- uploads both crops and the picture element picks.
  mobile_image_url text,
  headline         text,
  subtext          text,
  cta_label        text,
  cta_href         text,
  starts_at        timestamptz,
  ends_at          timestamptz,
  is_active        boolean not null default true,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint banners_window_ordered check (
    starts_at is null or ends_at is null or ends_at > starts_at
  )
);

create trigger banners_set_updated_at
  before update on public.banners
  for each row execute function public.set_updated_at();

create index banners_placement_idx on public.banners (placement, sort_order) where is_active;

-- --- settings ----------------------------------------------------------------
-- Key/value rather than one wide row: the owner's settings page grows over the
-- project's life, and adding a setting should not need a migration.

create table public.site_settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  -- Everything the storefront renders (phone number, shipping threshold,
  -- announcement copy) is public by definition. The flag exists so a future
  -- private setting -- an API key, a payout account -- can be added without
  -- having to remember to revisit the read policy.
  is_public   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger site_settings_set_updated_at
  before update on public.site_settings
  for each row execute function public.set_updated_at();

-- --- CMS pages ---------------------------------------------------------------

create table public.pages (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique,
  title            text not null,
  body             text,
  meta_title       text,
  meta_description text,
  is_published     boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create trigger pages_set_updated_at
  before update on public.pages
  for each row execute function public.set_updated_at();

create index pages_published_idx on public.pages (slug) where is_published;
