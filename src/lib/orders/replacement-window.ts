/**
 * The 24-hour damage window, as arithmetic.
 *
 * Lived as a private helper inside the admin actions module until Phase 11 —
 * where it could not be tested, which turned out to be fitting, because it
 * had also never once returned anything but `null`: `delivered_at` was null
 * on every order that had ever existed (audit 11B), so the shop's stated
 * returns policy never had a clock behind it. Batch 0.4 made the timestamp
 * real; extracting this makes the window provable, and
 * `audit:delivery-poll` holds it to a real boolean on both delivery paths.
 *
 * Null still means "no timestamp" — `recordReplacement` renders that case
 * honestly rather than guessing — but it is now the exception, not the rule.
 */

/** 24 hours from delivery. Null when the order has no delivery timestamp. */
export function withinReplacementWindow(
  deliveredAt: string | null,
): boolean | null {
  if (!deliveredAt) return null;
  const at = new Date(deliveredAt).getTime();
  if (Number.isNaN(at)) return null;
  return Date.now() - at <= 24 * 60 * 60 * 1000;
}
