import Link from "next/link";

import { AnnouncementDismiss } from "@/components/storefront/announcement-dismiss";
import { prerenderOrDefer } from "@/lib/prerender";
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
 * without a deploy, and `is_active: false` removes the strip entirely rather
 * than leaving an empty band.
 *
 * Dismissal is the interesting part. Rendering the bar and then hiding it in an
 * effect is a layout shift on every page load for anyone who has dismissed it —
 * the header and everything under it jump up by 33px. Reading a cookie on the
 * server would avoid that but makes every page in the layout dynamic, which
 * costs a database round trip on the LCP path of every route on the site.
 *
 * So: the bar renders, and a blocking inline script sets an attribute on <html>
 * from localStorage before first paint. The strip is `display: none` from the
 * first frame — nothing to shift, nothing to render on the server per visitor.
 *
 * The key is derived from the copy, so a *new* announcement comes back for
 * everyone. An owner who changes the message expects it to be seen.
 */
function keyFor(text: string): string {
  // djb2. Short, stable, and it only has to distinguish one announcement from
  // the next — there is nothing to attack here.
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = (hash * 33) ^ text.charCodeAt(i);
  return (hash >>> 0).toString(36);
}

export async function AnnouncementBar() {
  const settings = await prerenderOrDefer("announcement", getSiteSettings);
  const announcement = setting<AnnouncementSettings>(settings, "announcement", {
    text: "Free returns within 7 days",
    href: "/page/returns",
    is_active: true,
  });

  if (!announcement.is_active || !announcement.text) return null;
  const key = keyFor(announcement.text);

  const content = (
    <span className="font-mono text-xs tracking-[0.06em]">{announcement.text}</span>
  );

  return (
    <>
      <script
        // Runs before paint. `try` because Safari in private mode throws on
        // localStorage, and an announcement bar is not worth a blank page.
        dangerouslySetInnerHTML={{
          __html: `try{if(localStorage.getItem('fv-announce')===${JSON.stringify(key)})document.documentElement.setAttribute('data-fv-announce','off')}catch(e){}`,
        }}
      />
      {/* The hiding rule lives in globals.css next to the rest of the
          document-level state, so the attribute and the selector that reads it
          are one edit apart. */}
      {/* A landmark, not a bare div: content outside header / main / footer is
          content a screen-reader user cannot navigate to by region. */}
      <aside
        aria-label="Store announcement"
        data-announcement
        data-surface="ink"
        className="border-b border-white/10"
      >
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-2">
          <p className="flex-1 text-center">
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
          </p>
          <AnnouncementDismiss storageKey={key} />
        </div>
      </aside>
    </>
  );
}
