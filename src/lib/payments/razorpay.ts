import "server-only";

import { z } from "zod";

import {
  RAZORPAY_API_BASE,
  RAZORPAY_TIMEOUT_MS,
  isRazorpayConfigured,
  razorpayKeyId,
  razorpayWebhookSecret,
  requireRazorpayApiKeys,
} from "@/lib/payments/config";
import { verifyHexSignature } from "@/lib/payments/signature";
import {
  assertPaise,
  MIN_CHARGEABLE_PAISE,
  type ClientCallbackClaim,
  type InitiateContext,
  type PaymentAdapter,
  type PaymentInitiation,
  type PaymentOutcome,
  type PaymentOutcomeStatus,
  type VerificationResult,
  type WebhookParseResult,
} from "@/lib/payments/types";

/**
 * Razorpay, over `fetch` and `node:crypto`. No SDK.
 *
 * The entire provider surface is three HTTP calls and two HMACs: create an
 * order, read a payment back, and check two signatures. The official package is
 * CommonJS with `any`-shaped responses, which this phase's lint gate forbids,
 * and it would sit in the money path forever to save about forty lines. The
 * adapter interface already isolates the provider, so swapping this for the SDK
 * later is a change to one file.
 *
 * **Nothing in this file reads or writes an order.** It turns provider noise
 * into a `PaymentOutcome` and hands it back; moving order state is
 * `src/lib/orders/` work, reached through `applyPaymentOutcome`. That split is
 * what keeps the state machine in one place no matter how many providers get
 * added, and it is why no `Razorpay*` type below is exported.
 *
 * Money is integer paise in both directions, which is also what Razorpay's API
 * speaks, so there is no conversion anywhere here and no float to round.
 * `assertPaise` guards both boundaries anyway — the cost is a comparison and
 * the thing it catches is silent.
 */

/* ------------------------------------------------------------ wire shapes -- */

/**
 * Parsed, not cast.
 *
 * `await response.json()` is `any`, and an `as RazorpayOrder` on it is a lie
 * that type-checks: the first time Razorpay renames a field, the code keeps
 * compiling and starts reading `undefined` as an amount. Zod is already a
 * dependency for form validation; using it on the way in from a payment
 * provider is the same argument, with money attached.
 */
const razorpayOrderSchema = z.object({
  id: z.string().min(1),
  amount: z.number().int().nonnegative(),
  amount_paid: z.number().int().nonnegative(),
  currency: z.string().min(1),
  status: z.string().min(1),
  receipt: z.string().nullable().optional(),
});

const razorpayPaymentSchema = z.object({
  id: z.string().min(1),
  order_id: z.string().min(1).nullable().optional(),
  amount: z.number().int().nonnegative(),
  currency: z.string().min(1),
  status: z.string().min(1),
  error_code: z.string().nullable().optional(),
  error_description: z.string().nullable().optional(),
  error_reason: z.string().nullable().optional(),
});

type RazorpayPayment = z.infer<typeof razorpayPaymentSchema>;
type RazorpayOrder = z.infer<typeof razorpayOrderSchema>;

/**
 * The webhook envelope. `payload` carries whichever entities the event
 * `contains`, so both are optional and the event type decides which is read.
 */
const razorpayWebhookSchema = z.object({
  event: z.string().min(1),
  payload: z.object({
    payment: z.object({ entity: razorpayPaymentSchema }).optional(),
    order: z.object({ entity: razorpayOrderSchema }).optional(),
  }),
});

const razorpayErrorSchema = z.object({
  error: z.object({
    code: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
  }),
});

/* ------------------------------------------------------------------ http -- */

type ApiResult<T> =
  | { ok: true; body: T }
  | {
      ok: false;
      /** 0 when the request never completed — timeout, DNS, TLS. */
      status: number;
      code: string | null;
      description: string;
      /** True when Razorpay says the id we asked about is not a thing. */
      unknownId: boolean;
    };

function basicAuth(keyId: string, keySecret: string): string {
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`, "utf8").toString("base64")}`;
}

