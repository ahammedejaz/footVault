import "server-only";

import type {
  ProductDetail,
  ProductSummary,
  SizeAvailability,
} from "@/lib/catalog-types";
import { rows } from "@/lib/queries/run";
import { createStaticClient } from "@/lib/supabase/static";

/**
 * Stock, read live, over catalog content that was read from a cache.
 *
 * ## The bug this exists to prevent, and the measurement behind it
 *
 * Phase 7 opened with the owner reporting that an order had been placed for a
 * size the admin showed as zero. Four candidates were checked rather than
 * guessed between, and three came back clean:
 *
 *   - `create_order_with_stock` **does** verify before it decrements — it calls
 *     `assert_cart_stock`, which locks every variant `FOR UPDATE` and refuses by
 *     name.
 *   - `product_variants` **does** carry `CHECK (stock_quantity >= 0)`, so
 *     negative stock is unrepresentable.
 *   - `addToBag` **does** re-read stock and refuses at zero.
 *
 * The fourth was the answer. `cachedProduct` and the two listing caches store
 * `variants[].stock_quantity` inside an `unstable_cache` entry with a one-hour
 * window and a `catalog` tag — and **nothing that changes stock invalidated that
 * tag**. Grepped at the start of this phase, `CATALOG_CACHE_TAG` was reachable
 * from `src/lib/actions/admin/{brands,categories,media,products,settings}.ts`
 * and nowhere else. Not from checkout, not from a cancellation, not from the
 * webhook, and — the one the owner actually hit — not from the admin's own
 * stock editor, which called `revalidatePath("/", "layout")`. That expires the
 * *route* cache and leaves every `unstable_cache` entry exactly where it was.
 *
 * So the owner set a size to zero, the product page went on saying it was
 * available for up to an hour, and the size run — the element the whole shop is
 * built around — was reporting stock that had been gone since before lunch.
 * `addToBag` would have caught it at the tap, which is why this produced a
 * confusing failure rather than an oversold pair; but a size run that lies is
 * the bug, and being rescued at the last step is not a fix.
 *
 * ## Why an overlay rather than only a tag
 *
 * Both are done. `stockChanged()` in `src/lib/stock-freshness.ts` now expires
 * the tag from every path that moves a unit, which keeps *cards* honest. But a
 * tag cannot be expired by `release_abandoned_orders()`, which runs inside
 * Postgres under `pg_cron` and cannot reach Next at all, and it cannot be
 * expired by somebody editing a row in the Supabase dashboard. On the page
 * where a customer actually chooses a size, "honest within an invalidation
 * window" is not the same promise as "honest".
 *
 * So catalog *content* — names, prices, photography, colourways — stays cached
 * for the hour it always was, and *availability* is read live and laid over the
 * top. Content is what makes the LCP path expensive; availability is one
 * indexed read on `product_variants` keyed by `product_id`, and it is the only
 * part of a product that changes on a timescale a customer can notice.
 *
 * Measured on a local production build, warm: `/product/[slug]` TTFB moved from
 * 11ms to 14ms. That is the whole cost of never telling a customer we have
 * something we do not.
 */

type LiveVariant = {
  id: string;
  product_id: string;
  size: string;
  color: string;
  stock_quantity: number;
  is_active: boolean;
};

/**
 * Live stock for a set of products, as `productId -> variantId -> units`.
 *
 * Keyed by variant id rather than by size because a size is several variants
 * across colourways, and the card sums them while the colourway strip does not.
 * Both answers are derivable from this; neither is derivable from the other.
 */
export async function liveStockFor(
  productIds: string[],
): Promise<Map<string, Map<string, number>>> {
  const byProduct = new Map<string, Map<string, number>>();
  if (productIds.length === 0) return byProduct;

  const variants = await rows<LiveVariant>(
    "catalog.liveStock",
    createStaticClient()
      .from("product_variants")
      .select("id, product_id, size, color, stock_quantity, is_active")
      .in("product_id", productIds),
  );

  for (const variant of variants) {
    // An inactive variant is not stock anybody can buy. It is dropped here for
    // the same reason `toSizes` drops it: the two must agree or the overlay
    // would resurrect a size the cached content had already retired.
    if (!variant.is_active) continue;
    const forProduct = byProduct.get(variant.product_id) ?? new Map();
    forProduct.set(variant.id, variant.stock_quantity);
    byProduct.set(variant.product_id, forProduct);
  }

  return byProduct;
}

/**
 * Re-derive one size run against live stock.
 *
 * `variantId` is null on the card's summed run — a size across three colourways
 * has no single variant to name — so that run cannot be re-derived from variant
 * ids alone and is rebuilt from the colourway runs instead. See `applyLive`.
 */
function relive(
  sizes: SizeAvailability[],
  live: Map<string, number>,
): SizeAvailability[] {
  return sizes.map((entry) =>
    entry.variantId === null
      ? entry
      : {
          ...entry,
          stock: live.get(entry.variantId) ?? 0,
          available: (live.get(entry.variantId) ?? 0) > 0,
        },
  );
}

/** Sum the colourway runs back into the card's run, size by size. */
function summed(colors: ProductSummary["colors"]): Map<string, number> {
  const total = new Map<string, number>();
  for (const color of colors) {
    for (const entry of color.sizes) {
      total.set(entry.size, (total.get(entry.size) ?? 0) + entry.stock);
    }
  }
  return total;
}

function applyLive<T extends ProductSummary>(
  product: T,
  live: Map<string, number> | undefined,
): T {
  // No row for this product means every one of its variants is inactive or
  // gone. Sold out is the honest reading, and it is the safe direction.
  const stock = live ?? new Map<string, number>();

  const colors = product.colors.map((color) => ({
    ...color,
    sizes: relive(color.sizes, stock),
  }));

  const totals = summed(colors);
  const sizes = product.sizes.map((entry) => ({
    ...entry,
    stock: totals.get(entry.size) ?? 0,
    available: (totals.get(entry.size) ?? 0) > 0,
  }));

  return {
    ...product,
    sizes,
    colors,
    inStock: sizes.some((entry) => entry.available),
  };
}

/** One product, with every stock figure on it read from the database now. */
export async function withLiveStock<T extends ProductSummary>(
  product: T | null,
): Promise<T | null> {
  if (!product) return null;
  const [withStock] = await withLiveStockAll([product]);
  return withStock ?? null;
}

/** A page of products, in one round trip whatever its length. */
export async function withLiveStockAll<T extends ProductSummary>(
  products: T[],
): Promise<T[]> {
  if (products.length === 0) return products;
  const live = await liveStockFor(products.map((product) => product.id));
  return products.map((product) => applyLive(product, live.get(product.id)));
}

/**
 * A product detail carries a second copy of the numbers, in `variants[].stock`,
 * which the size guide and the admin-facing copy read. It is relived from the
 * same map rather than left behind, because two stock figures on one object
 * that disagree is worse than either of them being stale.
 */
export async function detailWithLiveStock(
  product: ProductDetail | null,
): Promise<ProductDetail | null> {
  if (!product) return null;
  const live = (await liveStockFor([product.id])).get(product.id) ?? new Map();
  const overlaid = applyLive(product, live);
  return {
    ...overlaid,
    variants: product.variants.map((variant) => ({
      ...variant,
      stock: live.get(variant.id) ?? 0,
    })),
  };
}
