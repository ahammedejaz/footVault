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
