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
 * **What the customer is charged does not come from here — yet.** Delivery is
 * ₹199, free at ₹2,499 and above, read from `site_settings.shipping`. The owner
 * has decided that below the threshold the customer should pay the courier's own
 * rate (cheapest non-India-Post, rounded up to ₹10), and that is a second step:
 * it cannot ship until the checkout page re-quotes when a PIN is entered, because
 * charging a number the customer was never shown is worse than charging too
 * little. Until then the rate below is captured for the admin and nowhere else.
 *
 * **It fails soft, in one direction only.** Every failure — no credentials, a
 * timeout, a 500, a malformed body — resolves to "we do not know", and "we do
 * not know" means the default estimate and COD **available**. A logistics
 * outage must never block a sale. The opposite default would mean a Shiprocket
 * incident silently switching off the payment method most of this shop's
 * customers use, which is a worse failure than occasionally accepting a COD
 * order to a PIN code that turns out to need a different courier.
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
   */
  forwardCostPaise: number | null;
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
  /** How we arrived at this, so the UI and the audit can tell them apart. */
  source: "shiprocket" | "unknown";
  /** Set when `source` is `unknown`, for the log and the audit script. */
  reason?: string;
};

/** What every failure resolves to. Availability over accuracy, on purpose. */
export const UNKNOWN_SERVICEABILITY: ServiceabilityVerdict = {
  estimatedDays: null,
  deliverable: true,
  forwardCostPaise: null,
  rtoCostPaise: null,
  codAvailable: true,
  cheapestRatePaise: null,
  courierName: null,
  source: "unknown",
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
  courier_name?: unknown;
  rate?: unknown;
  rto_charges?: unknown;
  estimated_delivery_days?: unknown;
  etd_hours?: unknown;
  cod?: unknown;
  is_surface?: unknown;
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
    data?: { available_courier_companies?: CourierRow[] };
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
        estimatedDays: null,
        deliverable: false,
        forwardCostPaise: null,
        rtoCostPaise: null,
        codAvailable: false,
        cheapestRatePaise: null,
        courierName: null,
        source: "shiprocket",
        reason: "no courier serves this route",
      };
    }
    return { ...UNKNOWN_SERVICEABILITY, reason: "no couriers returned" };
  }

  const readable = couriers
    .map((courier) => ({
      name:
        typeof courier.courier_name === "string" ? courier.courier_name : null,
      ratePaise: toRatePaise(courier.rate),
      rtoPaise: toRatePaise(courier.rto_charges),
      days: toDays(courier),
      cod: courier.cod === 1 || courier.cod === true,
    }))
    .filter(
      (courier): courier is typeof courier & { name: string } =>
        courier.name !== null,
    );

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
  const parsed = readable.filter((courier) => !isExcluded(courier.name));
  const priceable = parsed.length > 0 ? parsed : readable;

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
    // The return leg for the courier we would actually use, not the cheapest
    // return leg available — they are not the same parcel.
    rtoCostPaise: cheapest?.rtoPaise ?? null,
    // Asked of every readable courier, including excluded ones: see above.
    codAvailable: readable.some((courier) => courier.cod),
    cheapestRatePaise: cheapest?.ratePaise ?? null,
    courierName: cheapest?.name ?? null,
    source: "shiprocket",
  };
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