/**
 * One authenticated call to Razorpay, parsed or explained.
 *
 * Deliberately never throws: every caller has a customer waiting and needs to
 * decide between "tell them it failed" and "tell them we are checking", and an
 * exception forces both into the same catch block.
 *
 * The timeout is not optional. `fetch` with no signal waits on the OS TCP
 * timeout, which is minutes — long enough for the serverless function to be
 * killed mid-checkout with the order row already written and no initiation
 * returned. Ten seconds, then we give up and say so.
 */
async function razorpayRequest<T>(
  label: string,
  path: string,
  schema: z.ZodType<T>,
  init?: { method: "POST"; body: unknown },
): Promise<ApiResult<T>> {
  const { keyId, keySecret } = requireRazorpayApiKeys();

  let response: Response;
  try {
    response = await fetch(`${RAZORPAY_API_BASE}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: basicAuth(keyId, keySecret),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: init ? JSON.stringify(init.body) : undefined,
      // Razorpay is never cacheable and this is a payment. Be explicit, because
      // Next patches `fetch` and a default that changes between releases must
      // not be able to hand us a stale order.
      cache: "no-store",
      signal: AbortSignal.timeout(RAZORPAY_TIMEOUT_MS),
    });
  } catch (error) {
    const description = error instanceof Error ? error.message : "network error";
    console.error(`[razorpay] ${label}: request failed before a response`, { description });
    return { ok: false, status: 0, code: null, description, unknownId: false };
  }

  const text = await response.text();

  if (!response.ok) {
    const parsedError = razorpayErrorSchema.safeParse(safeJson(text));
    const code = parsedError.success ? (parsedError.data.error.code ?? null) : null;
    const description = parsedError.success
      ? (parsedError.data.error.description ?? "Razorpay rejected the request.")
      : "Razorpay rejected the request.";
    // Never the body: an error response can echo the request, and the request
    // to /orders carries the customer's order number. Code and description are
    // Razorpay's own words and are safe to keep.
    console.error(`[razorpay] ${label}: HTTP ${response.status}`, { code, description });
    return {
      ok: false,
      status: response.status,
      code,
      description,
      // Razorpay answers "no such payment" with a 400, not a 404, so the status
      // code alone cannot distinguish a bad id from a broken request. Verified
      // against the live test API: GET /payments/pay_00000000000000 returns 400
      // with description "The id provided does not exist".
      unknownId: response.status === 400 && /does not exist/i.test(description),
    };
  }

  const parsed = schema.safeParse(safeJson(text));
  if (!parsed.success) {
    console.error(`[razorpay] ${label}: response did not match the expected shape`, {
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.code}`),
    });
    return {
      ok: false,
      status: response.status,
      code: "unexpected_shape",
      description: "Razorpay returned something we do not understand.",
      unknownId: false,
    };
  }

  return { ok: true, body: parsed.data };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- mapping -- */

/**
 * Razorpay's payment states, in our three.
 *
 * The default arm is the important one. An unrecognised status becomes
 * `pending`, never `failed`, because the two mistakes are not symmetrical:
 * calling a captured payment pending means a confirmation page that says "we
 * are checking", and calling it failed means telling somebody who has been
 * charged that they have not been. `PaymentOutcomeStatus` exists precisely so
 * that middle can be expressed.
 *
 * `refunded` maps to `captured` on purpose. Money did move for this order; the
 * refund is a separate event stream that Phase 8 owns, and collapsing it into
 * `failed` here would un-confirm a delivered order.
 */
function mapPaymentStatus(rawStatus: string): PaymentOutcomeStatus {
  switch (rawStatus) {
    case "captured":
    case "refunded":
      return "captured";
    case "failed":
      return "failed";
    case "created":
    case "authorized":
      return "pending";
    default:
      console.warn("[razorpay] unrecognised payment status, treating as pending", { rawStatus });
      return "pending";
  }
}

/** Razorpay's failure text is written for the payer and is short. Ours is the fallback. */
function customerMessage(payment: RazorpayPayment, status: PaymentOutcomeStatus): string {
  if (status === "captured") return "Payment received.";
  if (status === "pending") return "Your bank is still confirming this payment.";

  const provided = payment.error_description?.trim();
  const detail = provided && provided.length <= 140 ? ` ${provided}` : "";
  return `The payment did not go through and you have not been charged.${detail}`;
}

