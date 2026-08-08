import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A native `<select>`, restyled to the Foot Vault tokens.
 *
 * Deliberately native rather than the Radix listbox shadcn ships. The first
 * thing this has to carry is the Indian state field — 36 options, on a phone,
 * inside a checkout. The platform control opens the OS picker with one tap,
 * scrolls with a thumb, types-to-jump, works with every screen reader without
 * an ARIA pattern to get wrong, and adds nothing to the bundle. A custom
 * listbox would be 36 popover children rendered into the page, a scroll
 * container to manage, and a focus trap to test — for a control the customer
 * uses once.
 *
 * The same two departures from the shadcn defaults as `Input`, for the same
 * reasons: `h-11` clears the 44px tap floor, and `text-base` at every width
 * stops iOS Safari zooming the page when the field takes focus.
 *
 * No `outline-none`, unlike `Input`. Tailwind puts that utility in
 * `@layer utilities`, which outranks the `:focus-visible` rule in
 * `@layer base` at equal specificity — so `outline-none` silently deletes the
 * 2px orange half of the composite focus indicator and leaves only the navy
 * halo. Measured on the header buttons of `/product` and `/cart`:
 * `outline-style: none`. That was a pre-existing bug in `button.tsx` and
 * `input.tsx`; both were fixed in Phase 5 once this file surfaced it.
 *
 * The chevron is `aria-hidden` and `pointer-events-none` — it is the affordance
 * the platform arrow would have drawn before `appearance-none` removed it, not
 * a control of its own.
 */
function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <div className="relative">
      <select
        data-slot="select"
        className={cn(
          "border-input disabled:bg-muted aria-invalid:border-destructive h-11 w-full min-w-0 appearance-none rounded-lg border bg-transparent py-1 pr-10 pl-3 text-base transition-colors disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="text-muted-foreground pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2"
      />
    </div>
  );
}

export { Select };
