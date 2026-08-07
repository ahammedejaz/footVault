"use client";

import { X } from "lucide-react";

/**
 * Dismissing the announcement.
 *
 * Writes the key of the announcement it dismissed, so a *different* message
 * from the owner comes back rather than being suppressed by a decision the
 * customer made about something else.
 *
 * The attribute on <html> is what hides it, set by the same expression the
 * inline script in announcement-bar.tsx uses — so the state is identical
 * whether it was dismissed a second ago or a week ago.
 */
export function AnnouncementDismiss({ storageKey }: { storageKey: string }) {
  return (
    <button
      type="button"
      aria-label="Dismiss this announcement"
      onClick={() => {
        try {
          localStorage.setItem("fv-announce", storageKey);
        } catch {
          // Private mode. The bar still closes for this page view, which is
          // the part the customer asked for.
        }
        document.documentElement.setAttribute("data-fv-announce", "off");
      }}
      className="hit-44 -my-2 flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-white/10"
    >
      <X className="size-3.5" aria-hidden />
    </button>
  );
}
