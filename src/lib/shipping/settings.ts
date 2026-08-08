import "server-only";

import type { AdvanceRule } from "@/lib/payments/advance";
import { type PaymentMethod } from "@/lib/payments/types";
import { maybeRow } from "@/lib/queries/run";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The numbers the shop owns, as opposed to the numbers the courier owns.
 *
 * The split matters and is the owner's instruction, given on 2026-08-08:
 *
 * > "Delivery charges should be picked up from shiprocket api we will not
 * > hardcode anything. Min order value is decided by us or admin from admin
 * > panel."
 *
 * So a **rate** is never written down in this codebase — `deliveryFee()` prices
 * from a live Shiprocket quote. A **threshold** is a business decision, and
 * every one of them lives here, editable at `/admin/settings`, because the
 * alternative is the owner asking an engineer to change a constant.
 *
 * This file replaced `shipping.flat_fee_paise`, which was the cause of a real
 * drift: the cart read the flat fee and showed ₹199 while checkout charged a
 * live courier rate. Orders FV-2026-00487 and FV-2026-00488 carry identical
 * ₹1,499 subtotals and different delivery — ₹199 and ₹220 — which is the bug
 * the owner reported as "totals differ between COD and pay-online". The flat fee
 * is gone rather than corrected, so it cannot come back.
 */

export type ShippingSettings = {
  /** Prepaid delivery is free at or above this. Zero disables the free tier. */
  freeAbovePaise: number;
  /**
   * Used **only** when Shiprocket cannot be reached, per method.
   *
   * Not a price list and not a rate: refusing to sell during a courier outage is
   * a worse outcome than mispricing a handful of orders, so something has to
   * exist. It is a setting rather than a constant so the owner can correct it
   * without a deploy.
   */
  fallbackFeePaise: Record<PaymentMethod, number>;
  /** Master switch for Pay on Delivery, independent of PIN-code serviceability. */
  codEnabled: boolean;

  /* --- Phase 7: the round-trip advance ---------------------------------- */

  /**
   * Below this basket value, Pay on Delivery is not offered at all.
   *
   * The guard rail that makes `balance >= 0` a property rather than a hope.
   * Under the round-trip model the advance is `forward + RTO` — on this account,
   * ₹280-odd to Bangalore — and on a ₹250 pair of flip-flops that is more than
   * the goods. Clamping the advance would "work" and would leave the shop
   * carrying a return it has not been paid for, so the method is withdrawn
   * instead and prepaid is offered in its place.
   */
  codMinimumOrderValuePaise: number;
  /**
   * A ceiling on the deposit, whatever the courier quotes.
   *
   * A heavy parcel to a remote PIN can quote a round trip in the hundreds, and
   * an advance that large reads as a scam to a customer who came to pay cash.
   * The shop absorbs the difference above this and keeps the sale.
   */
  codAdvanceMaximumPaise: number;
  /**
   * Shiprocket bills freight plus 18% GST. On means the advance recovers it.
   *
   * Off is a real choice, not a bug: the shop can reclaim input GST, so
   * absorbing it costs less than the 18% it would add to every deposit.
   */
  includeGstInAdvance: boolean;
  /**
   * Passed back to prepaid customers, because prepaid orders come back far less
   * often than cash ones and that is worth money. A named line, never a
   * silently lower total.
   */
  prepaidDiscount: { mode: "flat" | "percent"; value: number };
  /**
   * `live` charges what the courier quotes for this PIN. `flat` charges
   * `customerDeliveryFlatPaise` and the shop absorbs the difference either way.
   */
  customerDeliveryFeeMode: "live" | "flat";
  customerDeliveryFlatPaise: number;
  /** What a prepaid customer loses when their parcel comes back unaccepted. */
  rtoDeductionPolicy: "actual_freight" | "flat" | "none";
  rtoDeductionFlatPaise: number;
};

/**
 * What we answer with when `site_settings` is unreadable.
 *
 * Deliberately the same shape as the seeded row. A shop whose settings table is
 * briefly unavailable still sells, still offers Pay on Delivery, and still takes
 * an advance that Razorpay will accept.
 */
const FALLBACK: ShippingSettings = {
  freeAbovePaise: 249_900,
  fallbackFeePaise: { razorpay: 19_900, cod: 34_900 },
  codEnabled: true,
  /**
   * ₹999. Set so the round trip cannot approach the goods value: the most
   * expensive round trip measured on this account is ₹281 (Delhivery Surface,
   * Cuddapah → Bangalore, 1kg), and a floor three and a half times that leaves
   * the customer paying an advance that is a minority of what they owe. **The
   * owner sets the real value** — this is what the code does when the row is
   * unreadable, not a policy decision taken here.
   */
  codMinimumOrderValuePaise: 99_900,
  /** ₹500. Roughly twice the worst round trip seen, so it binds rarely. */
  codAdvanceMaximumPaise: 50_000,
  includeGstInAdvance: false,
  prepaidDiscount: { mode: "flat", value: 0 },
  customerDeliveryFeeMode: "live",
  customerDeliveryFlatPaise: 0,
  rtoDeductionPolicy: "actual_freight",
  rtoDeductionFlatPaise: 0,
};

