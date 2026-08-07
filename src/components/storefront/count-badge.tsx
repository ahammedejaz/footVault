import { cn } from "@/lib/utils";

/**
 * The number on the bag and saved-items icons.
 *
 * A Server Component now. The count comes from the `carts` table on the same
 * render as the rest of the header, so there is nothing to hydrate, no frame
 * where it reads zero, and no way for it to disagree with the bag itself — a
 * badge that survives a merge, a stock cap or another device only by being
 * asked fresh each time.
 *
 * Absolutely positioned so it can never change the header's height. A badge
 * that appears on the first add and pushes the icons down is a layout shift on
 * the most-looked-at element on the site.
 *
 * `aria-hidden` because the count is folded into the link's accessible name by
 * the caller: a screen reader hears "Bag, 3 items" rather than "Bag" and then a
 * stray "3".
 */
export function CountBadge({ count }: { count: number }) {
  if (count === 0) return null;

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

/** "Bag, 3 items" — the whole message in one utterance. */
export function countLabel(noun: string, count: number): string {
  if (count === 0) return noun;
  return count === 1 ? `${noun}, 1 item` : `${noun}, ${count} items`;
}
