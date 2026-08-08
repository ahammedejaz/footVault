import "server-only";

import type { PaymentMethod } from "@/lib/payments/types";
import type { ServiceabilityVerdict } from "@/lib/shipping/serviceability";

/**
 * What the customer pays for delivery.
 *
 * The rules are the owner's, recorded here because a pricing rule scattered
 * across a query, an action and a template is three rules:
 *
 *   **Prepaid, ₹2,499 and above** — free.
 *   **Prepaid, below that** — the cheapest courier's forward rate, excluding
 *     India Post, rounded up to the nearest ₹10.
 *   **Cash on delivery, any value** — the forward rate *plus the return leg*,
 *     rounded up to ₹10. No free threshold at all.
 *
 * **Why COD has no free threshold, and pays for the return.** A COD parcel can
 * be refused at the door. When that happens the shop pays to send it and pays
 * again to get it back, and collects nothing — measured against this account,
 * ₹205 out and ₹142 back on a single pair to Bengaluru. A free-delivery COD
 * order that is rejected is a pure loss of roughly ₹350, and it is precisely
 * the large orders the threshold would exempt that hurt most. So the customer
 * carries the round trip, which also makes prepaid visibly cheaper — the
 * outcome the shop wants.
 *
 * Note that `forwardCostPaise` already contains Shiprocket's cash-collection
 * fee when the quote was taken with `cod=1`, and that fee is a *percentage* of
 * the order value. So a COD fee legitimately grows with the basket.
 */

/** Delivery is free at or above this, prepaid only. Owner-set. */
export const FREE_DELIVERY_THRESHOLD_PAISE = 249_900;

/** Rounded up to the nearest ₹10 so the customer never sees ₹210.68. */
const ROUND_UP_TO_PAISE = 1_000;

/**
 * Used when Shiprocket cannot be reached, per method.
 *
 * Both are measured rather than invented: ₹199 is close to the cheapest real
 * forward rate seen from this pickup, and ₹349 is close to forward-plus-return.
 * They are deliberately not generous — an outage should not be a discount — but
 * they must exist, because refusing to sell during a courier outage is a worse
 * outcome than mispricing a handful of orders.
 */
export const FALLBACK_FEE_PAISE: Record<PaymentMethod, number> = {
  razorpay: 19_900,
  cod: 34_900,
};

export type DeliveryFee = {
  feePaise: number;
  /** False only when Shiprocket explicitly says no courier serves the route. */
  deliverable: boolean;
  codAvailable: boolean;
  estimatedDays: number | null;
  courierName: string | null;
  /** Shop cost, for the admin. Never rendered to a customer. */
  costForwardPaise: number | null;
  costRtoPaise: number | null;
  /** `shiprocket` when priced from a live quote, `fallback` when guessed. */
  basis: "free" | "shiprocket" | "fallback";
};

export function deliveryFee(input: {
  method: PaymentMethod;
  subtotalPaise: number;
  verdict: ServiceabilityVerdict;
}): DeliveryFee {
  const { method, subtotalPaise, verdict } = input;

  const shared = {
    deliverable: verdict.deliverable,
    codAvailable: verdict.codAvailable,
    estimatedDays: verdict.estimatedDays,
    courierName: verdict.courierName,
    costForwardPaise: verdict.forwardCostPaise,
    costRtoPaise: verdict.rtoCostPaise,
  };

  // Prepaid crosses the threshold. Checked before the courier lookup matters,
  // so a Shiprocket outage cannot cost a customer their free delivery.
  if (method !== "cod" && subtotalPaise >= FREE_DELIVERY_THRESHOLD_PAISE) {
    return { ...shared, feePaise: 0, basis: "free" };
  }

  const forward = verdict.forwardCostPaise;
  if (forward === null) {
    return {
      ...shared,
      feePaise: FALLBACK_FEE_PAISE[method],
      basis: "fallback",
    };
  }

  /**
   * The return leg, for COD only.
   *
   * `?? forward` rather than `?? 0` when Shiprocket gave a rate but no RTO
   * figure: a missing return cost is not a free return. Assuming the return
   * costs about what the delivery costs is far closer to the truth than
   * assuming it is nothing, and it errs towards covering the shop.
   */
  const rto = method === "cod" ? (verdict.rtoCostPaise ?? forward) : 0;

  return { ...shared, feePaise: roundUp(forward + rto), basis: "shiprocket" };
}

function roundUp(paise: number): number {
  return Math.ceil(paise / ROUND_UP_TO_PAISE) * ROUND_UP_TO_PAISE;
}
