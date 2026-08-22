-- =============================================================================
-- site_images · the originals behind every non-product picture on the site
--
-- ## What this table is for
--
-- Every image the shop shows that is not a product photograph — the hero, the
-- category tiles, the logo, the share card — was until now either a file
-- committed to `public/seed/`, or a URL an owner had to paste by hand. Both are
-- the same defect wearing different clothes: the picture cannot be changed
-- without a developer.
--
-- Making them uploadable is the easy half. The half that needs a table is
-- **adjusting** them. An owner who uploads a wide photograph for a 4:3 tile has
-- made a framing decision — which part of it shows — and that decision has to
-- survive so it can be revisited next week without hunting for the original
-- file again. So the rendered derivative is not the record: the original plus
-- the framing numbers is, and the derivative is what falls out of them.
--
-- This is the same arrangement `product_images.crop` already uses, and for the
-- same reason (`src/lib/images/crop.ts`). The difference is that a product
-- photograph is always a square and these are not, so the numbers live in
-- `src/lib/images/frame.ts` and carry an aspect.
--
-- ## Why `slot` is the primary key
--
-- One picture per place. `slot` names the place — 'brand.logo',
-- 'category.<uuid>', 'section.<uuid>.desktop' — so re-uploading the hero
-- replaces the hero rather than accumulating a second row nobody can tell apart
-- from the first. It is a text key rather than a foreign key because the places
-- are not all rows: the logo belongs to no table.
--
-- The consequence worth stating: deleting a category leaves its slot behind.
-- That is deliberate. An orphan row costs one row and one file; a cascade would
-- mean a mis-click in the category list silently destroys artwork the owner
-- may have paid for. `/admin/media` can see and remove the file.
--
-- ## What this table is NOT
--
-- It is not where the storefront reads from. The rendered URL is written into
-- the field that already drives the page — `categories.image_url`, the hero
-- section's payload, `site_settings.branding` — so every renderer keeps working
-- untouched and this table can be dropped without taking the shop down. It is
-- the edit history, not the content.
-- =============================================================================

create table public.site_images (
  -- The place this picture goes. See the header.
  slot              text primary key,

  -- Which preset framed it: a key of IMAGE_FRAMES in src/lib/images/frame.ts.
  -- Stored so a re-adjust knows the aspect without the caller having to say,
  -- and so a preset that changes shape later can be found and re-rendered.
  frame             text not null,

  -- The bytes as uploaded, inside the `site-assets` bucket. Kept forever:
  -- re-framing without it would mean re-uploading, which is the thing this
  -- table exists to avoid.
  original_path     text not null,
  original_width    integer not null check (original_width  > 0),
  original_height   integer not null check (original_height > 0),

  -- {cx, cy, zoom, rotation, brightness, contrast}. Normalised on both sides of
  -- the wire by `normaliseFraming`, so a half-written object still renders.
  framing           jsonb   not null default '{}'::jsonb,

  -- What the site actually serves, and where it came out.
  rendered_path     text not null,
  rendered_url      text not null,
  rendered_width    integer not null check (rendered_width  > 0),
  rendered_height   integer not null check (rendered_height > 0),

  -- Owner-written alternative text. Nullable because a decorative image should
  -- carry an empty alt rather than an invented sentence, and NULL says "the
  -- owner has not written one" where '' says "there is deliberately none".
  alt               text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.site_images is
  'Originals and framing for every non-product image. The storefront reads the '
  'rendered URL from the field it already read (categories.image_url, the hero '
  'payload, site_settings.branding); this table is what makes re-adjusting one '
  'possible without re-uploading it.';

create trigger site_images_set_updated_at
  before update on public.site_images
  for each row execute function public.set_updated_at();

-- Finding every slot that used a preset, for the day a preset changes shape.
create index site_images_frame_idx on public.site_images (frame);

alter table public.site_images enable row level security;

-- Public read: these are pictures on an open storefront and their URLs are
-- already public. Nothing here is a secret, and a readable row lets a future
-- renderer take the alt text from source rather than from a copy.
create policy "site images are publicly readable"
  on public.site_images for select to anon, authenticated
  using (true);

create policy "admins manage site images"
  on public.site_images for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
