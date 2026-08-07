-- =============================================================================
-- 0013 · Colour families
--
-- The seed holds 39 colourway names — "Peacoat Navy", "Wolf Grey", "Fire
-- Orchid", "Bone" — and the men's listing alone offered 26 of them as filter
-- options. That is not a filter, it is a glossary. A customer filtering by
-- colour is asking one question: is it black.
--
-- The bucket is derived from the hex the owner already enters, so nothing has
-- to be tagged twice and an uploaded colourway is classified the moment it is
-- saved. Two calibrations, both from looking at what the real values did:
--
--   Chroma, not HSL saturation, decides achromatic. #f4f1ec ("Cloud White") is
--   94% light with 3% chroma yet reports s = 0.27, and bucketed as Beige;
--   #f2f2ee ("White / Green") came out Yellow.
--
--   The cut sits at 0.075. At 0.10 it swallowed Bone (0.090) and Sea Salt
--   (0.082), which are warm beiges to any eye, while Wolf Grey (0.055) and
--   Grey / Lavender (0.059) sit safely below either way.
--
-- The Brown band runs to l = 0.58 so Taupe and Camel stop reading as Orange —
-- an orange shoe should be a genuinely orange shoe.
-- =============================================================================

create or replace function public.color_family(hex text)
returns text language plpgsql immutable set search_path = '' as $$
declare r numeric; g numeric; b numeric; mx numeric; mn numeric; d numeric;
        h numeric; l numeric;
begin
  if hex is null or hex !~* '^#[0-9a-f]{6}$' then return null; end if;
  r := ('x' || substr(hex,2,2))::bit(8)::int / 255.0;
  g := ('x' || substr(hex,4,2))::bit(8)::int / 255.0;
  b := ('x' || substr(hex,6,2))::bit(8)::int / 255.0;
  mx := greatest(r,g,b); mn := least(r,g,b); d := mx - mn; l := (mx + mn) / 2;
  if d <= 0.075 then
    if l <= 0.18 then return 'Black'; end if;
    if l >= 0.85 then return 'White'; end if;
    return 'Grey';
  end if;
  if l <= 0.16 then return 'Black'; end if;
  if mx = r then h := 60 * (mod(((g-b)/d), 6));
  elsif mx = g then h := 60 * (((b-r)/d) + 2);
  else h := 60 * (((r-g)/d) + 4);
  end if;
  if h < 0 then h := h + 360; end if;
  if h < 16 or h >= 345 then return 'Red'; end if;
  if h < 45 then
    if l >= 0.74 then return 'Beige'; end if;
    if l <= 0.58 then return 'Brown'; end if;
    return 'Orange';
  end if;
  if h < 70 then return 'Yellow'; end if;
  if h < 165 then return 'Green'; end if;
  if h < 200 then return 'Teal'; end if;
  if h < 260 then return 'Blue'; end if;
  if h < 300 then return 'Purple'; end if;
  return 'Pink';
end;
$$;

comment on function public.color_family is
  'Buckets a hex colourway into one of twelve families a customer would actually filter by. Derived rather than tagged, so an uploaded colourway is classified the moment it is saved.';

-- A generated column is not recomputed when the function behind it changes, so
-- any change to color_family() has to drop and re-add this column rather than
-- replace the function alone.
alter table public.product_variants drop column if exists color_family;
alter table public.product_variants
  add column color_family text
  generated always as (public.color_family(color_hex)) stored;

create index if not exists product_variants_color_family_idx
  on public.product_variants (color_family) where is_active;
