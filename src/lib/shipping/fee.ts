import "server-only";

import type { PaymentMethod } from "@/lib/payments/types";
import type { ServiceabilityVerdict } from "@/lib/shipping/serviceability";
import type { ShippingSettings } from "@/lib/shipping/settings";

/**
 * What the customer pays for delivery.
 *
 * **Every live rate here comes from Shiprocket.** The owner's instruction, given
 * 2026-08-08: *"Delivery charges should be picked up from shiprocket api we will
 * not hardcode anything. Min order value is decided by us or admin from admin
 * panel."* So this file contains no prices — it contains the *rules*, and every
 * threshold and every flat amount those rules compare against arrives in
 * `settings`, editable at `/admin/settings`.
 *
 * ## The rules, as the owner set them on 2026-08-09
 *
 *   **At or above the free-delivery threshold** — the delivery charge is zero,
 *     **for Pay on Delivery as well as prepaid**. That is decision 2, and the
 *     previous behaviour was the bug: the free tier was gated `!isCod`, so a
 *     ₹7,000 cash order paid full freight while a ₹7,000 card order paid
 *     nothing, and nothing on the page explained why.
 *
 *   **The cash-handling fee is still charged on top of free delivery.** Decision
 *     3, `waive_cod_fee_above_threshold = false`. It is a real courier cost and
 *     it gives customers a reason to prepay. Turning the setting on waives it.
 *
 *   **Below the threshold, live mode** — the cheapest courier's rate excluding
 *     India Post, rounded up to the nearest ₹10.
 *
 *   **Below the threshold, flat mode** — `flat_shipping_fee_paise`, with no
 *     Shiprocket call made at all. Decision 6, so a festival sale is a fixed
 *     price rather than a fixed price plus an API dependency.
 *
 *   **No live quote, live mode** — `prepaid_estimate_fee_paise`, and the
 *     customer is told it is an estimate. Pay on Delivery is withdrawn upstream
 *     rather than priced here; see `computeOrderTotals`.
 *
 * ## `codHandlingPaise` is Shiprocket's `cod_charges` or it is zero
 *
 * There is no third possibility and there must never be one. This is decision 9,
 * and it is written as a rule rather than a preference because the old code
 * broke it in a way that reached a customer: the no-quote branch computed
 * `fallback_fee_paise.cod − fallback_fee_paise.razorpay` — ₹349 − ₹199 — and
 * presented **₹150, the difference between two numbers the owner typed**, as
 * though it were the courier's cash-collection fee. Order FV-2026-00571 carries
 * that line. Both constants are now gone from settings entirely, so the
 * subtraction cannot be rewritten by accident.
 *
 * The consequence, stated so it is not mistaken for an oversight: in flat mode
 * and on an unavailable quote the cash-handling line is **zero**, because
 * Shiprocket was never asked. The shop absorbs it.
 *
 * ## Two figures here are the shop's cost and never the customer's price
 *
 * `costForwardPaise` is freight alone and `costRtoPaise` is the return leg;
 * together they are the advance. They are carried through this type rather than
 * re-quoted downstream so that both legs provably come from **one courier
 * entry** — the brief's rule, and under a round-trip advance a mismatched pair
 * would price a journey no parcel takes. Both are null in flat mode, by design.
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
   * The Pay-on-Delivery extra, shown as its own line. Always 0 for prepaid, and
   * always Shiprocket's own `cod_charges` or nothing. See the header.
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
   * customer as a price. **Both come from the same courier entry**, and both are
   * null in flat mode because no entry was fetched.
   */
  costForwardPaise: number | null;
  costRtoPaise: number | null;
  courierId: number | null;
  /**
   * How this fee was arrived at.
   *
   * `free` deliberately does not say which mode produced it — that is
   * `rateMode`'s job. `unavailable` replaces the old `fallback`, because
   * "fallback" named the number substituted rather than the thing that happened,
   * and what happened is that the courier could not be reached.
   */
  basis: "free" | "live" | "flat" | "unavailable";
  /**
   * The pricing mode in force, frozen onto the quote and onto the order.
   *
   * The owner's requirement: *"Freeze the mode used on each order alongside the
   * quote."* `basis` cannot answer it — a free-delivery order reads `free` in
   * both modes — and the question gets asked exactly once, the day after a
   * festival sale, about a refund.
   */
  rateMode: "live" | "flat";
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
    rateMode: settings.shippingRateMode,
  };

  /**
   * The three states a quote can be in, and the reason `flat` is one of them.
   *
   * `flat` and `unavailable` both mean "there is no courier rate", and they must
   * not be collapsed: `unavailable` withdraws Pay on Delivery under decision 4,
   * and if flat mode shared that path then switching to a festival price would
   * silently switch off Pay on Delivery for the whole shop. A pricing toggle
   * must not be able to cause a business outage.
   *
   * A `shiprocket` verdict with no rate on it — every courier answered but none
   * quoted a price, or the route is unserviceable — is `unavailable` too. The
   * source says we reached them; it does not say they gave us a number.
   */
  const flat = verdict.source === "flat";
  const hasLiveRate =
    verdict.source === "shiprocket" && verdict.forwardCostPaise !== null;

  /**
   * Decision 2. Checked before the courier lookup matters, so a Shiprocket
   * outage cannot cost a customer their free delivery, and applied to **both**
   * payment methods. A threshold of 0 disables the free tier entirely.
   */
  const freeDelivery =
    settings.freeAbovePaise > 0 && subtotalPaise >= settings.freeAbovePaise;

  /**
   * Decision 9, enforced in one place so it cannot be re-derived elsewhere:
   * Shiprocket's own `cod_charges`, or zero. Never a subtraction between two
   * settings, which is what produced the ₹150 on FV-2026-00571.
   */
  const quotedCodFee = isCod ? Math.max(0, verdict.codFeePaise ?? 0) : 0;

  // Decision 3: free delivery does not waive the cash-handling fee unless the
  // owner says it does.
  const codLine =
    freeDelivery && settings.waiveCodFeeAboveThreshold ? 0 : quotedCodFee;

  if (freeDelivery) {
    return {
      ...shared,
      shippingFeePaise: 0,
      codHandlingPaise: codLine,
      feePaise: codLine,
      basis: "free",
    };
  }

  if (flat) {
    /**
     * No call was made, so `codLine` is zero and the flat fee is the whole
     * charge. The shop absorbs the cash-collection cost in flat mode; that is
     * the price of a delivery charge that does not depend on a third party.
     */
    const total = Math.max(0, settings.flatShippingFeePaise);
    return {
      ...shared,
      shippingFeePaise: total,
      codHandlingPaise: codLine,
      feePaise: total + codLine,
      basis: "flat",
    };
  }

  if (!hasLiveRate) {
    /**
     * Shiprocket could not be reached, or answered without a price.
     *
     * Prepaid still sells — refusing to sell during a courier outage is a worse
     * outcome than mispricing a handful of orders — and the checkout labels this
     * figure an estimate rather than presenting it as a rate. Pay on Delivery is
     * withdrawn in `computeOrderTotals` under decision 4, so a cash order is
     * never priced from this branch.
     */
    const total = Math.max(0, settings.prepaidEstimateFeePaise);
    return {
      ...shared,
      shippingFeePaise: total,
      codHandlingPaise: codLine,
      feePaise: total + codLine,
      basis: "unavailable",
    };
  }

  /**
   * `forwardCostPaise` is the courier's all-in `rate`. Under Pay on Delivery the
   * quote was taken with `cod=1`, so it already contains the cash-collection
   * fee; under prepaid it was taken with `cod=0` and the two are the same
   * number. Either way it is what the courier charges to deliver, and it is what
   * the customer pays.
   *
   * Rounded once on the total and then split, never rounded twice. Rounding each
   * part separately quietly raises the price: ₹139.36 and ₹52.00 become ₹140 and
   * ₹60 — ₹200 instead of ₹192 — and ₹105.20 and ₹30.10 become ₹110 and ₹40
   * rather than ₹140. The customer pays the rounded total and the named line
   * carries whatever the remainder is.
   */
  const feePaise = roundUp(verdict.forwardCostPaise ?? 0);
  const codHandlingPaise = Math.min(codLine, feePaise);

  return {
    ...shared,
    shippingFeePaise: feePaise - codHandlingPaise,
    codHandlingPaise,
    feePaise,
    basis: "live",
  };
}

function roundUp(paise: number): number {
  return Math.ceil(paise / ROUND_UP_TO_PAISE) * ROUND_UP_TO_PAISE;
}
