import { cookies } from "next/headers";
import Link from "next/link";

import { AnnouncementStrip } from "@/components/storefront/announcement-strip";
import {
  ANNOUNCEMENT_COOKIE,
  announcementIsLive,
  announcementKey,
} from "@/lib/announcement";
import { contentTokens, fillTokens } from "@/lib/content-tokens";
import { prerenderOrDefer } from "@/lib/prerender";
import { cachedSiteSettings } from "@/lib/queries/cached";
import { setting, type AnnouncementSettings } from "@/lib/queries/content";

/**
 * The thin navy strip above the header. Mono at 12px with open tracking — the
 * same treatment as the size run, so the two read as one voice.
 *
 * The copy is a site setting, so the owner changes it from /admin/settings
 * without a deploy, and `is_active: false` removes the strip entirely rather
 * than leaving an empty band.
 *
 * Dismissal is decided here, on the server, from a cookie: a customer who has
 * closed this announcement is served HTML that never contained it. Nothing
 * renders and vanishes, so there is no flash and no 33px shift of the header
 * and everything under it. See src/lib/announcement.ts for what this replaced
 * and what it costs.
 */
export async function AnnouncementBar() {
  const [settings, cookieStore] = await Promise.all([
    prerenderOrDefer("announcement", cachedSiteSettings),
    cookies(),
  ]);

  const announcement = setting<AnnouncementSettings>(settings, "announcement", {
    // Must not promise more than the returns page delivers: this renders
    // when site_settings is unreachable, which is exactly when nobody is
    // watching what it says.
    text: "Damage on arrival? Tell us within 24 hours",
    href: "/page/returns",
    is_active: true,
    starts_at: null,
    ends_at: null,
  });

  /*
    The scheduling window, checked per request — this component already reads a
    cookie, so it renders dynamically and the clock is the request's. The
    semantics (inclusive start, exclusive end, malformed dates failing open)
    live with the dismissal mechanics in src/lib/announcement.ts.
  */
  if (
    !announcement.is_active ||
    !announcement.text ||
    !announcementIsLive(announcement)
  )
    return null;

  /**
   * The strip carried "Free shipping over ₹2,499" above every page on the site
   * while the setting said ₹6,499. Typed prose cannot hold a number the owner
   * changes elsewhere, so it holds a token instead.
   *
   * **The dismissal key is hashed from the raw text, before substitution.**
   * Hashing the filled text would bring the strip back for everyone the moment
   * the owner nudges the free-delivery threshold — the message has not changed,
   * only a figure inside it, and somebody who dismissed it has not asked to see
   * it again.
   */
  const key = announcementKey(announcement.text);
  const text = fillTokens(announcement.text, await contentTokens());
  if (cookieStore.get(ANNOUNCEMENT_COOKIE)?.value === key) return null;

  const content = (
    <span className="font-mono text-xs tracking-[0.06em]">
      {text}
    </span>
  );

  return (
    <AnnouncementStrip announcementKey={key}>
      {announcement.href ? (
        <Link
          href={announcement.href}
          className="hit-44 hover:text-orange inline-flex min-h-8 items-center transition-colors"
        >
          {content}
        </Link>
      ) : (
        content
      )}
    </AnnouncementStrip>
  );
}
