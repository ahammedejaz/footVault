/**
 * The hero video bucket, and the two different numbers that bound it.
 *
 * Deliberately **not** `server-only`. The admin panel has to tell the owner a
 * file is too big *before* it is sent, next to the size it actually is, and a
 * limit the browser cannot read is a limit the browser can only discover by
 * failing an upload. The server re-checks both numbers anyway — this module is
 * the shared vocabulary, not the enforcement.
 *
 * ## Why there are two ceilings and not one
 *
 * `HARD_MAX_BYTES` is the bucket's own `file_size_limit`. Storage rejects
 * anything larger on arrival, so it is a fact about the system rather than a
 * policy: nothing above it can be uploaded by any route, including SQL.
 *
 * `WARN_BYTES` is a judgement about customers, and it is the number that
 * matters. A 9MB hero clears the bucket and still costs a shopper on mobile
 * data roughly nine rupees of their pack to look at a shop they have not
 * decided to buy from yet, on a connection where it will not finish before they
 * scroll past it. So the panel warns at 4MB and still lets the owner proceed —
 * they can see the number, they know their footage, and a hard refusal at a
 * threshold somebody invented is how a capability becomes a support ticket.
 *
 * The gap between the two is the honest part: "this will work, and here is what
 * it costs" is a different sentence from "this is not allowed", and the panel
 * says whichever one is true.
 */

/** Created in production with public read, this limit, and these types. */
export const SITE_VIDEO_BUCKET = "site-video";

/** The bucket's own `file_size_limit`. Storage refuses anything above it. */
export const HARD_MAX_BYTES = 10 * 1024 * 1024;

/** Above this the panel warns and keeps going. See the header. */
export const WARN_BYTES = 4 * 1024 * 1024;

/**
 * What the bucket's `allowed_mime_types` accepts, refused earlier in the action
 * so the owner gets a sentence rather than a storage error.
 *
 * MP4 (H.264) and WebM only. Both play muted-autoplay everywhere this shop is
 * opened; MOV and AVI do not, and would upload happily and then not play.
 */
export const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/webm"] as const;

/**
 * A year, immutable. Every upload lands on a path with a random suffix, so a
 * given URL's bytes never change and re-fetching them is pure waste.
 *
 * This is set at upload time because it cannot be set afterwards without
 * rewriting the object: Storage stores `cacheControl` as metadata when the file
 * arrives. A file uploaded through the dashboard instead of this panel carries
 * the dashboard's default, which is `no-cache` — every repeat visitor
 * revalidates a file that is incapable of changing.
 */
export const VIDEO_CACHE_CONTROL = "31536000";

/** "2.6MB", "870KB" — the size, as the owner should read it. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