/**
 * The currency check lives here, next to the amount it governs, and not one
 * layer up.
 *
 * It used to be a single test above the event switch, reading
 * `payment?.currency ?? order?.currency`. That looked equivalent and was not:
 * `order.paid` takes its amount from `order.amount_paid`, so a payload with a
 * `USD` order entity and an `INR` payment entity passed a check on the payment
 * and then spent the order's number as though it were paise. Agent E landed a
 * signed `order.paid` through it (E-4).
 *
 * The lesson is not "add the missing case" — it is that a guard placed anywhere
 * other than beside the value it guards can be bypassed by the next event type
 * somebody adds. So every function that reads a raw provider amount validates
 * the currency of **the same entity it read the amount from**, and returns null
 * rather than an outcome when it does not like the answer. There is no way to
 * obtain a `PaymentOutcome` from this module without going past one of these.
 *
 * We only ever create INR orders, so a non-INR entity naming one of our order
 * ids cannot happen legitimately. Dropping is the safe direction: the amount is
 * otherwise compared against a rupee total as though the units matched, and
 * 199900 yen would settle a ₹1,999 order.
 */
function inrPaiseOrNull(label: string, amount: number, currency: string): number | null {
  if (currency !== "INR") return null;
  return assertPaise(label, amount);
}

/** Null when the payment is not in rupees. See `inrPaiseOrNull`. */
function outcomeFromPayment(payment: RazorpayPayment): PaymentOutcome | null {
  const amountPaise = inrPaiseOrNull("razorpay.outcome.amount", payment.amount, payment.currency);
  if (amountPaise === null) {
    console.error("[razorpay] payment dropped: unexpected currency", {
      paymentId: payment.id,
      currency: payment.currency,
    });
    return null;
  }

  const status = mapPaymentStatus(payment.status);
  return {
    status,
    providerPaymentId: payment.id,
    providerOrderId: payment.order_id ?? null,
    amountPaise,
    rawStatus: payment.status,
    message: customerMessage(payment, status),
  };
}

/**
 * `order.paid` describes the order, not one payment.
 *
 * The event carries the payment entity too when the order was settled by a
 * single payment, so the id is taken from there when it is present and left
 * null when it is not — a partially-paid order settled by two payments has no
 * single payment id, and inventing one would put the wrong reference on the
 * order.
 *
 * The amount is the **order's** `amount_paid`, so the **order's** currency is
 * what has to be INR. A payment entity that disagrees with its own order is an
 * anomaly no legitimate settlement produces, and it is refused rather than
 * resolved in either direction — picking a winner between two contradictory
 * statements about money is not something this function is in a position to do.
 */
function outcomeFromPaidOrder(
  order: RazorpayOrder,
  payment: RazorpayPayment | null,
): PaymentOutcome | null {
  const amountPaise = inrPaiseOrNull(
    "razorpay.outcome.amountPaid",
    order.amount_paid,
    order.currency,
  );
  if (amountPaise === null) {
    console.error("[razorpay] order.paid dropped: unexpected currency", {
      orderId: order.id,
      currency: order.currency,
    });
    return null;
  }

  if (payment && payment.currency !== order.currency) {
    console.error("[razorpay] order.paid dropped: entities disagree about currency", {
      orderId: order.id,
      orderCurrency: order.currency,
      paymentCurrency: payment.currency,
    });
    return null;
  }

  return {
    status: "captured",
    providerPaymentId: payment?.id ?? null,
    providerOrderId: order.id,
    amountPaise,
    rawStatus: order.status,
    message: "Payment received.",
  };
}

/**
 * Razorpay ids are `pay_`/`order_` followed by base62. Anything else is either
 * a bug or an attempt to steer the URL — `pay_x/../../orders/order_y` reaching
 * `GET /payments/{id}` would fetch a different resource entirely. The signature
 * check already makes forgery impractical; this makes it structurally
 * impossible, for the price of one regex.
 */
const PROVIDER_ID = /^[A-Za-z0-9_]{1,64}$/;

/* --------------------------------------------------------------- adapter -- */

