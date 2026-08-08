import {
  ORDER_STATUS_COPY,
  formatOrderDateTime,
} from "@/components/checkout/order-format";
import type { OrderTimelineEntry } from "@/lib/orders/types";
import { cn } from "@/lib/utils";

/**
 * Everything that has happened to this order, oldest first.
 *
 * An ordered list, because the order is the information. The rail and the dots
 * are drawn with a two-column grid rather than an absolutely positioned
 * overlay — the same lesson the product card taught this project, where a
 * layer over a text row clipped the brand name on every card.
 *
 * The newest entry is filled orange and named as the current state; everything
 * above it is history. The sort is done here rather than trusted from the
 * query, because a timeline out of order is worse than no timeline and the cost
 * of being sure is one comparison.
 */
export function OrderTimeline({
  timeline,
}: {
  timeline: OrderTimelineEntry[];
}) {
  if (timeline.length === 0) return null;

  const entries = [...timeline].sort((a, b) => a.at.localeCompare(b.at));
  const currentIndex = entries.length - 1;

  return (
    <ol className="mt-4">
      {entries.map((entry, index) => {
        const current = index === currentIndex;
        return (
          <li
            key={`${entry.status}-${entry.at}`}
            className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-4"
          >
            {/* The rail column: a dot, then a hairline that stops at the last
                entry so the list does not trail off into nothing. */}
            <div className="flex flex-col items-center">
              <span
                aria-hidden
                className={cn(
                  "mt-1.5 size-2.5 shrink-0 rounded-4xl",
                  current ? "bg-orange" : "bg-line",
                )}
              />
              {index < currentIndex ? (
                <span aria-hidden className="bg-line w-px flex-1" />
              ) : null}
            </div>

            <div className={cn("pb-5", current && "pb-0")}>
              <p className="text-sm font-medium">
                {ORDER_STATUS_COPY[entry.status].label}
                {current ? (
                  <span className="sr-only"> — current status</span>
                ) : null}
              </p>
              <p className="text-muted-foreground mt-0.5 font-mono text-xs tracking-[0.06em]">
                <time dateTime={entry.at}>{formatOrderDateTime(entry.at)}</time>{" "}
                · {entry.by}
              </p>
              {entry.note ? (
                <p className="text-muted-foreground mt-1 text-sm text-pretty">
                  {entry.note}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
