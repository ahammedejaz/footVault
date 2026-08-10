"use server";

import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";

import { adminAction, type AdminResult } from "@/lib/admin/guard";
import type { Json } from "@/lib/database.types";
import { MIN_CHARGEABLE_PAISE } from "@/lib/payments/types";
import { CATALOG_CACHE_TAG } from "@/lib/queries/cached";

/**
 * The shop's own numbers and words, written by the owner.
 *
 * **Rates are not here and must never be.** The owner's rule: delivery charges
 * come from the Shiprocket API for the destination pin code and are never
 * hardcoded. What lives in `site_settings` are *thresholds* — the value above
 * which delivery is free, how much of a Pay-on-Delivery order is taken upfront,
 * and the amounts used only when Shiprocket cannot be reached. Those are
 * business decisions, and a business decision that requires a developer is a
 * business decision the shop does not really own.
 *
 * Every write revalidates `CATALOG_CACHE_TAG`. Settings feed `unstable_cache`
 * with a one-hour window, and without this the owner changes a threshold, sees
 * the storefront ignore it, and changes it again. That is not hypothetical — it
 * took a full `.next` wipe to observe a settings change during this phase.
 */

/** Rupees in the form, paise in the database. The owner should never type paise. */
const rupees = (label: string) =>
  z
    .number({ message: `${label} must be a number.` })
    .min(0, `${label} cannot be negative.`)
    .max(10_000_000, `${label} looks wrong.`)
    .transform((value) => Math.round(value * 100));

/**
 * The seven numbers that decide whether the shop makes money.
 *
 * Phase 7 replaced the advance rule entirely, so `cod_advance_mode`,
 * `cod_advance_minimum_paise` and `cod_advance_fixed_paise` are gone from this
 * form and from `site_settings`. All three priced the deposit from what the
 * *customer* was charged for delivery, which has no relationship to what a
 * refusal costs the shop: under a fixed ₹99 advance against a ₹281 round trip,
 * every refused parcel lost ₹182 and the shop found out by reconciliation. The
 * advance is now the round trip itself and there is nothing to configure about
 * how it is derived — only what bounds it.
 */
