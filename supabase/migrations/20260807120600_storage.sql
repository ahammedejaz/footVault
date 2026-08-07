-- =============================================================================
-- 0007 · Storage
--
-- Three public-read buckets. Public read is deliberate: these are product
-- photographs on an open storefront, and signing every image URL would defeat
-- the CDN and cost a round trip per thumbnail. Writes are admin-only.
--
-- File size and MIME allow-lists are set on the bucket, so a malformed upload
-- is rejected by storage before it ever reaches an admin form.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('product-images',  'product-images',  true, 5242880,
   array['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/svg+xml']),
  ('category-images', 'category-images', true, 5242880,
   array['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/svg+xml']),
  ('site-assets',     'site-assets',     true, 5242880,
   array['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/svg+xml', 'image/x-icon'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- --- object policies ---------------------------------------------------------
-- storage.objects already has RLS enabled by Supabase. These policies are
-- scoped by bucket_id so the three buckets cannot be used to reach each other.

create policy "storefront assets are publicly readable"
  on storage.objects for select to anon, authenticated
  using (bucket_id in ('product-images', 'category-images', 'site-assets'));

create policy "admins upload storefront assets"
  on storage.objects for insert to authenticated
  with check (
    bucket_id in ('product-images', 'category-images', 'site-assets')
    and (select public.is_admin())
  );

create policy "admins replace storefront assets"
  on storage.objects for update to authenticated
  using (
    bucket_id in ('product-images', 'category-images', 'site-assets')
    and (select public.is_admin())
  )
  with check (
    bucket_id in ('product-images', 'category-images', 'site-assets')
    and (select public.is_admin())
  );

create policy "admins delete storefront assets"
  on storage.objects for delete to authenticated
  using (
    bucket_id in ('product-images', 'category-images', 'site-assets')
    and (select public.is_admin())
  );
