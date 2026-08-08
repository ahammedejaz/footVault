import "server-only";

import type { ReconciledPayment } from "@/lib/payments/razorpay";

/**
 * What to do about one abandoned-looking order, given what Razorpay says.
 *
 * Pulled out of the route as a pure function for one reason: this is the
 * decision that can cancel an order somebody has paid for, and a decision that
 * important should be assertable without a database, a network, or a live
 * Razorpay account behind it. Inside the route handler it was reachable only by
 * running the whole tick.
 *
 * The asymmetry that shapes every branch below: **cancelling wrongly is
 * unrecoverable and cancelling late is free.** An order left alone is looked at
 * again in ten minutes and costs the shop nothing but stock held slightly
 * longer. An order cancelled wrongly has charged a customer and restocked goods
 * they own. So every uncertain case resolves to `leave`, and `cancel` is
 * reachable only from a positive statement by Razorpay that nothing was ever
 * authorised.
 */
export type ReconcileAction =
  /** Razorpay says money was taken. Apply it, exactly as the webhook would. */
  | { action: "rescue"; payments: ReconciledPayment[] }
  /** Razorpay says nothing was ever authorised. Safe to cancel and restock. */
  | { action: "cancel" }
  /** Anything else. Change nothing, look again next tick. */
  | { action: "leave"; why: string };

/** Statuses that mean the customer's money moved. */
const MONEY_MOVED = new Set(["captured", "authorized"]);

export function decideForOrder(input: {
  /** Null when Razorpay could not be asked, or answered something unreadable. */
  payments: ReconciledPayment[] | null;
  /** Whether the order carries an id Razorpay would recognise. */
  providerOrderId: string | null;
}): ReconcileAction {
  if (!input.providerOrderId) {
    // A payments row with no provider order id cannot be asked about. It should
    // not exist, and inventing an answer for it is exactly the reflex that
    // caused the original bug.
    return { action: "leave", why: "no provider order id on the payment row" };
  }

  if (input.payments === null) {
    // THE branch. Razorpay was unreachable, timed out, rate-limited us, or sent
    // a shape we do not parse. "We could not ask" is not "the answer was no".
    return { action: "leave", why: "razorpay did not answer" };
  }

  const moved = input.payments.filter((payment) =>
    MONEY_MOVED.has(payment.rawStatus),
  );
  if (moved.length > 0) return { action: "rescue", payments: moved };

  if (input.payments.some((payment) => payment.rawStatus === "refunded")) {
    // Money arrived and left again with nothing recorded either way. Restocking
    // against a payment history we do not understand is not a call code should
    // make.
    return { action: "leave", why: "a refunded payment needs a human" };
  }

  // Razorpay answered, and every attempt on this order was `created` or
  // `failed` — begun and never completed. No money exists. This is the only
  // path to a cancellation, and it is reachable only from a positive answer.
  return { action: "cancel" };
}
