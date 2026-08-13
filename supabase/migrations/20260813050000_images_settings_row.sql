-- How much of the frame a shoe should fill, as a setting rather than a constant.
--
-- ## Where 85 comes from
--
-- Amazon and Flipkart both publish it, and they publish it for the same stated
-- reason: the remaining 15% is breathing room, and a product touching the frame
-- edge can trigger rejection. It is the suggested default here, not a law —
-- which is exactly why it is a row and not a number in a TypeScript file.
--
-- A shoe is a wide, low subject, and the marketplaces picked that figure with
-- boxes and bottles in mind. The owner may well find 78 or 80 sits better once
-- there are thirty real photographs to look at, and the whole point of making
-- it a setting is that finding out costs a number in a form rather than a
-- deploy.
--
-- ## What the number measures, which is the part that gets assumed wrong
--
-- **The subject's longest side, as a fraction of the frame's edge.** Not area.
-- The distinction is not pedantry for a shoe: a shoe silhouette that filled 85%
-- of its own bounding box by area would have to be a rectangle, so "85% by
-- area" is not a demanding target, it is an unreachable one. The admin control
-- says so in its own words, because somebody reading "85%" with no other
-- context will assume the other meaning.
--
-- ## Private
--
-- Nothing on the storefront reads it. It shapes what the owner is nudged
-- toward while framing a photograph, and a customer learns the result by
-- looking at the pictures. Classified in SETTINGS_VISIBILITY with that reason;
-- `audit:settings-visibility` fails if this row's `is_public` and that entry
-- ever disagree.
--
-- Stored as a whole percent because that is what the owner types. The reader
-- converts to a fraction, in one place, so the form and the arithmetic cannot
-- drift about whether 85 means 85 or 0.85 — a class of bug this codebase has
-- paid for once already with paise and rupees.

insert into public.site_settings (key, value, is_public)
values ('images', jsonb_build_object('target_fill_percent', 85), false)
on conflict (key) do nothing;
