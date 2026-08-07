import Link from "next/link";

import {
  getSiteSettings,
  setting,
  type AnnouncementSettings,
} from "@/lib/queries/content";

/**
 * The thin navy strip above the header. Mono at 12px with open tracking — the
 * same treatment as the size run, so the two read as one voice.
 *
 * The copy is a site setting, so the owner changes it from /admin/settings
 * without a deploy. `is_active: false` removes the strip entirely rather than
 * leaving an empty band.
 */
export async function AnnouncementBar() {
  const settings = await getSiteSettings();
  const announcement = setting<AnnouncementSettings>(settings, "announcement", {
    text: "Free returns within 7 days",
    href: "/page/returns",
    is_active: true,
  });

  if (!announcement.is_active || !announcement.text) return null;

  const content = (
    <span className="font-mono text-xs tracking-[0.06em]">{announcement.text}</span>
  );

  return (
    <div data-surface="ink" className="border-b border-white/10">
      <p className="mx-auto flex max-w-7xl items-center justify-center gap-2 px-4 py-2 text-center">
        {announcement.href ? (
          <Link
            href={announcement.href}
            className="hover:text-orange inline-flex min-h-8 items-center transition-colors"
          >
            {content}
          </Link>
        ) : (
          content
        )}
      </p>
    </div>
  );
}
