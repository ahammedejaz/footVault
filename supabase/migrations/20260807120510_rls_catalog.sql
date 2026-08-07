-- =============================================================================
-- 0006b · RLS — catalog and site content
--
-- Part of the single RLS pass split across four migrations so each applies as
-- one reviewable unit. Together they cover every table in `public`.
--
-- Two performance rules are followed throughout, per Supabase's RLS guidance:
--   1. auth.uid() and helper calls are wrapped in (select ...) so the planner
--      evaluates them once per query instead of once per row.
--   2. Every column a policy filters on is indexed (see the table migrations).
--
-- Coverage is proved by docs/rls-tests.md, which runs against the live database.
-- =============================================================================

-- Catalog and site content: public reads what is live, admins do everything.

alter table public.categories          enable row level security;
alter table public.brands              enable row level security;
alter table public.products            enable row level security;
alter table public.product_images      enable row level security;
alter table public.product_variants    enable row level security;
alter table public.collections         enable row level security;
alter table public.collection_products enable row level security;
alter table public.homepage_sections   enable row level security;
alter table public.banners             enable row level security;
alter table public.site_settings       enable row level security;
alter table public.pages               enable row level security;

create policy "categories are publicly readable when active"
  on public.categories for select to anon, authenticated
  using (is_active);
create policy "admins manage categories"
  on public.categories for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "brands are publicly readable when active"
  on public.brands for select to anon, authenticated
  using (is_active);
create policy "admins manage brands"
  on public.brands for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- A soft-deleted product is invisible to the storefront but still joined to by
-- order history, which reads through the service role.
create policy "products are publicly readable when live"
  on public.products for select to anon, authenticated
  using (is_active and deleted_at is null);
create policy "admins manage products"
  on public.products for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "product images follow their product"
  on public.product_images for select to anon, authenticated
  using ((select public.product_is_live(product_id)));
create policy "admins manage product images"
  on public.product_images for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- Sold-out and deactivated variants stay readable: the size run shows the whole
-- run with the unavailable sizes struck through, which it cannot do if the
-- database hides them.
create policy "product variants follow their product"
  on public.product_variants for select to anon, authenticated
  using ((select public.product_is_live(product_id)));
create policy "admins manage product variants"
  on public.product_variants for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "collections are publicly readable when active"
  on public.collections for select to anon, authenticated
  using (is_active);
create policy "admins manage collections"
  on public.collections for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "collection members follow their collection"
  on public.collection_products for select to anon, authenticated
  using (
    exists (
      select 1 from public.collections c
      where c.id = collection_id and c.is_active
    )
    and (select public.product_is_live(product_id))
  );
create policy "admins manage collection members"
  on public.collection_products for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "homepage sections are publicly readable when active"
  on public.homepage_sections for select to anon, authenticated
  using (is_active);
create policy "admins manage homepage sections"
  on public.homepage_sections for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- A scheduled banner is not readable before it starts or after it ends, so a
-- promo cannot leak early by inspecting the network tab.
create policy "banners are publicly readable while scheduled"
  on public.banners for select to anon, authenticated
  using (
    is_active
    and (starts_at is null or starts_at <= now())
    and (ends_at is null or ends_at > now())
  );
create policy "admins manage banners"
  on public.banners for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "public settings are publicly readable"
  on public.site_settings for select to anon, authenticated
  using (is_public);
create policy "admins manage site settings"
  on public.site_settings for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "pages are publicly readable when published"
  on public.pages for select to anon, authenticated
  using (is_published);
create policy "admins manage pages"
  on public.pages for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
