"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { acknowledgeCartChanges } from "@/lib/actions/cart";
import { formatPaise } from "@/lib/format";
import type { CartAdjustment } from "@/lib/cart-types";

/**
 * What changed while the customer was away.
 *
 * The bag re-reads price and stock on every load, and anything it had to change
 * is said here in plain language before the total is shown — never silently,
 * and never as a total that quietly differs from the one they decided on.
 *
 * "Got it" is a real write. `getCart()` reports the differences without
 * persisting them, because it runs during render; acknowledging is what brings
 * the stored quantities and price snapshots up to date so the notice does not
 * follow them around afterwards.
 */
export function CartNotices({
  adjustments,
}: {
  adjustments: CartAdjustment[];
}) {
  const [dismissed, setDismissed] = useState(false);
  const [pending, startTransition] = useTransition();

  if (adjustments.length === 0 || dismissed) return null;

  return (
    <div
      role="status"
      // Both halves of this were cut tokens, so the panel drew with no border
      // colour and no tint — a notice that did not read as one. Neutral rather
      // than warm on purpose: design-system §7 cut the second orange because it
      // fights the accent, and this is a status message, not an error.
      className="border-border bg-muted mb-6 rounded-lg border p-4"
    >
      <p className="font-mono text-xs tracking-[0.06em] uppercase">
        Your bag changed since you left it
      </p>
      <ul className="mt-2 space-y-1.5 text-sm">
        {adjustments.map((adjustment, index) => (
          <li
            key={`${adjustment.kind}-${adjustment.name}-${adjustment.size}-${index}`}
          >
            {sentence(adjustment)}
          </li>
        ))}
      </ul>
      <Button
        variant="outline"
        size="sm"
        className="mt-3"
        disabled={pending}
        onClick={() => {
          setDismissed(true);
          startTransition(async () => {
            await acknowledgeCartChanges();
          });
        }}
      >
        Got it
      </Button>
    </div>
  );
}

/** One change, as a sentence somebody would actually say. */
function sentence(adjustment: CartAdjustment): string {
  const item = adjustment.size
    ? `${adjustment.name} (UK ${adjustment.size})`
    : adjustment.name;

  switch (adjustment.kind) {
    case "price": {
      const direction =
        adjustment.to > adjustment.from ? "went up" : "came down";
      return `${item} ${direction} from ${formatPaise(adjustment.from)} to ${formatPaise(adjustment.to)}.`;
    }
    case "stock":
      return `We only have ${adjustment.to} of ${item} left, so your bag now holds ${adjustment.to} instead of ${adjustment.from}.`;
    case "gone":
      return `${item} sold out and has been taken out of your bag.`;
  }
}
