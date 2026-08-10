"use client";

import { useState, useTransition } from "react";
import { ProductImage } from "@/components/storefront/product-image";
import Link from "next/link";
import { Trash2 } from "lucide-react";

import { QuantityStepper } from "@/components/storefront/quantity-stepper";
import { addToBag, removeLine, setQuantity } from "@/lib/actions/cart";
import { formatPaise } from "@/lib/format";
import type { CartLine } from "@/lib/cart-types";
import { useBagUi } from "@/lib/stores/bag";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * The lines in the bag — the same component on the /cart page and in the
 * drawer, because they are the same list and two of them would drift.
 *
 * Every change is optimistic and rolls back out loud. The server is still the
 * authority: it re-reads stock, caps the quantity, and the number it sends back
 * replaces the guess. When those differ the customer is told which and why —
 * "Only 2 left" is a fact they need before checkout, not after.
 *
 * Removing offers an undo rather than a confirmation dialog. A dialog costs
 * every removal a decision to protect against the rare wrong one; an undo costs
 * nothing until it is needed, and on a phone it is the difference between a
 * list you can edit and a list you are careful with.
 */
/**
 * What heading level each product name should be.
 *
 * Deliberately its own prop rather than something inferred from `compact`. The
 * two happen to correlate today and are not the same question: `compact` is
 * about width, this is about where the list sits in the document outline. On
 * `/cart` the page's own `<h1>Your bag</h1>` is directly above, so the names
 * are `h2`. In the drawer, Radix renders `Dialog.Title` as an `h2`, so they are
 * `h3`. It was hardcoded to `h3` for both, which was right in the drawer and
 * produced `h1 -> h3 -> h2` on the page — a skipped level and then a jump back
 * up, which is how a screen-reader user loses the shape of the page.
 */
type HeadingLevel = "h2" | "h3";

export function CartLines({
  lines,
  onChanged,
  compact,
  headingLevel = "h2",
  className,
}: {
  lines: CartLine[];
  /** Re-read the server. The drawer refetches; the page revalidates. */
  onChanged?: () => void;
  /** The drawer is narrower and drops the SKU line. */
  compact?: boolean;
  headingLevel?: HeadingLevel;
  className?: string;
}) {
  return (
    <ul className={cn("divide-border divide-y", className)}>
      {lines.map((line) => (
        <CartLineRow
          key={line.id}
          line={line}
          onChanged={onChanged}
          compact={compact}
          headingLevel={headingLevel}
        />
      ))}
    </ul>
  );
}

