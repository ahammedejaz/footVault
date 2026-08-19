import "server-only";

import { shiprocketFetch } from "@/lib/shipping/client";
import { SHIPROCKET_SERVICEABILITY_TIMEOUT_MS } from "@/lib/shipping/config";

/**
 * "Can a courier get there, how long will it take, and will they collect cash?"
 *
 * Used for exactly two things, and the restraint is deliberate — this endpoint
 * also returns every courier's rate, and it would be easy to start quoting the
 * customer a real one:
 *
 *   1. A delivery estimate on the checkout address step and the product page.
 *   2. **Gating COD by PIN code.** Phase 5 recorded that COD's `isAvailable()`
 *      is unconditionally true with a hook waiting for exactly this.
 *
 * **What the customer is charged is decided in `deliveryFee()`, not here.** Two
 * rupee figures used to sit in this paragraph describing the fee and the free
 * threshold; both were stale within a phase — the row read ₹6,499 while this
 * said ₹2,499 — which is the third recorded instance of the
 * same number escaping into text nobody re-reads. Every threshold now resolves
 * from `site_settings.shipping` at the point of use, and this comment names no
 * amounts.
 *
 * **It fails soft, and reports rather than decides.** Every failure — no
 * credentials, a timeout, a 500, a malformed body — resolves to "we do not
 * know". `codAvailable` stays `true` on an unknown verdict because this type
 * answers *what Shiprocket said*, and Shiprocket said nothing; it is not the
 * place where the shop's policy lives.
 *
 * **The policy above it was reversed in Batch 2 and the reversal is deliberate.**
 * Phase 5 and 6 read an unknown verdict as "offer Pay on Delivery anyway", on
 * the reasoning that a logistics outage must never block a sale. That was right
 * when a COD order cost the shop nothing up front and wrong once the advance
 * became the shop's cover for a refused parcel: with no quote there is no round
 * trip, so a cash order accepted during an outage is an unsecured one. The
 * owner's decision, 2026-08-09, is `refuse_cod` — prepaid still sells through an
 * outage with its price labelled an estimate, and cash does not. That rule is
 * applied in `deliveryFee()` and `computeOrderTotals`, not here.
 */

export type ServiceabilityVerdict = {
  /** Null when unknown — render the default estimate, do not invent a number. */
  estimatedDays: number | null;
  /**
   * False only when Shiprocket says, in as many words, that no courier serves
   * the route. Ambiguous answers stay true — see the empty-list branch below.
   */
  deliverable: boolean;
  /**
   * What the courier charges the shop to carry it there, in paise. With `cod=1`
   * this already includes Shiprocket's cash-collection fee, which is a
   * percentage of the order value rather than a flat amount.
   *
   * This is the courier's `rate`, and `rate = freight_charge + cod_charges` —
   * verified against the live account: Delhivery Surface, 516360 → 560001, 1kg,
   * ₹1,000 declared, quoted `rate: 191.36`, `freight_charge: 139.36`,
   * `cod_charges: 52`.
   */
  forwardCostPaise: number | null;
  /**
   * The forward leg **without** the cash-collection fee.
   *
   * Phase 7's advance is `forward freight + RTO freight` and neither leg
   * includes the COD fee: on a refused parcel Shiprocket reverses the fee, so
   * charging the customer an advance that covers it would over-collect on
   * exactly the orders the advance exists to protect. Split out rather than
   * derived, because `rate - cod_charges` is an arithmetic identity that stops
   * holding the day Shiprocket adds a third component.
   */
  freightPaise: number | null;
  /**
   * Shiprocket's cash-collection fee — a percentage of the declared value
   * (`cod_multiplier`, 3% on this account), floored at a minimum. It is the
   * whole of the difference between a prepaid delivery charge and a
   * Pay-on-Delivery one, which is what makes it renderable as a named line.
   */
  codFeePaise: number | null;
  /**
   * What it costs the shop if the parcel comes back — a COD customer refusing at
   * the door. The shop pays this and collects nothing, which is why the COD fee
   * charged to the customer includes it.
   */
  rtoCostPaise: number | null;
  /**
   * Whether COD is offered. `true` when Shiprocket says yes **and** when we
   * could not ask. Only an explicit "no courier here will collect cash" turns
   * it off.
   */
  codAvailable: boolean;
  /** The cheapest quoted rate in paise, for the admin's eyes only. */
  cheapestRatePaise: number | null;
  courierName: string | null;
  /** Shiprocket's own id for the courier, frozen onto the order with the rate. */
  courierId: number | null;
  /**
   * Every courier the lane offered, with its rates and its scores.
   *
   * Carried so the admin can be shown the choice at fulfilment rather than
   * being handed whichever one was cheapest at quote time. See
   * `courierChoices()` and `courier_selection_mode`.
   */
  couriers: CourierQuote[];
  /** Which courier Shiprocket itself recommends, and why it says it does. */
  recommendedCourierId: number | null;
  /**
   * How we arrived at this, so the UI and the audit can tell them apart.
   *
   * `flat` is not a failure and must never be treated as one. It means the shop
   * is pricing from `flat_shipping_fee_paise` and **no call was made** — the
   * owner's requirement for the festival-sale toggle. Collapsing it into
   * `unknown` would make switching to a flat price silently switch off Pay on
   * Delivery, which is a pricing toggle causing a business outage.
   */
  source: "shiprocket" | "unknown" | "flat";
  /** Set when `source` is `unknown`, for the log and the audit script. */
  reason?: string;
};

