import { cookies } from "next/headers";
import Link from "next/link";

import { AnnouncementStrip } from "@/components/storefront/announcement-strip";
import { ANNOUNCEMENT_COOKIE, announcementKey } from "@/lib/announcement";
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
    text: "Free returns within 7 days",
    href: "/page/returns",
    is_active: true,
  });

  if (!announcement.is_active || !announcement.text) return null;

  const key = announcementKey(announcement.text);
  if (cookieStore.get(ANNOUNCEMENT_COOKIE)?.value === key) return null;

  const content = (
    <span className="font-mono text-xs tracking-[0.06em]">
      {announcement.text}
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
