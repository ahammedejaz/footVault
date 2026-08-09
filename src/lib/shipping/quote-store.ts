import "server-only";

import type { PaymentMethod } from "@/lib/payments/types";
import { maybeRow } from "@/lib/queries/run";
import { deliveryFee, type DeliveryFee } from "@/lib/shipping/fee";
import {
  parcelDefaultsStatus,
  parcelWeightKg,
  quoteDelivery,
} from "@/lib/shipping/quote";
import {
  FLAT_SERVICEABILITY,
  UNKNOWN_SERVICEABILITY,
  type ServiceabilityVerdict,
} from "@/lib/shipping/serviceability";
import { shippingSettings } from "@/lib/shipping/settings";
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
  /**
   * The bag's lines, each with its own parcel weight.
   *
   * **A product's own weight wins over the shop's default box.** Until Phase 7
   * this function multiplied one catalogue-wide weight by the number of pairs,
   * so a bag of boots and a bag of flip-flops quoted the same freight. Rate
   * bands are per half-kilogram on this account (`min_weight: 0.5`), so that is
   * not a rounding error: it under-recovers on every heavy order and over-quotes
   * every light one. Most products carry no override and use the common box,
   * which is the owner's decision and is correct for almost everything.
   *
   * Optional, because one caller genuinely does not have the lines — the
   * product page's "do you deliver to me?" check, which is asking about a
   * single pair before there is a bag. It falls back to the default, which is
   * what that question deserves.
   */
  lines?: { quantity: number; weightGrams: number | null }[];
}): Promise<StoredQuote> {
  const existing = await readQuote(input);
  if (existing) return { ...existing, fresh: false };

  // The thresholds are the shop's, not the courier's. Read before anything else
  // because the very first of them decides whether a courier is called at all.
  const settings = await shippingSettings();

  /**
   * **Flat mode makes no Shiprocket call.**
   *
   * The owner's requirement, and it is the whole point of the toggle: a fixed
   * festival price should not carry an API dependency, a timeout budget or a
   * courier outage. So the quote is built from a synthetic verdict rather than
   * from a call whose answer would then be discarded — which is what the old
   * flat mode did, paying the latency and the failure modes for nothing.
   *
   * The parcel defaults are not read here either. In flat mode there is no
   * parcel to describe — nobody is being asked to price one — so the shop can go
   * on selling at a fixed price while the box is still being measured.
   */
  const verdict =
    settings.shippingRateMode === "flat"
      ? FLAT_SERVICEABILITY
      : await quoteLive(input);

  const fee = deliveryFee({
    method: input.method,
    subtotalPaise: input.subtotalPaise,
    verdict,
    settings,
  });

  /**
   * **Which one served this quote, said out loud.**
   *
   * The brief: *"Log which one served each quote — a fallback must never be
   * presented silently as a live rate."* An estimate is a settings number the
   * owner typed when a courier could not be reached; it looks exactly like a
   * live rate on the page and in the database, and the only difference is this
   * line and the `source` column it is written to.
   *
   * `warn` only for `unavailable`, because a shop quietly running on estimates
   * all afternoon is a shop mispricing every order. A flat quote is logged at
   * info: it is the owner's choice, and warning about a deliberate setting is
   * how a real warning stops being read.
   */
  if (fee.basis === "unavailable") {
    console.warn("[shipping] quote served WITHOUT a live rate — estimate only", {
      postcode: input.postalCode,
      method: input.method,
      reason: verdict.reason ?? "unknown",
      feePaise: fee.feePaise,
    });
  } else if (fee.basis === "flat") {
    // Info, not warn. A flat quote is the owner's choice rather than a
    // degradation, and logging it as a problem is how a real problem stops
    // being noticed.
    console.info("[shipping] quote served at the flat rate; no courier called", {
      postcode: input.postalCode,
      method: input.method,
      feePaise: fee.feePaise,
    });
  } else {
    console.info("[shipping] quote served live", {
      postcode: input.postalCode,
      method: input.method,
      courier: fee.courierName,
      feePaise: fee.feePaise,
      forwardPaise: fee.costForwardPaise,
      rtoPaise: fee.costRtoPaise,
    });
  }

  await storeQuote(input, fee);
  return { ...fee, fresh: true };
}

/**
 * The live path: resolve the parcel, then ask Shiprocket.
 *
 * Split out so the flat branch above reads as one line and so the parcel read —
 * which throws when a dimension is unset — is reached only when a parcel is
 * actually needed. `quoteDelivery` turns that throw into an unknown verdict, so
 * an unset box height degrades to "no live rate" rather than to an exception on
 * the checkout path.
 */
