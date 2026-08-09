import "server-only";

import type { AdvanceRule } from "@/lib/payments/advance";
import { type FlatDepositRule } from "@/lib/payments/advance";
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
 * the owner reported as "totals differ between COD and pay-online".
 *
 * ## There is no fallback object any more, and that is the point
 *
 * This file used to answer an unreadable `site_settings` row with a hardcoded
 * `ShippingSettings` — free delivery above ₹2,499, a ₹199 prepaid fee, a ₹349
 * Pay-on-Delivery fee. Every one of those was stale: the live threshold is
 * ₹6,499. So a settings-table blip did not degrade the shop, it silently
 * repriced it, and `npm run audit:literals` could not see it because the numbers
 * were in a constant rather than in a component.
 *
 * The owner's rule for Batch 2 is absolute: *"nothing may fall through to a
 * literal."* So there is nothing to fall through to. An unreadable row throws
 * `ShippingSettingsUnavailableError` and each caller decides what that means for
 * its own surface — the product page hides its delivery estimate, the CMS leaves
 * `{{free_shipping_threshold}}` visible rather than filling it with a guess, and
 * checkout refuses rather than charging invented prices. A shop that cannot read
 * its own thresholds is not a shop that should be quoting.
 */

export type ShippingSettings = {
  /** Delivery is free at or above this, for **both** methods. Zero disables it. */
  freeAbovePaise: number;
  /**
   * What a prepaid customer is charged when Shiprocket cannot be reached.
   *
   * Shown to them as an estimate and labelled as one — see decision 4 below.
   * Not a rate and not a price list: refusing to sell during a courier outage is
   * a worse outcome than mispricing a handful of prepaid orders. There is no
   * Pay-on-Delivery counterpart, deliberately; see `fallbackBehaviour`.
   */
  prepaidEstimateFeePaise: number;
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

  /* --- Batch 2: the delivery controls ----------------------------------- */

  /**
   * `live` quotes Shiprocket for this PIN. `flat` charges `flatShippingFeePaise`
   * and **makes no Shiprocket call at all** — the owner's requirement, so a
   * festival sale is a fixed price rather than a fixed price plus an API
   * dependency.
   *
   * What flat mode gives up is worth stating: with no call there is no PIN-level
   * serviceability, no answer to whether a courier there collects cash, and no
   * cash-collection fee. The shop sells anyway and absorbs the difference, which
   * is the trade the owner asked for.
   */
  shippingRateMode: "live" | "flat";
  flatShippingFeePaise: number;
  /**
   * What secures a Pay-on-Delivery order in flat mode, where there is no round
   * trip to charge.
   *
   * Unset by default and that is not an oversight. The owner's instruction was
   * *"never silently collect nothing"*, so with no rule configured Pay on
   * Delivery is **refused** in flat mode rather than taking a deposit of zero.
   * See `flatModeDepositPaise` in `src/lib/payments/advance.ts`.
   */
  flatCodDeposit: FlatDepositRule;
  /**
   * Owner's decision 3, 2026-08-09: **false**.
   *
   * Free delivery now applies to Pay on Delivery as well as prepaid — that was
   * the original bug — but the cash-handling fee keeps being charged on top of
   * free delivery, because it is a real courier cost and it gives customers a
   * reason to prepay. Turning this on waives it above the threshold.
   */
  waiveCodFeeAboveThreshold: boolean;
  /**
   * Owner's decision 4, 2026-08-09: **`refuse_cod`**.
   *
   * With no live quote there is no round trip, so a Pay-on-Delivery order taken
   * anyway would be unsecured. Prepaid is let through with its price labelled to
   * the customer as an estimate.
   *
   * `allow_all` still requires `flatCodDeposit` to be set — there is no
   * configuration of this shop in which a cash order is accepted against a
   * deposit of nothing.
   */
  fallbackBehaviour: "refuse_cod" | "allow_all";
  /** What a prepaid customer loses when their parcel comes back unaccepted. */
  rtoDeductionPolicy: "actual_freight" | "flat" | "none";
  rtoDeductionFlatPaise: number;
  /**
   * Warn on the admin dashboard below this Shiprocket wallet balance. Null means
   * the owner has not chosen one, and the dashboard says so rather than quietly
   * never warning.
   */
  walletLowBalancePaise: number | null;
};

