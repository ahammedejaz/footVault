/**
 * The payment seam.
 *
 * Two methods ship in Phase 5 — Cash on Delivery and Razorpay — and the order
 * code must not be able to tell which one it is holding. That is the whole
 * point of this file: `src/lib/orders/` imports the types below and nothing
 * else, so adding Stripe later is a new adapter rather than an edit to
 * checkout. **No provider type may leak past this module.** A `RazorpayOrder`
 * appearing in an order signature is the failure this interface exists to
 * prevent.
 *
 * No server dependency here, deliberately. The checkout UI needs `PAYMENT_METHODS`
 * to render the choice and `PaymentInitiation` to drive the modal, and a Client
 * Component that imports a type from a `server-only` module compiles fine today
 * and pulls the Supabase server client into the browser bundle one edit later.
 * CI greps for that import (`.github/workflows/ci.yml`); the types live
 * somewhere with nothing to grep for.
 *
 * **Money is integer paise, everywhere, with no exceptions.** Razorpay's Orders
 * API takes paise too, so there is no conversion anywhere in this path and no
 * float to round. `assertPaise` below is the boundary check.
 */

/* --------------------------------------------------------------- methods -- */

export const PAYMENT_METHODS = ["cod", "razorpay"] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return (
    typeof value === "string" &&
    (PAYMENT_METHODS as readonly string[]).includes(value)
  );
}

/**
 * How each method is described to a customer.
 *
 * In plain language and in this file rather than in the checkout page, because
 * the words are part of the method: whoever adds an adapter has to say what it
 * means for the person paying. `note` is the honest caveat, not marketing.
 */
export type PaymentMethodCopy = {
  method: PaymentMethod;
  label: string;
  /** One line under the radio. What actually happens if they pick this. */
  description: string;
  /** The caveat, if there is one. Rendered smaller, never hidden. */
  note: string | null;
};

/* -------------------------------------------------------------- the money -- */

/**
 * Integer paise. ₹1,999 is 199900.
 *
 * Not a branded type: the codebase already stores paise as `number` everywhere
 * and a brand would need a cast at every database read, which is friction that
 * buys nothing a check at the boundary does not. This is that check. Call it
 * anywhere an amount crosses into or out of a provider.
 */
export function assertPaise(label: string, amount: number): number {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(
      `${label}: ${amount} is not an integer number of paise. ` +
        "Money never becomes a float in this codebase — find where the division happened.",
    );
  }
  return amount;
}

/** Razorpay rejects anything under one rupee, and so should we, earlier. */
export const MIN_CHARGEABLE_PAISE = 100;

/* ---------------------------------------------------------- initiation -- */

/**
 * What the browser is given after an order exists and before it is paid.
 *
 * A discriminated union rather than an optional bag of provider fields: COD has
 * genuinely nothing for the client to do, and modelling that as "all the
 * Razorpay fields are null" invites a page that opens an empty modal.
 *
 * Note what is *not* here. No key secret, no webhook secret, no signature. The
 * `keyId` is the publishable half of the Razorpay key pair and is designed to
 * be in a browser; everything else stays on the server.
 */
export type PaymentInitiation =
  | {
      kind: "none";
      /** Already final. COD orders are placed, not paid. */
      method: "cod";
    }
  | {
      kind: "razorpay";
      method: "razorpay";
      /** Publishable. Safe in the browser, and the only key that goes there. */
      keyId: string;
      /** The provider's order id — `order_...`. Never our order number. */
      providerOrderId: string;
      /** Recomputed from the cart on the server. The browser never sends this. */
      amountPaise: number;
      currency: "INR";
      /** Prefill for the modal, so the customer does not retype what we hold. */
      prefill: { name: string; email: string | null; contact: string | null };
    };

/* -------------------------------------------------------------- outcomes -- */

/**
 * What a provider says happened.
 *
 * `captured` is the only state that means money moved. `pending` covers the
 * genuine middle — a Razorpay `authorized` that has not settled — and must not
 * be collapsed into either end, because a customer told "payment failed" who
 * was in fact charged is the worst outcome this system can produce.
 */
export type PaymentOutcomeStatus = "captured" | "pending" | "failed";

export type PaymentOutcome = {
  status: PaymentOutcomeStatus;
  /** The provider's payment id — `pay_...`. Null for COD, which has none. */
  providerPaymentId: string | null;
  providerOrderId: string | null;
  amountPaise: number;
  /** The provider's own status string, stored verbatim for support questions. */
  rawStatus: string | null;
  /** Safe to show a customer. Never a provider error dump. */
  message: string | null;
};

