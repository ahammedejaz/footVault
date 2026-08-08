import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * Restyled to the Foot Vault tokens — this is deliberately not the shadcn
 * default look.
 *
 * Two things drive the shape of this file:
 *
 * 1. Every size clears 44px, because the quality floor requires 44×44 tap
 *    targets and shadcn's stock `h-8` default is 32px.
 * 2. The primary variant is navy-on-orange, never white-on-orange. White on
 *    #FE9301 measures 2.24:1 and fails; navy measures 8.18:1.
 *
 * Focus rings are omitted here on purpose: the composite orange+halo indicator
 * is defined once globally in globals.css so it can never drift per component.
 *
 * Which is exactly why there is **no `outline-none`** in the class string, and
 * why re-adding it from the shadcn default would be a regression. Tailwind puts
 * that utility in `@layer utilities`, which outranks the `:focus-visible` rule
 * in `@layer base` — so it silently deleted the 2px orange half of the
 * indicator and left only the navy halo, while the comment above went on
 * claiming otherwise. Measured on the header buttons of `/product` and
 * `/cart` before the fix: `outline-style: none`.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-transparent bg-clip-padding font-medium whitespace-nowrap transition-colors select-none active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-45 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground font-semibold hover:bg-[color-mix(in_srgb,var(--fv-orange)_88%,var(--fv-ink))]",
        outline:
          "border-foreground/25 text-foreground hover:border-foreground hover:bg-foreground hover:text-background",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_srgb,var(--secondary),var(--foreground)_7%)]",
        ghost: "text-foreground hover:bg-muted",
        destructive:
          "bg-destructive text-white hover:bg-[color-mix(in_srgb,var(--destructive)_88%,#000)]",
        link: "h-auto min-h-0 px-0 text-orange-ink underline-offset-4 hover:underline",
      },
      size: {
        /* 44px — the tap-target floor, and the storefront default. */
        default: "h-11 px-5 text-sm",
        /* 52px — the primary CTA: Add to bag, Place order. */
        lg: "h-13 px-7 text-base",
        /* 36px visual height for dense admin tables, with an invisible hit
           area extended to 44px so a thumb still lands on a tablet in-store. */
        sm: "h-9 px-3.5 text-sm relative before:absolute before:top-1/2 before:left-1/2 before:h-11 before:w-full before:min-w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']",
        icon: "size-11",
        "icon-sm":
          "size-9 relative before:absolute before:top-1/2 before:left-1/2 before:size-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
