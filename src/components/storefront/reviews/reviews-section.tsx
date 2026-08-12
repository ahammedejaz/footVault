import { ReviewList } from "@/components/storefront/reviews/review-list";
import { ReviewSummary } from "@/components/storefront/reviews/review-summary";
import {
  listProductReviews,
  liveReviewAggregate,
  ratingDistribution,
} from "@/lib/queries/reviews";

/**
 * The product page's reviews block: summary, bars, list — or the honest
 * sentence.
 *
 * Everything here is read LIVE, outside the catalog cache, at the moment the
 * page renders: `submitReview` and the moderation actions call
 * `revalidatePath` on this page, the regeneration runs these queries fresh,
 * and a review published under post-moderation is on the page immediately —
 * while `cachedProductContent`'s hour-old copy keeps serving everything
 * else. (Reading aggregates through the cache instead would lag a fresh
 * review by up to an hour: `revalidatePath` regenerates the page without
 * dropping `unstable_cache` entries. Audit 11A.3; provable only against a
 * production build, which is why the gate refuses to claim it under dev.)
 *
 * The empty state is the launch state — delivered purchasers are the only
 * people who may write here, and nothing has ever been delivered. Say it
 * plainly; never five grey stars.
 */
export async function ReviewsSection({ productId }: { productId: string }) {
  const aggregate = await liveReviewAggregate(productId);
  const empty = aggregate.reviewCount === 0;
  const [listed, distribution] = empty
    ? [{ reviews: [], hasMore: false }, null]
    : await Promise.all([
        listProductReviews({ productId, sort: "recent", page: 1 }),
        ratingDistribution(productId),
      ]);

  return (
    <section id="reviews" aria-labelledby="reviews-heading" className="mt-16">
      <h2
        id="reviews-heading"
        className="font-display text-2xl font-extrabold tracking-[-0.02em] uppercase"
      >
        Reviews
      </h2>

      {empty ? (
        <p className="text-muted-foreground mt-3 max-w-prose text-sm text-pretty">
          No reviews yet. Every review here comes from someone whose pair
          actually arrived — once yours does, you can be the first.
        </p>
      ) : (
        <div className="mt-6 space-y-8">
          <ReviewSummary
            ratingSum={aggregate.ratingSum}
            reviewCount={aggregate.reviewCount}
            distribution={distribution!}
          />
          <ReviewList
            productId={productId}
            initialReviews={listed.reviews}
            initialHasMore={listed.hasMore}
          />
        </div>
      )}
    </section>
  );
}
