import "server-only";

import type { PaymentMethod } from "@/lib/payments/types";
import { maybeRow } from "@/lib/queries/run";
import { deliveryFee, type DeliveryFee } from "@/lib/shipping/fee";
import { quoteDelivery, shippingDefaults } from "@/lib/shipping/quote";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The delivery fee, quoted once and read twice.
 *
 * This exists to close one specific gap. The checkout page has to *show* a fee
 * before the customer presses pay, and `placeOrder` has to *charge* one. If
 * those are two independent Shiprocket lookups, they can disagree — courier
 * rates move during the day — and the customer is billed a number they were
 * never shown. For a Razorpay order that is money taken without consent.
 *
 * So the first lookup writes a row, and `placeOrder` reads that row. The
 * customer is charged exactly what they saw, or the quote has genuinely gone
 * stale and they are re-quoted before anything is placed.
 *
 * **The browser still sends no number.** It sends a postcode and a payment
 * method; every rupee is computed here and read back here. `PlaceOrderInput`
 * remains a type with no money in it, which is the property that makes checkout
 * safe to reason about.
 *
 * A quote is keyed by (cart, postcode, method) and invalidated by the bag's
 * subtotal changing, because both the free-delivery threshold and Shiprocket's
 * cash-collection percentage move with it.
 */

/**
 * Fifteen minutes. Long enough to type an address and think about it, short
 * enough that a rate change cannot be exploited by leaving a tab open — and the
 * fee is recomputed rather than refused when it lapses, so the ceiling is never
 * a dead end.
 */
const QUOTE_TTL_MS = 15 * 60 * 1000;

export type StoredQuote = DeliveryFee & { fresh: boolean };

/** Read a live quote, or take a new one and store it. */
export async function quoteFor(input: {
  cartId: string;
  postalCode: string;
  method: PaymentMethod;
  subtotalPaise: number;
  units: number;
}): Promise<StoredQuote> {
  const existing = await readQuote(input);
  if (existing) return { ...existing, fresh: false };

  const defaults = await shippingDefaults();
  const verdict = await quoteDelivery({
    deliveryPostcode: input.postalCode,
    // The default parcel weight times the number of pairs. Serviceability and
    // rate bands barely move within a kilogram, and the alternative is a second
    // query on the checkout path to refine a number that will not change.
    weightKg: Math.max(0.1, (defaults.weight_grams * input.units) / 1000),
    valuePaise: input.subtotalPaise,
  });

  const fee = deliveryFee({
    method: input.method,
    subtotalPaise: input.subtotalPaise,
    verdict,
  });

  await storeQuote(input, fee);
  return { ...fee, fresh: true };
}

/**
 * The fee `placeOrder` charges.
 *
 * Deliberately the same function the page called. If the stored quote is still
 * live it is reused, and display and charge are identical by construction; if
 * it has lapsed, a fresh one is taken — which is the honest thing, because a
 * fifteen-minute-old price is not a promise anybody made.
 */
export async function chargeableFee(input: {
  cartId: string;
  postalCode: string;
  method: PaymentMethod;
  subtotalPaise: number;
  units: number;
}): Promise<StoredQuote> {
  return quoteFor(input);
}

async function readQuote(input: {
  cartId: string;
  postalCode: string;
  method: PaymentMethod;
  subtotalPaise: number;
}): Promise<DeliveryFee | null> {
  const row = await maybeRow<{
    fee_paise: number;
    deliverable: boolean;
    cod_available: boolean;
    estimated_days: number | null;
    courier_name: string | null;
    cost_forward_paise: number | null;
    cost_rto_paise: number | null;
    subtotal_paise: number;
    source: string;
    quoted_at: string;
  }>(
    "shipping.readQuote",
    createAdminClient()
      .from("shipping_quotes")
      .select(
        `fee_paise, deliverable, cod_available, estimated_days, courier_name,
         cost_forward_paise, cost_rto_paise, subtotal_paise, source, quoted_at`,
      )
      .eq("cart_id", input.cartId)
      .eq("postal_code", input.postalCode)
      .eq("payment_method", input.method)
      .maybeSingle(),
  );

  if (!row) return null;
  // A changed bag is a changed quote — the threshold and the COD percentage
  // both depend on the subtotal.
  if (row.subtotal_paise !== input.subtotalPaise) return null;
  if (Date.now() - new Date(row.quoted_at).getTime() > QUOTE_TTL_MS)
    return null;

  return {
    feePaise: row.fee_paise,
    deliverable: row.deliverable,
    codAvailable: row.cod_available,
    estimatedDays: row.estimated_days,
    courierName: row.courier_name,
    costForwardPaise: row.cost_forward_paise,
    costRtoPaise: row.cost_rto_paise,
    basis:
      row.source === "free" || row.source === "fallback"
        ? row.source
        : "shiprocket",
  };
}

async function storeQuote(
  input: {
    cartId: string;
    postalCode: string;
    method: PaymentMethod;
    subtotalPaise: number;
  },
  fee: DeliveryFee,
): Promise<void> {
  const { error } = await createAdminClient().from("shipping_quotes").upsert(
    {
      cart_id: input.cartId,
      postal_code: input.postalCode,
      payment_method: input.method,
      subtotal_paise: input.subtotalPaise,
      fee_paise: fee.feePaise,
      deliverable: fee.deliverable,
      cod_available: fee.codAvailable,
      estimated_days: fee.estimatedDays,
      courier_name: fee.courierName,
      cost_forward_paise: fee.costForwardPaise,
      cost_rto_paise: fee.costRtoPaise,
      source: fee.basis,
    },
    { onConflict: "cart_id,postal_code,payment_method" },
  );

  // A quote we could not store still priced this request correctly; the cost is
  // that `placeOrder` will re-quote rather than reuse. Logged, never thrown —
  // failing a checkout because a cache write failed would be absurd.
  if (error)
    console.error("[shipping] could not store the quote:", error.message);
}
