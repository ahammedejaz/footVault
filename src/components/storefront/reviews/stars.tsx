import { Star } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A star rating, displayed.
 *
 * One muted row with a width-clipped filled row on top, so 4.3 paints as 4.3
 * rather than rounding itself to a lie in either direction. The number is in
 * the accessible name; the stars are presentation.
 *
 * Never renders zero grey stars as an empty promise — callers with no
 * reviews render words ("No reviews yet") instead of this component. That is
 * a rule from the brief, not a style choice.
 */
export function Stars({
  average,
  className,
  size = "sm",
}: {
  /** 1–5, any precision. */
  average: number;
  size?: "sm" | "md";
  className?: string;
}) {
  const clamped = Math.min(5, Math.max(0, average));
  const iconClass = size === "md" ? "size-5" : "size-4";
  const row = (tone: string, hidden = false) => (
    <span className={cn("flex", tone)} aria-hidden={hidden || undefined}>
      {[1, 2, 3, 4, 5].map((star) => (
        <Star key={star} className={cn(iconClass, "shrink-0 fill-current")} />
      ))}
    </span>
  );

  return (
    <span
      className={cn("relative inline-flex", className)}
      role="img"
      aria-label={`Rated ${clamped.toFixed(1)} out of 5`}
    >
      {row("text-border")}
      <span
        className="absolute inset-0 overflow-hidden"
        style={{ width: `${(clamped / 5) * 100}%` }}
        aria-hidden
      >
        {row("text-foreground", true)}
      </span>
    </span>
  );
}
