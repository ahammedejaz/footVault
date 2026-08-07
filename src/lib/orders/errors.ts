import type { OutOfStockItem } from "@/lib/orders/types";

/**
 * The words `create_order_with_stock` uses to refuse, and how to read them.
 *
 * A plpgsql `raise` reaches supabase-js as a PostgrestError whose `code` is the
 * SQLSTATE and whose `details` is the DETAIL clause. So the function raises
 * SQLSTATEs from classes Postgres does not use, and this file is the only place
 * that knows what they mean — the alternative is the checkout action matching
 * on `error.message === "out_of_stock"`, which survives exactly until somebody
 * rewords the message.
 *
 * No server dependency and no Supabase import: this is a vocabulary, and both
 * the action and any future admin tool need it.
 */
export const CHECKOUT_SQLSTATE = {
  /** The cart is empty, or every line in it died before the transaction ran. */
  emptyCart: "MTCRT",
  /** At least one line exceeds stock. `details` carries the items. */
  outOfStock: "OSTCK",
  /** The cart is missing, is not the caller's, or has already become an order. */
  cartUnavailable: "CNVRT",
} as const;

/**
 * The DETAIL clause, turned back into the items the page has to name.
 *
 * Defensive to the point of paranoia about a payload that came out of the
 * database as text: a checkout that has already succeeded in claiming nothing
 * must not then fail to render its own error. Anything unparseable yields an
 * empty list, and the caller falls back to a generic message rather than
 * throwing on top of a throw.
 */
export function parseOutOfStockItems(details: string | null | undefined): OutOfStockItem[] {
  if (!details) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(details);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const items: OutOfStockItem[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const productName = typeof row.productName === "string" ? row.productName : null;
    const size = typeof row.size === "string" ? row.size : "";
    const requested = typeof row.requested === "number" ? row.requested : null;
    const available = typeof row.available === "number" ? row.available : 0;
    if (!productName || requested === null) continue;
    items.push({ productName, size, requested, available });
  }
  return items;
}

/**
 * One sentence a customer can act on.
 *
 * Names the item and the size, because "some items are out of stock" makes the
 * customer re-derive which ones from a bag they have stopped looking at.
 */
export function describeOutOfStock(items: OutOfStockItem[]): string {
  if (items.length === 0) {
    return "Something in your bag sold out while you were checking out. Your bag is unchanged.";
  }

  const phrases = items.map((item) => {
    const what = item.size ? `${item.productName} in ${item.size}` : item.productName;
    return item.available === 0
      ? `${what} is sold out`
      : `${what} has only ${item.available} left, and you asked for ${item.requested}`;
  });

  const list =
    phrases.length === 1
      ? phrases[0]
      : `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;

  return `${list}. Nothing has been charged and your bag is unchanged.`;
}
