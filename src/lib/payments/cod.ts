import type {
  PaymentAdapter,
  PaymentInitiation,
  VerificationResult,
  WebhookParseResult,
} from "@/lib/payments/types";

/**
 * Cash on delivery.
 *
 * An adapter with almost nothing in it, which is the point: checkout asks every
 * payment method the same questions, and COD answering "nothing to do" is what
 * lets the order code stay ignorant of which method it is holding. Special-
 * casing COD with an `if` in the checkout action would put provider knowledge
 * back in the place this interface exists to keep it out of.
 *
 * No `server-only` here, deliberately — there is no secret to protect and
 * nothing to reach. It stays importable from anywhere so that a future
 * "available methods" render path is not forced through the server boundary by
 * this file. (`index.ts` is server-only regardless, because Razorpay is.)
 */

/**
 * The honest words, including the caveat.
 *
 * `note` says what a customer actually needs to know before choosing: the money
 * is due at the door, in cash, to a courier. Discovering that on the doorstep is
 * how a delivery gets refused.
 */
export const codAdapter: PaymentAdapter = {
  method: "cod",

  copy: {
    method: "cod",
    label: "Cash on delivery",
    description: "Pay the courier when your order arrives. Nothing is charged now.",
    note: "Please have the exact amount ready. Our couriers cannot always give change.",
  },

  /**
   * Always. COD needs no keys and no provider.
   *
   * If the shop ever needs to switch COD off — a PIN code it does not serve, a
   * cart above a value threshold — that is a business rule keyed on the order,
   * not a property of the method, and `isAvailable()` is synchronous and knows
   * nothing about the cart. It would belong in the checkout action beside the
   * shipping calculation, reading `site_settings`.
   */
  isAvailable(): boolean {
    return true;
  },

  /**
   * There is no provider to initiate with. The order is placed, and that is the
   * whole transaction as far as payment is concerned; money arrives at the door
   * and an admin marks it paid. `kind: "none"` is what stops the checkout page
   * from opening an empty modal.
   */
  async initiate(): Promise<PaymentInitiation> {
    return { kind: "none", method: "cod" };
  },

  /**
   * Fail closed rather than pretend.
   *
   * A COD order has no signature to check, so the only two possible
   * implementations are "reject" and "return ok without checking anything". The
   * second is a free order: post the verify action with `paymentMethod: "cod"`
   * and any three strings, and an unpaid order marks itself paid. Returning
   * `provider_error` means a caller that reaches here has a routing bug, and it
   * will find out.
   */
  async verifyClientCallback(): Promise<VerificationResult> {
    console.error("[cod] verifyClientCallback was called. COD has no payment to verify.");
    return {
      ok: false,
      reason: "provider_error",
      message: "Cash on delivery has no online payment to verify.",
    };
  },

  /** Same reasoning. Nothing sends us COD webhooks, so anything claiming to be one is not. */
  parseWebhook(): WebhookParseResult {
    console.error("[cod] parseWebhook was called. COD has no webhooks.");
    return {
      ok: false,
      reason: "unhandled",
      message: "Cash on delivery has no webhooks.",
    };
  },
};