/** What every failure resolves to. A report of ignorance, not a decision. */
export const UNKNOWN_SERVICEABILITY: ServiceabilityVerdict = {
  estimatedDays: null,
  deliverable: true,
  forwardCostPaise: null,
  freightPaise: null,
  codFeePaise: null,
  rtoCostPaise: null,
  codAvailable: true,
  cheapestRatePaise: null,
  courierName: null,
  courierId: null,
  couriers: [],
  recommendedCourierId: null,
  source: "unknown",
};

/**
 * What flat mode uses instead of a quote.
 *
 * Every cost field is null because none of them was asked for, and that is the
 * honest record: `cost_forward_paise` on a flat-mode quote row is null *by
 * design*, not because a call failed. `deliverable` and `codAvailable` are true
 * because with no call the shop cannot say otherwise — flat mode trades
 * PIN-level serviceability for a price that does not depend on a third party,
 * which is the trade the owner asked for.
 */
export const FLAT_SERVICEABILITY: ServiceabilityVerdict = {
  ...UNKNOWN_SERVICEABILITY,
  source: "flat",
  reason: "flat rate mode — no courier call was made",
};

/**
 * One courier's offer on one lane.
 *
 * The scores are Shiprocket's own and they are not all the same kind of number,
 * which is worth knowing before any of them is used to choose:
 *
 *   - `slaAdherence` and its siblings are **ranks**, 1 best to 5 worst, and are
 *     absent on couriers Shiprocket has not ranked. Measured on the live
 *     account, 516360 → 560001: Delhivery Air 2, Delhivery Surface 3, Blue Dart
 *     Air 5, India Post absent.
 *   - `rtoPerformance`, `trackingPerformance` and `deliveryPerformance` are
 *     out of 5 and on this account came back **identical for every courier**
 *     (4.4, 4.5, 4.5). They are surfaced anyway, and the admin screen says so,
 *     because an account with volume will see them separate — but nothing is
 *     ranked on them today, since a tie is not a signal.
 *   - `rating` does vary (4.4 – 4.83) and is what the "best rated" mode uses.
 */
export type CourierQuote = {
  id: number;
  name: string;
  /** All-in, as quoted: freight plus the cash-collection fee. */
  ratePaise: number | null;
  freightPaise: number | null;
  codFeePaise: number | null;
  rtoPaise: number | null;
  days: number | null;
  cod: boolean;
  rating: number | null;
  slaAdherence: number | null;
  rtoPerformance: number | null;
  trackingPerformance: number | null;
  deliveryPerformance: number | null;
  /** True when the shop has chosen not to quote from this courier. */
  excluded: boolean;
};

/**
 * Couriers the shop will not use, matched case-insensitively on the name.
 *
 * India Post is excluded by the owner's decision. It is consistently the
 * cheapest quote and it is not comparable to the others: measured against this
 * account it returns `rto_charges: 0.01` for a return leg the private couriers
 * price at ₹142–246, which is not a real number — so quoting from it would
 * understate the shop's exposure on exactly the orders most likely to come back.
 */
const EXCLUDED_COURIERS = [/india\s*post/i];

function isExcluded(name: string): boolean {
  return EXCLUDED_COURIERS.some((pattern) => pattern.test(name));
}

/**
 * Shiprocket's own words for "this route has no service at all", as observed
 * against the live account rather than guessed from documentation.
 */
const UNSERVICEABLE_ROUTE = /no courier service available/i;

/** The `message` field, which Shiprocket populates on a zero-courier response. */
function providerMessage(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const value = (payload as { message?: unknown }).message;
    if (typeof value === "string") return value;
  }
  return "";
}

