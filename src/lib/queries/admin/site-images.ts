import "server-only";

import { normaliseFraming } from "@/lib/images/frame";
import type { SiteImageValue } from "@/lib/images/site-image";
import { isFrameKey, type FrameKey } from "@/lib/images/site-frames";
import { createClient } from "@/lib/supabase/server";

/**
 * What the panel needs to draw a picture that is already in place.
 *
 * Only the admin reads this. The storefront never does — the rendered URL was
 * written into the field that already drove the page (`categories.image_url`,
 * the hero payload, `site_settings.branding`), so no customer-facing query
 * gained a table. That is the property that makes this whole feature safe to
 * ship: if `site_images` vanished tonight, every page would render exactly what
 * it renders now, and only *re-adjusting* would be lost.
 */

/**
 * `SiteImageValue` is the shared half — exactly what the field needs. The extra
 * fields here are what the *panel around* the field needs: which slot this is,
 * which preset framed it, and the size it came out, so a screen can say
 * "1600x900" next to a picture without asking the image element.
 */
export type SiteImage = NonNullable<SiteImageValue> & {
  slot: string;
  frame: FrameKey;
  width: number;
  height: number;
};

/**
 * The rows for a set of slots, keyed by slot.
 *
 * A Map rather than an array because every caller is looking one up by the slot
 * it is about to render, and an admin page that draws six image fields would
 * otherwise do six linear scans or invent its own index.
 *
 * An empty `slots` returns an empty Map **without a query**. PostgREST's `in.()`
 * with no values is a syntax error, and the pages that call this legitimately
 * have nothing to ask about — a category list with no categories, a homepage
 * with no image sections.
 */
export async function getSiteImages(
  slots: readonly string[],
): Promise<Map<string, SiteImage>> {
  if (slots.length === 0) return new Map();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("site_images")
    .select(
      "slot, frame, original_path, original_width, original_height, framing, rendered_url, rendered_width, rendered_height, alt",
    )
    .in("slot", [...slots]);

  if (error) {
    /*
      A missing table is not an error worth taking a screen down for.

      There is one window in which it happens: the code deploys before the
      migration is applied. Thrown, it 500s /admin/categories, /admin/brands,
      /admin/settings and /admin/appearance — including the screens the owner
      would use to run the shop while they sort it out, and none of which have
      anything to do with pictures.

      Degraded, every one of those screens renders exactly as it did before this
      feature existed: the fields show as empty, and an upload says plainly what
      is missing (`missingTableMessage`). That is the same trade `prerenderOrDefer`
      makes and the same one `brandingOf` makes — a wrong picture is recoverable
      and a dead admin panel is not.

      Every other error still throws, because "the query is broken" and "the
      table is not there yet" are different problems and only one of them is
      about to fix itself.
    */
    if (isMissingTable(error)) {
      console.warn(
        "[admin] site_images is not in the schema cache yet — image fields " +
          "will show as empty until the migration is applied. See " +
          "supabase/migrations/20260822090000_site_images.sql",
      );
      return new Map();
    }
    throw new Error(`getSiteImages failed: ${error.message}`);
  }

  const out = new Map<string, SiteImage>();
  for (const row of data ?? []) {
    /*
      A row whose `frame` is no longer a preset is skipped rather than shown.
      It can only arrive by a preset being renamed or removed, and the panel has
      no shape to draw it in — rendering it against a guessed aspect would show
      the owner a framing that is not the one in force. Skipping means the field
      offers a fresh upload, which is a recoverable state; the row and its
      original stay in the bucket for whoever renamed the preset to re-render.
    */
    if (!isFrameKey(row.frame)) continue;
    out.set(row.slot, {
      slot: row.slot,
      frame: row.frame,
      originalPath: row.original_path,
      sourceWidth: row.original_width,
      sourceHeight: row.original_height,
      framing: normaliseFraming(row.framing),
      url: row.rendered_url,
      width: row.rendered_width,
      height: row.rendered_height,
      alt: row.alt,
    });
  }
  return out;
}

/**
 * PostgREST's answer when a table is not in its schema cache.
 *
 * `PGRST205` is the code; the message is matched too because the code was added
 * to PostgREST relatively recently and an older deployment answers with only
 * the sentence. Matching either is deliberately loose — the consequence of a
 * false positive here is an empty image field, and of a false negative a 500.
 */
function isMissingTable(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "PGRST205" ||
    /could not find the table/i.test(error.message ?? "")
  );
}

/** What to tell the owner when the table has not arrived yet. */
export const MISSING_TABLE_MESSAGE =
  "Pictures cannot be saved yet — the database has not been updated for this " +
  "feature. Everything else on this screen works. Ask whoever deploys the " +
  "shop to apply the pending migration.";
