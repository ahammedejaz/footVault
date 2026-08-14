-- A colourway is a text string repeated across every size row, and
-- `product_images.color` matches it by exact equality. Nothing kept the two
-- sides in step: renaming "Navy" to "Midnight" in the variant editor left the
-- Navy photographs matching a colourway that no longer exists, and the gallery
-- for Midnight fell through to whatever was untagged — which on a seeded
-- product is nothing at all. The colourway silently lost its photography, and
-- no gate went red because nothing reads the two columns together.
--
-- The cascade lives here rather than in `saveVariant` for two reasons. It has
-- to be in the *same transaction* as the rename, and two PostgREST calls are
-- two transactions with a window in between. And a rule that lives in one
-- Server Action holds only for callers who went through that action — the
-- seed, a SQL fix-up, and whatever writes variants next year all rename
-- colourways too.
--
-- What it deliberately does NOT do:
--
--   * A **split** is not a rename. Renaming one size out of a colourway while
--     the others keep the old name leaves the old colourway alive, and its
--     photography with it. The guard is "does any other variant of this
--     product still carry the old string" — which also makes a whole-colourway
--     rename converge correctly when it arrives as N single-row updates: every
--     update but the last one sees a survivor and does nothing, and the last
--     one moves the images.
--
--   * A **merge** — renaming the last "Navy" variant to an existing "Midnight"
--     — moves Navy's photographs onto Midnight. That is a real decision rather
--     than an accident: the alternative is leaving them tagged with a colourway
--     that no longer exists, where they are shown on no page at all. The image
--     manager now prints which colourway each photograph belongs to and says
--     when one is shown nowhere, so a merge the owner did not intend is
--     visible and correctable in the place they made it.

create or replace function public.product_images_follow_colour_rename()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- `after update of color` fires whenever the column is in the SET list, even
  -- when the value is unchanged. The value is the real test.
  if new.color is not distinct from old.color then
    return new;
  end if;

  -- Moving a variant between products is not a rename and has never happened.
  -- Refusing to guess is cheaper than guessing wrong about somebody's gallery.
  if new.product_id is distinct from old.product_id then
    return new;
  end if;

  -- A split: some other size still sells the old colourway, so the old
  -- colourway still has customers and still owns its photographs.
  if exists (
    select 1
      from public.product_variants v
     where v.product_id = old.product_id
       and v.color = old.color
       and v.id <> new.id
  ) then
    return new;
  end if;

  update public.product_images
     set color = new.color
   where product_id = old.product_id
     and color = old.color;

  return new;
end;
$$;

comment on function public.product_images_follow_colour_rename() is
  'Keeps product_images.color in step with product_variants.color when the last '
  'variant carrying a colourway is renamed. SECURITY DEFINER so the cascade does '
  'not depend on the renaming role also holding UPDATE on product_images. Does '
  'nothing when another variant still carries the old name (a split) or when the '
  'product changed (a move).';

-- Default PUBLIC EXECUTE is revoked for the same reason every other function in
-- this schema revokes it: a new function inherits no ACL and Postgres grants
-- EXECUTE to PUBLIC on creation, which is how create_order_with_stock reopened
-- itself on 2026-08-11. Trigger execution does not check EXECUTE, so the
-- cascade still fires for the admin session that renames a size — the same
-- shape every other trigger function in this schema already has.
revoke all on function public.product_images_follow_colour_rename()
  from public, anon, authenticated;
grant execute on function public.product_images_follow_colour_rename()
  to service_role;

drop trigger if exists product_variants_colour_follows_images
  on public.product_variants;

create trigger product_variants_colour_follows_images
  after update of color on public.product_variants
  for each row execute function public.product_images_follow_colour_rename();