const shippingSchema = z
  .object({
    freeAboveRupees: rupees("The free-delivery threshold"),
    codEnabled: z.boolean(),
    codMinimumOrderRupees: rupees("The Pay-on-Delivery minimum order"),
    codAdvanceMaximumRupees: rupees("The cap on the amount paid upfront"),
    includeGstInAdvance: z.boolean(),
    prepaidDiscountMode: z.enum(["flat", "percent"]),
    prepaidDiscountValue: z
      .number({ message: "The prepaid discount must be a number." })
      .min(0, "The prepaid discount cannot be negative."),
    maxTotalDiscountPercent: z
      .number({ message: "The combined-discount ceiling must be a number." })
      .min(0, "The combined-discount ceiling cannot be negative.")
      .max(100, "A ceiling over 100% is not a ceiling."),
    shippingRateMode: z.enum(["live", "flat"]),
    flatShippingFeeRupees: rupees("The flat delivery charge"),
    flatCodDepositMode: z.enum(["unset", "multiplier", "fixed"]),
    flatCodDepositMultiplier: z
      .number({ message: "The deposit multiplier must be a number." })
      .min(0, "The deposit multiplier cannot be negative."),
    flatCodDepositRupees: rupees("The flat-mode deposit"),
    waiveCodFeeAboveThreshold: z.boolean(),
    fallbackBehaviour: z.enum(["refuse_cod", "allow_all"]),
    rtoDeductionPolicy: z.enum(["actual_freight", "flat", "none"]),
    rtoDeductionFlatRupees: rupees("The flat return deduction"),
    prepaidEstimateRupees: rupees("The prepaid estimate"),
    walletLowBalanceRupees: rupees("The low wallet-balance warning"),
  })
  .refine(
    (value) =>
      value.prepaidDiscountMode !== "percent" ||
      value.prepaidDiscountValue <= 100,
    {
      message: "A percentage discount cannot be more than 100%.",
      path: ["prepaidDiscountValue"],
    },
  )
  .refine(
    (value) =>
      value.shippingRateMode !== "flat" || value.flatShippingFeeRupees > 0,
    {
      message:
        "A flat delivery charge of ₹0 means free delivery on every order. " +
        "Set an amount, or switch back to charging the live courier rate.",
      path: ["flatShippingFeeRupees"],
    },
  )
  /**
   * **The guard that stops flat mode collecting nothing.**
   *
   * The owner's instruction, 2026-08-09: *"the Pay-on-Delivery deposit still
   * needs a round-trip figure in flat mode, so derive it from the flat fee via a
   * configurable multiplier or a configurable flat deposit — never silently
   * collect nothing."*
   *
   * Flat mode makes no Shiprocket call, so there is no forward leg and no return
   * leg to build an advance from. Saved without a deposit rule it would take a
   * deposit of a rupee against a parcel that costs ₹280 to send and bring back —
   * which is order FV-2026-00488 again, arrived at by configuration instead of
   * by code.
   *
   * Refused at the point of saving rather than only at checkout, so the shop
   * cannot be *put* into that state. `computeOrderTotals` refuses Pay on
   * Delivery too if it somehow gets there, but a runtime refusal is a silently
   * lost sale and this is a sentence the owner can act on.
   *
   * Only when Pay on Delivery is actually on: flat mode with cash switched off
   * has nothing to secure, and blocking it would be a rule with no purpose.
   */
  .refine(
    (value) =>
      !value.codEnabled ||
      value.shippingRateMode !== "flat" ||
      value.flatCodDepositMode !== "unset",
    {
      message:
        "A flat delivery charge needs a Pay-on-Delivery deposit to go with it. " +
        "With no live courier quote there is no round trip to charge, so the " +
        "deposit would be nothing and a refused parcel would cost you both " +
        "journeys. Set a deposit, or switch Pay on Delivery off.",
      path: ["flatCodDepositMode"],
    },
  )
  /**
   * The same rule for `allow_all`, which is the other way to reach a cash order
   * with no quote behind it. There is no configuration of this shop in which a
   * parcel goes out against a deposit of nothing.
   */
  .refine(
    (value) =>
      !value.codEnabled ||
      value.fallbackBehaviour !== "allow_all" ||
      value.flatCodDepositMode !== "unset",
    {
      message:
        "Offering Pay on Delivery during a courier outage needs a deposit to " +
        "secure it — there is no quote to work one out from. Set a deposit, or " +
        "leave Pay on Delivery switched off during outages.",
      path: ["fallbackBehaviour"],
    },
  )
  .refine(
    (value) =>
      value.flatCodDepositMode !== "multiplier" ||
      value.flatCodDepositMultiplier > 0,
    {
      message:
        "A deposit of zero times the delivery charge is a deposit of nothing.",
      path: ["flatCodDepositMultiplier"],
    },
  )
  .refine(
    (value) =>
      value.flatCodDepositMode !== "fixed" || value.flatCodDepositRupees > 0,
    {
      message: "A fixed deposit of ₹0 collects nothing. Set an amount.",
      path: ["flatCodDepositRupees"],
    },
  )
  .refine(
    (value) =>
      value.rtoDeductionPolicy !== "flat" || value.rtoDeductionFlatRupees > 0,
    {
      message:
        "A flat return deduction of ₹0 is the same as refunding in full. " +
        "Set an amount, or choose 'refund in full'.",
      path: ["rtoDeductionFlatRupees"],
    },
  )
  .refine(
    (value) =>
      value.codAdvanceMaximumRupees === 0 ||
      value.codAdvanceMaximumRupees >= MIN_CHARGEABLE_PAISE,
    {
      message:
        "Razorpay cannot charge less than ₹1, so a cap below that would make " +
        "every Pay-on-Delivery order unpayable. Use ₹0 for no cap.",
      path: ["codAdvanceMaximumRupees"],
    },
  );