/* --------------------------------------------------------------- verify -- */

/**
 * The browser's success callback, forwarded for checking.
 *
 * **This is a claim, not a fact.** Anyone can POST these three strings. The
 * signature is what makes them worth reading, and even a valid signature only
 * proves the browser saw a real Razorpay response — the webhook is what decides
 * payment state. Verifying this exists so the confirmation page can say
 * something true immediately instead of spinning until a webhook lands.
 */
export type ClientCallbackClaim = {
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
};

export type VerificationResult =
  | { ok: true; outcome: PaymentOutcome }
  | {
      ok: false;
      reason: "bad_signature" | "unknown_order" | "provider_error";
      message: string;
    };

/* -------------------------------------------------------------- webhooks -- */

/**
 * A webhook, once it has been proved to have come from the provider.
 *
 * `eventId` is the idempotency key and is not optional. Razorpay retries, so
 * the same event *will* arrive more than once; a handler that trusts arrival
 * order or arrival count decrements stock twice. Whoever stores this row stores
 * `eventId` first and short-circuits on a duplicate.
 */
export type VerifiedWebhookEvent = {
  eventId: string;
  eventType: string;
  /** Which of our orders this concerns, resolved from the provider's order id. */
  providerOrderId: string | null;
  outcome: PaymentOutcome | null;
};

/**
 * A refund webhook, once it has been proved to have come from the provider.
 *
 * A separate shape rather than a `PaymentOutcome` because it *is* separate:
 * a payment outcome moves an order's payment state, a refund event settles a
 * `refunds` row, and forcing the second through the first's type is how a
 * refund ends up un-confirming an order. `eventId` is derived the same way —
 * `refund.processed:rfnd_x` — so retries and manual resends dedupe in
 * `payment_events` exactly like payment events do.
 */
export type VerifiedRefundEvent = {
  eventId: string;
  eventType: "refund.processed" | "refund.failed";
  /** Razorpay's `rfnd_...` — the join key to `refunds.razorpay_refund_id`. */
  providerRefundId: string;
  /** The `pay_...` the money went back along. Resolves dashboard refunds to an order. */
  providerPaymentId: string;
  amountPaise: number;
  /** The provider's own status word, stored verbatim. */
  rawStatus: string;
  /**
   * Our `refunds.id`, when the refund was created by this codebase — carried
   * in the provider's notes. It is how a refund whose create call timed out is
   * matched back to the row that was waiting for it.
   */
  refundRowId: string | null;
};

export type WebhookParseResult =
  | { ok: true; event: VerifiedWebhookEvent; refund?: undefined }
  | { ok: true; refund: VerifiedRefundEvent; event?: undefined }
  | {
      ok: false;
      reason: "bad_signature" | "malformed" | "unhandled";
      message: string;
    };

/* --------------------------------------------------------------- adapter -- */

/**
 * Everything a payment method has to be able to do.
 *
 * Implementations live in `src/lib/payments/<provider>.ts` and are reached only
 * through `getPaymentAdapter()`. They may read secrets; they may not read or
 * write orders. Moving an order's state is `src/lib/orders/` work, called by
 * the webhook route with the outcome this interface produced — which keeps the
 * state machine in one place and out of every provider that gets added.
 */
export type InitiateContext = {
  /** Our order's primary key, for the provider's `receipt` field. */
  orderId: string;
  /** Our human-readable number, which is what support will be asked about. */
  orderNumber: string;
  amountPaise: number;
  customer: { name: string; email: string | null; phone: string | null };
};

export interface PaymentAdapter {
  readonly method: PaymentMethod;
  readonly copy: PaymentMethodCopy;

  /**
   * True when this method can actually be used right now.
   *
   * Razorpay with no keys configured must not be offered — a customer who picks
   * it and hits a 500 has been failed twice. The checkout page filters on this.
   */
  isAvailable(): boolean;

  /** Create whatever the provider needs. Server-side; the amount is ours. */
  initiate(context: InitiateContext): Promise<PaymentInitiation>;

  /** Check the browser's claim. Returns a verdict, never throws at a customer. */
  verifyClientCallback(claim: ClientCallbackClaim): Promise<VerificationResult>;

  /**
   * Prove a webhook came from the provider and say what it means.
   *
   * Takes the **raw** body, not a parsed object: the signature is over the
   * exact bytes, and `JSON.parse` followed by `JSON.stringify` does not
   * reproduce them.
   */
  parseWebhook(
    rawBody: string,
    signatureHeader: string | null,
  ): WebhookParseResult;
}
