import type { Metadata } from "next";
import Link from "next/link";

import { ReviewRowActions } from "@/components/admin/reviews/review-row-actions";
import { Stars } from "@/components/storefront/reviews/stars";
import { AdminPage, Chip, EmptyState, PageHeader } from "@/components/admin/ui";
import { listReviewsForAdmin } from "@/lib/queries/admin/reviews";

export const metadata: Metadata = { title: "Reviews" };
export const dynamic = "force-dynamic";

const STATES = [
  { value: "live", label: "Live" },
  { value: "removed", label: "Removed" },
  { value: "all", label: "All" },
] as const;

/**
 * The moderation desk — post-moderation's other half.
 *
 * Reviews publish the moment a delivered purchaser writes one (owner's
 * decision, plan D2); this page is where one comes down, with a reason that
 * is recorded and survives. Removal is soft: the "Removed" filter is the
 * ledger of the shop's own edits to its public reputation, which is exactly
 * the thing that should be inspectable later.
 */
export default async function AdminReviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string; rating?: string }>;
}) {
  const sp = await searchParams;
  const state =
    STATES.find((entry) => entry.value === sp.show)?.value ?? "live";
  const rating = /^[1-5]$/.test(sp.rating ?? "") ? Number(sp.rating) : undefined;

  const reviews = await listReviewsForAdmin({ state, rating });

  const href = (next: { show?: string; rating?: string }) => {
    const params = new URLSearchParams();
    const show = next.show ?? state;
    const stars = "rating" in next ? next.rating : sp.rating;
    if (show !== "live") params.set("show", show);
    if (stars && /^[1-5]$/.test(stars)) params.set("rating", stars);
    const query = params.toString();
    return `/admin/reviews${query ? `?${query}` : ""}`;
  };

  return (
    <AdminPage>
      <PageHeader
        title="Reviews"
        description="Every review is from a customer whose parcel arrived. Removal is soft — the row and your reason survive."
      />

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {STATES.map((entry) => (
          <Link
            key={entry.value}
            href={href({ show: entry.value })}
            aria-current={state === entry.value ? "true" : undefined}
            className={
              state === entry.value
                ? "bg-ink text-paper hit-44 relative rounded-lg px-3 py-1.5 font-mono text-xs tracking-[0.06em] uppercase"
                : "hit-44 hover:bg-fog relative rounded-lg px-3 py-1.5 font-mono text-xs tracking-[0.06em] uppercase"
            }
          >
            {entry.label}
          </Link>
        ))}
        <span className="text-muted-foreground ml-2 font-mono text-xs tracking-[0.06em] uppercase">
          Stars
        </span>
        {[undefined, 1, 2, 3, 4, 5].map((star) => (
          <Link
            key={star ?? "any"}
            href={href({ rating: star ? String(star) : undefined })}
            aria-current={rating === star ? "true" : undefined}
            className={
              rating === star
                ? "bg-ink text-paper hit-44 relative rounded-lg px-2.5 py-1.5 font-mono text-xs"
                : "hit-44 hover:bg-fog relative rounded-lg px-2.5 py-1.5 font-mono text-xs"
            }
          >
            {star ?? "Any"}
          </Link>
        ))}
      </div>

      {reviews.length === 0 ? (
        <EmptyState
          title={
            state === "removed"
              ? "Nothing has been removed"
              : "No reviews yet"
          }
          body={
            state === "removed"
              ? "When you remove a review, it lands here with your reason."
              : "Reviews can only come from delivered orders, and nothing has been delivered yet. The first parcel that lands can produce the first one."
          }
        />
      ) : (
        <ul className="divide-border border-border mt-6 divide-y rounded-lg border">
          {reviews.map((review) => (
            <li key={review.id} className="p-4 sm:p-5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Stars average={review.rating} />
                <Link
                  href={`/product/${review.productSlug}`}
                  className="text-sm font-medium underline-offset-2 hover:underline"
                >
                  {review.productName}
                </Link>
                {review.removedAt ? (
                  <Chip tone="bad">removed</Chip>
                ) : review.isApproved ? (
                  <Chip tone="good">live</Chip>
                ) : (
                  <Chip tone="neutral">awaiting approval</Chip>
                )}
                <time
                  dateTime={review.createdAt}
                  className="text-muted-foreground text-xs"
                >
                  {new Date(review.createdAt).toLocaleString("en-IN")}
                </time>
              </div>

              {review.title ? (
                <p className="mt-2 text-sm font-medium">{review.title}</p>
              ) : null}
              {review.body ? (
                <p className="text-muted-foreground mt-1 max-w-prose text-sm whitespace-pre-line">
                  {review.body}
                </p>
              ) : null}

              <p className="text-muted-foreground mt-2 text-xs">
                Shown as <strong>{review.displayName}</strong>
                {review.reviewerName
                  ? ` — account: ${review.reviewerName}`
                  : ""}
              </p>

              {review.removedAt && review.removedReason ? (
                <p className="bg-fog mt-2 inline-block rounded-lg px-2 py-1 text-xs">
                  Removed: {review.removedReason}
                </p>
              ) : null}

              <div className="mt-3">
                <ReviewRowActions
                  reviewId={review.id}
                  removed={review.removedAt !== null}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </AdminPage>
  );
}
