import "server-only";

import { createStaticClient } from "@/lib/supabase/static";
import { rows } from "@/lib/queries/run";

/**
 * The storefront's read of reviews — live, beside the cached product.
 *
 * Deliberately NOT inside `cachedProductContent`: post-moderation means a
 * review publishes the moment it is written, and "immediately" is not within
 * the catalog cache's hour (audit 11A.3). `cachedProduct` already composes
 * cached content with live stock for exactly this class of fact; reviews get
 * the identical treatment — one indexed read on `reviews_product_approved_idx`
 * per product page render. The alternative, revalidating CATALOG_CACHE_TAG on
 * every review write, drops the whole catalog cache for one review on the LCP
 * path.
 *
 * Through `createStaticClient()` — the cookieless anon client the whole
 * catalog read path uses, which is why `/product/[slug]` does not wait on
 * cookies before the LCP image. RLS shows it exactly the approved,
 * non-removed rows; `display_name` is snapshotted onto the review at write
 * time precisely so this client never needs a `profiles` join it would not
 * be allowed.
 */

export type ReviewView = {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
  /** First name, snapshotted at the moment of writing. */
  displayName: string;
  isVerifiedPurchase: boolean;
  createdAt: string;
};

export type ReviewSort = "recent" | "rating";

export const REVIEWS_PER_PAGE = 10;

export async function listProductReviews(input: {
  productId: string;
  sort?: ReviewSort;
  page?: number;
}): Promise<{ reviews: ReviewView[]; hasMore: boolean }> {
  const sort = input.sort ?? "recent";
  const page = Math.max(1, input.page ?? 1);
  const from = (page - 1) * REVIEWS_PER_PAGE;

  const found = await rows<{
    id: string;
    rating: number;
    title: string | null;
    body: string | null;
    display_name: string;
    is_verified_purchase: boolean;
    created_at: string;
  }>(
    "reviews.list",
    createStaticClient()
      .from("reviews")
      .select("id, rating, title, body, display_name, is_verified_purchase, created_at")
      .eq("product_id", input.productId)
      .order(sort === "rating" ? "rating" : "created_at", { ascending: false })
      // Rating ties read newest-first, so "by rating" is stable and fresh.
      .order("created_at", { ascending: false })
      // One extra row answers "is there another page" without a count query.
      .range(from, from + REVIEWS_PER_PAGE),
  );

  return {
    reviews: found.slice(0, REVIEWS_PER_PAGE).map((row) => ({
      id: row.id,
      rating: row.rating,
      title: row.title,
      body: row.body,
      displayName: row.display_name,
      isVerifiedPurchase: row.is_verified_purchase,
      createdAt: row.created_at,
    })),
    hasMore: found.length > REVIEWS_PER_PAGE,
  };
}

/**
 * The five bars. Read as bare ratings and counted here: the shop's review
 * volume is human-scale, and the cap below turns "unbounded" into "honest" —
 * past a thousand ratings the bars are statistically identical anyway.
 */
export async function ratingDistribution(
  productId: string,
): Promise<Record<1 | 2 | 3 | 4 | 5, number>> {
  const found = await rows<{ rating: number }>(
    "reviews.distribution",
    createStaticClient()
      .from("reviews")
      .select("rating")
      .eq("product_id", productId)
      .limit(1000),
  );
  const bars: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of found) {
    if (row.rating >= 1 && row.rating <= 5) {
      bars[row.rating as 1 | 2 | 3 | 4 | 5] += 1;
    }
  }
  return bars;
}

/**
 * The aggregate, read LIVE — never from `cachedProduct`.
 *
 * `cachedProductContent` is `unstable_cache`d for an hour, and
 * `revalidatePath` (what the write path calls) regenerates the page without
 * dropping that data-cache entry — so aggregates read through the cache
 * would lag a fresh review by up to an hour on the exact page the customer
 * returns to. One indexed primary-key read; the same trade
 * `detailWithLiveStock` makes for stock, for the same reason.
 */
export async function liveReviewAggregate(
  productId: string,
): Promise<{ reviewCount: number; ratingSum: number }> {
  const found = await rows<{ review_count: number; rating_sum: number }>(
    "reviews.aggregate",
    createStaticClient()
      .from("products")
      .select("review_count, rating_sum")
      .eq("id", productId)
      .limit(1),
  );
  return {
    reviewCount: found[0]?.review_count ?? 0,
    ratingSum: found[0]?.rating_sum ?? 0,
  };
}
