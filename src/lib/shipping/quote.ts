import "server-only";

import { maybeRow } from "@/lib/queries/run";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  checkServiceability,
  UNKNOWN_SERVICEABILITY,
  type ServiceabilityVerdict,
} from "@/lib/shipping/serviceability";

/**
 * The one box every product ships in, and the reason nothing may substitute for
 * it.
 *
 * The owner's decision, 2026-08-09: *"There is one common box for the whole
 * catalogue: roughly 20cm x 10cm, about 1kg packed, and it should apply to every
 * existing product and every product added in future."* So this is not a
 * fallback in the old sense — it is the actual parcel, and
 * `products.weight_grams` and its three siblings are the exception for something
 * bulky like boots.
 *
 * ## The 900g is gone and nothing replaced it
 *
 * This file used to carry `FALLBACK = { weight_grams: 900, ... }`, reached
 * whenever the settings row was missing a field. That constant was the shop's
 * real shipping weight for most of Phase 6 and 7 without anybody deciding it,
 * and it was invisible: a row that lost a field looked exactly like a row that
 * had one. The owner's instruction for Batch 2 is that nothing may fall through
 * to a literal, so there is now nothing to fall through to — a missing field
 * throws and names itself.
 *
 * ## What an unset field costs, said plainly
 *
 * `default_parcel_height_cm` is **unset**, because the owner has given the
 * footprint and the packed weight and not yet the height. Until it is filled:
 *
 *   - no Shiprocket call can be made, because a parcel with no height is not a
 *     parcel Shiprocket will price;
 *   - prepaid orders still sell, at `prepaid_estimate_fee_paise`, labelled to
 *     the customer as an estimate;
 *   - **Pay on Delivery is refused shop-wide**, because with no quote there is
 *     no round trip and an unsecured cash order is the failure Phase 7 removed;
 *   - creating a shipment fails at the admin's button with this error rather
 *     than sending Shiprocket a parcel with a missing dimension.
 *
 * That is the loud failure the owner asked for. One number at `/admin/settings`
 * clears all four.
 */

export type ShippingDefaults = {
  weight_grams: number;
  length_cm: number;
  breadth_cm: number;
  height_cm: number;
  pickup_postcode: string;
};

/**
 * The settings-row field names, kept beside the code that reads them.
 *
 * Listed rather than inlined so the error message, the admin banner and the
 * audit all name the field the same way the owner sees it in the settings form.
 * A message saying "height is missing" sends somebody looking in the wrong
 * place; `default_parcel_height_cm` does not.
 */
const FIELDS = {
  weight_grams: "default_parcel_weight_grams",
  length_cm: "default_parcel_length_cm",
  breadth_cm: "default_parcel_breadth_cm",
  height_cm: "default_parcel_height_cm",
} as const;

export class ParcelDefaultsIncompleteError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `The shop's default parcel is incomplete — ${missing.join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} not set. Shiprocket cannot ` +
        `price a parcel without every dimension, so nothing will be quoted and ` +
        `Pay on Delivery is refused until it is filled in at /admin/settings. ` +
        `No value is assumed on purpose: a guessed dimension is priced as ` +
        `volumetric weight and would misprice every parcel invisibly.`,
    );
    this.name = "ParcelDefaultsIncompleteError";
    this.missing = missing;
  }
}

/**
 * Read directly, with the service role, and not through `cachedSiteSettings()`.
 *
 * Two reasons, and the first is a bug this nearly shipped with.
 * `cachedSiteSettings()` filters `is_public = true`, and `shipping_defaults` is
 * deliberately not public — nothing in a browser needs the shop's pickup PIN or
 * its default box size. So the cached reader would never have returned this row
 * at all, and every caller would have silently used `FALLBACK` while looking
 * like it was reading configuration. The audit suite is what surfaced it.
 *
 * The second reason is that `unstable_cache` requires a Next request context, so
 * anything reached through it cannot be exercised by a plain script. A module
 * the fulfilment path depends on has to be testable outside a server render.
 *
 * The cost is one small query per call. `site_settings` has nine rows.
 *
 * **Throws** when anything is missing. Callers on the customer path are already
 * wrapped — `quoteDelivery` below turns it into an unknown verdict — and callers
 * on the fulfilment path are meant to fail: a shipment created with a guessed
 * height is a real parcel priced wrongly by a third party.
 */
