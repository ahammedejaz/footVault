import { Stars } from "@/components/storefront/reviews/stars";

/**
 * The number, the stars, and the five bars everyone recognises.
 *
 * Rendered only when there is at least one review — the empty state is a
 * sentence, never five grey stars (the brief's rule, and the honest one: this
 * shop launches with zero reviews and stays there until the first parcel
 * lands, so the empty state is the state, not an edge).
 */
export function ReviewSummary({
  ratingSum,
  reviewCount,
  distribution,
}: {
  ratingSum: number;
  reviewCount: number;
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
}) {
  if (reviewCount === 0) return null;
  const average = ratingSum / reviewCount;

  return (
    <div className="flex flex-wrap items-start gap-x-10 gap-y-6">
      <div>
        <p className="font-mono text-4xl font-medium tabular-nums">
          {average.toFixed(1)}
        </p>
        <Stars average={average} size="md" className="mt-1" />
        <p className="text-muted-foreground mt-1 text-sm">
          {reviewCount === 1 ? "1 review" : `${reviewCount} reviews`}, all from
          verified purchases
        </p>
      </div>

      <dl className="min-w-56 flex-1 space-y-1.5" aria-label="Rating breakdown">
        {([5, 4, 3, 2, 1] as const).map((star) => {
          const count = distribution[star];
          const share = reviewCount === 0 ? 0 : (count / reviewCount) * 100;
          return (
            <div key={star} className="flex items-center gap-3">
              <dt className="text-muted-foreground w-12 shrink-0 font-mono text-xs tracking-[0.06em]">
                {star} STAR
              </dt>
              <dd className="flex min-w-0 flex-1 items-center gap-3">
                <span className="bg-fog block h-2 flex-1 overflow-hidden rounded-full">
                  <span
                    className="bg-foreground block h-full rounded-full"
                    style={{ width: `${share}%` }}
                  />
                </span>
                <span className="text-muted-foreground w-6 text-right font-mono text-xs tabular-nums">
                  {count}
                </span>
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
