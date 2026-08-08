import "server-only";

import type { AdvanceRule, CodAdvanceMode } from "@/lib/payments/advance";
import { MIN_CHARGEABLE_PAISE, type PaymentMethod } from "@/lib/payments/types";
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
  codAdvanceMode: CodAdvanceMode;
  /** The advance never falls below this. ₹99 by default. */
  codAdvanceMinimumPaise: number;
  /** Used only when the mode is `fixed`. */
  codAdvanceFixedPaise: number;
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
  codAdvanceMode: "greater_of",
  codAdvanceMinimumPaise: 9_900,
  codAdvanceFixedPaise: 9_900,
};

const MODES: readonly CodAdvanceMode[] = ["shipping_fee", "fixed", "greater_of"];

/**
 * The settings, narrowed to just what the advance calculation needs.
 *
 * `advanceFor()` takes this rather than the whole settings object so it stays a
 * pure function over three numbers, importable from anywhere including the
 * checkout UI. See `src/lib/payments/advance.ts`.
 */
export function advanceRule(settings: ShippingSettings): AdvanceRule {
  return {
    mode: settings.codAdvanceMode,
    minimumPaise: settings.codAdvanceMinimumPaise,
    fixedPaise: settings.codAdvanceFixedPaise,
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
    codAdvanceMode: MODES.includes(partial.cod_advance_mode as CodAdvanceMode)
      ? (partial.cod_advance_mode as CodAdvanceMode)
      : FALLBACK.codAdvanceMode,
    /**
     * Floored at Razorpay's own minimum, not merely at zero.
     *
     * An owner who types 0 into `/admin/settings` is asking for an advance of
     * nothing, which is unsecured COD — the exact thing this phase removes — and
     * Razorpay would reject the order anyway. Clamping here means the floor
     * holds no matter which of the three modes is selected.
     */
    codAdvanceMinimumPaise: Math.max(
      MIN_CHARGEABLE_PAISE,
      paiseOr(partial.cod_advance_minimum_paise, FALLBACK.codAdvanceMinimumPaise),
    ),
    codAdvanceFixedPaise: Math.max(
      MIN_CHARGEABLE_PAISE,
      paiseOr(partial.cod_advance_fixed_paise, FALLBACK.codAdvanceFixedPaise),
    ),
  };
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
