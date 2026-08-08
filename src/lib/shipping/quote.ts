import "server-only";

import { maybeRow } from "@/lib/queries/run";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  checkServiceability,
  UNKNOWN_SERVICEABILITY,
  type ServiceabilityVerdict,
} from "@/lib/shipping/serviceability";

/**
 * What the shop assumes about a parcel when nobody has measured one.
 *
 * Every field is nullable on `products` and falls back to here, so the first
 * shipment can be created before the owner has weighed anything. The pickup PIN
 * is the shop's own — serviceability is quoted *from* somewhere, and getting it
 * wrong silently produces plausible estimates for the wrong city.
 */
export type ShippingDefaults = {
  weight_grams: number;
  length_cm: number;
  breadth_cm: number;
  height_cm: number;
  pickup_postcode: string;
};

const FALLBACK: ShippingDefaults = {
  weight_grams: 900,
  length_cm: 33,
  breadth_cm: 22,
  height_cm: 13,
  pickup_postcode: "560001",
};

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
 */
export async function shippingDefaults(): Promise<ShippingDefaults> {
  const row = await maybeRow<{ value: unknown }>(
    "shipping.defaults",
    createAdminClient()
      .from("site_settings")
      .select("value")
      .eq("key", "shipping_defaults")
      .maybeSingle(),
  );

  const value = row?.value;
  if (!value || typeof value !== "object") return FALLBACK;

  // Merged over the fallback rather than trusted wholesale: a hand-edited row
  // missing one field must not produce `undefined` inside a Shiprocket payload,
  // where it becomes a quote for a parcel with no weight.
  const partial = value as Partial<ShippingDefaults>;
  return {
    weight_grams: numberOr(partial.weight_grams, FALLBACK.weight_grams),
    length_cm: numberOr(partial.length_cm, FALLBACK.length_cm),
    breadth_cm: numberOr(partial.breadth_cm, FALLBACK.breadth_cm),
    height_cm: numberOr(partial.height_cm, FALLBACK.height_cm),
    pickup_postcode:
      typeof partial.pickup_postcode === "string" &&
      /^\d{6}$/.test(partial.pickup_postcode)
        ? partial.pickup_postcode
        : FALLBACK.pickup_postcode,
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/**
 * A parcel's weight in kilograms, from the lines in the bag.
 *
 * Weights are per *product*, not per variant — see the column comment on
 * `products.weight_grams` for why — and a line with no weight of its own uses
 * the default rather than counting as zero. A parcel that Shiprocket is told
 * weighs nothing is quoted as if it weighs nothing, and the quote is wrong in
 * the direction that costs the shop money.
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
export async function quoteDelivery(input: {
  deliveryPostcode: string;
  weightKg: number;
  valuePaise?: number;
}): Promise<ServiceabilityVerdict> {
  try {
    const defaults = await shippingDefaults();
    return await checkServiceability({
      pickupPostcode: defaults.pickup_postcode,
      deliveryPostcode: input.deliveryPostcode,
      weightKg: input.weightKg,
      declaredValuePaise: input.valuePaise,
    });
  } catch (error) {
    // `checkServiceability` already resolves its own failures to a verdict, so
    // reaching here means the *settings* read failed. Still fail soft: a
    // database hiccup reading a default weight must not decline a COD order.
    console.error(
      "[shiprocket] quote failed before it reached the provider:",
      error instanceof Error ? error.message : "unknown",
    );
    return { ...UNKNOWN_SERVICEABILITY, reason: "settings unavailable" };
  }
}
