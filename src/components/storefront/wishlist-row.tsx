"use client";

import { useState, useTransition } from "react";
import { ProductImage } from "@/components/storefront/product-image";
import Link from "next/link";

import { SizeSelector } from "@/components/storefront/size-selector";
import { Button } from "@/components/ui/button";
import { addToBag } from "@/lib/actions/cart";
import { toggleSaved } from "@/lib/actions/wishlist";
import type { ProductSummary } from "@/lib/catalog-types";
import { formatPaise } from "@/lib/format";
import { useBagUi } from "@/lib/stores/bag";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * One saved shoe, with the move to the bag done in place.
 *
 * A saved item is a decision half made, so the remaining half — which size —
 * happens here rather than by sending the customer back to the product page and
 * expecting them to find their way to the bag. The size run is the same
 * component as everywhere else, so it looks and behaves like the one they
 * already used.
 *
 * A size is required and its absence is not an error: pressing "Move to bag"
 * with nothing chosen marks the strip instead of raising a toast, the same as
 * on the product page.
 */
export function WishlistRow({ product }: { product: ProductSummary }) {
  const [colourway, setColourway] = useState(product.colors[0]?.name ?? null);
  const [size, setSize] = useState<string | null>(null);
  const [needsSize, setNeedsSize] = useState(false);
  const [gone, setGone] = useState(false);
  const [pending, startTransition] = useTransition();
  const refreshBag = useBagUi((state) => state.refresh);
  const bump = useBagUi((state) => state.bump);

  if (gone) return null;

  const active =
    product.colors.find((c) => c.name === colourway) ??
    product.colors[0] ??
    null;
  const sizes =
    active && active.sizes.length > 0 ? active.sizes : product.sizes;
  const available = sizes.filter((entry) => entry.available);
  // One size in stock is not a choice, so it is made for them.
  const chosen = size ?? (available.length === 1 ? available[0]!.size : null);
  const entry = chosen ? sizes.find((s) => s.size === chosen) : undefined;
  const price = product.salePrice ?? product.basePrice;

  const move = () => {
    if (!entry?.variantId || !entry.available) {
      setNeedsSize(true);
      return;
    }

    // The badge moves with the tap; the round trip is what this hides.
    bump(1);
    startTransition(async () => {
      const added = await addToBag({
        variantId: entry.variantId!,
        quantity: 1,
      });
      if (!added.ok) {
        bump(-1);
        toast.failed(added.message);
        return;
      }
      void refreshBag();

      // Moved, not copied: it is in the bag now, so leaving it in the saved
      // list as well would show it in two places and make "saved" mean nothing.
      const unsaved = await toggleSaved(product.id);
      if (unsaved.ok) setGone(true);

      toast.done("Moved to bag", `${product.name} · UK ${entry.size}`);
    });
  };

  return (
    <li className="border-border flex gap-4 border-b py-6 last:border-b-0">
      <Link
        href={`/product/${product.slug}`}
        className="bg-fog relative aspect-4/5 w-24 shrink-0 overflow-hidden rounded-lg sm:w-28"
        tabIndex={-1}
        aria-hidden
      >
        {product.heroImage ? (
          <ProductImage
            src={product.heroImage.url}
            alt=""
            fill
            loading="lazy"
            sizes="112px"
            className="object-cover"
          />
        ) : null}
      </Link>

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {product.brandName ? (
              <p className="text-muted-foreground font-mono text-xs tracking-[0.14em] uppercase">
                {product.brandName}
              </p>
            ) : null}
            <h2 className="mt-0.5 text-sm font-medium">
              <Link
                href={`/product/${product.slug}`}
                className="hover:text-orange-ink"
              >
                {product.name}
              </Link>
            </h2>
          </div>
          <p className="shrink-0 font-mono text-sm font-medium tabular-nums">
            {formatPaise(price)}
          </p>
        </div>

        {product.colors.length > 1 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {product.colors.map((colour) => (
              <button
                key={colour.name}
                type="button"
                onClick={() => {
                  setColourway(colour.name);
                  setSize(null);
                  setNeedsSize(false);
                }}
                aria-pressed={colour.name === colourway}
                className={cn(
                  "hit-44 rounded-lg border px-2 py-1 font-mono text-xs",
                  colour.name === colourway ? "border-orange" : "border-border",
                )}
              >
                {colour.name}
              </button>
            ))}
          </div>
        ) : null}

        {available.length === 0 ? (
          <p className="text-state-out mt-3 font-mono text-xs tracking-[0.06em] uppercase">
            Sold out in every size
          </p>
        ) : (
          <div
            className={cn(
              "mt-3 rounded-lg transition-shadow",
              // Cut token: this ring never drew. Same defect as product-viewer.
              needsSize &&
                "ring-destructive/60 ring-2 ring-offset-4 ring-offset-background",
            )}
          >
            <p id={`size-label-${product.id}`} className="sr-only">
              Size, in UK
            </p>
            <SizeSelector
              sizes={sizes}
              selected={chosen}
              onSelect={(value) => {
                setSize(value);
                setNeedsSize(false);
              }}
              labelledBy={`size-label-${product.id}`}
            />
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            onClick={move}
            disabled={pending || available.length === 0}
            aria-describedby={needsSize ? `size-hint-${product.id}` : undefined}
          >
            {pending ? "Moving…" : "Move to bag"}
          </Button>
          <button
            type="button"
            className="hit-44 text-muted-foreground hover:text-foreground inline-flex min-h-9 items-center rounded-lg text-xs transition-colors"
            onClick={() => {
              setGone(true);
              startTransition(async () => {
                const result = await toggleSaved(product.id);
                if (!result.ok) {
                  setGone(false);
                  toast.failed(result.message);
                  return;
                }
                toast.note("Removed from saved", product.name);
              });
            }}
          >
            Remove
            <span className="sr-only"> {product.name} from saved items</span>
          </button>
        </div>

        {needsSize ? (
          <p
            id={`size-hint-${product.id}`}
            className="text-destructive mt-2 font-mono text-xs"
          >
            Choose a size first
          </p>
        ) : null}
      </div>
    </li>
  );
}
