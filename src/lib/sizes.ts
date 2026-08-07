/**
 * Size-run ordering.
 *
 * Sizes are text in the database — UK 8.5, EU 42 and kids' 12C all have to fit
 * in one column — which means they sort as strings unless something orders
 * them. As strings, "10" comes before "6", and the size run on every card and
 * every product page reads as nonsense.
 *
 * Kids' sizes run 10C, 11C, 12C, 13C and then continue at 1, 2, 3 — a junior 1
 * is a whole size larger than a 13C, not eleven sizes smaller — so the "C"
 * sizes sort as negative numbers to keep the run in the order a parent expects.
 */

export function sizeSortKey(size: string): number {
  const trimmed = size.trim().toUpperCase();
  const child = trimmed.endsWith("C");
  const value = Number.parseFloat(child ? trimmed.slice(0, -1) : trimmed);
  if (Number.isNaN(value)) return Number.POSITIVE_INFINITY;
  // 13C -> -1, 10C -> -4, so the child run stays ordered and sits below 1.
  return child ? value - 14 : value;
}

export function compareSizes(a: string, b: string): number {
  const delta = sizeSortKey(a) - sizeSortKey(b);
  return delta !== 0 ? delta : a.localeCompare(b);
}
