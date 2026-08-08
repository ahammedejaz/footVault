import "server-only";

import type { OrderTotals } from "@/lib/orders/types";
import { advanceFor } from "@/lib/payments/advance";
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
};

export async function computeOrderTotals(input: {
  cartId: string;
  postalCode: string;
  method: PaymentMethod;
  subtotalPaise: number;
  units: number;
  /** Coupons are Phase 8. The parameter exists so the arithmetic is already right. */
  discountPaise?: number;
}): Promise<CheckoutTotals> {
  const discountTotal = input.discountPaise ?? 0;

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
   * `shippingFee` is the **total** charged for delivery, and `codHandlingFee`
   * says how much of that total is the Pay-on-Delivery extra.
   *
   * Modelled as "total, of which" rather than as two addends on purpose: it
   * keeps `grandTotal` arithmetic identical to what it has always been, and it
   * matches `orders.shipping_fee`, so no read site has to remember to add two
   * columns together. The forward leg is derived once, in the `Totals`
   * component, which is the only place that needs to draw them apart.
   */
  const shippingFee = quote.feePaise;
  const codHandlingFee = quote.codHandlingPaise;
  const grandTotal = input.subtotalPaise - discountTotal + shippingFee;

  /**
   * Prepaid settles in full online, so its "advance" is the whole order and the
   * courier collects nothing. Expressing it this way rather than with a null
   * means every order in the system answers the same two questions — how much
   * was paid online, how much is owed at the door — and the invariant
   * `advance + balance = grand_total` holds for every row without a special
   * case. The database enforces exactly that.
   */
  const split =
    input.method === "cod"
      ? advanceFor({
          rule: advanceRule(settings),
          deliveryTotalPaise: shippingFee,
          grandTotalPaise: grandTotal,
        })
      : { advancePaise: grandTotal, balanceDuePaise: 0 };

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
    // A method the shop has switched off is not available whatever the courier
    // says. The PIN-code check is the second gate, not the only one.
    codAvailable: settings.codEnabled && quote.codAvailable,
    estimatedDays: quote.estimatedDays,
    courierName: quote.courierName,
    basis: quote.basis,
  };
}
