import { RETURN_WINDOW_DAYS } from "@/lib/site-config";

/**
 * The thin navy strip above the header. Mono at 12px with open tracking —
 * the same treatment as the size run, so the two read as one voice.
 *
 * Copy moves to site_settings in Phase 7; the dismiss control arrives with it,
 * since a bar the owner cannot edit is not worth letting people close.
 */
export function AnnouncementBar() {
  return (
    <div data-surface="ink" className="border-b border-white/10">
      <p className="mx-auto flex max-w-7xl items-center justify-center gap-2 px-4 py-2 text-center font-mono text-xs tracking-[0.06em]">
        Free returns within {RETURN_WINDOW_DAYS} days
      </p>
    </div>
  );
}
