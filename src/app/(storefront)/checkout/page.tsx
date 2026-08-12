import type { Metadata } from "next";

import { CheckoutFlow } from "@/components/checkout/checkout-flow";
import { getCurrentUser } from "@/lib/auth";
import type { OrderTotals } from "@/lib/orders/types";
import { availablePaymentMethods } from "@/lib/payments";
import { listAddresses } from "@/lib/queries/addresses";
import { getCart } from "@/lib/queries/cart";

export const metadata: Metadata = {
  title: "Checkout",
  robots: { index: false, follow: false },
};

/**
 * Checkout.
 *
 * Open to guests, on purpose and for the last time it needs saying: an account
 * is what makes a bag survive a new phone, not what makes a purchase possible.
 * Everything a signed-in customer gets here — a preselected address, no email
 * to type — is a saving, never a gate.
 *
 * The totals below are a **preview**. They are computed from `getCart()`, which
 * re-reads every price from the catalog on every load, so they are honest at
 * the moment of render — but the server action recomputes all of it again from
 * the database when the order is written, and that is the number that gets
 * charged. Nothing typed in this browser reaches the arithmetic either way.
 *
 * Payment methods come from `availablePaymentMethods()` rather than from a list
 * in this file. Razorpay with no keys configured must not appear: a customer who
 * picks it and hits a 500 has been failed twice.
 *
 * **The empty bag is not handled here.** It looks like it belongs on this side —
 * a server component that knows the cart is empty rendering an empty state — but
 * `placeOrder` revalidates this route, and by the time it does the cart is
 * `converted`. Branching here therefore unmounts the checkout component mid-flow
 * and takes the open Razorpay modal's state with it. `CheckoutFlow` owns that
 * branch so it can stay mounted; see the comment above its render.
 */
export default async function CheckoutPage() {
  const [cart, user] = await Promise.all([getCart(), getCurrentUser()]);
  const addresses = user ? await listAddresses() : [];
  const methods = availablePaymentMethods();

  /**
   * The opening totals, before a destination is known.
   *
   * **Delivery is deliberately zero here, and the UI says so rather than
   * showing ₹0.** This page cannot price delivery: Shiprocket quotes it from the
   * customer's PIN code, and nothing on this render knows one yet. The old code
   * filled the gap with a flat fee from `site_settings`, which is how checkout
   * came to display one number and charge another — the drift the owner
   * reported. `CheckoutFlow` replaces every figure below the moment a real
   * quote lands, and holds the Place Order button until it does.
   *
   * Tax is zero on the line, not absent from the price. Every price in this
   * shop is tax-inclusive — see `docs/design-system.md` §8 — so a GST row would
   * double-count. The field stays in the shape because `OrderTotals` is the
   * same type the placed order uses and the two must be comparable.
   */
  const totals: OrderTotals = {
    subtotal: cart.subtotal,
    // Both zero before a destination is known, and both are replaced wholesale
    // by `CheckoutFlow` the moment a quote lands. The prepaid discount depends
    // on the payment method, which is chosen two steps after this render.
    discountTotal: 0,
    prepaidDiscount: 0,
    couponDiscount: 0,
    shippingFee: 0,
    forwardShippingFee: 0,
    codHandlingFee: 0,
    taxTotal: 0,
    grandTotal: cart.subtotal,
    // Prepaid is the shape of an unquoted order: everything settles online and
    // the courier collects nothing. A Pay-on-Delivery split needs a delivery
    // charge to compute an advance from, so it cannot exist before the quote.
    advanceAmount: cart.subtotal,
    balanceDueOnDelivery: 0,
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="font-display text-4xl font-extrabold tracking-[-0.03em] uppercase">
        Checkout
      </h1>

      <CheckoutFlow
        lines={cart.lines}
        totals={totals}
        itemCount={cart.count}
        methods={methods}
        addresses={addresses}
        signedIn={Boolean(user)}
        customerName={user?.name ?? null}
      />
    </div>
  );
}
