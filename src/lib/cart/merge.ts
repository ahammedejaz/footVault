import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { maybeRow, rows } from "@/lib/queries/run";
import { MAX_LINE_QUANTITY } from "@/lib/validations/cart";

/**
 * Folding the guest bag into the account bag, at the moment of signing in.
 *
 * This is the behaviour the phase is really about. Three shoes go in as a
 * guest, Google happens, and all three are still there — combined with whatever
 * was already in the account from another device, quantities summed, each line
 * capped at what the shop actually holds.
 *
 * It runs inside /auth/callback, after the code exchange, and it needs one
 * client that can see *both* bags at once. That is exactly what the callback's
 * client is: it was constructed while the guest cookie was still set, so it
 * carries the `x-guest-token` header the anonymous cart policy matches on, and
 * after the exchange it also carries the new session the account cart policy
 * matches on. Both halves are still governed by RLS — nothing here runs with
 * elevated privileges.
 *
 * Failure must never cost the customer their sign-in. If this throws, the caller
 * leaves the guest token alone, so the bag is still reachable and the next
 * sign-in tries again; a lost session with an intact cart is a worse trade than
 * a delayed merge.
 *
 * The token is a parameter and cookies are the caller's problem. That is partly
 * layering — this is a statement about two rows in a database, not about HTTP —
 * and partly so the behaviour can actually be tested end to end without a
 * browser: scripts/audit/cart-merge.ts calls straight into it.
 */

export type MergeOutcome = {
  /** Lines that moved across or were added into an existing line. */
  merged: number;
  /** Lines that could not come: sold out or withdrawn while they were away. */
  dropped: number;
  /** True once the guest bag is gone, which is when its cookie may be dropped. */
  guestCartConsumed: boolean;
};

export async function mergeGuestCartIntoAccount(
  supabase: SupabaseClient<Database>,
  userId: string,
  guestToken: string | null,
): Promise<MergeOutcome> {
  const empty: MergeOutcome = { merged: 0, dropped: 0, guestCartConsumed: false };

  if (!guestToken) return empty;

  const guestCart = await maybeRow<{ id: string }>(
    "merge.guestCart",
    supabase
      .from("carts")
      .select("id")
      .eq("status", "active")
      .eq("guest_token", guestToken)
      .maybeSingle(),
  );

  // A token with no bag behind it is just a stale cookie; say it is spent so
  // the caller stops sending it.
  if (!guestCart) return { ...empty, guestCartConsumed: true };

  const guestLines = await rows<{
    variant_id: string;
    quantity: number;
    unit_price_seen: number | null;
  }>(
    "merge.guestLines",
    supabase
      .from("cart_items")
      .select("variant_id, quantity, unit_price_seen")
      .eq("cart_id", guestCart.id),
  );

  if (guestLines.length === 0) {
    return { ...empty, guestCartConsumed: await dropGuestCart(supabase, guestCart.id) };
  }

  const accountCartId = await getOrCreateAccountCart(supabase, userId);

  const accountLines = await rows<{ id: string; variant_id: string; quantity: number }>(
    "merge.accountLines",
    supabase.from("cart_items").select("id, variant_id, quantity").eq("cart_id", accountCartId),
  );
  const byVariant = new Map(accountLines.map((line) => [line.variant_id, line]));

  // Live stock for everything involved, in one round trip rather than one per
  // line — a bag with eight lines should not cost eight queries at the exact
  // moment somebody is watching a redirect.
  const variantIds = guestLines.map((line) => line.variant_id);
  const variants = await rows<{
    id: string;
    stock_quantity: number;
    is_active: boolean;
    price_override: number | null;
    product: {
      is_active: boolean;
      deleted_at: string | null;
      effective_price: number | null;
      base_price: number;
    } | null;
  }>(
    "merge.variants",
    supabase
      .from("product_variants")
      .select(
        `id, stock_quantity, is_active, price_override,
         product:products!inner ( is_active, deleted_at, effective_price, base_price )`,
      )
      .in("id", variantIds)
      .overrideTypes<
        {
          id: string;
          stock_quantity: number;
          is_active: boolean;
          price_override: number | null;
          product: {
            is_active: boolean;
            deleted_at: string | null;
            effective_price: number | null;
            base_price: number;
          } | null;
        }[]
      >(),
  );
  const stockById = new Map(variants.map((variant) => [variant.id, variant]));

  let merged = 0;
  let dropped = 0;

  for (const line of guestLines) {
    const variant = stockById.get(line.variant_id);
    const product = variant?.product;

    const sellable =
      variant && product && variant.is_active && product.is_active && !product.deleted_at;

    if (!sellable || variant.stock_quantity <= 0) {
      dropped++;
      continue;
    }

    const existing = byVariant.get(line.variant_id);
    const ceiling = Math.min(variant.stock_quantity, MAX_LINE_QUANTITY);
    const quantity = Math.min((existing?.quantity ?? 0) + line.quantity, ceiling);
    const unitPrice = variant.price_override ?? product.effective_price ?? product.base_price;

    const error = existing
      ? (
          await supabase
            .from("cart_items")
            .update({ quantity, unit_price_seen: line.unit_price_seen ?? unitPrice })
            .eq("id", existing.id)
        ).error
      : (
          await supabase.from("cart_items").insert({
            cart_id: accountCartId,
            variant_id: line.variant_id,
            quantity,
            // The price they last saw as a guest travels with the line, so a
            // change that happened while they were signing in is still reported.
            unit_price_seen: line.unit_price_seen ?? unitPrice,
          })
        ).error;

    if (error) {
      console.error("[cart] merge line failed:", error.message, error.code);
      dropped++;
      continue;
    }
    merged++;
  }

  return { merged, dropped, guestCartConsumed: await dropGuestCart(supabase, guestCart.id) };
}

/** The account's active cart, created if signing in is their first bag. */
async function getOrCreateAccountCart(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<string> {
  const existing = await maybeRow<{ id: string }>(
    "merge.accountCart",
    supabase
      .from("carts")
      .select("id")
      .eq("status", "active")
      .eq("user_id", userId)
      .maybeSingle(),
  );
  if (existing) return existing.id;

  const { data, error } = await supabase
    .from("carts")
    .insert({ user_id: userId })
    .select("id")
    .single();

  if (error) {
    if (error.code !== "23505") {
      throw new Error(`merge.createAccountCart: ${error.message} [${error.code}]`);
    }
    const raced = await maybeRow<{ id: string }>(
      "merge.accountCart.raced",
      supabase
        .from("carts")
        .select("id")
        .eq("status", "active")
        .eq("user_id", userId)
        .maybeSingle(),
    );
    if (!raced) throw new Error("merge: cart insert conflicted but no active cart exists");
    return raced.id;
  }

  return data.id;
}

/**
 * The guest bag is gone once its contents have a home.
 *
 * Deleted rather than marked abandoned: the row is keyed by a token that is
 * about to be thrown away, so nothing could ever reach it again, and cart_items
 * cascades. Returns whether it actually went — the caller only drops the cookie
 * on a true, because while the cookie exists the bag is still findable, and
 * that is what makes a half-finished merge recoverable.
 */
async function dropGuestCart(
  supabase: SupabaseClient<Database>,
  guestCartId: string,
): Promise<boolean> {
  const { error } = await supabase.from("carts").delete().eq("id", guestCartId);
  if (error) {
    console.error("[cart] could not delete the merged guest cart:", error.message);
    return false;
  }
  return true;
}
