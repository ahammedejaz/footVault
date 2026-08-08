"use server";

import { getPaymentAdapter } from "@/lib/payments";
import { recordAndApply } from "@/lib/payments/apply";
import type { PaymentOutcomeStatus } from "@/lib/payments/types";
import { razorpayCallbackSchema } from "@/lib/validations/checkout";

/**
 * What the browser does after Razorpay's modal closes with a success.
 *
 * This exists so the confirmation page can say something true *immediately*.
 * The webhook is what decides payment state, and it usually lands within a
 * second or two — but "usually" is not a thing to build a confirmation page on,
 * and a customer staring at a spinner after a successful payment will refresh,
 * go back, or pay again. So the callback is checked here, on the server, and
 * the answer is applied through exactly the same seam the webhook uses.
 *
 * **The three strings are a claim, not a fact.** They arrive from a browser and
 * anyone can POST them. Two things make them worth reading: the HMAC, which
 * only a holder of our key secret could have produced, and the read-back from
 * Razorpay's Payments API, which is what actually says whether the money moved
 * — a valid signature accompanies an authorised-but-uncaptured payment just as
 * happily as a captured one.
 *
 * The order in which this happens matters and is not an accident: parse, then
 * verify the signature, then call Razorpay, then touch the database. An
 * unsigned POST costs one HMAC and stops, which is what keeps this action from
 * being a way to make us hammer Razorpay's API for free.
 */

const RAZORPAY = "razorpay" as const;

export type VerifyPaymentResult =
  | {
      /**
       * We checked, and the answer is trustworthy. **Not a synonym for "paid"**
       * — read `payment` for that. A verified callback describing a failed
       * payment is still `ok: true`, because the failure is a fact we are sure
       * of rather than a problem with the check.
       */
      ok: true;
      /**
       * What we believe about the money. `pending` is a real answer, not a
       * failure — an authorised payment that has not settled is neither paid
       * nor lost, and the page must say so rather than pick a side.
       */
      payment: PaymentOutcomeStatus;
      message: string;
    }
  | {
      ok: false;
      reason: "invalid_input" | "bad_signature" | "unknown_order" | "provider_error" | "error";
      /**
       * Safe to render, and written so that a customer always knows whether
       * they were charged. "Something went wrong" after a payment screen is
       * how a person pays twice.
       */
      message: string;
    };

export async function verifyRazorpayPayment(input: unknown): Promise<VerifyPaymentResult> {
  const parsed = razorpayCallbackSchema.safeParse(input);
  if (!parsed.success) {
    // Not logged with the input. A malformed callback is either a bug in our
    // own page or someone poking at the action, and neither is worth keeping
    // an attacker-supplied string in the log for.
    console.warn("[payment] verify rejected: malformed callback");
    return {
      ok: false,
      reason: "invalid_input",
      message: "We could not read that payment confirmation. Your order page has the latest status.",
    };
  }

  const claim = {
    providerOrderId: parsed.data.razorpay_order_id,
    providerPaymentId: parsed.data.razorpay_payment_id,
    signature: parsed.data.razorpay_signature,
  };

  try {
    const verification = await getPaymentAdapter(RAZORPAY).verifyClientCallback(claim);

    if (!verification.ok) {
      return { ok: false, reason: verification.reason, message: verification.message };
    }

    const { outcome } = verification;

    /**
     * A different event id from the webhook's, on purpose.
     *
     * The webhook records `payment.captured:pay_XYZ`; this records
     * `callback:pay_XYZ`. If both used one key, whichever arrived second would
     * be swallowed as a duplicate — and the one that must never be swallowed is
     * the webhook, which is the authoritative source. Distinct keys mean both
     * are processed on their own merits.
     *
     * That is safe because applying twice is not the same as applying two
     * different things. Stock is decremented when the order is *created*, not
     * when it is paid, so a payment event never moves inventory; and the second
     * "captured" to reach an already-confirmed order is not a legal transition,
     * so the state machine declines it. That is the whole answer to "webhook
     * arrived before the callback".
     */
    const application = await recordAndApply({
      eventId: `callback:${claim.providerPaymentId}`,
      provider: RAZORPAY,
      providerOrderId: claim.providerOrderId,
      eventType: "client.callback",
      outcome,
    });

    if (application.status === "failed") {
      console.error("[payment] verify could not apply the outcome", {
        providerOrderId: claim.providerOrderId,
        detail: application.message,
      });
      // The signature and Razorpay both said this payment is real, so the
      // customer must not be told it failed. The webhook will confirm the order
      // independently; all that is lost here is the immediate confirmation.
      return {
        ok: true,
        payment: outcome.status,
        message: messageFor(outcome.status, outcome.message),
      };
    }

    /**
     * A verified payment for an order this deployment does not have.
     *
     * Close to impossible — the signature was made with our key secret and the
     * callback is posted to the origin the customer is on — but "close to
     * impossible" is not "cannot", and the one thing we must not do is print
     * "your order is confirmed" when there is no order. Loud in the log,
     * honest on the screen.
     */
    if (
      application.status === "applied" &&
      !application.result.applied &&
      application.result.reason === "not_found"
    ) {
      console.error("[payment] verified a payment for an order we do not have", {
        providerOrderId: claim.providerOrderId,
      });
      return {
        ok: false,
        reason: "unknown_order",
        message:
          "Your payment went through but we could not match it to an order. " +
          "Please contact us with your payment reference and we will sort it out.",
      };
    }

    // `duplicate` means the webhook, or a double-submit of this action, got
    // here first. The payment is still whatever Razorpay just told us it is,
    // and that is what the page should show.
    return {
      ok: true,
      payment: outcome.status,
      message: messageFor(outcome.status, outcome.message),
    };
  } catch (error) {
    console.error("[payment] verify threw", {
      providerOrderId: claim.providerOrderId,
      detail: error instanceof Error ? error.message : "unknown",
    });
    return {
      ok: false,
      reason: "error",
      // Deliberately does not claim they were not charged — we do not know.
      message:
        "We could not confirm your payment just now. Your order page will update on its own; " +
        "do not pay again.",
    };
  }
}

/**
 * Not exported: a `"use server"` module may only export async functions, and a
 * plain helper crossing that boundary type-checks, builds, and then throws the
 * first time the action runs — which is in production, on a button press.
 * Phase 4 shipped exactly that bug, and CI now greps for it.
 */
function messageFor(status: PaymentOutcomeStatus, providerMessage: string | null): string {
  switch (status) {
    case "captured":
      return "Payment received. Your order is confirmed.";
    case "pending":
      return "Your bank is still confirming this payment. We will update your order the moment it clears.";
    case "failed":
      return providerMessage ?? "The payment did not go through and you have not been charged.";
  }
}
