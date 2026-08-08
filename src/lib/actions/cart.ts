"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth";
import { getOrCreateGuestToken, readGuestToken } from "@/lib/cart/token";
import { maybeRow, rows } from "@/lib/queries/run";
import { createClient } from "@/lib/supabase/server";
import {
  addToBagSchema,
  removeLineSchema,
  setQuantitySchema,
  MAX_LINE_QUANTITY,
} from "@/lib/validations/cart";

/**
 * Changing the bag.
 *
 * Every action here validates with Zod before it touches the database, returns
 * a typed result rather than throwing at the customer, and re-reads price and
 * stock from the catalog. The client sends identifiers and quantities; it is
 * never asked for and never believed about anything else.
 *
 * **The reservation model.** Adding to a bag does not reserve stock. Two
 * customers can both hold the last pair, and both bags are honest about that —
 * quantities are capped at what exists *now*, and re-capped on every read. The
 * unit is claimed in Phase 5, where checkout decrements stock in a transaction
 * and exactly one of the two succeeds. Reserving at add-time would be worse for
 * this shop, not better: an abandoned bag would hold real stock hostage for as
 * long as the browser lived, and the seed catalog runs to single figures in
 * some sizes. The promise the cart makes is "this is what we hold right now",
 * not "this is yours".
 */

export type ActionResult<T = undefined> =
  { ok: true; data: T } | { ok: false; message: string };

const GENERIC = "That did not save. Try again.";

/** Everything the undo affordance needs to put a removed line back. */
export type RemovedLine = {
  variantId: string;
  quantity: number;
  name: string;
  size: string;
};

/* ------------------------------------------------------------------ shared -- */

type Sellable = {
  variantId: string;
  stock: number;
  unitPrice: number;
  name: string;
  size: string;
};

/**
 * Is this variant something we can sell right now, and for how much?
 *
 * The join is `!inner` on an active, non-deleted product on purpose: a variant
 * whose product was retired is not sellable however alive the variant row is.
 */
async function readSellable(variantId: string): Promise<Sellable | null> {
  const supabase = await createClient();
  const row = await maybeRow<{
    id: string;
    size: string;
    stock_quantity: number;
    price_override: number | null;
    product: {
      name: string;
      is_active: boolean;
      deleted_at: string | null;
      effective_price: number | null;
      base_price: number;
    } | null;
  }>(
    `readSellable(${variantId})`,
    supabase
      .from("product_variants")
      .select(
        `id, size, stock_quantity, price_override,
         product:products!inner ( name, is_active, deleted_at, effective_price, base_price )`,
      )
      .eq("id", variantId)
      .eq("is_active", true)
      .maybeSingle(),
  );

  const product = row?.product;
  if (!row || !product || !product.is_active || product.deleted_at) return null;

  return {
    variantId: row.id,
    stock: row.stock_quantity,
    unitPrice:
      row.price_override ?? product.effective_price ?? product.base_price,
    name: product.name,
    size: row.size,
  };
}

/**
 * The caller's active cart, created if this is their first item.
 *
 * The partial unique indexes on `carts` mean two simultaneous adds cannot end
 * up with two active carts and a split bag — the second insert loses with
 * 23505, and re-selecting finds the row the first one wrote.
 */
async function getOrCreateCartId(): Promise<string> {
  const user = await getCurrentUser();
  // Minted before the client is built: createClient() reads the guest cookie at
  // construction to forward it to PostgREST, so a token created afterwards
  // would not be on the request that needs it.
  const guestToken = user ? null : await getOrCreateGuestToken();

  const supabase = await createClient();
  const owner = user
    ? { column: "user_id" as const, value: user.id }
    : { column: "guest_token" as const, value: guestToken! };

  const existing = await maybeRow<{ id: string }>(
    "getOrCreateCartId.select",
    supabase
      .from("carts")
      .select("id")
      .eq("status", "active")
      .eq(owner.column, owner.value)
      .maybeSingle(),
  );
  if (existing) return existing.id;

  const { data, error } = await supabase
    .from("carts")
    .insert({ [owner.column]: owner.value })
    .select("id")
    .single();

  if (error) {
    if (error.code !== "23505") {
      throw new Error(
        `getOrCreateCartId.insert: ${error.message} [${error.code}]`,
      );
    }
    // Lost the race. The winner's cart is the one we want.
    const raced = await maybeRow<{ id: string }>(
      "getOrCreateCartId.raced",
      supabase
        .from("carts")
        .select("id")
        .eq("status", "active")
        .eq(owner.column, owner.value)
        .maybeSingle(),
    );
    if (!raced)
      throw new Error(
        "getOrCreateCartId: insert conflicted but no active cart exists",
      );
    return raced.id;
  }

  return data.id;
}

