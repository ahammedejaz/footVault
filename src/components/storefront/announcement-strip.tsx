"use client";

import { useState } from "react";
import { X } from "lucide-react";

import { dismissAnnouncement } from "@/lib/actions/announcement";

/**
 * The strip itself, and the one client-side thing about it: closing.
 *
 * `children` is rendered on the server and passed through, so the announcement
 * copy and its link stay server markup — this component exists only to own the
 * dismissed state, not the content.
 *
 * The button is a real form bound to a Server Action, so it works with
 * JavaScript disabled: the post sets the cookie and the server renders the next
 * page without the strip. With JavaScript, the click hides it on the spot so
 * nobody waits for a round trip to watch a bar close.
 *
 * Hidden, not unmounted — and that distinction is the whole reason this
 * component has a comment. Returning null on click removes the `<form>` from
 * the tree while its own submission is still in flight, so the action never
 * reaches the server: the bar vanished, the cookie was never written, and it
 * came back on the next load. `hidden` collapses it just as instantly and
 * leaves the form alive long enough to finish what the click started.
 */
export function AnnouncementStrip({
  announcementKey,
  children,
}: {
  announcementKey: string;
  children: React.ReactNode;
}) {
  const [dismissed, setDismissed] = useState(false);

  return (
    /* A landmark, not a bare div: content outside header / main / footer is
       content a screen-reader user cannot navigate to by region. */
    <aside
      hidden={dismissed}
      aria-label="Store announcement"
      // A stable hook for scripts/audit/interactions.ts. The strip's classes
      // are styling and may change; this is what the audit is allowed to hold
      // on to.
      data-announcement
      data-surface="ink"
      className="border-b border-white/10"
    >
      <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-2">
        <p className="flex-1 text-center">{children}</p>
        <form action={dismissAnnouncement.bind(null, announcementKey)}>
          <button
            type="submit"
            aria-label="Dismiss this announcement"
            onClick={() => setDismissed(true)}
            className="hit-44 -my-2 flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-white/10"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </form>
      </div>
    </aside>
  );
}