export async function shippingDefaults(): Promise<ShippingDefaults> {
  const status = await parcelDefaultsStatus();
  if (!status.ok) throw new ParcelDefaultsIncompleteError(status.missing);
  return status.defaults;
}

export type ParcelDefaultsStatus =
  | { ok: true; defaults: ShippingDefaults }
  | { ok: false; missing: string[] };

/**
 * The same read, as a value rather than a throw.
 *
 * The admin settings page and `npm run audit:parcel` both need to say *which*
 * field is unset without a try/catch around a happy-path function, and the
 * banner that tells the owner what to fill in must not be able to crash the page
 * it is warning on.
 */
export async function parcelDefaultsStatus(): Promise<ParcelDefaultsStatus> {
  const row = await maybeRow<{ value: unknown }>(
    "shipping.defaults",
    createAdminClient()
      .from("site_settings")
      .select("value")
      .eq("key", "shipping_defaults")
      .maybeSingle(),
  );

  const value = row?.value;
  if (!value || typeof value !== "object")
    return { ok: false, missing: [...Object.values(FIELDS), "pickup_postcode"] };

  const partial = value as Record<string, unknown>;
  const missing: string[] = [];

  const read = (key: keyof typeof FIELDS): number => {
    const raw = partial[FIELDS[key]];
    // Zero is as absent as null here: a parcel cannot weigh nothing and cannot
    // be nothing across, and Shiprocket rejects both.
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      missing.push(FIELDS[key]);
      return 0;
    }
    return raw;
  };

  const defaults: ShippingDefaults = {
    weight_grams: read("weight_grams"),
    length_cm: read("length_cm"),
    breadth_cm: read("breadth_cm"),
    height_cm: read("height_cm"),
    pickup_postcode: "",
  };

  // Serviceability is quoted *from* somewhere, and getting it wrong silently
  // produces plausible estimates for the wrong city — which is worse than no
  // estimate, because nobody reports it.
  const pickup = partial.pickup_postcode;
  if (typeof pickup === "string" && /^\d{6}$/.test(pickup)) {
    defaults.pickup_postcode = pickup;
  } else {
    missing.push("pickup_postcode");
  }

  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, defaults };
}

/**
 * A parcel's weight in kilograms, from the lines in the bag.
 *
 * Weights are per *product*, not per variant — see the column comment on
 * `products.weight_grams` for why — and a line with no weight of its own uses
 * the shop's default box rather than counting as zero. A parcel that Shiprocket
 * is told weighs nothing is quoted as if it weighs nothing, and the quote is
 * wrong in the direction that costs the shop money.
 */
export function parcelWeightKg(
  lines: { quantity: number; weightGrams: number | null }[],
  defaults: ShippingDefaults,
): number {
  const grams = lines.reduce(
    (total, line) =>
      total + (line.weightGrams ?? defaults.weight_grams) * line.quantity,
    0,
  );
  return Math.max(0.1, grams / 1000);
}

/**
 * The serviceability verdict for a delivery, or the fail-soft default.
 *
 * Wrapped rather than called directly so that every caller — checkout's COD
 * gate, the address step's estimate, the product page — resolves the pickup PIN
 * and the weight the same way. Three call sites computing a parcel weight three
 * ways is three different answers to one question.
 */