export const razorpayAdapter: PaymentAdapter = {
  method: "razorpay",

  copy: {
    method: "razorpay",
    label: "Pay online",
    description: "UPI, cards, net banking or a wallet. You pay now and we ship on confirmation.",
    note: "You will be taken to Razorpay's secure window. We never see your card details.",
  },

  isAvailable(): boolean {
    return isRazorpayConfigured();
  },

  /**
   * Create the Razorpay order the browser's modal will open against.
   *
   * The amount comes from `context`, which the checkout action computed from
   * the catalog — never from the browser. That is the whole reason this takes a
   * context object rather than a request: there is no field here an attacker
   * could have filled in.
   *
   * Throws on failure, because `PaymentInitiation` has no failure variant by
   * design: an order whose provider could not be reached is not "initiated with
   * a null id", it is a `payment_init_failed` for the checkout action to catch
   * and turn into "you have not been charged" — which is a decision about the
   * order, and orders are not this module's business.
   */
  async initiate(context: InitiateContext): Promise<PaymentInitiation> {
    const amountPaise = assertPaise("razorpay.initiate.amount", context.amountPaise);
    if (amountPaise < MIN_CHARGEABLE_PAISE) {
      throw new Error(
        `razorpay.initiate: ${amountPaise} paise is below Razorpay's ${MIN_CHARGEABLE_PAISE} paise floor.`,
      );
    }

    const keyId = razorpayKeyId();
    if (!keyId) throw new Error("razorpay.initiate: RAZORPAY_KEY_ID is not set.");

    const result = await razorpayRequest("createOrder", "/orders", razorpayOrderSchema, {
      method: "POST",
      body: {
        amount: amountPaise,
        currency: "INR",
        // Max 40 characters at Razorpay. `FV-2026-00147` is thirteen, and it is
        // the string a customer quotes to support, so it is the one that should
        // appear in the Razorpay dashboard's own column.
        receipt: context.orderNumber,
        // Notes survive into every export and refund screen. The uuid is here
        // because the order number is the human key and the id is the one that
        // joins to anything.
        notes: {
          order_number: context.orderNumber,
          order_id: context.orderId,
        },
      },
    });

    if (!result.ok) {
      throw new Error(
        `razorpay.initiate: could not create a Razorpay order for ${context.orderNumber} ` +
          `(HTTP ${result.status}${result.code ? `, ${result.code}` : ""}): ${result.description}`,
      );
    }

    const order = result.body;

    // Razorpay echoes the amount back. If it disagrees with what we asked for,
    // something between us rewrote the money, and opening a modal for the wrong
    // number is worse than failing the checkout.
    assertPaise("razorpay.initiate.echoedAmount", order.amount);
    if (order.amount !== amountPaise) {
      throw new Error(
        `razorpay.initiate: asked for ${amountPaise} paise, Razorpay created ${order.amount}.`,
      );
    }
    if (order.currency !== "INR") {
      throw new Error(`razorpay.initiate: expected INR, Razorpay created ${order.currency}.`);
    }

    return {
      kind: "razorpay",
      method: "razorpay",
      keyId,
      providerOrderId: order.id,
      amountPaise: order.amount,
      currency: "INR",
      prefill: {
        name: context.customer.name,
        email: context.customer.email,
        // Dialled, not stored. `phoneSchema` normalises to a bare ten digits on
        // purpose so the database holds one format and a support search finds
        // an order — but Razorpay's mobile modal parses `contact` against its
        // country selector, and ten bare digits leave the field empty with +91
        // already chosen. The country code is a property of this provider's UI,
        // so it is added here rather than polluting the stored shape.
        contact: e164India(context.customer.phone),
      },
    };
  },

  /**
   * Check the browser's three strings, then ask Razorpay what actually happened.
   *
   * The signature proves the pair `(order, payment)` was produced by someone
   * holding our key secret — that is, by Razorpay. It proves nothing about the
   * payment's *state*: a valid signature accompanies an authorised-but-not-
   * captured payment just as happily. So the signature is the gate, and the
   * Payments API read is the answer. Skipping the read and assuming "callback
   * fired, therefore captured" is the bug that makes a shop confirm orders that
   * were never settled.
   */
  async verifyClientCallback(claim: ClientCallbackClaim): Promise<VerificationResult> {
    if (!isRazorpayConfigured()) {
      return {
        ok: false,
        reason: "provider_error",
        message: "Online payment is not available right now.",
      };
    }

    if (!PROVIDER_ID.test(claim.providerOrderId) || !PROVIDER_ID.test(claim.providerPaymentId)) {
      console.warn("[razorpay] client callback rejected: malformed provider id");
      return {
        ok: false,
        reason: "bad_signature",
        message: "We could not verify that payment.",
      };
    }

    const { keySecret } = requireRazorpayApiKeys();
    const signedMessage = `${claim.providerOrderId}|${claim.providerPaymentId}`;

    if (!verifyHexSignature(keySecret, signedMessage, claim.signature)) {
      // The ids, never the signature. A rejected signature in a log is a
      // half-solved forgery for whoever reads the log next.
      console.warn("[razorpay] client callback rejected: signature mismatch", {
        providerOrderId: claim.providerOrderId,
        providerPaymentId: claim.providerPaymentId,
      });
      return {
        ok: false,
        reason: "bad_signature",
        message: "We could not verify that payment. If you were charged, it will be confirmed shortly.",
      };
    }

    const result = await razorpayRequest(
      "fetchPayment",
      `/payments/${encodeURIComponent(claim.providerPaymentId)}`,
      razorpayPaymentSchema,
    );

    if (!result.ok) {
      if (result.unknownId) {
        return {
          ok: false,
          reason: "unknown_order",
          message: "We could not find that payment.",
        };
      }
      return {
        ok: false,
        reason: "provider_error",
        message: "We could not reach the payment provider. Your order status will update shortly.",
      };
    }

    const payment = result.body;

    // A valid signature already binds the two ids, so a mismatch here means the
    // key secret is compromised or Razorpay changed something fundamental.
    // Either way it is not a payment for this order.
    if (payment.order_id !== claim.providerOrderId) {
      console.error("[razorpay] client callback: payment belongs to a different order", {
        claimed: claim.providerOrderId,
        actual: payment.order_id,
      });
      return {
        ok: false,
        reason: "unknown_order",
        message: "That payment does not belong to this order.",
      };
    }

    const outcome = outcomeFromPayment(payment);
    if (!outcome) {
      // Non-INR, refused by the currency check beside the amount. Reachable
      // only if the Razorpay account starts taking another currency, in which
      // case this shop has a bigger problem than one callback — but a customer
      // must never be told a payment we cannot account for was received.
      return {
        ok: false,
        reason: "provider_error",
        message: "We could not confirm that payment. Please contact us before paying again.",
      };
    }

    return { ok: true, outcome };
  },

  /**
   * Prove a webhook came from Razorpay, then say what it means.
   *
   * Three things have burned every integration that got this wrong:
   *
   *  1. The secret is `RAZORPAY_WEBHOOK_SECRET`, **not** `RAZORPAY_KEY_SECRET`.
   *     They are different strings from different screens.
   *  2. The signed message is the raw request bytes. `JSON.parse` then
   *     `JSON.stringify` reorders keys and drops whitespace, and the HMAC of
   *     that is not the HMAC of what arrived. Hence `rawBody: string`.
   *  3. Verification comes before parsing, and certainly before the database.
   *     A payload is not data until it is proved.
   */
  parseWebhook(rawBody: string, signatureHeader: string | null): WebhookParseResult {
    const secret = razorpayWebhookSecret();
    if (!secret) {
      // Fail closed. With no secret configured there is no way to tell a real
      // Razorpay event from a POST by anyone who can reach the URL, and the URL
      // is public. Rejecting everything is the correct behaviour until the
      // owner creates the secret in the dashboard — the alternative is a route
      // that will confirm any order it is asked to.
      console.error(
        "[razorpay] webhook rejected: RAZORPAY_WEBHOOK_SECRET is not set, so no webhook " +
          "can be verified. Create it in the Razorpay dashboard under Settings → Webhooks " +
          "and set it in the environment.",
      );
      return {
        ok: false,
        reason: "bad_signature",
        message: "Webhook verification is not configured.",
      };
    }

    if (!verifyHexSignature(secret, rawBody, signatureHeader)) {
      // Length only. The body of a rejected webhook is attacker-controlled and
      // has no business in our logs; its size is enough to tell an empty probe
      // from a real payload with the wrong secret.
      console.warn("[razorpay] webhook rejected: signature mismatch", {
        bodyBytes: Buffer.byteLength(rawBody, "utf8"),
        signaturePresent: signatureHeader !== null,
      });
      return { ok: false, reason: "bad_signature", message: "Signature mismatch." };
    }

    const parsed = razorpayWebhookSchema.safeParse(safeJson(rawBody));
    if (!parsed.success) {
      console.error("[razorpay] webhook verified but unreadable", {
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.code}`),
      });
      return { ok: false, reason: "malformed", message: "Verified, but not a shape we know." };
    }

    const { event, payload } = parsed.data;
    const payment = payload.payment?.entity ?? null;
    const order = payload.order?.entity ?? null;

    /**
     * The currency guard is **not** here.
     *
     * It was, and being here is precisely what made it wrong: a check above the
     * switch has to guess which entity the arm below it will read the amount
     * from, and for `order.paid` it guessed the payment. It now lives inside
     * `outcomeFromPayment` and `outcomeFromPaidOrder`, beside the amounts they
     * read, and a null coming back from either is a refusal. Adding an event
     * type therefore cannot reintroduce the hole — the new arm has to build an
     * outcome, and there is no way to build one without being checked.
     */
    switch (event) {
      case "payment.captured":
      case "payment.failed":
      case "payment.authorized": {
        if (!payment) {
          return { ok: false, reason: "malformed", message: `${event} carried no payment entity.` };
        }
        const outcome = outcomeFromPayment(payment);
        if (!outcome) {
          return { ok: false, reason: "malformed", message: "Unexpected currency." };
        }
        return {
          ok: true,
          event: {
            eventId: webhookEventId(event, payment.id),
            eventType: event,
            providerOrderId: payment.order_id ?? null,
            outcome,
          },
        };
      }

      case "order.paid": {
        if (!order) {
          return { ok: false, reason: "malformed", message: "order.paid carried no order entity." };
        }
        const outcome = outcomeFromPaidOrder(order, payment);
        if (!outcome) {
          return { ok: false, reason: "malformed", message: "Unexpected currency." };
        }
        return {
          ok: true,
          event: {
            eventId: webhookEventId(event, order.id),
            eventType: event,
            providerOrderId: order.id,
            outcome,
          },
        };
      }

      default:
        // Not an error. Razorpay sends whatever the dashboard subscription
        // asks for, plus events added after we wrote this, and a 400 on an
        // event we simply do not care about would make Razorpay retry it for
        // hours and eventually disable the endpoint.
        return { ok: false, reason: "unhandled", message: `No handler for ${event}.` };
    }
  },
};

/**
 * The idempotency key, derived rather than taken from Razorpay.
 *
 * Razorpay's own event id arrives in the `x-razorpay-event-id` header, which
 * `parseWebhook` cannot see — the interface takes the signature header and the
 * body, and widening a contract two other agents are already building against
 * is worse than the alternative. But deriving is also *better*, which is why
 * this is not a workaround:
 *
 *   - Retries of one event carry the same event id, so both keys dedupe those.
 *   - A **manual resend** from the Razorpay dashboard carries a *new* event id
 *     for the same state change. The provider's key would let it through and
 *     apply it a second time; `payment.captured:pay_XYZ` will not.
 *   - Two different attempts on the same order are genuinely different events
 *     and must both be processed. They carry different `pay_` ids, so they get
 *     different keys — a retry after a failure is never swallowed.
 *
 * The provider's event id is still logged by the route, so a support question
 * about a specific dashboard row can be answered.
 */
function webhookEventId(event: string, entityId: string): string {
  return `${event}:${entityId}`;
}

/**
 * A stored ten-digit Indian mobile as Razorpay wants to receive it.
 *
 * Defensive about what it is handed: anything already carrying a country code,
 * or that is not ten digits, is passed through untouched rather than mangled —
 * a wrong prefill is worse than none, because the customer has to notice and
 * clear it before they can type their own.
 */
function e164India(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d]/g, "");
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : phone;
}