/**
 * Thrown when `site_settings.shipping` cannot be read or is not an object.
 *
 * A distinct class rather than a bare `Error` so callers can tell "the shop has
 * no thresholds" apart from "the courier is down" and degrade differently.
 * Nothing catches this and substitutes numbers; that is the whole point.
 */
export class ShippingSettingsUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `site_settings.shipping is unreadable (${detail}). Delivery thresholds ` +
        `cannot be guessed, so nothing will be quoted until it is readable. ` +
        `Check the row exists and that the service role can select it.`,
    );
    this.name = "ShippingSettingsUnavailableError";
  }
}

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
  if (!value || typeof value !== "object")
    throw new ShippingSettingsUnavailableError(
      row ? "the value is not an object" : "no row came back",
    );

  const partial = value as Record<string, unknown>;

  /**
   * Every field below is **required**, and a missing one throws rather than
   * defaulting. A hand-edited row that lost `free_above_paise` used to become
   * ₹2,499 out of a constant; now it becomes a loud failure naming the field,
   * which is the difference between finding out today and finding out in a
   * reconciliation next month.
   *
   * The two-argument reads carry a default only where **zero is the meaningful
   * absent value** and the owner's intent is unambiguous — an unset cap means
   * "no cap", an unset RTO deduction means "deduct nothing". Those are not
   * prices.
   */
  return {
    freeAbovePaise: requiredPaise(partial, "free_above_paise"),
    prepaidEstimateFeePaise: requiredPaise(
      partial,
      "prepaid_estimate_fee_paise",
      // See `legacy()` below: this key was `fallback_fee_paise.razorpay` until
      // Batch 2 renamed it.
      legacy(partial, ["fallback_fee_paise", "razorpay"]),
    ),
    codEnabled: partial.cod_enabled !== false,
    /**
     * **Optional, and zero means "no minimum".**
     *
     * It was written as required and that was wrong in a way that only showed up
     * on a fresh database: **no migration anywhere writes this field.** It
     * exists on production because somebody saved the settings form once. Replay
     * the migrations into an empty project and every page 500s with
     * `ShippingSettingsUnavailableError` — found by the staging rebuild, and the
     * workaround was to invent a value by hand, which is exactly what this batch
     * is meant to stop.
     *
     * Zero is not a guessed price, it is the absence of a guard rail, and the
     * consequence is worth stating: with no minimum, a cheap Pay-on-Delivery
     * order has an advance larger than the goods, which `advanceFor` clamps to
     * the order total — so the customer pays everything online under a method
     * called Pay on Delivery. Confusing, not unsafe. The owner sets the real
     * figure at /admin/settings, where an unset field now renders as an empty
     * box rather than as somebody else's number.
     */
    codMinimumOrderValuePaise: optionalPaise(
      partial.cod_minimum_order_value_paise,
      0,
    ),
    codAdvanceMaximumPaise: optionalPaise(partial.cod_advance_maximum_paise, 0),
    includeGstInAdvance: partial.include_gst_in_advance === true,
    prepaidDiscount: readPrepaidDiscount(partial.prepaid_discount),
    shippingRateMode:
      (partial.shipping_rate_mode ?? partial.customer_delivery_fee_mode) ===
      "flat"
        ? "flat"
        : "live",
    flatShippingFeePaise: optionalPaise(
      partial.flat_shipping_fee_paise ?? partial.customer_delivery_flat_paise,
      0,
    ),
    flatCodDeposit: readFlatDeposit(partial),
    waiveCodFeeAboveThreshold: partial.waive_cod_fee_above_threshold === true,
    fallbackBehaviour:
      partial.fallback_behaviour === "allow_all" ? "allow_all" : "refuse_cod",
    rtoDeductionPolicy: RTO_POLICIES.includes(
      partial.rto_deduction_policy as ShippingSettings["rtoDeductionPolicy"],
    )
      ? (partial.rto_deduction_policy as ShippingSettings["rtoDeductionPolicy"])
      : "actual_freight",
    rtoDeductionFlatPaise: optionalPaise(partial.rto_deduction_flat_paise, 0),
    walletLowBalancePaise: nullablePaise(partial.wallet_low_balance_paise),
  };
}