export async function saveShippingSettings(
  input: unknown,
): Promise<AdminResult<object>> {
  return adminAction<object>(
    "saveShippingSettings",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = shippingSchema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          reason: "invalid",
          message:
            parsed.error.issues[0]?.message ?? "Check those numbers and try again.",
        };
      }
      const v = parsed.data;

      /**
       * Merged over what is already stored rather than replacing it.
       *
       * `shipping` also carries `currency` and `regions`, which this form does
       * not edit. Writing a whole object here would silently drop them, and the
       * loss would only surface somewhere far away.
       */
      const { data: existing, error: readError } = await supabase
        .from("site_settings")
        .select("value")
        .eq("key", "shipping")
        .maybeSingle();
      if (readError) {
        return {
          ok: false,
          reason: "error",
          message: "Could not read the current settings.",
        };
      }

      const current =
        existing?.value && typeof existing.value === "object"
          ? (existing.value as Record<string, unknown>)
          : {};

      const { error } = await supabase
        .from("site_settings")
        .update({
          value: {
            ...current,
            free_above_paise: v.freeAboveRupees,
            cod_enabled: v.codEnabled,
            cod_minimum_order_value_paise: v.codMinimumOrderRupees,
            cod_advance_maximum_paise: v.codAdvanceMaximumRupees,
            include_gst_in_advance: v.includeGstInAdvance,
            prepaid_discount: {
              mode: v.prepaidDiscountMode,
              // A percentage is a percentage, not paise. `rupees()` multiplies
              // by 100 and would turn 5% into 500%.
              value:
                v.prepaidDiscountMode === "percent"
                  ? v.prepaidDiscountValue
                  : Math.round(v.prepaidDiscountValue * 100),
            },
            /*
              Null rather than zero when unset, for the same reason as the
              flat-mode deposit: zero would read as "a ceiling of nothing",
              which is a rule, and an empty box is the absence of one. Unset
              withholds stacking — the customer gets the larger single
              discount until the owner chooses the ceiling.
            */
            max_total_discount_percent:
              v.maxTotalDiscountPercent > 0 ? v.maxTotalDiscountPercent : null,
            shipping_rate_mode: v.shippingRateMode,
            flat_shipping_fee_paise: v.flatShippingFeeRupees,
            /*
              Null rather than absent when unset, so the row says "the owner has
              not chosen" out loud. `readFlatDeposit` treats both the same, but
              only one of them is legible to a person reading the JSON.

              A multiplier is a ratio, not money, so it is written as typed —
              `rupees()` would multiply 1.5 into 150.
            */
            flat_cod_deposit_mode:
              v.flatCodDepositMode === "unset" ? null : v.flatCodDepositMode,
            flat_cod_deposit_multiplier:
              v.flatCodDepositMode === "multiplier"
                ? v.flatCodDepositMultiplier
                : null,
            flat_cod_deposit_paise:
              v.flatCodDepositMode === "fixed" ? v.flatCodDepositRupees : null,
            waive_cod_fee_above_threshold: v.waiveCodFeeAboveThreshold,
            fallback_behaviour: v.fallbackBehaviour,
            rto_deduction_policy: v.rtoDeductionPolicy,
            rto_deduction_flat_paise: v.rtoDeductionFlatRupees,
            prepaid_estimate_fee_paise: v.prepaidEstimateRupees,
            // Zero means "no threshold chosen" and the dashboard says so, rather
            // than warning at a figure this file invented.
            wallet_low_balance_paise:
              v.walletLowBalanceRupees > 0 ? v.walletLowBalanceRupees : null,
          },
        })
        .eq("key", "shipping");
      if (error) {
        return { ok: false, reason: "error", message: "That did not save." };
      }

      /**
       * `updateTag`, not `revalidateTag`.
       *
       * This Next takes a cache profile as a second argument to
       * `revalidateTag`, and ships `updateTag` for precisely this case: called
       * from inside a Server Action it gives read-your-own-writes, so the owner
       * sees the change on the very next render rather than after the one-hour
       * window lapses. Getting this wrong is invisible in development and looks
       * like "my edit did nothing" in production.
       */
      updateTag(CATALOG_CACHE_TAG);
      revalidatePath("/", "layout");
      return { ok: true };
    },
  );
}

const textSettingSchema = z.object({
  storeName: z.string().trim().min(1, "The shop needs a name.").max(80),
  storeTagline: z.string().trim().max(120),
  email: z.string().trim().email("That is not an email address.").or(z.literal("")),
  phone: z.string().trim().max(30),
  whatsapp: z.string().trim().max(30),
  address: z.string().trim().max(300),
  instagram: z.string().trim().max(200),
  facebook: z.string().trim().max(200),
});

/**
 * Store identity and how to reach the shop.
 *
 * The contact details are load-bearing rather than decorative: the returns
 * policy is that a customer contacts the shop directly, so a wrong number here
 * makes a replacement unclaimable. That is why the phone and WhatsApp fields
 * say so in the form.
 */
