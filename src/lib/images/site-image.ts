/**
 * The vocabulary a site picture is described in, shared by both sides.
 *
 * Deliberately **not** `server-only`. The browser field says which slot it is
 * uploading into and renders what is already there; the Server Action writes
 * that slot and the admin query reads it back. A slot named by a literal on one
 * side and a helper on the other stops matching the day somebody renames a
 * prefix — and the symptom is not an error, it is a picture that uploads fine
 * and then cannot be adjusted, because the row is filed under a name nothing
 * looks up.
 *
 * `SiteImageValue` lives here for the same reason. It was briefly declared
 * twice — once by the field and once by the query that feeds it — and the two
 * agreed by coincidence until one grew `sourceWidth`. Two structurally similar
 * types are not one type; they are a compile error waiting for the edit that
 * separates them, or worse, no compile error at all.
 */

import type { Framing } from "./frame";

/**
 * A picture in place, as the panel needs it.
 *
 * `url` is the **rendered derivative** — what the page shows. `originalPath`
 * and the source dimensions are the untouched upload, which is what the framing
 * stage drags around; without them Adjust could only re-cut an already-cut
 * picture, losing a little more each time.
 *
 * `null` means the place is empty. It is a whole-value null rather than a
 * record with an empty url because "no picture" and "a picture with no address"
 * are not states worth telling apart, and one of them would have to be handled
 * everywhere.
 */
export type SiteImageValue = {
  url: string;
  originalPath: string;
  sourceWidth: number;
  sourceHeight: number;
  framing: Framing;
  alt: string | null;
} | null;
export const slotFor = {
  /** Shop identity: the logo, the favicon, the share card. */
  branding: (name: "logo" | "favicon" | "share_image") => `branding.${name}`,
  /** One department tile. Keyed by id, so renaming a category keeps its art. */
  category: (categoryId: string) => `category.${categoryId}`,
  /** A maker's mark. */
  brand: (brandId: string) => `brand.${brandId}`,
  /** A homepage section's own imagery, by section row and which picture. */
  section: (sectionId: string, part: "desktop" | "mobile" | "poster" | "background") =>
    `section.${sectionId}.${part}`,
} as const;

/**
 * A slot, as a storage path segment.
 *
 * Slots are built from uuids and known words so they are already tame, but this
 * is the boundary where a slot becomes a *path* and a path that escapes its
 * prefix is a different class of problem from a slot that looks odd. Anything
 * outside the allowed set becomes a hyphen; the slot itself is unchanged.
 */
export function slotPathSegment(slot: string): string {
  return slot.replace(/[^a-z0-9._-]/gi, "-").slice(0, 120);
}
