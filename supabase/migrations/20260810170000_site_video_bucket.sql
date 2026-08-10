-- =============================================================================
-- 0043 · The hero video bucket
--
-- The bucket already exists in production, made by hand before this migration
-- was written. This file exists so it also exists everywhere else — a staging
-- project rebuilt from migrations, a local stack, the next production project —
-- and so the thing it actually needs, which is a write policy, exists anywhere
-- at all.
--
-- Every value below is the production bucket's, read back off it rather than
-- chosen here: public read, 10485760 bytes, video/mp4 and video/webm. The
-- `on conflict do update` therefore lands as a no-op against production and as
-- a create everywhere else, which is the only shape that is safe to run in both
-- places.
--
-- ## Why the policies are separate statements and not an edit
--
-- 0007 grants insert, update and delete on `bucket_id in ('product-images',
-- 'category-images', 'site-assets')`. Adding a fourth name to those three
-- policies would mean dropping and recreating each one, and a failure halfway
-- through leaves the *photograph* buckets without a write policy — the admin
-- panel stops uploading product images because a hero video feature was added.
-- Additive policies cannot do that. Postgres ORs permissive policies together,
-- so a separate one grants exactly this bucket and touches nothing else.
--
-- ## Read is public and there is still a select policy
--
-- The storefront fetches the film from `/object/public/...`, which does not
-- consult RLS on a public bucket. The policy is here for the API paths that do:
-- the admin listing what is in the bucket, and any later screen that wants to
-- show the owner what they have uploaded. Without it those return an empty list
-- rather than an error, which is the kind of wrong that gets debugged twice.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('site-video', 'site-video', true, 10485760,
   array['video/mp4', 'video/webm'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- --- object policies ---------------------------------------------------------

create policy "site video is publicly readable"
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'site-video');

create policy "admins upload site video"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'site-video'
    and (select public.is_admin())
  );

create policy "admins replace site video"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'site-video'
    and (select public.is_admin())
  )
  with check (
    bucket_id = 'site-video'
    and (select public.is_admin())
  );

create policy "admins delete site video"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'site-video'
    and (select public.is_admin())
  );
