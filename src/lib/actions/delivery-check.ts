"use server";

import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { callerIdentity, consumeRateLimit } from "@/lib/rate-limit";
import { shippingSettings } from "@/lib/shipping/settings";
import { quoteDelivery, shippingDefaults } from "@/lib/shipping/quote";

/**
 * "Do you deliver to my pin code, and how long does it take?"
 *
 * Asked from a product page, before there is a bag — which is exactly why this
 * is not `quoteShipping`. That action prices a *cart*: it resolves the caller's
 * bag under RLS and refuses without one, because a fee that did not come from
 * the real basket is a fee nobody should be shown. Most people asking this
 * question have not added anything yet.
 *
 * So this answers the two things that do not need a basket — whether a courier
 * goes there, and roughly how long — and deliberately returns **no price**. A
 * figure quoted here would be for one pair at a default weight, and the number
 * at checkout would differ; showing it would recreate, on the product page, the
 * exact drift this phase spent itself removing.
 *
 * Rate-limited under `serviceability` like the checkout quote, because every
 * miss is a call to Shiprocket on the shop's quota and this endpoint is
 * reachable by anyone with the page open.
 */

const schema = z.object({
  postalCode: z.string().regex(/^\d{6}$/, "Enter a six-digit pin code."),
});

export type DeliveryCheckResult =
  | {
      ok: true;
      deliverable: boolean;
      /** Null when Shiprocket did not say. Render the default, never a guess. */
      estimatedDays: number | null;
      /** False means no courier will collect cash there, so the method is not offered. */
      codAvailable: boolean;
      /** True when Shiprocket actually answered, rather than us failing soft. */
      live: boolean;
    }
  | { ok: false; message: string };

export async function checkDeliveryTo(
  input: unknown,
): Promise<DeliveryCheckResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Check the pin code.",
    };
  }

  const user = await getCurrentUser();
  const throttle = await consumeRateLimit(
    "serviceability",
    await callerIdentity(user?.id ?? null),
  );
  if (!throttle.allowed) {
    return { ok: false, message: "Give that a moment, then try again." };
  }

  try {
    const [defaults, settings] = await Promise.all([
      shippingDefaults(),
      shippingSettings(),
    ]);

    /**
     * One pair at the shop's default parcel weight. This is an availability
     * question, not a pricing one, and rate bands barely move within a
     * kilogram — the alternative is asking the caller which variant they mean
     * before they have chosen a size.
     */
    const verdict = await quoteDelivery({
      deliveryPostcode: parsed.data.postalCode,
      weightKg: Math.max(0.1, defaults.weight_grams / 1000),
    });

    return {
      ok: true,
      deliverable: verdict.deliverable,
      estimatedDays: verdict.estimatedDays,
      // The shop's master switch counts here too, not just the courier's answer.
      codAvailable: settings.codEnabled && verdict.codAvailable,
      live: verdict.source === "shiprocket",
    };
  } catch (error) {
    // Never fatal to a product page. A courier lookup failing must not stop
    // somebody reading about a shoe.
    console.error(
      "[shipping] delivery check failed:",
      error instanceof Error ? error.message : "unknown",
    );
    return { ok: false, message: "We could not check that just now." };
  }
}