export async function saveStoreSettings(
  input: unknown,
): Promise<AdminResult<object>> {
  return adminAction<object>(
    "saveStoreSettings",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = textSettingSchema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          reason: "invalid",
          message: parsed.error.issues[0]?.message ?? "Check that and try again.",
        };
      }
      const v = parsed.data;

      const writes: { key: string; value: Json }[] = [
        { key: "store_name", value: v.storeName },
        { key: "store_tagline", value: v.storeTagline },
        {
          key: "contact",
          value: {
            email: v.email,
            phone: v.phone,
            whatsapp: v.whatsapp,
            address: v.address,
          },
        },
        { key: "social", value: { instagram: v.instagram, facebook: v.facebook } },
      ];

      for (const write of writes) {
        const { error } = await supabase
          .from("site_settings")
          .update({ value: write.value })
          .eq("key", write.key);
        if (error) {
          return {
            ok: false,
            reason: "error",
            message: `Could not save ${write.key}.`,
          };
        }
      }

      /**
       * `updateTag`, not `revalidateTag`.
       *
       * This Next takes a cache profile as a second argument to
       * `revalidateTag`, and ships `updateTag` for precisely this case: called
       * from inside a Server Action it gives read-your-own-writes, so the owner
       * sees the change on the very next render rather than after the one-hour
       * window lapses. Getting this wrong is invisible in development and looks
       * like "my edit did nothing" in production.
       */
      updateTag(CATALOG_CACHE_TAG);
      revalidatePath("/", "layout");
      return { ok: true };
    },
  );
}

/* ------------------------------------------------ the shop's parcel ------- */

/**
 * The one box every product ships in.
 *
 * The owner's decision, 2026-08-09: one common box for the whole catalogue,
 * roughly 20 × 10 cm and about 1 kg packed, applied to every existing product
 * and every product added afterwards. `products.weight_grams` and its three
 * siblings stay as an override for something bulky like boots, and almost
 * nothing needs one.
 *
 * **Every dimension is required and none of them has a default.** That is the
 * point rather than an oversight. This form used to have a silent partner — a
 * 900g literal in `src/lib/shipping/quote.ts` reached whenever a field was
 * missing — which meant a half-filled row and a filled one looked identical
 * while quoting different parcels. There is nothing to fall through to now, so
 * a missing field stops quoting and says which field it was.
 *
 * Shiprocket prices on volumetric weight as well as actual weight, which is why
 * a guessed height is not a small error: it silently misprices every parcel in
 * the direction nobody checks.
 */
const parcelSchema = z.object({
  weightGrams: z
    .number({ message: "The packed weight must be a number." })
    .int("The packed weight must be a whole number of grams.")
    .min(1, "A parcel cannot weigh nothing.")
    .max(50_000, "That is over 50kg — check the units are grams."),
  lengthCm: dimension("The box length"),
  breadthCm: dimension("The box breadth"),
  heightCm: dimension("The box height"),
  pickupPostcode: z
    .string()
    .regex(/^\d{6}$/, "The pickup PIN code must be six digits."),
});

/**
 * A box side in centimetres.
 *
 * The ceiling is Shiprocket's own courier limit rather than an arbitrary large
 * number: a side beyond it is rejected at shipment creation, which is a third
 * party refusing an order somebody has already paid for.
 */
function dimension(label: string) {
  return z
    .number({ message: `${label} must be a number.` })
    .positive(`${label} must be more than zero — a parcel has three sides.`)
    .max(120, `${label} looks wrong. Couriers refuse a side over 120cm.`);
}

export async function saveParcelDefaults(
  input: unknown,
): Promise<AdminResult<object>> {
  return adminAction<object>(
    "saveParcelDefaults",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = parcelSchema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          reason: "invalid",
          message:
            parsed.error.issues[0]?.message ?? "Check those numbers and try again.",
        };
      }
      const v = parsed.data;

      /**
       * Written whole rather than merged, unlike the shipping row above.
       *
       * `shipping_defaults` has exactly these five fields and the schema
       * requires all five, so there is nothing a merge would preserve — and a
       * merge here would quietly keep an old `weight_grams` key beside the new
       * `default_parcel_weight_grams`, which is the sort of leftover that gets
       * read by mistake two phases later.
       */
      const { error } = await supabase
        .from("site_settings")
        .update({
          value: {
            default_parcel_weight_grams: v.weightGrams,
            default_parcel_length_cm: v.lengthCm,
            default_parcel_breadth_cm: v.breadthCm,
            default_parcel_height_cm: v.heightCm,
            pickup_postcode: v.pickupPostcode,
          } satisfies Record<string, Json>,
        })
        .eq("key", "shipping_defaults");

      if (error) {
        return { ok: false, reason: "error", message: "That did not save." };
      }

      updateTag(CATALOG_CACHE_TAG);
      revalidatePath("/admin/settings");
      return { ok: true };
    },
  );
}