type CourierRow = {
  courier_company_id?: unknown;
  courier_name?: unknown;
  rate?: unknown;
  freight_charge?: unknown;
  cod_charges?: unknown;
  rto_charges?: unknown;
  estimated_delivery_days?: unknown;
  etd_hours?: unknown;
  cod?: unknown;
  is_surface?: unknown;
  rating?: unknown;
  SLA_Adherence?: unknown;
  rto_performance?: unknown;
  tracking_performance?: unknown;
  delivery_performance?: unknown;
};

export async function checkServiceability(input: {
  pickupPostcode: string;
  deliveryPostcode: string;
  weightKg: number;
  /** Order value in paise, used by Shiprocket to price COD. */
  declaredValuePaise?: number;
}): Promise<ServiceabilityVerdict> {
  // A six-digit Indian PIN, checked before we spend a round trip on it.
  if (!/^\d{6}$/.test(input.deliveryPostcode)) {
    return {
      ...UNKNOWN_SERVICEABILITY,
      reason: "delivery postcode is not six digits",
    };
  }

  const result = await shiprocketFetch<{
    data?: {
      available_courier_companies?: CourierRow[];
      recommended_courier_company_id?: unknown;
    };
  }>("/courier/serviceability/", {
    query: {
      pickup_postcode: input.pickupPostcode,
      delivery_postcode: input.deliveryPostcode,
      // Kilograms, one decimal. Shiprocket rejects a weight of 0.
      weight: Math.max(0.1, Number(input.weightKg.toFixed(2))),
      // Asked with cod=1 so the response says which couriers will collect
      // cash. Asking with cod=0 returns a list that cannot answer the
      // question this function exists for.
      cod: 1,
      declared_value: input.declaredValuePaise
        ? Math.round(input.declaredValuePaise / 100)
        : undefined,
    },
    timeoutMs: SHIPROCKET_SERVICEABILITY_TIMEOUT_MS,
  });

  if (!result.ok) {
    // Info, not error, for the two expected cases. An unconfigured integration
    // and a slow third party are not incidents, and logging them as errors is
    // how a real error stops being noticed.
    const level =
      result.reason === "not_configured" || result.reason === "timeout"
        ? "info"
        : "warn";
    console[level]("[shiprocket] serviceability unavailable", {
      reason: result.reason,
      status: result.status,
    });
    return { ...UNKNOWN_SERVICEABILITY, reason: result.reason };
  }

  const couriers = result.data?.data?.available_courier_companies;
  if (!Array.isArray(couriers) || couriers.length === 0) {
    /**
     * An empty list has two meanings, and only one of them is an answer.
     *
     * This was originally written to treat every empty list as "we do not know"
     * — on the reasoning that "no courier serves this PIN" and "no courier
     * serves it *for these parameters*" are indistinguishable, and the second is
     * reachable by a weight we rounded. Testing against the live account showed
     * that reasoning was too cautious: Shiprocket **says which it is**.
     *
     *   pickup 516360 → delivery 744101 (Port Blair)
     *   → 200, zero couriers, "No courier service available between 516360 and 744101"
     *
     * That is a definitive answer about the route, not about our parameters. An
     * empty list *without* that message stays "unknown" and keeps COD on, which
     * is the ambiguous case the original reasoning was actually about.
     *
     * Matching on the message is admittedly brittle — it is English prose from a
     * third party. It is safe here because the failure direction is right: if
     * Shiprocket rewords it, this stops recognising the definitive case and
     * falls back to leaving COD available, which is where it started.
     */
    if (UNSERVICEABLE_ROUTE.test(providerMessage(result.data))) {
      return {
        ...UNKNOWN_SERVICEABILITY,
        deliverable: false,
        codAvailable: false,
        source: "shiprocket",
        reason: "no courier serves this route",
      };
    }
    return { ...UNKNOWN_SERVICEABILITY, reason: "no couriers returned" };
  }

  const readable: CourierQuote[] = couriers
    .map((courier) => ({
      id: toInt(courier.courier_company_id) ?? 0,
      name:
        typeof courier.courier_name === "string" ? courier.courier_name : null,
      ratePaise: toRatePaise(courier.rate),
      freightPaise: toRatePaise(courier.freight_charge),
      codFeePaise: toRatePaise(courier.cod_charges),
      rtoPaise: toRatePaise(courier.rto_charges),
      days: toDays(courier),
      cod: courier.cod === 1 || courier.cod === true,
      rating: toScore(courier.rating),
      slaAdherence: toScore(courier.SLA_Adherence),
      rtoPerformance: toScore(courier.rto_performance),
      trackingPerformance: toScore(courier.tracking_performance),
      deliveryPerformance: toScore(courier.delivery_performance),
      excluded: false,
    }))
    .filter((courier): courier is CourierQuote & { name: string } =>
      Boolean(courier.name),
    )
    .map((courier) => ({ ...courier, excluded: isExcluded(courier.name) }));

  if (readable.length === 0) {
    return {
      ...UNKNOWN_SERVICEABILITY,
      reason: "courier rows were unreadable",
    };
  }

  /**
   * Excluded couriers are dropped for *pricing* but still count for
   * serviceability and for COD.
   *
   * If India Post is the only carrier that will reach a pin code, the address is
   * still deliverable and cash can still be collected there — the shop simply
   * will not quote from it. Filtering before those questions were answered would
   * turn "we choose not to use this courier" into "we cannot deliver here",
   * which is a different and much more expensive statement.
   */
  const kept = readable.filter((courier) => !courier.excluded);
  const priceable = kept.length > 0 ? kept : readable;

  /**
   * **One courier entry supplies every leg.** The brief is explicit: *"Never mix
   * a forward rate from one courier with an RTO rate from another."* Under the
   * round-trip advance that is not a tidiness rule — the advance is
   * `freight + rto` and a mismatched pair would price a journey no parcel takes.
   * So the cheapest entry is selected once and read four times, rather than
   * four minimums being taken independently.
   */
  const withRates = priceable.filter((courier) => courier.ratePaise !== null);
  const cheapest = withRates.length
    ? withRates.reduce((best, courier) =>
        (courier.ratePaise ?? Infinity) < (best.ratePaise ?? Infinity)
          ? courier
          : best,
      )
    : null;

  const days = priceable
    .map((courier) => courier.days)
    .filter((d): d is number => d !== null);

  return {
    // The fastest quoted, not the average: the estimate shown to a customer
    // should be one a courier actually offered.
    estimatedDays: days.length ? Math.min(...days) : null,
    deliverable: true,
    forwardCostPaise: cheapest?.ratePaise ?? null,
    // Falls back to the all-in rate rather than to null when Shiprocket omits
    // the breakdown: an advance that under-recovers is a smaller wrong than one
    // that cannot be computed at all, and it errs towards the customer.
    freightPaise: cheapest?.freightPaise ?? cheapest?.ratePaise ?? null,
    codFeePaise: cheapest?.codFeePaise ?? null,
    // The return leg for the courier we would actually use, not the cheapest
    // return leg available — they are not the same parcel.
    rtoCostPaise: cheapest?.rtoPaise ?? null,
    // Asked of every readable courier, including excluded ones: see above.
    codAvailable: readable.some((courier) => courier.cod),
    cheapestRatePaise: cheapest?.ratePaise ?? null,
    courierName: cheapest?.name ?? null,
    courierId: cheapest?.id ?? null,
    couriers: readable,
    recommendedCourierId:
      toInt(
        (result.data?.data as { recommended_courier_company_id?: unknown })
          ?.recommended_courier_company_id,
      ) ?? null,
    source: "shiprocket",
  };
}

