"use client";

import { useState, useTransition } from "react";

import { Stars } from "@/components/storefront/reviews/stars";
import { fetchProductReviews } from "@/lib/actions/reviews";
import type { ReviewSort, ReviewView } from "@/lib/queries/reviews";
import { cn } from "@/lib/utils";

/**
 * The reviews themselves: rating, title, body, first name, date, and the
 * verified-purchase mark — which on this shop is every review, because a
 * delivered order is the entry condition, so the mark states the system
 * rather than decorating some rows.
 *
 * Client-driven sort and paging, deliberately: the product page is static
 * (its header forbids `searchParams` — a read there puts a database round
 * trip in front of the LCP image), so re-sorting cannot be a navigation.
 * The first page arrives server-rendered in the HTML for free; the buttons
 * fetch further pages through a read-only server action.
 */
export function ReviewList({
  productId,
  initialReviews,
  initialHasMore,
}: {
  productId: string;
  initialReviews: ReviewView[];
  initialHasMore: boolean;
}) {
  const [sort, setSort] = useState<ReviewSort>("recent");
  const [reviews, setReviews] = useState(initialReviews);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [pending, startTransition] = useTransition();

  function resort(nextSort: ReviewSort) {
    if (nextSort === sort) return;
    setSort(nextSort);
    startTransition(async () => {
      const result = await fetchProductReviews({
        productId,
        sort: nextSort,
        page: 1,
      });
      setReviews(result.reviews);
      setPage(1);
      setHasMore(result.hasMore);
    });
  }

  function more() {
    startTransition(async () => {
      const next = page + 1;
      const result = await fetchProductReviews({ productId, sort, page: next });
      setReviews((current) => [...current, ...result.reviews]);
      setPage(next);
      setHasMore(result.hasMore);
    });
  }

  if (reviews.length === 0) return null;

  return (
    <div aria-busy={pending}>
      <div
        role="group"
        aria-label="Sort reviews"
        className="flex items-center gap-2"
      >
        <span className="text-muted-foreground font-mono text-xs tracking-[0.06em] uppercase">
          Sort
        </span>
        {(
          [
            ["recent", "Most recent"],
            ["rating", "Highest rated"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => resort(value)}
            aria-pressed={sort === value}
            className={cn(
              "hit-44 relative rounded-lg px-3 py-1.5 font-mono text-xs tracking-[0.06em] uppercase",
              sort === value ? "bg-ink text-paper" : "hover:bg-fog",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <ul className="divide-border mt-4 divide-y">
        {reviews.map((review) => (
          <li key={review.id} className="py-5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Stars average={review.rating} />
              <span className="text-sm font-medium">{review.displayName}</span>
              {review.isVerifiedPurchase ? (
                <span className="bg-fog rounded-lg px-2 py-0.5 font-mono text-xs tracking-[0.06em] uppercase">
                  Verified purchase
                </span>
              ) : null}
              <time
                dateTime={review.createdAt}
                className="text-muted-foreground text-sm"
              >
                {new Date(review.createdAt).toLocaleDateString("en-IN", {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
              </time>
            </div>
            {review.title ? (
              <p className="mt-2 text-base leading-snug font-medium">
                {review.title}
              </p>
            ) : null}
            {review.body ? (
              <p className="text-muted-foreground mt-1 text-sm text-pretty whitespace-pre-line">
                {review.body}
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      {hasMore ? (
        <div className="border-border border-t pt-4">
          <button
            type="button"
            onClick={more}
            disabled={pending}
            className="hit-44 relative font-mono text-xs tracking-[0.06em] uppercase underline underline-offset-2 disabled:opacity-60"
          >
            {pending ? "Loading…" : "More reviews"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
