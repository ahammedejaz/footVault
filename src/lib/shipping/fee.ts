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
 *   **Pay on Delivery, any value** — the live COD rate for the lane: forward
 *     freight plus Shiprocket's cash-collection fee. No free threshold.
 *
 * **The return leg left this file in Phase 7, and that is the money model
 * changing rather than a rule being relaxed.** Until then a COD delivery charge
 * was `forward + RTO`, so the customer paid for a return that usually never
 * happened. The RTO leg is now covered by the *advance* — money the customer
 * pays online and which is netted straight off what the courier collects, so it
 * costs them nothing on a delivered parcel and covers the shop completely on a
 * refused one. See `src/lib/payments/advance.ts`. What the customer pays for
 * delivery is now simply what the courier charges to deliver.
 *
 * **The COD extra is still a named line.** `codHandlingPaise` is Shiprocket's
 * cash-collection fee — a percentage of the declared value, `cod_multiplier`
 * 3% on this account — and it is the whole of the difference between a prepaid
 * delivery charge and a Pay-on-Delivery one. Returned separately so it can be
 * drawn as its own row: the owner's condition for charging it at all is that a
 * customer can see it and point at it.
 *
 * **Two figures here are the shop's cost and never the customer's price.**
 * `costForwardPaise` is freight alone and `costRtoPaise` is the return leg;
 * together they are the advance. They are carried through this type rather than
 * re-quoted downstream so that both legs provably come from **one courier
 * entry** — the brief's rule, and under a round-trip advance a mismatched pair
 * would price a journey no parcel takes.
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
  /**
   * Shop cost, and the two numbers the advance is made of. Never rendered to a
   * customer as a price. **Both come from the same courier entry.**
   */
  costForwardPaise: number | null;
  costRtoPaise: number | null;
  courierId: number | null;
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
    courierId: verdict.courierId,
    // Freight alone, never the all-in rate: the cash-collection fee is reversed
    // by Shiprocket on an RTO, so an advance that included it would over-collect
    // on exactly the orders the advance exists to cover.
    costForwardPaise: verdict.freightPaise ?? verdict.forwardCostPaise,
    costRtoPaise: verdict.rtoCostPaise,
  };

  /**
   * The owner can choose to charge a flat delivery fee and absorb the
   * difference — `customer_delivery_fee_mode`. It changes only what the
   * *customer* pays; the shop's costs above still come from the live quote, so
   * the advance and the RTO ledger stay truthful about what a parcel really
   * costs. Free delivery still wins over it, because that is a promise.
   */
  const flatMode = settings.customerDeliveryFeeMode === "flat";

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

  if (flatMode) {
    const total = settings.customerDeliveryFlatPaise;
    const codFee = isCod
      ? Math.min(total, Math.max(0, verdict.codFeePaise ?? 0))
      : 0;
    return {
      ...shared,
      shippingFeePaise: total - codFee,
      codHandlingPaise: codFee,
      feePaise: total,
      basis: verdict.source === "shiprocket" ? "shiprocket" : "fallback",
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
   * `forward` is the courier's all-in `rate`. Under Pay on Delivery the quote
   * was taken with `cod=1`, so it already contains the cash-collection fee;
   * under prepaid it was taken with `cod=0` and the two are the same number.
   * Either way it is what the courier charges to deliver, and it is what the
   * customer pays.
   *
   * Rounded once on the total and then split, never rounded twice. Rounding
   * each part separately quietly raises the price: ₹139.36 and ₹52.00 become
   * ₹140 and ₹60 — ₹200 instead of ₹200… and ₹105.20 and ₹30.10 become ₹110 and
   * ₹40 rather than ₹140. The customer pays the rounded total and the named
   * line carries whatever the remainder is.
   */
  const feePaise = roundUp(forward);
  const codFee = isCod ? Math.max(0, verdict.codFeePaise ?? 0) : 0;
  const shippingFeePaise = Math.max(0, feePaise - Math.min(codFee, feePaise));

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
