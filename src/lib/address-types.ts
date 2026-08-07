import type { ShippingAddress } from "@/lib/orders/types";

/**
 * The address book, as the browser sees it.
 *
 * Same structural reason as `cart-types.ts`: the checkout form is a Client
 * Component and needs this shape, `src/lib/queries/addresses.ts` is
 * `server-only`, and a type-only import across that line compiles today and
 * pulls the Supabase server client into the browser bundle one edit later. CI
 * greps for the import rather than trusting nobody will make that edit.
 *
 * Built on `ShippingAddress` rather than restating its seven fields, so a book
 * entry and the snapshot written onto an order cannot drift apart — an entry
 * is exactly a shippable address plus the two things that only matter while it
 * is still in a book.
 */
export type SavedAddress = ShippingAddress & {
  id: string;
  /** "Home", "Office". Free text, and usually absent. */
  label: string | null;
  /** Preselected at checkout. Exactly one per customer, enforced on write. */
  isDefault: boolean;
};