async function quoteLive(input: {
  postalCode: string;
  subtotalPaise: number;
  units: number;
  lines?: { quantity: number; weightGrams: number | null }[];
}): Promise<ServiceabilityVerdict> {
  const status = await parcelDefaultsStatus();
  if (!status.ok) {
    /**
     * An unset parcel dimension is not an exception on the checkout path.
     *
     * It resolves to the same "we do not know" every courier failure resolves
     * to, which under decision 4 sells prepaid at an estimate and withdraws Pay
     * on Delivery. The reason names the field so the log line, the admin banner
     * and `npm run audit:parcel` all say the same sentence.
     */
    const reason = `parcel defaults incomplete: ${status.missing.join(", ")}`;
    console.error("[shipping] cannot quote — %s", reason);
    return { ...UNKNOWN_SERVICEABILITY, reason };
  }

  return quoteDelivery({
    deliveryPostcode: input.postalCode,
    weightKg: input.lines?.length
      ? parcelWeightKg(input.lines, status.defaults)
      : Math.max(0.1, (status.defaults.weight_grams * input.units) / 1000),
    valuePaise: input.subtotalPaise,
  });
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
  lines?: { quantity: number; weightGrams: number | null }[];
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
    shipping_fee_paise: number;
    cod_handling_paise: number;
    deliverable: boolean;
    cod_available: boolean;
    estimated_days: number | null;
    courier_name: string | null;
    cost_forward_paise: number | null;
    cost_rto_paise: number | null;
    courier_id: number | null;
    subtotal_paise: number;
    source: string;
    rate_mode: string;
    quoted_at: string;
  }>(
    "shipping.readQuote",
    createAdminClient()
      .from("shipping_quotes")
      .select(
        `fee_paise, shipping_fee_paise, cod_handling_paise, deliverable,
         cod_available, estimated_days, courier_name,
         cost_forward_paise, cost_rto_paise, courier_id, subtotal_paise, source,
         rate_mode, quoted_at`,
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
    shippingFeePaise: row.shipping_fee_paise,
    codHandlingPaise: row.cod_handling_paise,
    deliverable: row.deliverable,
    codAvailable: row.cod_available,
    estimatedDays: row.estimated_days,
    courierName: row.courier_name,
    costForwardPaise: row.cost_forward_paise,
    costRtoPaise: row.cost_rto_paise,
    courierId: row.courier_id,
    basis: BASES.includes(row.source as DeliveryFee["basis"])
      ? (row.source as DeliveryFee["basis"])
      : "unavailable",
    /**
     * **The frozen mode is read back, never recomputed from current settings.**
     *
     * This is the half of the owner's requirement that does the work: *"Switching
     * modes must never change a price a customer has already been shown."* A
     * customer quoted at the live rate who is still on the payment step when the
     * owner flips to a festival price keeps the row they were shown — price and
     * mode both — because `placeOrder` charges this row rather than re-quoting.
     * Reading `settings.shippingRateMode` here instead would silently relabel
     * their order as flat-priced when it was not.
     */
    rateMode: row.rate_mode === "flat" ? "flat" : "live",
  };
}

/**
 * The four values `source` may hold. An unrecognised one degrades to
 * `unavailable` rather than to `live`: a row written by an older deploy must
 * never be read back as a live courier rate it never was.
 */
const BASES: readonly DeliveryFee["basis"][] = [
  "free",
  "live",
  "flat",
  "unavailable",
];

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
      shipping_fee_paise: fee.shippingFeePaise,
      cod_handling_paise: fee.codHandlingPaise,
      deliverable: fee.deliverable,
      cod_available: fee.codAvailable,
      estimated_days: fee.estimatedDays,
      courier_name: fee.courierName,
      cost_forward_paise: fee.costForwardPaise,
      cost_rto_paise: fee.costRtoPaise,
      courier_id: fee.courierId,
      freight_paise: fee.costForwardPaise,
      cod_fee_paise: fee.codHandlingPaise,
      source: fee.basis,
      rate_mode: fee.rateMode,
    },
    { onConflict: "cart_id,postal_code,payment_method" },
  );

  // A quote we could not store still priced this request correctly; the cost is
  // that `placeOrder` will re-quote rather than reuse. Logged, never thrown —
  // failing a checkout because a cache write failed would be absurd.
  if (error)
    console.error("[shipping] could not store the quote:", error.message);
}
