import "server-only";

import type { OrderTotals } from "@/lib/orders/types";
import {
  advanceFor,
  codOfferedForOrder,
  prepaidDiscountFor,
} from "@/lib/payments/advance";
import type { PaymentMethod } from "@/lib/payments/types";
import { quoteFor } from "@/lib/shipping/quote-store";
import { advanceRule, shippingSettings } from "@/lib/shipping/settings";

/**
 * The one place a total is computed. Everything else reads the answer.
 *
 * The brief asked for this by name, and the reason was a live bug: *"checkout
 * totals now differ between COD and pay-online... make total computation a
 * single shared server-side function that both methods call."* Three places
 * were computing delivery independently — the cart read a flat fee from
 * settings, the product page hardcoded the same two literals, and `placeOrder`
 * charged a live Shiprocket rate. Orders FV-2026-00487 and FV-2026-00488 carry
 * identical ₹1,499 subtotals and different delivery, ₹199 against ₹220, and the
 * checkout page displayed a third number again.
 *
 * The rule this file exists to enforce: **any difference between what two
 * payment methods cost must be a named line item, never an artefact of two code
 * paths that drifted.** There is exactly one such difference — `codHandlingFee`
 * — and it is returned separately so it can be rendered as its own row.
 *
 * **Nothing here trusts the browser.** The subtotal and unit count are resolved
 * from the caller's own cart under RLS by whoever calls this; the postcode is
 * the only customer-supplied input and it only selects a courier rate. A caller
 * who posted their own subtotal could otherwise quote themselves free delivery.
 */

export type CheckoutTotals = OrderTotals & {
  /** False means no courier will carry there — checkout must refuse. */
  deliverable: boolean;
  codAvailable: boolean;
  estimatedDays: number | null;
  courierName: string | null;
  /** `shiprocket` when priced from a live rate, `fallback` when Shiprocket was unreachable. */
  basis: "free" | "shiprocket" | "fallback";
  /** What was passed back for paying online. A named line; zero on Pay on Delivery. */
  prepaidDiscount: number;
  /** Why Pay on Delivery is not on offer, when it is not. Null when it is. */
  codWithheldReason: "below_minimum" | "settings" | "courier" | null;
  /** The two legs the advance is made of, and the courier both came from. */
  quotedForwardPaise: number | null;
  quotedRtoPaise: number | null;
  quotedCodFeePaise: number | null;
  courierId: number | null;
};

export async function computeOrderTotals(input: {
  cartId: string;
  postalCode: string;
  method: PaymentMethod;
  subtotalPaise: number;
  units: number;
  /** Coupons are Phase 8. The parameter exists so the arithmetic is already right. */
  discountPaise?: number;
  /** Set when this customer has had Pay on Delivery withdrawn. */
  codBlocked?: boolean;
}): Promise<CheckoutTotals> {
  const couponDiscount = input.discountPaise ?? 0;

  const [quote, settings] = await Promise.all([
    quoteFor({
      cartId: input.cartId,
      postalCode: input.postalCode,
      method: input.method,
      subtotalPaise: input.subtotalPaise,
      units: input.units,
    }),
    shippingSettings(),
  ]);

  /**
   * **Prepaid is visibly cheaper, as a line the customer can point at.**
   *
   * Prepaid orders are refused far less often than cash ones, and that is worth
   * money to the shop — so some of it goes back. It is folded into
   * `discountTotal` so `grandTotal` arithmetic is unchanged and every existing
   * read site still works, and returned separately so the payment step can draw
   * it beside the Pay-on-Delivery option, which is the only place a customer can
   * act on it. The owner sets the value; this file only knows it is a line.
   */
  const prepaidDiscount =
    input.method === "cod"
      ? 0
      : prepaidDiscountFor({
          discount: settings.prepaidDiscount,
          goodsTotalPaise: input.subtotalPaise,
        });

  const discountTotal = couponDiscount + prepaidDiscount;

  /**
   * `shippingFee` is the **total** charged for delivery, and `codHandlingFee`
   * says how much of that total is the Pay-on-Delivery extra — Shiprocket's
   * cash-collection fee, and nothing else since Phase 7 moved the return leg
   * into the advance.
   *
   * Modelled as "total, of which" rather than as two addends on purpose: it
   * keeps `grandTotal` arithmetic identical to what it has always been, and it
   * matches `orders.shipping_fee`, so no read site has to remember to add two
   * columns together.
   */
  const shippingFee = quote.feePaise;
  const codHandlingFee = quote.codHandlingPaise;
  const grandTotal = input.subtotalPaise - discountTotal + shippingFee;

  /**
   * **The advance is the round trip, and it is netted off the balance.**
   *
   * `advance = forward freight + RTO freight`, both from the same courier
   * entry; `balance = goods + delivery − advance`. The customer's total is
   * identical either way and a refused parcel is already paid for. See
   * `src/lib/payments/advance.ts` for the arithmetic and the worked example.
   *
   * Prepaid settles in full online, so its "advance" is the whole order and the
   * courier collects nothing. Expressing it this way rather than with a null
   * means every order answers the same two questions, and the invariant
   * `advance + balance = grand_total` holds for every row without a special
   * case. The database enforces exactly that.
   */
  const split =
    input.method === "cod"
      ? advanceFor({
          rule: advanceRule(settings),
          /*
            `?? 0` would produce an advance of nothing on a fallback quote,
            which is unsecured Pay on Delivery — the thing this model exists to
            remove. The fallback fee stands in instead, and the return leg
            mirrors the forward one, because a return whose cost is unknown is
            not a free return.
          */
          forwardFreightPaise:
            quote.costForwardPaise ?? settings.fallbackFeePaise.cod,
          rtoFreightPaise:
            quote.costRtoPaise ??
            quote.costForwardPaise ??
            settings.fallbackFeePaise.cod,
          grandTotalPaise: grandTotal,
        })
      : { advancePaise: grandTotal, balanceDuePaise: 0, cappedBy: null };

  /**
   * Three separate reasons Pay on Delivery may not be offered, kept apart
   * because they need different words on the payment step. "The shop has turned
   * it off", "your basket is under the minimum" and "no courier here collects
   * cash" are three different things to tell a customer, and only one of them
   * is something they can do anything about.
   */
  const belowMinimum = !codOfferedForOrder({
    goodsTotalPaise: input.subtotalPaise,
    minimumOrderValuePaise: settings.codMinimumOrderValuePaise,
  });
  const codWithheldReason: CheckoutTotals["codWithheldReason"] =
    !settings.codEnabled || input.codBlocked
      ? "settings"
      : belowMinimum
        ? "below_minimum"
        : !quote.codAvailable
          ? "courier"
          : null;

  return {
    subtotal: input.subtotalPaise,
    discountTotal,
    shippingFee,
    codHandlingFee,
    taxTotal: 0,
    grandTotal,
    advanceAmount: split.advancePaise,
    balanceDueOnDelivery: split.balanceDuePaise,
    deliverable: quote.deliverable,
    codAvailable: codWithheldReason === null,
    codWithheldReason,
    prepaidDiscount,
    estimatedDays: quote.estimatedDays,
    courierName: quote.courierName,
    courierId: quote.courierId,
    quotedForwardPaise: quote.costForwardPaise,
    quotedRtoPaise: quote.costRtoPaise,
    quotedCodFeePaise: quote.codHandlingPaise,
    basis: quote.basis,
  };
}
