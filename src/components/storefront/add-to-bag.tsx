"use client";

import { useTransition } from "react";

import { Button } from "@/components/ui/button";
import { addToBag, setQuantity } from "@/lib/actions/cart";
import { useBagUi } from "@/lib/stores/bag";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * Add to bag.
 *
 * Two behaviours the brief is specific about, and both are about not scolding
 * somebody for a step they have not taken yet:
 *
 * **No size chosen is not an error.** Pressing the button without a size does
 * not raise a toast saying so — it moves the focus to the size run and marks
 * it, because the customer has not done anything wrong, they have simply
 * arrived at the next decision. An error toast for a missing selection blames
 * the customer for the form's ordering.
 *
 * **Every add can be taken back.** The most common regret on a phone is a tap
 * you did not mean, and the fix belongs next to the thing that just happened.
 * Undo restores the previous quantity rather than emptying the line, so adding
 * a fourth pair and undoing leaves the three that were already there.
 */
export function AddToBag({
  variantId,
  label = "Add to bag",
  size = "lg",
  className,
  onNeedSize,
  soldOut,
}: {
  /** Null when no size is chosen yet, or when the chosen size has no variant. */
  variantId: string | null;
  label?: string;
  size?: "default" | "lg";
  className?: string;
  /** Focus and mark the size run. Called instead of complaining. */
  onNeedSize?: () => void;
  soldOut?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const refreshBag = useBagUi((state) => state.refresh);

  return (
    <Button
      size={size}
      className={cn(className)}
      disabled={pending || soldOut}
      // Not `disabled` when a size is missing: a disabled button cannot be
      // focused, cannot be pressed, and so can never explain itself. It stays
      // live and answers the press by pointing at what is missing.
      aria-describedby={variantId ? undefined : "size-required-hint"}
      onClick={() => {
        if (!variantId) {
          onNeedSize?.();
          return;
        }

        startTransition(async () => {
          const result = await addToBag({ variantId, quantity: 1 });

          if (!result.ok) {
            toast.failed(result.message);
            return;
          }

          void refreshBag();
          const { itemId, name, size: chosen, previousQuantity } = result.data;

          toast.undoable(
            "Added to bag",
            `${name} · UK ${chosen}`,
            () => {
              startTransition(async () => {
                const undone = await setQuantity({ itemId, quantity: previousQuantity });
                if (!undone.ok) {
                  toast.failed(undone.message);
                  return;
                }
                void refreshBag();
                toast.note(previousQuantity === 0 ? "Removed from bag" : "Back to what it was");
              });
            },
          );
        });
      }}
    >
      {pending ? "Adding…" : soldOut ? "Sold out" : label}
    </Button>
  );
}
