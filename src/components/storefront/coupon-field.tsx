"use client";

import * as React from "react";

import { applyCoupon, removeCoupon } from "@/lib/actions/coupon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPaise } from "@/lib/format";

/**
 * The coupon field, live (§9F).
 *
 * What "applied" means here is precise and worth keeping precise: the code is
 * written to the cart row and priced into the checkout preview. It is not
 * *spent* until Place Order, where `create_order_with_stock` re-validates it
 * under a row lock — so everything this component shows is a preview, and the
 * copy says "at checkout" rather than promising a number that could move.
 *
 * The saving shown comes from the server's verdict, never computed here: the
 * rounding rule and the no-stacking rule live in one place each, and a second
 * implementation in a client component is how two surfaces disagree.
 */
export function CouponField({ appliedCode }: { appliedCode: string | null }) {
  const [pending, startTransition] = React.useTransition();
  const [message, setMessage] = React.useState<string | null>(null);
  const [savedPaise, setSavedPaise] = React.useState<number | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const submit = () => {
    const code = inputRef.current?.value ?? "";
    setMessage(null);
    startTransition(async () => {
      const result = await applyCoupon({ code });
      if (result.ok) {
        setSavedPaise(result.discountPaise);
        setMessage(null);
      } else {
        setSavedPaise(null);
        setMessage(result.message);
      }
    });
  };

  const remove = () => {
    setMessage(null);
    startTransition(async () => {
      const result = await removeCoupon();
      if (!result.ok) setMessage(result.message);
      else setSavedPaise(null);
    });
  };

  if (appliedCode) {
    return (
      <div>
        <p className="font-mono text-xs tracking-[0.06em] uppercase">
          Coupon applied
        </p>
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-sm">
            <span className="font-mono font-medium">{appliedCode}</span>
            {savedPaise ? (
              <span className="text-muted-foreground">
                {" "}
                — about {formatPaise(savedPaise)} off at checkout
              </span>
            ) : (
              <span className="text-muted-foreground">
                {" "}
                — applied at checkout
              </span>
            )}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={remove}
            disabled={pending}
          >
            Remove
          </Button>
        </div>
        <p aria-live="polite" className="text-destructive mt-2 text-xs">
          {message}
        </p>
      </div>
    );
  }

  return (
    <div>
      <Label
        htmlFor="coupon"
        className="font-mono text-xs tracking-[0.06em] uppercase"
      >
        Coupon code
      </Label>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Input
          id="coupon"
          name="coupon"
          ref={inputRef}
          placeholder="FOOTVAULT10"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={40}
          disabled={pending}
          aria-describedby="coupon-status"
          className="font-mono uppercase"
        />
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Checking…" : "Apply"}
        </Button>
      </form>
      <p
        id="coupon-status"
        aria-live="polite"
        className={
          message
            ? "text-destructive mt-2 text-xs text-pretty"
            : "text-muted-foreground mt-2 text-xs text-pretty"
        }
      >
        {message ?? "Applied to the goods total when you place the order."}
      </p>
    </div>
  );
}
