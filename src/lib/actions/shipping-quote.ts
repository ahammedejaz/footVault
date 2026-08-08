"use server";

import { z } from "zod";

import { getCart } from "@/lib/queries/cart";
import { callerIdentity, consumeRateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/auth";
import { codBlockedForCaller } from "@/lib/orders/cod-block";
import { computeOrderTotals } from "@/lib/orders/totals";

/**
 * What the checkout page asks when a customer finishes typing their pin code.
 *
 * The answer is written to `shipping_quotes`, and `placeOrder` charges from that
 * same row — so this is not a preview that a second calculation might contradict.
 * It is the price.
 *
 * **The bag is resolved from the caller's own session, never from the payload.**
 * The browser sends a postcode and a payment method and nothing else; the
 * subtotal and the unit count come from `getCart()` under RLS. A caller who
 * posted their own subtotal could otherwise quote themselves free delivery by
 * claiming to be over the threshold — and the quote is exactly what gets
 * charged, so that would be a live price-manipulation hole rather than a
 * cosmetic one.
 *
 * Rate-limited under `serviceability`, because every miss is a call to
 * Shiprocket on the shop's quota and this endpoint is reachable by anyone with a
 * bag.
 */

const schema = z.object({
  // Six digits, checked before a round trip is spent on it.
  postalCode: z.string().regex(/^\d{6}$/, "Enter a six-digit pin code."),
  paymentMethod: z.enum(["cod", "razorpay"]),
});

/**
 * The whole money picture for this bag, this destination and this method.
 *
 * It returns the totals rather than just a fee because the checkout page has to
 * show three numbers a Pay-on-Delivery customer must not be able to
 * misunderstand — pay now, pay on delivery, order total — and computing any of
 * them in the browser would be a fourth place that money is calculated. The
 * server sends the answer; the client renders it.
 */
export type ShippingQuoteResult =
  | {
      ok: true;
      /** The total charged for delivery, including any COD handling. */
      feePaise: number;
      /** The Pay-on-Delivery extra, as its own named line. 0 for prepaid. */
      codHandlingPaise: number;
      /** Charged online now. For prepaid this is the whole order. */
      advancePaise: number;
      /** Collected in cash by the courier. */
      balanceDuePaise: number;
      grandTotalPaise: number;
      /** False means no courier will carry there — checkout must refuse. */
      deliverable: boolean;
      codAvailable: boolean;
      estimatedDays: number | null;
      /** True when priced from a live courier rate rather than the fallback. */
      live: boolean;
    }
  | { ok: false; message: string };

export async function quoteShipping(
  input: unknown,
): Promise<ShippingQuoteResult> {
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

  const cart = await getCart();
  if (!cart.id || cart.lines.length === 0) {
    return { ok: false, message: "Your bag is empty." };
  }

  try {
    const totals = await computeOrderTotals({
      // Withdrawn from this customer by the owner, for refusing parcels. Read
      // here rather than assumed false: the parameter existed and nothing
      // passed it, so the control was a column.
      codBlocked: await codBlockedForCaller(),
      cartId: cart.id,
      postalCode: parsed.data.postalCode,
      method: parsed.data.paymentMethod,
      subtotalPaise: cart.subtotal,
      units: cart.lines.reduce((total, line) => total + line.quantity, 0),
    });

    return {
      ok: true,
      feePaise: totals.shippingFee,
      codHandlingPaise: totals.codHandlingFee,
      advancePaise: totals.advanceAmount,
      balanceDuePaise: totals.balanceDueOnDelivery,
      grandTotalPaise: totals.grandTotal,
      deliverable: totals.deliverable,
      codAvailable: totals.codAvailable,
      estimatedDays: totals.estimatedDays,
      live: totals.basis === "shiprocket",
    };
  } catch (error) {
    // Never fatal to the page. The customer keeps the estimate already on
    // screen and `placeOrder` will price it properly; a failed quote must not
    // be a dead checkout.
    console.error(
      "[shipping] quote action failed:",
      error instanceof Error ? error.message : "unknown",
    );
    return { ok: false, message: "We could not check delivery just now." };
  }
}
