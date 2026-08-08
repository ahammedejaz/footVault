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
    customerDeliveryFeeMode: z.enum(["live", "flat"]),
    customerDeliveryFlatRupees: rupees("The flat delivery charge"),
    rtoDeductionPolicy: z.enum(["actual_freight", "flat", "none"]),
    rtoDeductionFlatRupees: rupees("The flat return deduction"),
    fallbackPrepaidRupees: rupees("The prepaid fallback"),
    fallbackCodRupees: rupees("The Pay-on-Delivery fallback"),
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
      value.customerDeliveryFeeMode !== "flat" ||
      value.customerDeliveryFlatRupees > 0,
    {
      message:
        "A flat delivery charge of ₹0 means free delivery on every order. " +
        "Set an amount, or switch back to charging the live courier rate.",
      path: ["customerDeliveryFlatRupees"],
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
            customer_delivery_fee_mode: v.customerDeliveryFeeMode,
            customer_delivery_flat_paise: v.customerDeliveryFlatRupees,
            rto_deduction_policy: v.rtoDeductionPolicy,
            rto_deduction_flat_paise: v.rtoDeductionFlatRupees,
            fallback_fee_paise: {
              razorpay: v.fallbackPrepaidRupees,
              cod: v.fallbackCodRupees,
            },
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
