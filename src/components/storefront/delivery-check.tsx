"use client";

import * as React from "react";
import { Loader2, Truck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { checkDeliveryTo, type DeliveryCheckResult } from "@/lib/actions/delivery-check";

/**
 * "Do you deliver to me?", answered before the customer commits to anything.
 *
 * The question people actually have on a product page is whether the thing can
 * reach them and roughly when — not what postage costs, which depends on a
 * basket they have not filled yet. So this answers those two and says nothing
 * about price. Quoting a figure here for one pair at a default weight would
 * disagree with checkout, which is precisely the drift this phase removed.
 *
 * It also answers whether Pay on Delivery is available there, because
 * discovering at the payment step that the only method you intended to use is
 * missing is a bad moment to find out.
 */
export function DeliveryCheck() {
  const [pin, setPin] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<DeliveryCheckResult | null>(null);

  const valid = /^\d{6}$/.test(pin);

  return (
    <form
      className="border-border rounded-lg border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || pending) return;
        setPending(true);
        void checkDeliveryTo({ postalCode: pin })
          .then(setResult)
          .finally(() => setPending(false));
      }}
    >
      <label
        htmlFor="delivery-pin"
        className="flex items-center gap-2 text-sm font-medium"
      >
        <Truck aria-hidden className="size-4" />
        Check delivery to your pin code
      </label>

      <div className="mt-2 flex flex-wrap gap-2">
        <Input
          id="delivery-pin"
          value={pin}
          onChange={(event) => {
            setPin(event.target.value.replace(/\D/g, "").slice(0, 6));
            setResult(null);
          }}
          inputMode="numeric"
          autoComplete="postal-code"
          placeholder="516360"
          className="max-w-32"
          aria-describedby="delivery-answer"
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          className="min-h-11"
          disabled={!valid || pending}
        >
          {pending ? (
            <Loader2 aria-hidden className="size-4 animate-spin" />
          ) : null}
          Check
        </Button>
      </div>

      {/*
        A live region, because the answer replaces itself in place and a screen
        reader would otherwise never be told it arrived.
      */}
      <p
        id="delivery-answer"
        role="status"
        className="text-muted-foreground mt-2 text-sm text-pretty"
      >
        {pending ? "Checking…" : answer(result)}
      </p>
    </form>
  );
}

function answer(result: DeliveryCheckResult | null): string {
  if (!result) return "Six digits, and we will tell you if a courier goes there.";
  if (!result.ok) return result.message;
  if (!result.deliverable) {
    return "No courier will carry to that pin code from our store. Try another address, or contact us and we will see what we can do.";
  }

  const when =
    result.estimatedDays === null
      ? "Usually 3–5 working days."
      : `Usually about ${result.estimatedDays} ${result.estimatedDays === 1 ? "day" : "days"} after dispatch.`;

  const cod = result.codAvailable
    ? "Pay on Delivery is available there."
    : "Pay on Delivery is not available there — you can pay online instead.";

  return `${when} ${cod}`;
}
