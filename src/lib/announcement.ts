/**
 * The announcement bar's dismissal, as a cookie.
 *
 * The first attempt at this rendered the bar and then hid it before paint with
 * a blocking inline `<script>` that read localStorage. That script never ran.
 * React does not execute a `<script>` it renders — in a Client Component it is
 * inert markup, and React 19 warns as much ("Scripts inside React components
 * are never executed when rendering on the client"). So every returning
 * visitor saw the strip they had already dismissed, forever.
 *
 * A cookie fixes the mechanism rather than the symptom. The server knows the
 * dismissal before it renders, so the bar is simply absent from the HTML: no
 * flash, no layout shift, no inline script, no localStorage — and Safari in
 * private mode stops being a special case, because there is nothing for it to
 * throw on.
 *
 * The cost is honest and paid deliberately: reading a cookie in the layout
 * makes every route dynamic. That is why the chrome's queries moved behind
 * `unstable_cache` (src/lib/queries/cached.ts) — the render is per-request, but
 * the data behind it is not, so there is no database round trip on the LCP path.
 */

export const ANNOUNCEMENT_COOKIE = "fv_announce";

/** A year. Long enough that dismissing it means dismissing it. */
export const ANNOUNCEMENT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * The cookie holds the key of the announcement that was dismissed, not a bare
 * flag, so a *new* message from the owner comes back for everyone rather than
 * being suppressed by a decision the customer made about a different one.
 */
export function announcementKey(text: string): string {
  // djb2. Short, stable, and it only has to distinguish one announcement from
  // the next — there is nothing to attack here.
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = (hash * 33) ^ text.charCodeAt(i);
  return (hash >>> 0).toString(36);
}

/**
 * The shape `announcementKey` produces: base36, so 1–7 characters.
 *
 * The key arrives from the browser, and anything that arrives from a browser
 * and gets written into a `Set-Cookie` header is checked first. A key that does
 * not match is not an attack worth reporting, it is just not a key.
 */
export function isAnnouncementKey(value: string): boolean {
  return /^[0-9a-z]{1,7}$/.test(value);
}
