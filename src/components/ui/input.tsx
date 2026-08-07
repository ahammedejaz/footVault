import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Restyled to the Foot Vault tokens.
 *
 * Two departures from the shadcn default:
 *
 * 1. `h-11` rather than `h-8`. A 32px field fails the 44px tap floor, and a
 *    customer filling in a delivery address on a phone is the last place to
 *    economise on target size.
 * 2. `text-base` at every width. shadcn drops to `text-sm` above `md`, but iOS
 *    Safari zooms the page whenever a focused field is under 16px — which is
 *    exactly the pinch-to-zoom the brief forbids.
 *
 * The focus ring is the global composite indicator; no per-component ring here.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "border-input placeholder:text-muted-foreground file:text-foreground disabled:bg-muted aria-invalid:border-destructive h-11 w-full min-w-0 rounded-lg border bg-transparent px-3 py-1 text-base transition-colors outline-none file:inline-flex file:h-8 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
