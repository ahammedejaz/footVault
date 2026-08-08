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
 * The visual strip is `aria-hidden` and followed by one sentence for a screen
 * reader. Read literally, "6 7 8 9 10 11 12" tells a non-sighted customer
 * nothing about which of those they can actually buy, and the strikethrough
 * that carries the meaning is invisible to them; "Available in UK 7, 8, 9, 11"
 * is the same information in a form that survives being spoken.
 */
export function SizeRun({
  sizes,
  className,
}: {
  sizes: SizeAvailability[];
  className?: string;
}) {
  if (sizes.length === 0) return null;

  const available = sizes.filter((entry) => entry.available);

  return (
    <div className={className}>
      <ul
        className="flex flex-wrap gap-x-2 gap-y-1 font-mono text-xs tracking-[0.06em] tabular-nums"
        aria-hidden="true"
      >
        {sizes.map((entry) => (
          <li
            key={entry.size}
            className={cn(
              "leading-4",
              entry.available
                ? "text-foreground"
                : "text-dim line-through decoration-1",
            )}
          >
            {entry.size}
          </li>
        ))}
      </ul>
      <p className="sr-only">
        {available.length === 0
          ? "Sold out in every size."
          : available.length === sizes.length
            ? `Available in every size, UK ${sizes[0]!.size} to ${sizes[sizes.length - 1]!.size}.`
            : `Available in UK ${available.map((entry) => entry.size).join(", ")}. Sold out in UK ${sizes
                .filter((entry) => !entry.available)
                .map((entry) => entry.size)
                .join(", ")}.`}
      </p>
    </div>
  );
}
