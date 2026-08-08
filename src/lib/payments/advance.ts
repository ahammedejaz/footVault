import { MIN_CHARGEABLE_PAISE } from "@/lib/payments/types";

/**
 * How much of a Pay-on-Delivery order is paid online, and how much at the door.
 *
 * The model, which replaced unsecured cash on delivery: the customer pays the
 * **advance** through Razorpay at checkout, and the courier collects the
 * **balance** in cash on delivery. The order is not placed until the advance
 * captures, so there is no longer a path that creates a confirmed order with no
 * money against it — `FV-2026-00488` was one of those, `confirmed` and `unpaid`.
 *
 * **Why this is a separate module from the settings that configure it.** The
 * settings reader is `server-only` (it holds a Supabase client); this is pure
 * arithmetic over three numbers. Keeping them apart means the checkout UI can
 * import the rule to *display* a split without dragging a database client into
 * the browser bundle — the failure CI already caught once (`9440fa0`).
 *
 * Nothing here reads settings, a cart, or an order. It takes the rule and the
 * two amounts and returns the split, which is what makes it exhaustively
 * testable — see `npm run audit:totals`.
 */

/** How the advance is decided. The owner picks this in `/admin/settings`. */
export type CodAdvanceMode = "shipping_fee" | "fixed" | "greater_of";

export type AdvanceRule = {
  mode: CodAdvanceMode;
  /** The advance never falls below this. ₹99 by default. */
  minimumPaise: number;
  /** Used only when the mode is `fixed`. */
  fixedPaise: number;
};

export type AdvanceSplit = {
  /** Charged through Razorpay now, before the order is confirmed. */
  advancePaise: number;
  /** Collected by the courier. What Shiprocket must be told to collect. */
  balanceDuePaise: number;
};

export function advanceFor(input: {
  rule: AdvanceRule;
  /** Everything the customer is charged for delivery: shipping + COD handling. */
  deliveryTotalPaise: number;
  grandTotalPaise: number;
}): AdvanceSplit {
  const { rule, deliveryTotalPaise, grandTotalPaise } = input;

  const requested =
    rule.mode === "fixed"
      ? rule.fixedPaise
      : rule.mode === "shipping_fee"
        ? deliveryTotalPaise
        : Math.max(deliveryTotalPaise, rule.minimumPaise);

  /**
   * The floor, applied in two steps because they answer different questions.
   *
   * The **configured minimum** is the shop's answer to "delivery came out free,
   * so how much do we still take to secure the order?" — without it, an order
   * over the free-delivery threshold produces an advance of zero and we are back
   * to unsecured COD, which is the thing this model removes.
   *
   * **Razorpay's floor** is the provider's answer, and it is not negotiable:
   * an order for less than 100 paise cannot be created at all. An owner who
   * types 0 into the minimum field gets this rather than a broken checkout.
   */
  const floored = Math.max(
    requested > 0 ? requested : rule.minimumPaise,
    rule.minimumPaise,
    MIN_CHARGEABLE_PAISE,
  );

  /**
   * Never more than the order is worth.
   *
   * Reachable when a courier quote exceeds a cheap basket — a ₹150 pair of
   * flip-flops to a remote PIN can genuinely cost more to send than it sells
   * for. Charging an advance larger than the total would leave a negative
   * balance for the courier to "collect", so the whole order is simply taken
   * online and the courier collects nothing.
   */
  const advancePaise = Math.min(floored, grandTotalPaise);

  return { advancePaise, balanceDuePaise: grandTotalPaise - advancePaise };
}
