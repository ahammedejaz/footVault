/**
 * Money and unit formatting. Market is India: INR, tax-inclusive, Indian digit
 * grouping (₹1,24,999). Every price in the UI goes through here so the grouping
 * and the symbol never drift between components.
 *
 * Prices are stored as integer paise in the database to avoid float drift, and
 * converted at the boundary by these helpers.
 */

const RUPEES = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

const RUPEES_WITH_PAISE = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Format integer paise as rupees: 899500 → "₹8,995". */
export function formatPaise(paise: number): string {
  const rupees = paise / 100;
  return Number.isInteger(rupees)
    ? RUPEES.format(rupees)
    : RUPEES_WITH_PAISE.format(rupees);
}

/** Format a rupee amount that is already a decimal number: 8995 → "₹8,995". */
export function formatRupees(rupees: number): string {
  return Number.isInteger(rupees)
    ? RUPEES.format(rupees)
    : RUPEES_WITH_PAISE.format(rupees);
}

/**
 * Discount percentage off, rounded down so we never overstate the saving.
 * Returns null when there is no genuine discount.
 */
export function discountPercent(
  basePaise: number,
  salePaise: number | null | undefined,
): number | null {
  if (!salePaise || salePaise >= basePaise || basePaise <= 0) return null;
  return Math.floor(((basePaise - salePaise) / basePaise) * 100);
}

const RELATIVE = new Intl.RelativeTimeFormat("en-IN", { numeric: "always" });

/**
 * "4 minutes ago", for a timestamp somebody is reading to decide whether
 * something is wrong right now. An absolute time makes them do the subtraction.
 *
 * It lived in `src/lib/payments/health.ts` until 2026-08-15, with a comment
 * explaining that it belonged there rather than here because it was only ever
 * applied to health timestamps. That stopped being true the moment a Client
 * Component needed it — and `health.ts` is `server-only`, so the import was a
 * build error, caught by the build and by nothing before it. `guard:client-imports`
 * did not see it: that guard names three server-only paths by hand and this was
 * a fourth. (It now derives the list from the tree; see the script.)
 *
 * Pure and `now` is injectable, so every branch is testable without a clock.
 */
export function relativeAge(iso: string, now = new Date()): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "at a time we cannot read";

  const seconds = Math.round((ms - now.getTime()) / 1_000);
  if (Math.abs(seconds) < 60) return RELATIVE.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return RELATIVE.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return RELATIVE.format(hours, "hour");
  return RELATIVE.format(Math.round(hours / 24), "day");
}