/**
 * A ceiling on courier calls that does not depend on the database.
 *
 * `consumeRateLimit` is the real control and it is the right shape — but it
 * **fails open**: when its counter cannot be read it allows the call and logs.
 * That is correct for a cart write, where failing closed means a customer
 * cannot add to their bag. It is the wrong trade here, and this is the one
 * limiter in the codebase where the fail-open direction actually exposes
 * something.
 *
 * The reason is what the two limiters protect. Every other policy bounds work
 * *against Postgres* using a counter *in* Postgres, so when Postgres is
 * unreachable the guard and the thing worth guarding disappear together — the
 * flood cannot do damage because its target is already down. This one guards
 * the **Shiprocket quota**: an external, paid resource that has nothing to do
 * with our database. A counter outage removes the guard and leaves the exposure
 * intact, and a public Server Action reaches this code.
 *
 * It is not hypothetical. PostgREST reloads its schema cache on every DDL and
 * cannot be told not to, so an RPC can fail transiently on exactly the deploys
 * this shop keeps doing.
 *
 * ## Why the number is large and why it is unconditional
 *
 * Six hundred an hour, per instance, across every caller. A real shop's
 * delivery checks are bounded by the number of people shopping; a scraper's are
 * not. Ten a minute sustained is far above the first and far below what makes a
 * scrape worth running, which is the only place the line can sit while
 * satisfying the rule that **no real customer may ever reach it**.
 *
 * Unconditional rather than "only when the counter looked broken", because
 * knowing the counter is broken requires the counter. A budget consulted only
 * in a state you cannot reliably detect is a budget that is not there.
 *
 * ## What a trip does, which is the part that matters
 *
 * It returns the same verdict a courier outage returns — `source: "unknown"` —
 * so the shop degrades to a **labelled estimate** rather than an error.
 * Prepaid still sells at a settings figure the checkout marks as an estimate;
 * Pay on Delivery falls to the owner's `fallback_behaviour`. A limiter that
 * threw here would take Pay on Delivery off the table for a real customer,
 * which is precisely the outcome the size of the budget exists to prevent.
 */
const COURIER_CALLS_PER_HOUR = 600;
const COURIER_WINDOW_MS = 3_600_000;
let courierCalls = 0;
let courierWindowStartedAt = 0;

function withinCourierBudget(now: number): boolean {
  if (now - courierWindowStartedAt > COURIER_WINDOW_MS) {
    courierWindowStartedAt = now;
    courierCalls = 0;
  }
  if (courierCalls >= COURIER_CALLS_PER_HOUR) return false;
  courierCalls += 1;
  return true;
}

export async function quoteDelivery(input: {
  deliveryPostcode: string;
  weightKg: number;
  valuePaise?: number;
}): Promise<ServiceabilityVerdict> {
  if (!withinCourierBudget(Date.now())) {
    /*
      Deliberately `console.error`: this should never happen on a healthy shop,
      and if it is in the log it means either the database counter is down or
      somebody is scraping. Both are worth waking up for, and neither is
      visible from the customer's side — they simply see an estimate.
    */
    console.error(
      "[shiprocket] hourly courier-call budget spent in this instance — " +
        "serving a labelled estimate instead. Either the rate-limit counter " +
        "is unavailable or this endpoint is being scraped.",
    );
    return {
      ...UNKNOWN_SERVICEABILITY,
      reason: "courier call budget spent in this instance",
    };
  }

  try {
    const defaults = await shippingDefaults();
    return await checkServiceability({
      pickupPostcode: defaults.pickup_postcode,
      deliveryPostcode: input.deliveryPostcode,
      weightKg: input.weightKg,
      declaredValuePaise: input.valuePaise,
    });
  } catch (error) {
    /**
     * `checkServiceability` resolves its own failures to a verdict, so reaching
     * here means the *settings* read failed — almost always an unset parcel
     * dimension.
     *
     * It still fails soft, but "soft" now means something different from what it
     * meant in Phase 6. The verdict comes back `source: "unknown"`, and under
     * the owner's decision 4 that withdraws Pay on Delivery rather than leaving
     * it available: an unquotable parcel is an unsecurable cash order. Prepaid
     * still sells, at an estimate, labelled as one. See `deliveryFee()`.
     *
     * The reason carries the missing field name so the log line and the admin
     * banner say the same thing.
     */
    const reason =
      error instanceof ParcelDefaultsIncompleteError
        ? `parcel defaults incomplete: ${error.missing.join(", ")}`
        : "settings unavailable";

    console.error("[shiprocket] quote failed before it reached the provider:", reason);
    return { ...UNKNOWN_SERVICEABILITY, reason };
  }
}
