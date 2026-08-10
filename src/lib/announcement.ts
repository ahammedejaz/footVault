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

/**
 * Whether a scheduled announcement is inside its window right now.
 *
 * Starts is inclusive, ends is exclusive. A date that fails to parse is NaN,
 * every NaN comparison is false, and both clauses fall through to **showing**
 * the strip — deliberate: a malformed date producing a visible strip is
 * reported within the hour; a strip silently withheld by a typo is not.
 * Well-formedness is `saveAnnouncement`'s job; this only answers "is it now".
 *
 * A plain function rather than logic in the bar's render, because it reads the
 * clock: the announcement bar already renders per request (it reads the
 * dismissal cookie), so request-time is the right time — but a clock read
 * belongs in a named, honestly-impure helper, not loose in a component body.
 */
export function announcementIsLive(window: {
  starts_at?: string | null;
  ends_at?: string | null;
}): boolean {
  const now = Date.now();
  const startsAt = window.starts_at ? Date.parse(window.starts_at) : null;
  const endsAt = window.ends_at ? Date.parse(window.ends_at) : null;
  return !(
    (startsAt !== null && now < startsAt) ||
    (endsAt !== null && now >= endsAt)
  );
}

/**
 * A stored ISO instant, as the wall-clock string `datetime-local` edits.
 *
 * Rendered in Asia/Kolkata regardless of the machine: `saveAnnouncement` pins
 * the wall time to +05:30, so the display side must read it back in the same
 * zone or the value would drift by the viewer's timezone on every open-and-
 * save. Lives here — a plain shared module — because the settings *page* is a
 * Server Component and the form is a Client Component, and both need it; an
 * export of a "use client" module is a client reference on the server, not a
 * callable function. That exact mistake broke the whole settings page for one
 * commit, and `audit:settings-controls` caught it as eight missing labels.
 */
export function istWallClock(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const at = new Date(ms);
  const date = at.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const time = at.toLocaleTimeString("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${date}T${time}`;
}
