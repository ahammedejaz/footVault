"use client";

import { useState, useTransition } from "react";
import Image from "next/image";
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
export function CartLines({
  lines,
  onChanged,
  compact,
}: {
  lines: CartLine[];
  /** Re-read the server. The drawer refetches; the page revalidates. */
  onChanged?: () => void;
  /** The drawer is narrower and drops the SKU line. */
  compact?: boolean;
}) {
  return (
    <ul className="divide-border divide-y">
      {lines.map((line) => (
        <CartLineRow key={line.id} line={line} onChanged={onChanged} compact={compact} />
      ))}
    </ul>
  );
}

function CartLineRow({
  line,
  onChanged,
  compact,
}: {
  line: CartLine;
  onChanged?: () => void;
  compact?: boolean;
}) {
  const [optimistic, setOptimistic] = useState<number | null>(null);
  const [removed, setRemoved] = useState(false);
  const [pending, startTransition] = useTransition();
  const refreshBag = useBagUi((state) => state.refresh);

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
    setOptimistic(next);

    startTransition(async () => {
      const result = await setQuantity({ itemId: line.id, quantity: next });

      if (!result.ok) {
        setOptimistic(null);
        toast.failed(result.message);
        onChanged?.();
        return;
      }

      if (result.data.capped) {
        toast.note(
          `Only ${result.data.quantity} left in UK ${line.size}`,
          `${line.productName} — your bag has been set to what we hold.`,
        );
      }
      settle();
    });
  };

  const remove = () => {
    setRemoved(true);

    startTransition(async () => {
      const result = await removeLine({ itemId: line.id });

      if (!result.ok) {
        setRemoved(false);
        toast.failed(result.message);
        return;
      }

      const { variantId, quantity: was, name, size } = result.data;
      void refreshBag();
      onChanged?.();

      toast.undoable(
        "Removed from bag",
        `${name} · UK ${size}`,
        () => {
          startTransition(async () => {
            const back = await addToBag({ variantId, quantity: was });
            if (!back.ok) {
              toast.failed(back.message);
              return;
            }
            void refreshBag();
            onChanged?.();
            toast.done("Back in your bag", `${name} · UK ${size}`);
          });
        },
      );
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
          <Image
            src={line.imageUrl}
            alt=""
            fill
            loading="lazy"
            sizes="80px"
            className="object-cover"
          />
        ) : null}
      </Link>

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {line.brand ? (
              <p className="text-muted-foreground font-mono text-xs tracking-[0.14em] uppercase">
                {line.brand}
              </p>
            ) : null}
            <h3 className="mt-0.5 text-sm font-medium">
              <Link href={`/product/${line.productSlug}`} className="hover:text-orange-ink">
                {line.productName}
              </Link>
            </h3>
            <p className="text-muted-foreground mt-1 font-mono text-xs tracking-[0.06em] tabular-nums">
              UK {line.size} · {line.color}
              {compact ? null : ` · ${line.sku}`}
            </p>
          </div>

          <p className="shrink-0 font-mono text-sm font-medium tabular-nums">
            {formatPaise(line.unitPrice * quantity)}
          </p>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
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
            className="hit-44 text-muted-foreground hover:text-state-low inline-flex min-h-9 items-center gap-1.5 rounded-lg text-xs transition-colors"
          >
            <Trash2 className="size-3.5" aria-hidden />
            Remove
            <span className="sr-only">
              {line.productName}, UK {line.size}, from your bag
            </span>
          </button>

          {line.stock <= 3 ? (
            <span className="text-state-low font-mono text-xs tracking-[0.06em]">
              Only {line.stock} left
            </span>
          ) : null}
        </div>
      </div>
    </li>
  );
}
