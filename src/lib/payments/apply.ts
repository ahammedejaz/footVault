import "server-only";

import type { ApplyPaymentResult } from "@/lib/orders/types";
import { applyPaymentOutcome } from "@/lib/orders/payment-state";
import { claimPaymentEvent, releasePaymentEvent } from "@/lib/payments/events";
import { assertPaise, type PaymentMethod, type PaymentOutcome } from "@/lib/payments/types";

/**
 * Claim the event, then let the order code move the order. In that order.
 *
 * Both paths that can learn a payment's fate — the webhook and the browser's
 * verify call — go through this function, so the idempotency rule is written
 * once and cannot differ between them. The rule is:
 *
 *   1. Write the event to the ledger. If the row already exists, stop.
 *   2. Hand the outcome to `applyPaymentOutcome`, the only thing in the
 *      codebase allowed to move order state.
 *   3. If step 2 did not complete, give the claim back so a redelivery can
 *      try again.
 *
 * Step 3 is the one that is easy to leave out and impossible to notice missing.
 * Without it, a database blip while confirming an order marks the event handled
 * forever: Razorpay redelivers, the ledger says "already done", the route
 * answers 200, and a customer who paid has an order that stays pending with no
 * error in any log. See `releasePaymentEvent`.
 *
 * Nothing here reads or writes `orders`. It calls a seam and reports what came
 * back.
 */

export type PaymentApplication =
  /** The seam ran. `result` says whether it changed anything. */
  | { status: "applied"; result: ApplyPaymentResult }
  /** The ledger already had this event. Nothing ran, and nothing should. */
  | { status: "duplicate" }
  /**
   * Could not finish. `retryable` decides whether the caller should ask the
   * provider to send it again — a 500 to Razorpay means redelivery, and that is
   * the right answer to "our database was briefly unreachable" and the wrong
   * one to "this order is not ours".
   */
  | { status: "failed"; retryable: boolean; message: string };

export type RecordAndApplyInput = {
  eventId: string;
  provider: PaymentMethod;
  providerOrderId: string;
  eventType: string;
  outcome: PaymentOutcome;
};

export async function recordAndApply(input: RecordAndApplyInput): Promise<PaymentApplication> {
  const { eventId, provider, providerOrderId, eventType, outcome } = input;

  // The last boundary check before the number reaches the order code. It has
  // already been asserted where it was parsed; asserting again costs a
  // comparison and means no caller can construct an outcome that skips it.
  assertPaise("payments.apply.amount", outcome.amountPaise);

  let claim: Awaited<ReturnType<typeof claimPaymentEvent>>;
  try {
    // `event_type` is `not null` on `payment_events`, and it is the column that
    // makes a row readable by a human six weeks later — "which event was this"
    // is the first question anyone asks of the ledger.
    claim = await claimPaymentEvent(provider, eventId, eventType);
  } catch (error) {
    return {
      status: "failed",
      retryable: true,
      message: error instanceof Error ? error.message : "could not record the payment event",
    };
  }

  if (!claim.claimed) return { status: "duplicate" };

  let result: ApplyPaymentResult;
  try {
    result = await applyPaymentOutcome({ eventId, provider, providerOrderId, eventType, outcome });
  } catch (error) {
    await releasePaymentEvent(provider, eventId);
    return {
      status: "failed",
      retryable: true,
      message: error instanceof Error ? error.message : "applying the payment outcome failed",
    };
  }

  /**
   * An event for an order we do not have.
   *
   * Dev, preview and production share one Razorpay test account, so a webhook
   * for a preview order genuinely does arrive at production. Retrying that
   * forever is pointless, so the caller answers 200 — but the claim is released
   * anyway, so that a manual resend from the Razorpay dashboard can be
   * reprocessed once whoever is investigating has worked out why the order is
   * missing. A kept claim would make that resend a silent no-op.
   *
   * `applyPaymentOutcome` releases the row too when it resolves nothing, so in
   * practice this is usually a delete of a row that is already gone. Both are
   * idempotent and neither can be relied on to be the only one: this module
   * owns the pre-claim, and a pre-claim nobody clears is exactly the stuck-order
   * bug the release exists to prevent.
   */
  if (!result.applied && result.reason === "not_found") {
    await releasePaymentEvent(provider, eventId);
  }

  return { status: "applied", result };
}
