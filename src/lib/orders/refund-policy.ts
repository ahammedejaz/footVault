/**
 * What is owed back, and why — as a table rather than as scattered conditionals.
 *
 * The brief is specific about the shape as well as the answer: *"Build this as
 * an explicit table in code, not scattered conditionals — every branch
 * derivable from the order's state and the freight actually incurred."* The
 * reason is that a refund is the one calculation nobody checks until somebody
 * is angry about it, and a rule spread across four `if`s in three files is a
 * rule nobody can read back to a customer.
 *
 * | Stage | Freight incurred | Prepaid refund | Pay-on-Delivery refund |
 * |---|---|---|---|
 * | Cancelled before shipment created | none | **full** | **full advance** |
 * | Cancelled after AWB, before pickup | usually reversed by Shiprocket | **full** | **full advance** |
 * | Cancelled in transit → RTO | forward + RTO | total − actual freight | **nothing** |
 * | Refused at the door → RTO | forward + RTO | total − actual freight | **nothing** |
 * | Undeliverable — bad address | forward + RTO | total − actual freight | **nothing** |
 * | Delivered, then damage claim | n/a | replacement only | replacement only |
 * | **Shop's own error** | shop's cost | **full, no deduction** | **full advance, no deduction** |
 *
 * ## Two things this file exists to make impossible
 *
 * **A Pay-on-Delivery refund can never exceed the advance.** The rest of that
 * order's money was cash the courier collected — or never collected, on an RTO
 * — and refunding it through Razorpay would be sending the customer money the
 * shop never received. `capturedPaise` is what was actually taken online and
 * every branch is clamped to it.
 *
 * **The shop-error row is a first-class reason, not a workaround.** The brief
 * calls it "not optional" and it is right to: *"damage during shipment only"*
 * does not cover the shop sending the wrong shoe, and the shop will send the
 * wrong shoe. Without a named reason an admin fixing their own mistake has to
 * lie about which branch they are in, and the RTO ledger then reads as a
 * customer problem.
 *
 * Nothing here reads a database, a setting, or an order. It takes the state and
 * the money and returns the answer with a breakdown, which is what makes it
 * exhaustively testable — and what makes the breakdown storable verbatim in
 * `refunds.deduction_breakdown`, so the arithmetic can be shown to a customer
 * six months later.
 */

/** Where the order stopped. Derived from the order, never typed by an admin. */
export type RefundStage =
  | "before_shipment"
  | "after_awb_before_pickup"
  | "in_transit_rto"
  | "refused_rto"
  | "undeliverable_rto"
  | "delivered";

/** Why we are refunding. The admin picks this; it is not derivable. */
export type RefundCause =
  /** The order stopped for an ordinary reason — the table above applies. */
  | "normal"
  /** Wrong item, wrong size, damaged before dispatch. Full, always. */
  | "shop_error";

export type RtoDeductionPolicy = "actual_freight" | "flat" | "none";

export type RefundLine = { label: string; amountPaise: number };

export type RefundVerdict = {
  /** What to send to Razorpay. Never more than was captured. */
  refundPaise: number;
  /** The enum stored on the row, chosen here so the admin cannot mismatch it. */
  reason: "cancelled_before_dispatch" | "rto" | "shop_error" | "other";
  /** Every deduction, itemised, stored verbatim on the refund row. */
  deductions: RefundLine[];
  /** Said to the admin before they press the button, and to the customer after. */
  explanation: string;
  /** True when the answer is "a replacement, not money". */
  replacementOnly: boolean;
};