/** A whole number from a field Shiprocket sends as either a number or a string. */
function toInt(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

/** A score, left as the decimal Shiprocket sent. Absent means unranked. */
function toScore(value: unknown): number | null {
  const parsed =
    typeof value === "string" ? Number.parseFloat(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

/** Shiprocket quotes rupees, sometimes as a string. The codebase holds paise. */
function toRatePaise(rate: unknown): number | null {
  const value = typeof rate === "string" ? Number.parseFloat(rate) : rate;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return null;
  return Math.round(value * 100);
}

/**
 * Days, from whichever field this courier populated.
 *
 * `estimated_delivery_days` is usually a string, occasionally a number, and
 * sometimes absent with `etd_hours` in its place. Reading only the first would
 * silently produce "no estimate" for a courier that gave one.
 */
function toDays(courier: CourierRow): number | null {
  const raw = courier.estimated_delivery_days;
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : raw;
  if (typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0)
    return parsed;

  const hours = courier.etd_hours;
  const parsedHours =
    typeof hours === "string" ? Number.parseFloat(hours) : hours;
  if (
    typeof parsedHours === "number" &&
    Number.isFinite(parsedHours) &&
    parsedHours > 0
  ) {
    return Math.max(1, Math.ceil(parsedHours / 24));
  }
  return null;
}
