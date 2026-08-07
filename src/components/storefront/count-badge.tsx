"use client";

import { useBagStore } from "@/lib/stores/bag";
import { cn } from "@/lib/utils";

/**
 * The number on the bag and saved-items icons.
 *
 * Absolutely positioned so it can never change the header's height — a badge
 * that appears on the first add and pushes the icons down is a layout shift on
 * the most-looked-at element on the site.
 *
 * The count is also folded into the link's accessible name by the caller, so a
 * screen reader hears "Bag, 3 items" rather than "Bag" and then a stray "3".
 */
export function CountBadge({ of }: { of: "bag" | "saved" }) {
  const count = useBagStore((state) => (of === "bag" ? state.bagCount : state.savedCount));
  const hydrated = useBagStore((state) => state.hydrated);

  if (!hydrated || count === 0) return null;

  return (
    <span
      aria-hidden
      className={cn(
        "bg-orange text-ink absolute -top-0.5 -right-0.5 inline-flex min-w-4 items-center justify-center rounded-full px-1 font-mono text-xs leading-4 font-medium tabular-nums",
      )}
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}

/** The same number, for the accessible name. */
export function useCount(of: "bag" | "saved") {
  const count = useBagStore((state) => (of === "bag" ? state.bagCount : state.savedCount));
  const hydrated = useBagStore((state) => state.hydrated);
  return hydrated ? count : 0;
}