/** The bag changed, so the page and the header badge both need re-rendering. */
function refreshBag(): void {
  revalidatePath("/", "layout");
}

/* -------------------------------------------------------------------- add -- */

/** Everything the toast needs to describe what happened and to take it back. */
export type AddedToBag = {
  itemId: string;
  name: string;
  size: string;
  /** How many this call actually added, after capping. */
  added: number;
  /** What the line held before, so undo restores rather than removes. */
  previousQuantity: number;
};

export async function addToBag(input: {
  variantId: string;
  quantity?: number;
}): Promise<ActionResult<AddedToBag>> {
  const parsed = addToBagSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "That size is not available.",
    };
  }

  try {
    const sellable = await readSellable(parsed.data.variantId);
    if (!sellable)
      return { ok: false, message: "That size is no longer available." };
    if (sellable.stock <= 0) {
      return {
        ok: false,
        message: `${sellable.name} in ${sellable.size} is sold out.`,
      };
    }

    const cartId = await getOrCreateCartId();
    const supabase = await createClient();

    const existing = await maybeRow<{ id: string; quantity: number }>(
      "addToBag.existing",
      supabase
        .from("cart_items")
        .select("id, quantity")
        .eq("cart_id", cartId)
        .eq("variant_id", sellable.variantId)
        .maybeSingle(),
    );

    // Adding the same size twice bumps the line rather than making a second
    // one, capped by what actually exists and by the per-line ceiling.
    const ceiling = Math.min(sellable.stock, MAX_LINE_QUANTITY);
    const wanted = (existing?.quantity ?? 0) + parsed.data.quantity;
    const quantity = Math.min(wanted, ceiling);

    if (existing && quantity === existing.quantity) {
      return {
        ok: false,
        message:
          sellable.stock <= MAX_LINE_QUANTITY
            ? `Only ${sellable.stock} left in ${sellable.size}, and they are already in your bag.`
            : `Up to ${MAX_LINE_QUANTITY} per size.`,
      };
    }

    // `(await …).error` rather than a destructured binding: a write has no data
    // to unwrap, and this is the shape footvault/no-unchecked-supabase-error
    // recognises as "the error is the only thing read", which is the point.
    let itemId = existing?.id ?? null;
    let error = null;

    if (existing) {
      error = (
        await supabase
          .from("cart_items")
          .update({ quantity, unit_price_seen: sellable.unitPrice })
          .eq("id", existing.id)
      ).error;
    } else {
      // `select("id")` on the insert so undo has something to address without a
      // second round trip.
      const { data: inserted, error: insertError } = await supabase
        .from("cart_items")
        .insert({
          cart_id: cartId,
          variant_id: sellable.variantId,
          quantity,
          unit_price_seen: sellable.unitPrice,
        })
        .select("id")
        .maybeSingle();
      error = insertError;
      itemId = inserted?.id ?? null;
    }

    if (error || !itemId) {
      console.error(
        "[cart] addToBag failed:",
        error?.message ?? "no row id",
        error?.code,
      );
      return { ok: false, message: GENERIC };
    }

    refreshBag();
    return {
      ok: true,
      data: {
        itemId,
        name: sellable.name,
        size: sellable.size,
        added: quantity - (existing?.quantity ?? 0),
        previousQuantity: existing?.quantity ?? 0,
      },
    };
  } catch (error) {
    console.error("[cart] addToBag threw:", error);
    return { ok: false, message: GENERIC };
  }
}

/* --------------------------------------------------------------- quantity -- */