export function refundFor(input: {
  stage: RefundStage;
  cause: RefundCause;
  /** What was actually taken online. The ceiling on every branch. */
  capturedPaise: number;
  /** Forward freight actually incurred. Zero before a shipment exists. */
  actualForwardPaise: number;
  /** The return leg actually billed by Shiprocket, when one was. */
  actualRtoPaise: number;
  /** The owner's rule for what a prepaid customer loses on an RTO. */
  rtoPolicy: RtoDeductionPolicy;
  rtoFlatDeductionPaise: number;
}): RefundVerdict {
  const {
    stage,
    cause,
    capturedPaise,
    actualForwardPaise,
    actualRtoPaise,
    rtoPolicy,
    rtoFlatDeductionPaise,
  } = input;

  const clamp = (paise: number) =>
    Math.max(0, Math.min(Math.round(paise), Math.max(0, capturedPaise)));

  /**
   * **The shop's error short-circuits every other row**, deliberately and
   * before the stage is even consulted. Wrong shoe, wrong size, damaged on
   * dispatch: the customer pays nothing towards a journey they only took
   * because we got it wrong, whichever stage the order happened to stop at.
   */
  if (cause === "shop_error") {
    return {
      refundPaise: clamp(capturedPaise),
      reason: "shop_error",
      deductions: [],
      explanation:
        "Our mistake, so everything paid online comes back with nothing deducted — " +
        "including delivery, and including the return journey.",
      replacementOnly: false,
    };
  }

  switch (stage) {
    /**
     * Nothing has moved, so nothing has been spent. Identical for both payment
     * methods, and the Pay-on-Delivery case is the one worth stating: the
     * advance is refunded **in full**, because the round trip it was covering
     * never happened.
     */
    case "before_shipment":
      return {
        refundPaise: clamp(capturedPaise),
        reason: "cancelled_before_dispatch",
        deductions: [],
        explanation:
          "Cancelled before the parcel was handed to the courier, so everything " +
          "paid online comes back in full.",
        replacementOnly: false,
      };

    /**
     * An AWB exists but nothing has been collected. Shiprocket reverses the
     * charge on a shipment cancelled before pickup, so the shop has spent
     * nothing — *usually*. If it did not reverse, the admin records the actual
     * charge and the row above this one becomes the honest branch.
     */
    case "after_awb_before_pickup": {
      const spent = actualForwardPaise + actualRtoPaise;
      if (spent === 0) {
        return {
          refundPaise: clamp(capturedPaise),
          reason: "cancelled_before_dispatch",
          deductions: [],
          explanation:
            "Cancelled before the courier collected it. Shiprocket reversed the " +
            "charge, so everything paid online comes back in full.",
          replacementOnly: false,
        };
      }
      return {
        refundPaise: clamp(capturedPaise - spent),
        reason: "cancelled_before_dispatch",
        deductions: [{ label: "Courier charge not reversed", amountPaise: spent }],
        explanation:
          "Cancelled before collection, but the courier's charge was not reversed, " +
          "so that amount is deducted and the rest comes back.",
        replacementOnly: false,
      };
    }

    /**
     * The parcel went out and came back. The shop has paid both legs and
     * collected nothing.
     *
     * **A Pay-on-Delivery order gets nothing back, and that is the whole point
     * of the advance** — it was the round trip, it has been spent on the round
     * trip, and the customer's balance was never collected. The arithmetic
     * below reaches that answer rather than special-casing it: the deduction is
     * the freight, the freight is what the advance was, and the difference is
     * zero. Stating it as arithmetic rather than as a branch means an advance
     * that was *capped* below the round trip still refunds correctly — the
     * customer gets nothing and the shop absorbs the shortfall, which is what a
     * cap means.
     */
    case "in_transit_rto":
    case "refused_rto":
    case "undeliverable_rto": {
      const freight = actualForwardPaise + actualRtoPaise;
      const deduction =
        rtoPolicy === "none"
          ? 0
          : rtoPolicy === "flat"
            ? rtoFlatDeductionPaise
            : freight;

      const deductions: RefundLine[] =
        deduction === 0
          ? []
          : rtoPolicy === "flat"
            ? [{ label: "Return handling", amountPaise: deduction }]
            : [
                { label: "Delivery attempted", amountPaise: actualForwardPaise },
                { label: "Return to us", amountPaise: actualRtoPaise },
              ];

      const refundPaise = clamp(capturedPaise - deduction);

      return {
        refundPaise,
        reason: "rto",
        deductions,
        explanation:
          refundPaise === 0
            ? "The parcel travelled out and came back, and what was paid online " +
              "covered exactly those two journeys, so there is nothing left to " +
              "return."
            : stage === "undeliverable_rto"
              ? "The courier could not deliver it and it has come back to us. The " +
                "two journeys are deducted and the rest comes back."
              : "The parcel came back to us. The two journeys are deducted and the " +
                "rest comes back.",
        replacementOnly: false,
      };
    }

    /**
     * Delivered. The policy is narrow and is stated the same way everywhere:
     * no refunds, no online returns, a replacement for damage in shipment only
     * and only within the window. So this branch returns money nowhere — and it
     * returns `replacementOnly` rather than zero-with-no-explanation, because
     * an admin looking at this screen needs to be told what they *can* do.
     */
    case "delivered":
      return {
        refundPaise: 0,
        reason: "other",
        deductions: [],
        explanation:
          "This order was delivered. The policy is a replacement for damage in " +
          "shipment, reported within the window — not a refund. If this is our " +
          "error, choose 'our mistake' instead and the full amount comes back.",
        replacementOnly: true,
      };
  }
}

/**
 * Which stage an order is at, from what the order row says.
 *
 * Derived rather than chosen, so an admin cannot select the wrong row of the
 * table by accident and refund a delivered order as though it had never
 * shipped. The one thing they *do* choose is `cause`, because whether the shop
 * made a mistake is not knowable from any column.
 */
export function stageFor(order: {
  status: string;
  hasShipment: boolean;
  hasAwb: boolean;
  pickedUp: boolean;
  rtoAt: string | null;
  deliveredAt: string | null;
}): RefundStage {
  if (order.deliveredAt || order.status === "delivered") return "delivered";
  if (order.rtoAt || order.status === "returning" || order.status === "returned")
    return order.pickedUp ? "refused_rto" : "in_transit_rto";
  if (order.hasAwb && !order.pickedUp) return "after_awb_before_pickup";
  if (!order.hasShipment) return "before_shipment";
  return "in_transit_rto";
}