/**
 * The settings, narrowed to just what the advance calculation needs.
 *
 * `advanceFor()` takes this rather than the whole settings object so it stays a
 * pure function over three numbers, importable from anywhere including the
 * checkout UI. See `src/lib/payments/advance.ts`.
 */
export function advanceRule(settings: ShippingSettings): AdvanceRule {
  return {
    maximumPaise: settings.codAdvanceMaximumPaise,
    includeGst: settings.includeGstInAdvance,
  };
}

export async function shippingSettings(): Promise<ShippingSettings> {
  const row = await maybeRow<{ value: unknown }>(
    "shipping.settings",
    createAdminClient()
      .from("site_settings")
      .select("value")
      .eq("key", "shipping")
      .maybeSingle(),
  );

  const value = row?.value;
  if (!value || typeof value !== "object") return FALLBACK;

  // Merged over the fallback rather than trusted wholesale, for the same reason
  // `shippingDefaults()` does it: one missing field in a hand-edited row must
  // not become `undefined` inside a money calculation.
  const partial = value as Record<string, unknown>;

  return {
    freeAbovePaise: paiseOr(
      partial.free_above_paise,
      FALLBACK.freeAbovePaise,
      // Zero is meaningful here — it means "no free tier" — so unlike every
      // other field below, it is allowed through.
      true,
    ),
    fallbackFeePaise: readFallbackFees(partial.fallback_fee_paise),
    codEnabled: partial.cod_enabled !== false,

    // Zero is meaningful for both — "no minimum" and "no cap" — so both are
    // read with the allow-zero flag rather than falling back on a falsy value.
    codMinimumOrderValuePaise: paiseOr(
      partial.cod_minimum_order_value_paise,
      FALLBACK.codMinimumOrderValuePaise,
      true,
    ),
    codAdvanceMaximumPaise: paiseOr(
      partial.cod_advance_maximum_paise,
      FALLBACK.codAdvanceMaximumPaise,
      true,
    ),
    includeGstInAdvance: partial.include_gst_in_advance === true,
    prepaidDiscount: readPrepaidDiscount(partial.prepaid_discount),
    customerDeliveryFeeMode:
      partial.customer_delivery_fee_mode === "flat" ? "flat" : "live",
    customerDeliveryFlatPaise: paiseOr(
      partial.customer_delivery_flat_paise,
      FALLBACK.customerDeliveryFlatPaise,
      true,
    ),
    rtoDeductionPolicy: RTO_POLICIES.includes(
      partial.rto_deduction_policy as ShippingSettings["rtoDeductionPolicy"],
    )
      ? (partial.rto_deduction_policy as ShippingSettings["rtoDeductionPolicy"])
      : FALLBACK.rtoDeductionPolicy,
    rtoDeductionFlatPaise: paiseOr(
      partial.rto_deduction_flat_paise,
      FALLBACK.rtoDeductionFlatPaise,
      true,
    ),
  };
}

const RTO_POLICIES: readonly ShippingSettings["rtoDeductionPolicy"][] = [
  "actual_freight",
  "flat",
  "none",
];

/**
 * The prepaid discount, refused rather than clamped when it is nonsense.
 *
 * A percentage over 100 or a negative flat amount would turn a discount into a
 * surcharge somewhere downstream, and the safe reading of a malformed money
 * rule is "there is no discount" rather than "here is one I invented".
 */
function readPrepaidDiscount(
  value: unknown,
): ShippingSettings["prepaidDiscount"] {
  if (!value || typeof value !== "object") return FALLBACK.prepaidDiscount;
  const partial = value as Record<string, unknown>;
  const mode = partial.mode === "percent" ? "percent" : "flat";
  const raw = partial.value;
  const amount =
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
  const ceiling = mode === "percent" ? 100 : Number.MAX_SAFE_INTEGER;
  return { mode, value: Math.min(amount, ceiling) };
}

function readFallbackFees(value: unknown): Record<PaymentMethod, number> {
  if (!value || typeof value !== "object") return FALLBACK.fallbackFeePaise;
  const partial = value as Record<string, unknown>;
  return {
    razorpay: paiseOr(partial.razorpay, FALLBACK.fallbackFeePaise.razorpay),
    cod: paiseOr(partial.cod, FALLBACK.fallbackFeePaise.cod),
  };
}

/** Integer paise only. A float or a negative in this table is a typo, not a price. */
function paiseOr(value: unknown, fallback: number, allowZero = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return fallback;
  if (value < 0) return fallback;
  if (value === 0 && !allowZero) return fallback;
  return value;
}
