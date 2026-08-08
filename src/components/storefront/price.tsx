import { cn } from "@/lib/utils";
import { discountPercent, formatPaise } from "@/lib/format";

/**
 * Price, with the strikethrough and the saving spelled out.
 *
 * The discount is computed from the two prices rather than stored, so a badge
 * can never claim a percentage the arithmetic does not support. `discountPercent`
 * rounds down, so we never overstate the saving.
 */
export function Price({
  basePrice,
  salePrice,
  size = "default",
  className,
}: {
  basePrice: number;
  salePrice?: number | null;
  size?: "default" | "lg";
  className?: string;
}) {
  const off = discountPercent(basePrice, salePrice);
  const now = salePrice ?? basePrice;

  return (
    <p
      className={cn("flex flex-wrap items-baseline gap-x-2 gap-y-1", className)}
    >
      <span
        className={cn(
          "font-mono font-medium tracking-[-0.01em]",
          size === "lg" ? "text-2xl" : "text-base",
        )}
      >
        {formatPaise(now)}
      </span>
      {off !== null ? (
        <>
          <span className="text-muted-foreground font-mono text-sm line-through">
            {formatPaise(basePrice)}
          </span>
          <span className="text-orange-ink font-mono text-xs font-medium">
            {off}% off
          </span>
          <span className="sr-only">
            Reduced from {formatPaise(basePrice)} to {formatPaise(now)}.
          </span>
        </>
      ) : null}
    </p>
  );
}
