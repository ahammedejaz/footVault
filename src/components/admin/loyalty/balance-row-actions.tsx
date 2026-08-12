"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { adjustCoins, setCoinsDisabled } from "@/lib/actions/admin/loyalty";
import { Button } from "@/components/ui/button";

/**
 * Per-customer controls: a ledger adjustment with its required reason, and
 * the disable switch. The adjustment form appears inline when asked for —
 * the reason is a record the owner reads back later, and the ledger refuses
 * a blank one anyway.
 */
export function BalanceRowActions({
  userId,
  disabled,
}: {
  userId: string;
  disabled: boolean;
}) {
  const [adjusting, setAdjusting] = useState(false);
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <div className="flex flex-wrap items-center gap-2">
      {!adjusting ? (
        <Button variant="outline" size="sm" onClick={() => setAdjusting(true)}>
          Adjust coins…
        </Button>
      ) : (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            startTransition(async () => {
              const result = await adjustCoins({
                userId,
                delta: Number(delta),
                reason,
              });
              if (result.ok) {
                toast.success("Adjustment written to the ledger.");
                setAdjusting(false);
                setDelta("");
                setReason("");
                router.refresh();
              } else {
                toast.error(result.message);
              }
            });
          }}
        >
          <label className="sr-only" htmlFor={`adjust-delta-${userId}`}>
            Coins to add, negative to remove
          </label>
          <input
            id={`adjust-delta-${userId}`}
            type="number"
            value={delta}
            onChange={(event) => setDelta(event.target.value)}
            placeholder="+10 / −10"
            className="border-border bg-background w-24 rounded-lg border px-2 py-1.5 font-mono text-sm tabular-nums"
          />
          <label className="sr-only" htmlFor={`adjust-reason-${userId}`}>
            Why — written into the ledger
          </label>
          <input
            id={`adjust-reason-${userId}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why? Written into the ledger."
            maxLength={500}
            className="border-border bg-background w-56 rounded-lg border px-2 py-1.5 text-sm"
          />
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Writing…" : "Write it"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setAdjusting(false)}
          >
            Cancel
          </Button>
        </form>
      )}

      <Button
        variant={disabled ? "outline" : "ghost"}
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await setCoinsDisabled({
              userId,
              disabled: !disabled,
            });
            if (result.ok) {
              toast.success(
                result.disabled
                  ? "Coins disabled for this customer — no earning, no spending."
                  : "Coins re-enabled for this customer.",
              );
              router.refresh();
            } else {
              toast.error(result.message);
            }
          })
        }
      >
        {disabled ? "Enable coins" : "Disable coins"}
      </Button>
    </div>
  );
}