export async function setQuantity(input: {
  itemId: string;
  quantity: number;
}): Promise<ActionResult<{ quantity: number; capped: boolean }>> {
  const parsed = setQuantitySchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: GENERIC };

  try {
    const supabase = await createClient();

    // RLS scopes this to the caller's own cart, so a forged item id finds
    // nothing rather than somebody else's line.
    const line = await maybeRow<{ id: string; variant_id: string }>(
      "setQuantity.line",
      supabase
        .from("cart_items")
        .select("id, variant_id")
        .eq("id", parsed.data.itemId)
        .maybeSingle(),
    );
    if (!line)
      return { ok: false, message: "That item is no longer in your bag." };

    if (parsed.data.quantity === 0) {
      const { error } = await supabase
        .from("cart_items")
        .delete()
        .eq("id", line.id);
      if (error) {
        console.error("[cart] setQuantity delete failed:", error.message);
        return { ok: false, message: GENERIC };
      }
      refreshBag();
      return { ok: true, data: { quantity: 0, capped: false } };
    }

    const sellable = await readSellable(line.variant_id);
    if (!sellable || sellable.stock <= 0) {
      const { error: dropError } = await supabase
        .from("cart_items")
        .delete()
        .eq("id", line.id);
      if (dropError)
        console.error(
          "[cart] dropping a sold-out line failed:",
          dropError.message,
        );
      refreshBag();
      return {
        ok: false,
        message: "That size sold out. It has been removed from your bag.",
      };
    }

    const ceiling = Math.min(sellable.stock, MAX_LINE_QUANTITY);
    const quantity = Math.min(parsed.data.quantity, ceiling);

    const { error } = await supabase
      .from("cart_items")
      .update({ quantity, unit_price_seen: sellable.unitPrice })
      .eq("id", line.id);

    if (error) {
      console.error("[cart] setQuantity failed:", error.message);
      return { ok: false, message: GENERIC };
    }

    refreshBag();
    return {
      ok: true,
      data: { quantity, capped: quantity < parsed.data.quantity },
    };
  } catch (error) {
    console.error("[cart] setQuantity threw:", error);
    return { ok: false, message: GENERIC };
  }
}

/* ----------------------------------------------------------------- remove -- */

/** Removes a line and hands back what it was, so it can be put straight back. */
export async function removeLine(input: {
  itemId: string;
}): Promise<ActionResult<RemovedLine>> {
  const parsed = removeLineSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: GENERIC };

  try {
    const supabase = await createClient();
    const line = await maybeRow<{
      id: string;
      variant_id: string;
      quantity: number;
    }>(
      "removeLine.line",
      supabase
        .from("cart_items")
        .select("id, variant_id, quantity")
        .eq("id", parsed.data.itemId)
        .maybeSingle(),
    );
    if (!line)
      return { ok: false, message: "That item is no longer in your bag." };

    const sellable = await readSellable(line.variant_id);

    const { error } = await supabase
      .from("cart_items")
      .delete()
      .eq("id", line.id);
    if (error) {
      console.error("[cart] removeLine failed:", error.message);
      return { ok: false, message: GENERIC };
    }

    refreshBag();
    return {
      ok: true,
      data: {
        variantId: line.variant_id,
        quantity: line.quantity,
        name: sellable?.name ?? "Item",
        size: sellable?.size ?? "",
      },
    };
  } catch (error) {
    console.error("[cart] removeLine threw:", error);
    return { ok: false, message: GENERIC };
  }
}

/* ------------------------------------------------------------ acknowledge -- */

/**
 * "Got it" on a price or stock change.
 *
 * getCart() reports changes without writing them back, because it runs during
 * render. This is the write: quantities are clamped to what exists and the
 * price snapshots are brought up to date, so the notice does not follow the
 * customer around after they have read it.
 */
export async function acknowledgeCartChanges(): Promise<ActionResult> {
  try {
    const user = await getCurrentUser();
    const guestToken = user ? null : await readGuestToken();
    if (!user && !guestToken) return { ok: true, data: undefined };

    const supabase = await createClient();
    const cart = await maybeRow<{ id: string }>(
      "acknowledge.cart",
      supabase
        .from("carts")
        .select("id")
        .eq("status", "active")
        .eq(user ? "user_id" : "guest_token", user ? user.id : guestToken!)
        .maybeSingle(),
    );
    if (!cart) return { ok: true, data: undefined };

    const lines = await rows<{
      id: string;
      variant_id: string;
      quantity: number;
    }>(
      "acknowledge.lines",
      supabase
        .from("cart_items")
        .select("id, variant_id, quantity")
        .eq("cart_id", cart.id),
    );

    for (const line of lines) {
      const sellable = await readSellable(line.variant_id);

      if (!sellable || sellable.stock <= 0) {
        const { error } = await supabase
          .from("cart_items")
          .delete()
          .eq("id", line.id);
        if (error)
          console.error(
            "[cart] acknowledge: dropping a dead line failed:",
            error.message,
          );
        continue;
      }

      const quantity = Math.min(
        line.quantity,
        sellable.stock,
        MAX_LINE_QUANTITY,
      );
      const { error } = await supabase
        .from("cart_items")
        .update({ quantity, unit_price_seen: sellable.unitPrice })
        .eq("id", line.id);
      if (error)
        console.error(
          "[cart] acknowledge: reconciling a line failed:",
          error.message,
        );
    }

    refreshBag();
    return { ok: true, data: undefined };
  } catch (error) {
    console.error("[cart] acknowledgeCartChanges threw:", error);
    return { ok: false, message: GENERIC };
  }
}
