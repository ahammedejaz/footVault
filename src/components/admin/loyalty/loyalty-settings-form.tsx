"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { saveLoyaltySettings } from "@/lib/actions/admin/loyalty";
import type { LoyaltySettings } from "@/lib/queries/admin/loyalty";
import { Button } from "@/components/ui/button";

/**
 * Every setting with a plain-language account of what it does, what happens
 * set too high, and what happens set too low — the owner's requirement.
 * Every field starts however the database has it: unset stays unset, and an
 * empty box means the programme does not run that half.
 */
const FIELDS: {
  key: keyof Omit<LoyaltySettings, "enabled">;
  label: string;
  explanation: string;
}[] = [
  {
    key: "earnRupeesPerCoin",
    label: "Rupees spent to earn 1 coin",
    explanation:
      "A customer earns 1 coin for every this-many rupees of shoes (never delivery) once the parcel is delivered. Empty: nobody earns anything. Set low (say 10): you are giving away a tenth of every sale as coins. Set high (say 1000): coins arrive so slowly nobody will care. 100 means a one-percent programme when a coin is worth one rupee.",
  },
  {
    key: "coinValuePaise",
    label: "What 1 coin is worth at checkout (paise)",
    explanation:
      "Must be a whole number of rupees (a multiple of 100 paise) — the courier collects cash in whole rupees. Empty: coins cannot be spent. Raising it later is a gift customers notice; lowering it devalues coins people already hold and produces the one complaint you cannot answer. Start low.",
  },
  {
    key: "coinMaxPercentOfOrder",
    label: "Most of an order payable in coins (%)",
    explanation:
      "One of TWO caps — the lower one wins. This one stops a big balance swallowing a small order. Set to 100 and someone with enough coins pays nothing; set to 5 and the programme feels unusable. It binds hardest on cheap orders.",
  },
  {
    key: "coinMaxCoinsPerOrder",
    label: "Most coins spendable on one order",
    explanation:
      "The other cap — an absolute count, so a customer holding 250 coins can spend only this many at once, however big the order. It binds hardest on expensive orders, where the percent cap alone would let the whole balance go. The intent of the pair: every order is part-paid in real money.",
  },
  {
    key: "coinMinimumBalance",
    label: "Coins needed before spending any",
    explanation:
      "Below this balance the checkout does not offer coins. Too low and the ledger churns coin-sized redemptions; too high and most customers never reach it — a balance they can see but never spend reads as a promise being withheld.",
  },
  {
    key: "coinExpiryMonths",
    label: "Months before earned coins expire",
    explanation:
      "Counted from the day the parcel was delivered, stamped on the coins when they are minted. Empty: coins currently NEVER expire, and the liability figure on the dashboard only grows — watch it. Setting this later only affects newly earned coins; nobody's existing coins change.",
  },
];

export function LoyaltySettingsForm({ initial }: { initial: LoyaltySettings }) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(
      FIELDS.map((field) => [
        field.key,
        initial[field.key] === null ? "" : String(initial[field.key]),
      ]),
    ),
  );
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          const parsedNumber = (key: string) =>
            values[key]?.trim() === "" || values[key] === undefined
              ? null
              : Number(values[key]);
          const result = await saveLoyaltySettings({
            enabled,
            earnRupeesPerCoin: parsedNumber("earnRupeesPerCoin"),
            coinValuePaise: parsedNumber("coinValuePaise"),
            coinMaxPercentOfOrder: parsedNumber("coinMaxPercentOfOrder"),
            coinMaxCoinsPerOrder: parsedNumber("coinMaxCoinsPerOrder"),
            coinMinimumBalance: parsedNumber("coinMinimumBalance"),
            coinExpiryMonths: parsedNumber("coinExpiryMonths"),
          });
          if (result.ok) {
            toast.success("Loyalty settings saved.");
            router.refresh();
          } else {
            toast.error(result.message);
          }
        });
      }}
    >
      <label className="border-border flex items-start gap-3 rounded-lg border p-4">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          className="accent-orange mt-1 size-4 shrink-0"
        />
        <span>
          <span className="block text-sm font-medium">
            Vault Coins are switched on
          </span>
          <span className="text-muted-foreground mt-0.5 block text-sm text-pretty">
            The master switch, enforced in the database on both sides: off
            means no order earns and no order spends, whatever the numbers
            below say. Balances are untouched — pausing the programme does
            not take anything from anybody.
          </span>
        </span>
      </label>

      <div className="mt-4 space-y-4">
        {FIELDS.map((field) => (
          <div key={field.key} className="border-border rounded-lg border p-4">
            <label className="block">
              <span className="text-sm font-medium">{field.label}</span>
              <input
                type="number"
                inputMode="numeric"
                value={values[field.key] ?? ""}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [field.key]: event.target.value,
                  }))
                }
                placeholder="Not set"
                className="border-border bg-background mt-2 block w-40 rounded-lg border px-3 py-2 font-mono text-sm tabular-nums"
              />
            </label>
            <p className="text-muted-foreground mt-2 max-w-prose text-sm text-pretty">
              {field.explanation}
            </p>
          </div>
        ))}
      </div>

      <Button type="submit" disabled={pending} className="mt-4">
        {pending ? "Saving…" : "Save loyalty settings"}
      </Button>
    </form>
  );
}
