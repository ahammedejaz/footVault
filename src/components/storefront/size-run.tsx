import { cn } from "@/lib/utils";
import type { SizeAvailability } from "@/lib/catalog-types";

/**
 * The signature element.
 *
 * Every product card and every product page carries the full UK size run as a
 * monospace strip. Sold-out sizes are struck through and dimmed — never hidden
 * — so a customer scanning a grid on a phone can tell at a glance which shoes
 * exist in their size. That honesty is the whole point; a run that quietly
 * drops the sizes it lacks is just a shorter run.
 *
 * `compact` is the read-only strip on cards. The full size is the interactive
 * selector on the product page, where each chip clears the 44px tap floor.
 */
export function SizeRun({
  sizes,
  compact = false,
  className,
}: {
  sizes: SizeAvailability[];
  compact?: boolean;
  className?: string;
}) {
  if (sizes.length === 0) return null;

  const available = sizes.filter((entry) => entry.available);

  return (
    <div className={className}>
      <ul
        className={cn(
          "flex flex-wrap font-mono tabular-nums",
          compact ? "gap-x-2 gap-y-1 text-xs tracking-[0.06em]" : "gap-2",
        )}
        aria-hidden={compact ? true : undefined}
      >
        {sizes.map((entry) => (
          <li
            key={entry.size}
            className={cn(
              compact
                ? "leading-4"
                : "border-border flex h-11 min-w-11 items-center justify-center rounded-lg border px-3 text-base",
              entry.available
                ? "text-foreground"
                : "text-dim line-through decoration-1",
            )}
          >
            {entry.size}
          </li>
        ))}
      </ul>
      {compact ? (
        <p className="sr-only">
          {available.length === 0
            ? "Sold out in every size."
            : `Available in UK ${available.map((entry) => entry.size).join(", ")}.`}
        </p>
      ) : null}
    </div>
  );
}
