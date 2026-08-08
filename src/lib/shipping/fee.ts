import "server-only";

import type { PaymentMethod } from "@/lib/payments/types";
import type { ServiceabilityVerdict } from "@/lib/shipping/serviceability";
import type { ShippingSettings } from "@/lib/shipping/settings";

/**
 * What the customer pays for delivery.
 *
 * **Every rate here comes from Shiprocket.** The owner's instruction, given
 * 2026-08-08: *"Delivery charges should be picked up from shiprocket api we will
 * not hardcode anything. Min order value is decided by us or admin from admin
 * panel."* So this file contains no prices — it contains the *rules*, and the
 * thresholds those rules compare against arrive in `settings`.
 *
 * The rules are the owner's:
 *
 *   **Prepaid, at or above the free-delivery threshold** — free.
 *   **Prepaid, below it** — the cheapest courier's forward rate, excluding
 *     India Post, rounded up to the nearest ₹10.
 *   **Pay on Delivery, any value** — the forward rate *plus the return leg*.
 *     No free threshold at all.
 *
 * **Why Pay on Delivery has no free tier, and pays for the return.** A COD
 * parcel can be refused at the door. When that happens the shop pays to send it
 * and pays again to get it back, and collects nothing — measured against this
 * account, ₹205 out and ₹142 back on a single pair to Bengaluru. A free-delivery
 * COD order that is rejected is a pure loss of roughly ₹350, and it is precisely
 * the large orders a threshold would exempt that hurt most. The owner confirmed
 * this rule stands when the payment model changed.
 *
 * **The return leg is a named line, not a hidden markup.** `codHandlingPaise` is
 * returned separately from `shippingFeePaise` and is rendered as its own row
 * wherever a total is shown. That was the owner's condition for keeping the
 * surcharge: the difference between a prepaid total and a Pay-on-Delivery total
 * must be something a customer can see and point at, never an artefact of two
 * code paths that drifted. It drifted once already — see `settings.ts`.
 *
 * Note that `forwardCostPaise` already contains Shiprocket's cash-collection
 * fee when the quote was taken with `cod=1`, and that fee is a *percentage* of
 * the order value. So a COD fee legitimately grows with the basket.
 */

/** Rounded up to the nearest ₹10 so the customer never sees ₹210.68. */
const ROUND_UP_TO_PAISE = 1_000;

export type DeliveryFee = {
  /**
   * The forward leg — what a prepaid order of this size to this PIN would pay.
   * Zero when the free-delivery threshold applies.
   */
  shippingFeePaise: number;
  /**
   * The Pay-on-Delivery extra, shown as its own line. Always 0 for prepaid.
   */
  codHandlingPaise: number;
  /** What the customer actually pays for delivery. The sum of the two above. */
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
  settings: ShippingSettings;
}): DeliveryFee {
  const { method, subtotalPaise, verdict, settings } = input;
  const isCod = method === "cod";

  const shared = {
    deliverable: verdict.deliverable,
    codAvailable: verdict.codAvailable,
    estimatedDays: verdict.estimatedDays,
    courierName: verdict.courierName,
    costForwardPaise: verdict.forwardCostPaise,
    costRtoPaise: verdict.rtoCostPaise,
  };

  // Prepaid crosses the threshold. Checked before the courier lookup matters,
  // so a Shiprocket outage cannot cost a customer their free delivery. A
  // threshold of 0 disables the free tier entirely.
  if (
    !isCod &&
    settings.freeAbovePaise > 0 &&
    subtotalPaise >= settings.freeAbovePaise
  ) {
    return {
      ...shared,
      shippingFeePaise: 0,
      codHandlingPaise: 0,
      feePaise: 0,
      basis: "free",
    };
  }

  const forward = verdict.forwardCostPaise;

  /**
   * Shiprocket could not be reached.
   *
   * The fallback amounts are settings rather than constants so the owner can
   * correct them without a deploy, and the COD figure is expressed as a total
   * so that the split below still produces a sensible named line. Refusing to
   * sell during a courier outage is a worse outcome than mispricing a handful
   * of orders.
   */
  if (forward === null) {
    const prepaid = settings.fallbackFeePaise.razorpay;
    const total = isCod ? settings.fallbackFeePaise.cod : prepaid;
    return {
      ...shared,
      shippingFeePaise: Math.min(prepaid, total),
      codHandlingPaise: Math.max(0, total - prepaid),
      feePaise: total,
      basis: "fallback",
    };
  }

  /**
   * The return leg, for Pay on Delivery only.
   *
   * `?? forward` rather than `?? 0` when Shiprocket gave a rate but no RTO
   * figure: a missing return cost is not a free return. Assuming the return
   * costs about what the delivery costs is far closer to the truth than
   * assuming it is nothing, and it errs towards covering the shop.
   */
  const rto = isCod ? (verdict.rtoCostPaise ?? forward) : 0;

  /**
   * Rounded once on the total, then split — rather than rounded twice.
   *
   * Rounding each leg separately would quietly raise the price: ₹205 and ₹142
   * become ₹210 and ₹150 (₹360) instead of ₹350. The customer pays exactly what
   * the old single-figure calculation charged, and the named line carries
   * whatever the remainder is.
   */
  const feePaise = roundUp(forward + rto);
  const shippingFeePaise = Math.min(roundUp(forward), feePaise);

  return {
    ...shared,
    shippingFeePaise,
    codHandlingPaise: feePaise - shippingFeePaise,
    feePaise,
    basis: "shiprocket",
  };
}

function roundUp(paise: number): number {
  return Math.ceil(paise / ROUND_UP_TO_PAISE) * ROUND_UP_TO_PAISE;
}