const RTO_POLICIES: readonly ShippingSettings["rtoDeductionPolicy"][] = [
  "actual_freight",
  "flat",
  "none",
];

/**
 * The flat-mode deposit rule, or `unset`.
 *
 * `unset` is returned for a missing mode **and** for a mode whose own value is
 * missing or nonsense — a `multiplier` rule with no multiplier is not a rule,
 * and treating it as one would compute a deposit of zero, which is the outcome
 * the owner ruled out by name.
 */
function readFlatDeposit(partial: Record<string, unknown>): FlatDepositRule {
  const mode = partial.flat_cod_deposit_mode;
  if (mode === "multiplier") {
    const raw = partial.flat_cod_deposit_multiplier;
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0
      ? { mode: "multiplier", multiplier: raw }
      : { mode: "unset" };
  }
  if (mode === "fixed") {
    const raw = partial.flat_cod_deposit_paise;
    return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0
      ? { mode: "fixed", paise: raw }
      : { mode: "unset" };
  }
  return { mode: "unset" };
}

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
  const none = { mode: "flat", value: 0 } as const;
  if (!value || typeof value !== "object") return none;
  const partial = value as Record<string, unknown>;
  const mode = partial.mode === "percent" ? "percent" : "flat";
  const raw = partial.value;
  const amount =
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
  const ceiling = mode === "percent" ? 100 : Number.MAX_SAFE_INTEGER;
  return { mode, value: Math.min(amount, ceiling) };
}

/**
 * A threshold the shop cannot operate without. Absent or malformed throws.
 *
 * `fallbackValue` is the same setting under the name it had before Batch 2
 * renamed it — see `legacy()`. It is not a default and cannot become one: it is
 * a number the owner themselves set, read from where they set it.
 */
function requiredPaise(
  partial: Record<string, unknown>,
  key: string,
  fallbackValue?: unknown,
): number {
  const value = partial[key] ?? fallbackValue;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new ShippingSettingsUnavailableError(
      `${key} is ${value === undefined ? "missing" : JSON.stringify(value)}; ` +
        `it must be a whole number of paise. Set it at /admin/settings`,
    );
  return value;
}

/**
 * The same setting under the name it had before Batch 2.
 *
 * **This is a deploy-ordering guard, not a default.** Three keys were renamed —
 * `fallback_fee_paise.razorpay` → `prepaid_estimate_fee_paise`,
 * `customer_delivery_fee_mode` → `shipping_rate_mode`,
 * `customer_delivery_flat_paise` → `flat_shipping_fee_paise` — and the values
 * are moved by `20260809110100_shipping_rate_mode_and_cod_controls.sql`. If this
 * code reached a database that migration had not, `prepaid_estimate_fee_paise`
 * would be missing, `requiredPaise` would throw, and **every quote in the shop
 * would fail** — checkout down, for a rename. Production is currently exactly
 * that database.
 *
 * So the old name is read as a second chance at the *owner's own number*, which
 * is categorically different from the constants this batch deleted: it is not a
 * value invented in code, it is the value they typed, read from where they typed
 * it. Once the migration has run everywhere these paths are dead and can be
 * deleted — the migration removes the old keys, so a grep for them will find
 * nothing but this function.
 */
function legacy(partial: Record<string, unknown>, path: string[]): unknown {
  let cursor: unknown = partial;
  for (const step of path) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[step];
  }
  return cursor;
}

/** Integer paise where zero is the meaningful absent value. Never a price. */
function optionalPaise(value: unknown, absent: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return absent;
  return value;
}

/** Integer paise where "the owner has not chosen" is distinct from zero. */
function nullablePaise(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    return null;
  return value;
}
