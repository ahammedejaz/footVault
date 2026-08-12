"use client";

import { useEffect, useState } from "react";

import { previewCoinSpend } from "@/lib/actions/coins";
import type { CoinSpendPlan } from "@/lib/coins/redeem";
import { formatPaise } from "@/lib/format";

/**
 * "Use my Vault Coins" — one checkbox, spending as many as the rules allow.
 *
 * A checkbox rather than an amount field (owner's standing rule: the simple
 * rule that fits on screen beats the flexible one needing a paragraph). The
 * sentence names the exact coins and rupees before the customer commits,
 * and which rule stopped it going higher when one did.
 *
 * Renders NOTHING when coins are not spendable here — signed out, none
 * held, programme not switched on, under the minimum. A checkout is the
 * wrong place to advertise a programme; the account page explains it.
 */
export function CoinSpendOption({
  quoteKey,
  grandTotalPaise,
  advancePaise,
  balancePaise,
  paysOnDelivery,
  checked,
  onChange,
}: {
  /** Changes when the quote does, so the preview follows the numbers. */
  quoteKey: string;
  grandTotalPaise: number;
  advancePaise: number;
  balancePaise: number;
  paysOnDelivery: boolean;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const [plan, setPlan] = useState<CoinSpendPlan | null>(null);

  useEffect(() => {
    let cancelled = false;
    void previewCoinSpend({ grandTotalPaise, advancePaise, balancePaise }).then(
      (answer) => {
        if (!cancelled) setPlan(answer);
      },
    );
    return () => {
      cancelled = true;
    };
    // quoteKey is the identity of the numbers; the numbers ride along.
  }, [quoteKey, grandTotalPaise, advancePaise, balancePaise]);

  useEffect(() => {
    // A quote change can shrink the plan to nothing; a stale tick must not
    // ride into placeOrder looking like a choice.
    if (checked && plan && !plan.available) onChange(false);
  }, [checked, plan, onChange]);

  if (!plan?.available) return null;

  return (
    <div className="border-border mt-4 rounded-lg border p-4">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className="accent-orange mt-1 size-4 shrink-0"
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium">
            Use my Vault Coins — {plan.coins}{" "}
            {plan.coins === 1 ? "coin" : "coins"} ({formatPaise(plan.paise)})
          </span>
          <span className="text-muted-foreground mt-0.5 block text-sm text-pretty">
            {paysOnDelivery
              ? `Comes off the cash you pay at the door. The ${formatPaise(advancePaise)} paid now stays the same — it covers delivery.`
              : plan.paise === advancePaise
                ? "That settles the whole order. Nothing to pay by card."
                : `Comes off what you pay by card now.`}
            {plan.boundBy === "percent_cap" || plan.boundBy === "coin_cap"
              ? " This is the most that can go on one order — the rest stays in your account."
              : ""}
          </span>
        </span>
      </label>
    </div>
  );
}
