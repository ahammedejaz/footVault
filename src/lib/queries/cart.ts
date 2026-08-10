import "server-only";

import { getCurrentUser } from "@/lib/auth";
import { readGuestToken } from "@/lib/cart/token";
import { maybeRow, rows } from "@/lib/queries/run";
import { cachedSiteSettings } from "@/lib/queries/cached";
import {
  publicShippingSettings,
  type ShippingSettings,
} from "@/lib/queries/content";
import { createClient } from "@/lib/supabase/server";
import type {
  Cart,
  CartAdjustment,
  CartLine,
  FreeShipping,
} from "@/lib/cart-types";

/**
 * Reading the bag.
 *
 * Two rules shape everything here.
 *
 * **The server is the only authority on price and stock.** `cart_items` stores
 * an identifier and a quantity, and nothing else. Every rupee on this page is
 * recomputed from the catalog on every read, so there is no browser-supplied
 * number anywhere near the arithmetic and no way to show a stale total.
 *
 * **This read is pure.** It reports what the bag *is* right now — quantities
 * clamped to live stock, dead lines dropped — without writing any of that back.
 * A Server Component runs during render and may run more than once; a render
 * that mutates the database is a render that cannot be retried. The clamped
 * view is what the customer sees and what checkout will recompute from, so the
 * stored row being briefly optimistic is not a correctness problem. Every
 * mutation in src/lib/actions/cart.ts re-clamps as it goes.
 *
 * What the customer is *told* is `adjustments`. Nothing is allowed to change
 * quietly.
 */

export type {
  Cart,
  CartAdjustment,
  CartLine,
  FreeShipping,
} from "@/lib/cart-types";

type RawLine = {
  id: string;
  quantity: number;
  unit_price_seen: number | null;
  variant: {
    id: string;
    size: string;
    color: string;
    sku: string;
    stock_quantity: number;
    is_active: boolean;
    price_override: number | null;
    product: {
      slug: string;
      name: string;
      is_active: boolean;
      deleted_at: string | null;
      effective_price: number | null;
      base_price: number;
      weight_grams: number | null;
      brand: { name: string } | null;
      images: { url: string; alt_text: string | null; is_primary: boolean }[];
    } | null;
  } | null;
};

/** The active cart's id for this caller, or null. RLS decides which one that is. */
async function activeCartId(): Promise<string | null> {
  return (await activeCartRow())?.id ?? null;
}

/**
 * The cart row itself — the id, plus the coupon code waiting on it. One
 * query serving both callers so the "which cart is mine" logic cannot fork.
 */
async function activeCartRow(): Promise<{
  id: string;
  coupon_code: string | null;
} | null> {
  const user = await getCurrentUser();
  const guestToken = user ? null : await readGuestToken();
  if (!user && !guestToken) return null;

  const supabase = await createClient();
  const query = supabase
    .from("carts")
    .select("id, coupon_code")
    .eq("status", "active");

  // Both filters are belt and braces — the RLS policies already scope this to
  // the caller — but they keep the query honest if a policy is ever loosened.
  const scoped = user
    ? query.eq("user_id", user.id)
    : query.eq("guest_token", guestToken!);

  return maybeRow<{ id: string; coupon_code: string | null }>(
    "activeCartRow",
    scoped.maybeSingle(),
  );
}

