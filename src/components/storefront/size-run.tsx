import { cn } from "@/lib/utils";

export type SizeRunEntry = {
  /** UK size as text, so half sizes and kids' sizes stay expressible. */
  size: string;
  available: boolean;
};

/**
 * The signature element.
 *
 * Every product card and every product page carries the full UK size run as a
 * monospace strip. Sold-out sizes are struck through and dimmed — never hidden
 * — so a customer scanning a grid on a phone can tell at a glance which shoes
 * exist in their size. That honesty is the whole point; a run that quietly
 * drops the sizes it lacks is just a shorter run.
 *
 * `compact` is the read-only strip used on cards. The product page uses the
 * default size, where chips clear 48px and the selection is interactive
 * (wired in Phase 3).
 */
export function SizeRun({
  sizes,
  compact = false,
  className,
}: {
  sizes: SizeRunEntry[];
  compact?: boolean;
  className?: string;
}) {
  if (sizes.length === 0) return null;

  const availableCount = sizes.filter((entry) => entry.available).length;

  return (
    <div className={className}>
      <ul
        className={cn(
          "flex flex-wrap font-mono tabular-nums",
          compact ? "gap-x-2 gap-y-1 text-xs tracking-[0.06em]" : "gap-2",
        )}
      >
        {sizes.map((entry) => (
          <li
            key={entry.size}
            className={cn(
              compact
                ? "leading-4"
                : "border-border flex h-12 min-w-12 items-center justify-center rounded-lg border px-2 text-base",
              entry.available
                ? compact
                  ? "text-foreground"
                  : "text-foreground"
                : "text-dim line-through decoration-1",
            )}
          >
            {entry.size}
          </li>
        ))}
      </ul>
      <p className="sr-only">
        {availableCount === 0
          ? "Sold out in every size."
          : `Available in UK ${sizes
              .filter((entry) => entry.available)
              .map((entry) => entry.size)
              .join(", ")}.`}
      </p>
    </div>
  );
}
