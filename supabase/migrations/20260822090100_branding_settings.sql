-- =============================================================================
-- site_settings.branding · the shop's artwork, and the sentence search shows
--
-- ## What this row is, and what it deliberately is not
--
-- It is **not** where the shop's name lives. `store_name` and `store_tagline`
-- have been rows since Phase 7 and the settings page has always written them —
-- adding a second name here would create two answers to "what is this shop
-- called", and the one that won would depend on which reader you asked. It is
-- the artwork, plus the one piece of owner-facing text that had no home:
-- the description search engines and link previews print.
--
-- ## Why the artwork needed a row at all
--
-- The logo was worse than hardcoded — it was a *compiled import*
-- (`import lockup from "../../../public/brand/logo.png"`), so replacing it
-- meant a git commit and a deploy. So did the favicon (`src/app/icon.png`).
-- Those are precisely the capabilities that stop existing when development
-- stops, which is the situation this shop is now in.
--
-- ## Every image field is seeded null, and that is load-bearing
--
-- Null means "use the artwork committed in the repository". So applying this
-- changes nothing a customer can see: the header keeps rendering
-- `public/brand/logo.png`, the tab keeps showing `src/app/icon.png`, and link
-- previews keep coming from the generated `opengraph-image` route. The row
-- makes them *replaceable*; it does not replace them. A migration that quietly
-- rebrands a live shop is not one anybody wants to run on a Friday.
--
-- The description is seeded with the sentence the site already serves, read
-- from `src/lib/site-config.ts`, for the same reason.
-- =============================================================================

insert into public.site_settings (key, value, description, is_public)
values (
  'branding',
  jsonb_build_object(
    'description',     'Sneakers, formal shoes, boots and sandals for men, women and kids. Delivered across India from our shop in Proddatur.',
    'logo_url',        null,
    'favicon_url',     null,
    'share_image_url', null
  ),
  'The shop artwork and the sentence search engines print: the logo, the '
  'favicon, the social share card, and the site description. The shop NAME is '
  'store_name, not this row. Null image fields fall back to the artwork '
  'committed in public/brand and src/app/icon.png.',
  true
)
on conflict (key) do nothing;