function CartLineRow({
  line,
  onChanged,
  compact,
  headingLevel,
}: {
  line: CartLine;
  onChanged?: () => void;
  compact?: boolean;
  headingLevel: HeadingLevel;
}) {
  const Heading = headingLevel;
  const [optimistic, setOptimistic] = useState<number | null>(null);
  const [removed, setRemoved] = useState(false);
  const [pending, startTransition] = useTransition();
  const refreshBag = useBagUi((state) => state.refresh);
  // The header badge counts units; every optimistic change here moves it too.
  const bump = useBagUi((state) => state.bump);

  const quantity = optimistic ?? line.quantity;
  const ceiling = Math.min(line.stock, 10);

  // Gone from this list the instant it is removed, so the row does not sit
  // there greyed out while the server catches up.
  if (removed) return null;

  const settle = () => {
    setOptimistic(null);
    void refreshBag();
    onChanged?.();
  };

  const change = (next: number) => {
    if (next < 1) return;
    const shown = quantity;
    setOptimistic(next);
    bump(next - shown);

    startTransition(async () => {
      const result = await setQuantity({ itemId: line.id, quantity: next });

      if (!result.ok) {
        setOptimistic(null);
        bump(shown - next);
        toast.failed(result.message);
        onChanged?.();
        return;
      }

      if (result.data.capped) {
        // The server held fewer than asked; the badge follows the truth.
        bump(result.data.quantity - next);
        toast.note(
          `Only ${result.data.quantity} left in UK ${line.size}`,
          `${line.productName} — your bag has been set to what we hold.`,
        );
      }
      settle();
    });
  };

  const remove = () => {
    const shown = quantity;
    setRemoved(true);
    bump(-shown);

    startTransition(async () => {
      const result = await removeLine({ itemId: line.id });

      if (!result.ok) {
        setRemoved(false);
        bump(shown);
        toast.failed(result.message);
        return;
      }

      const { variantId, quantity: was, name, size } = result.data;
      void refreshBag();
      onChanged?.();

      toast.undoable("Removed from bag", `${name} · UK ${size}`, () => {
        bump(was);
        startTransition(async () => {
          const back = await addToBag({ variantId, quantity: was });
          if (!back.ok) {
            bump(-was);
            toast.failed(back.message);
            return;
          }
          void refreshBag();
          onChanged?.();
          toast.done("Back in your bag", `${name} · UK ${size}`);
        });
      });
    });
  };

  return (
    <li className={cn("flex gap-4 py-4", pending && "opacity-70")}>
      <Link
        href={`/product/${line.productSlug}`}
        className="bg-fog relative aspect-4/5 w-20 shrink-0 overflow-hidden rounded-lg"
        tabIndex={-1}
        aria-hidden
      >
        {line.imageUrl ? (
          <ProductImage
            src={line.imageUrl}
            alt=""
            fill
            loading="lazy"
            // Contain, matching the card: the same asset, and at 80px a crop
            // costs a shoe its toe. It also lines the thumbnail up with what
            // the customer clicked, which a crop does not.
            sizes="80px"
            className="object-contain"
          />
        ) : null}
      </Link>

      {/*
        One wrapping flex line, ordered twice.

        Narrow — and in the drawer at every width — it reads details, price,
        then the controls on their own row underneath, which is the shape a
        380px column can hold. On the bag page from `lg` the controls move up
        between the details and the price, so the three groups share one line
        and the price is a step away from the shoe rather than stranded at the
        far side of an empty half-column. Ordering rather than two renderings:
        one price in the DOM, read once.
      */}
      <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-6 gap-y-3">
        <div className="order-1 min-w-0 flex-1">
          {line.brand ? (
            <p className="text-muted-foreground font-mono text-xs tracking-[0.14em] uppercase">
              {line.brand}
            </p>
          ) : null}
          {/*
            `hit-44` rather than a taller box. The name is a 14px line inside a
            three-line block, and giving the anchor 44px of its own would space
            the brand, the name and the size apart until the row stopped reading
            as one item. The audit measured this link at 98x18 with a bag in it
            — /cart is in the audit's route list but the harness never puts
            anything in the bag, so every line-item control has been unmeasured
            since the bag shipped.
          */}
          <Heading className="mt-0.5 text-sm font-medium">
            <Link
              href={`/product/${line.productSlug}`}
              className="hit-44 hover:text-orange-ink"
            >
              {line.productName}
            </Link>
          </Heading>
          <p className="text-muted-foreground mt-1 font-mono text-xs tracking-[0.06em] tabular-nums">
            UK {line.size} · {line.color}
            {compact ? null : ` · ${line.sku}`}
          </p>
        </div>

        <div
          className={cn(
            "order-3 flex w-full flex-wrap items-center gap-3",
            compact ? null : "md:order-2 md:w-auto md:flex-none",
          )}
        >
          <QuantityStepper
            quantity={quantity}
            max={ceiling}
            onChange={change}
            busy={pending}
            label={`${line.productName}, UK ${line.size}`}
          />

          <button
            type="button"
            onClick={remove}
            // `hover:text-state-low` was inert: --state-low was cut from the
            // palette in the design system and never removed from here, so the
            // one destructive control in the bag had no hover state at all.
            className="hit-44 text-muted-foreground hover:text-foreground inline-flex min-h-9 items-center gap-1.5 rounded-lg text-xs transition-colors"
          >
            <Trash2 className="size-3.5" aria-hidden />
            Remove
            <span className="sr-only">
              {line.productName}, UK {line.size}, from your bag
            </span>
          </button>

          {/* Same cut token, same silence. Stock pressure is the one thing on
              this row a customer has to act on, and it was rendering in body
              colour. `--fv-orange-ink` is the palette's text orange, 5.20:1. */}
          {line.stock <= 3 ? (
            <span className="text-orange-ink font-mono text-xs tracking-[0.06em]">
              Only {line.stock} left
            </span>
          ) : null}
        </div>

        <p
          className={cn(
            "order-2 shrink-0 font-mono text-sm font-medium tabular-nums",
            compact ? null : "md:order-3",
          )}
        >
          {formatPaise(line.unitPrice * quantity)}
        </p>
      </div>
    </li>
  );
}
