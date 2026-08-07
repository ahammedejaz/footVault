import "server-only";

import { getCurrentUser } from "@/lib/auth";
import { PRODUCT_FIELDS, toSummary, type RawProduct } from "@/lib/queries/catalog";
import { rows } from "@/lib/queries/run";
import type { ProductSummary } from "@/lib/catalog-types";
import { createClient } from "@/lib/supabase/server";

/**
 * Saved items.
 *
 * Unlike the bag, this has no anonymous half: a wishlist keyed to a browser
 * cookie is a wishlist that dies with the browser, which is the opposite of
 * what saving something is for. Signed out, every read here is zero and the
 * heart prompts to sign in.
 */

/** Just the badge number. */
export async function getWishlistCount(): Promise<number> {
  const user = await getCurrentUser();
  if (!user) return 0;

  const supabase = await createClient();
  const { count, error } = await supabase
    .from("wishlist_items")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);

  if (error) {
    console.error("[wishlist] count failed:", error.message);
    return 0;
  }
  return count ?? 0;
}

/**
 * Which products this customer has saved.
 *
 * Ids rather than rows, because the callers are hearts on a grid: the product
 * card needs to know whether *this* one is saved, and a Set answers that
 * without a query per card.
 */
export async function getSavedProductIds(): Promise<Set<string>> {
  const user = await getCurrentUser();
  if (!user) return new Set();

  const supabase = await createClient();
  const saved = await rows<{ product_id: string }>(
    "getSavedProductIds",
    supabase.from("wishlist_items").select("product_id").eq("user_id", user.id),
  );
  return new Set(saved.map((row) => row.product_id));
}

/**
 * The saved list itself.
 *
 * Full product summaries rather than names and prices, because the page has to
 * offer move-to-bag — and that needs the size run, the colourways and the
 * variant behind each chip, which is exactly what a summary carries. Reusing
 * the catalog's own projection keeps a saved product and a listed product the
 * same shape, so the card and the size strip behave identically in both places.
 *
 * Newest first: the last thing you saved is the thing you are still thinking
 * about.
 */
export async function getWishlist(): Promise<ProductSummary[]> {
  const user = await getCurrentUser();
  if (!user) return [];

  const supabase = await createClient();

  const saved = await rows<{ product_id: string; created_at: string }>(
    "getWishlist.ids",
    supabase
      .from("wishlist_items")
      .select("product_id, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),
  );
  if (saved.length === 0) return [];

  const products = await rows<RawProduct>(
    "getWishlist.products",
    supabase
      .from("products")
      .select(PRODUCT_FIELDS)
      .in("id", saved.map((row) => row.product_id))
      .eq("is_active", true)
      .is("deleted_at", null)
      .overrideTypes<RawProduct[]>(),
  );

  // The `in` filter loses the saved order, so it is reapplied here rather than
  // left to whatever the planner returned.
  const order = new Map(saved.map((row, index) => [row.product_id, index]));
  return products
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map(toSummary);
}
