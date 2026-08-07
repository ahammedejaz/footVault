import type { Database } from "@/lib/database.types";

/**
 * The bag, as the browser sees it.
 *
 * Separate from src/lib/queries/cart.ts for the same reason catalog-types.ts is
 * separate from the catalog queries: those modules are `server-only`, and a
 * Client Component that imports a *type* from one compiles perfectly well today
 * because the import is erased — and is one careless edit away from pulling the
 * Supabase server client into the browser bundle. CI greps for the import
 * rather than trusting that nobody will make that edit, so the types live
 * somewhere with no server dependency and the question does not arise.
 */

// Referenced so the file has a real dependency on the schema it describes:
// if `cart_status` is ever renamed, this stops compiling.
export type CartStatus = Database["public"]["Enums"]["cart_status"];

export type CartLine = {
  id: string;
  variantId: string;
  productSlug: string;
  productName: string;
  brand: string | null;
  size: string;
  color: string;
  sku: string;
  imageUrl: string | null;
  imageAlt: string;
  /** Live effective price, in paise. */
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  /** Live stock, so the stepper knows where to stop. */
  stock: number;
};

/** Something changed under the customer since they put this in the bag. */
export type CartAdjustment =
  | { kind: "price"; name: string; size: string; from: number; to: number }
  | { kind: "stock"; name: string; size: string; from: number; to: number }
  | { kind: "gone"; name: string; size: string };

export type FreeShipping = {
  thresholdPaise: number;
  feePaise: number;
  remainingPaise: number;
  qualified: boolean;
};

export type Cart = {
  id: string | null;
  lines: CartLine[];
  /** Total units, which is what the header badge counts. */
  count: number;
  subtotal: number;
  adjustments: CartAdjustment[];
  freeShipping: FreeShipping;
};