export async function getCart(): Promise<Cart> {
  const settings = await cachedSiteSettings();
  const shipping = publicShippingSettings(settings);

  const cartRow = await activeCartRow();
  if (!cartRow) return emptyCart(null, shipping);
  const cartId = cartRow.id;

  const supabase = await createClient();
  const raw = await rows<RawLine>(
    "getCart",
    supabase
      .from("cart_items")
      .select(
        `id, quantity, unit_price_seen,
         variant:product_variants!inner (
           id, size, color, sku, stock_quantity, is_active, price_override,
           product:products!inner (
             slug, name, is_active, deleted_at, effective_price, base_price,
             weight_grams,
             brand:brands ( name ),
             images:product_images ( url, alt_text, is_primary )
           )
         )`,
      )
      .eq("cart_id", cartId)
      .order("created_at", { ascending: true })
      .overrideTypes<RawLine[]>(),
  );

  const lines: CartLine[] = [];
  const adjustments: CartAdjustment[] = [];

  for (const item of raw) {
    const variant = item.variant;
    const product = variant?.product;

    // The line no longer refers to anything sellable: the owner deactivated the
    // product, retired the size, or soft-deleted it out from under the bag.
    if (
      !variant ||
      !product ||
      !variant.is_active ||
      !product.is_active ||
      product.deleted_at
    ) {
      adjustments.push({
        kind: "gone",
        name: product?.name ?? "An item",
        size: variant?.size ?? "",
      });
      continue;
    }

    const unitPrice =
      variant.price_override ?? product.effective_price ?? product.base_price;

    if (variant.stock_quantity <= 0) {
      adjustments.push({
        kind: "gone",
        name: product.name,
        size: variant.size,
      });
      continue;
    }

    const quantity = Math.min(item.quantity, variant.stock_quantity);
    if (quantity < item.quantity) {
      adjustments.push({
        kind: "stock",
        name: product.name,
        size: variant.size,
        from: item.quantity,
        to: quantity,
      });
    }

    // A snapshot exists and disagrees with the catalog. The total below already
    // uses the live price; this is only so the change gets said out loud.
    if (item.unit_price_seen !== null && item.unit_price_seen !== unitPrice) {
      adjustments.push({
        kind: "price",
        name: product.name,
        size: variant.size,
        from: item.unit_price_seen,
        to: unitPrice,
      });
    }

    const primary =
      product.images.find((image) => image.is_primary) ??
      product.images[0] ??
      null;

    lines.push({
      id: item.id,
      variantId: variant.id,
      productSlug: product.slug,
      productName: product.name,
      brand: product.brand?.name ?? null,
      size: variant.size,
      color: variant.color,
      sku: variant.sku,
      imageUrl: primary?.url ?? null,
      imageAlt: primary?.alt_text ?? product.name,
      unitPrice,
      quantity,
      lineTotal: unitPrice * quantity,
      stock: variant.stock_quantity,
      weightGrams: product.weight_grams ?? null,
    });
  }

  const subtotal = lines.reduce((total, line) => total + line.lineTotal, 0);
  const count = lines.reduce((total, line) => total + line.quantity, 0);

  return {
    id: cartId,
    lines,
    count,
    subtotal,
    adjustments,
    couponCode: cartRow.coupon_code,
    freeShipping: freeShippingFrom(shipping, subtotal),
  };
}

/**
 * Just the badge number.
 *
 * The header renders on every route, and the full read above joins four tables
 * to build something the badge throws away. This is the same authority — live
 * stock, dead lines dropped — over three columns.
 */
export async function getCartCount(): Promise<number> {
  const cartId = await activeCartId();
  if (!cartId) return 0;

  const supabase = await createClient();
  const raw = await rows<{
    quantity: number;
    variant: { stock_quantity: number; is_active: boolean } | null;
  }>(
    "getCartCount",
    supabase
      .from("cart_items")
      .select(
        "quantity, variant:product_variants!inner ( stock_quantity, is_active )",
      )
      .eq("cart_id", cartId)
      .overrideTypes<
        {
          quantity: number;
          variant: { stock_quantity: number; is_active: boolean } | null;
        }[]
      >(),
  );

  return raw.reduce((total, item) => {
    if (!item.variant?.is_active) return total;
    return total + Math.min(item.quantity, item.variant.stock_quantity);
  }, 0);
}

function freeShippingFrom(
  shipping: ShippingSettings,
  subtotal: number,
): FreeShipping {
  const thresholdPaise = shipping.free_above_paise;
  const remainingPaise = Math.max(0, thresholdPaise - subtotal);
  return {
    thresholdPaise,
    remainingPaise,
    // An empty bag has not qualified for anything, whatever the arithmetic says.
    qualified: subtotal > 0 && remainingPaise === 0,
  };
}

function emptyCart(id: string | null, shipping: ShippingSettings): Cart {
  return {
    id,
    lines: [],
    count: 0,
    subtotal: 0,
    adjustments: [],
    couponCode: null,
    freeShipping: freeShippingFrom(shipping, 0),
  };
}
