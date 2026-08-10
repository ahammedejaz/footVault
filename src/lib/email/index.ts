import "server-only";

import { createConsoleEmailAdapter } from "@/lib/email/console-adapter";
import { createResendAdapter } from "@/lib/email/resend-adapter";
import {
  buildDeliveredEmail,
  buildOwnerNewOrderEmail,
  buildRefundedEmail,
  buildShippedEmail,
  type DeliveredInput,
  type OwnerNewOrderInput,
  type RefundedInput,
  type ShippedInput,
} from "@/lib/email/lifecycle";
import {
  buildOrderConfirmationEmail,
  type OrderConfirmationInput,
} from "@/lib/email/order-confirmation";
import type { EmailAdapter, EmailMessage, EmailSendResult } from "@/lib/email/types";

export type {
  EmailAdapter,
  EmailMessage,
  EmailSendResult,
} from "@/lib/email/types";
export type { OrderConfirmationInput } from "@/lib/email/order-confirmation";
export type {
  DeliveredInput,
  OwnerNewOrderInput,
  RefundedInput,
  ShippedInput,
} from "@/lib/email/lifecycle";

/**
 * Which adapter is in play.
 *
 * A function rather than a bare export so that adding a provider is a branch
 * here and nothing else changes — the same shape `getPaymentAdapter()` has, for
 * the same reason.
 *
 * **Both variables are required together.** A key with no `EMAIL_FROM` would
 * send from Resend's sandbox domain, which is worse than not sending: it looks
 * delivered, lands in spam, and nobody finds out until a customer says they
 * never got a receipt. Half a configuration falls back to the console adapter
 * and says so once, loudly.
 *
 * Setting the two variables up is an owner task and is written out step by step
 * in `docs/admin-guide.md` § Order emails. Nothing here is code we are missing.
 */
let warnedPartial = false;

export function getEmailAdapter(): EmailAdapter {
  const apiKey = process.env.EMAIL_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();

  if (apiKey && from) return createResendAdapter(apiKey, from);

  if ((apiKey || from) && !warnedPartial) {
    warnedPartial = true;
    console.error(
      "[email] EMAIL_API_KEY and EMAIL_FROM must both be set. " +
        `Have key: ${Boolean(apiKey)}, have from: ${Boolean(from)}. ` +
        "Falling back to the console adapter — nothing is being delivered.",
    );
  }

  return createConsoleEmailAdapter();
}

/**
 * Send one message, and never let it matter.
 *
 * Every send in this module goes through here. The try/catch is not belt and
 * braces: `send` is contractually not allowed to throw, but an adapter is a
 * third-party call under a thin wrapper, and the places these are called from
 * are the places where a broken dependency must not surface — immediately after
 * a customer's money has moved, or in the middle of a fulfilment step that has
 * already created a real parcel.
 *
 * `label` is what appears in the log. It names the *event*, not the template,
 * because the question being asked at 2am is "did the shipped email go out for
 * FV-2026-00661", not which builder produced it.
 */
async function dispatch(
  label: string,
  reference: string,
  message: EmailMessage,
): Promise<EmailSendResult> {
  const adapter = getEmailAdapter();
  try {
    const result = await adapter.send(message);
    if (!result.ok) {
      console.error(
        `[email] ${adapter.name} refused ${label} for ${reference}: ${result.reason}`,
      );
    }
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    console.error(
      `[email] ${adapter.name} threw on ${label} for ${reference}: ${reason}`,
    );
    return { ok: false, via: adapter.name, reason };
  }
}

/* ------------------------------------------------------------- customer -- */

export function sendOrderConfirmation(
  input: OrderConfirmationInput,
): Promise<EmailSendResult> {
  return dispatch(
    "order-confirmation",
    input.orderNumber,
    buildOrderConfirmationEmail(input),
  );
}

export function sendShipped(input: ShippedInput): Promise<EmailSendResult> {
  return dispatch("shipped", input.orderNumber, buildShippedEmail(input));
}

export function sendDelivered(input: DeliveredInput): Promise<EmailSendResult> {
  return dispatch("delivered", input.orderNumber, buildDeliveredEmail(input));
}

export function sendRefunded(input: RefundedInput): Promise<EmailSendResult> {
  return dispatch("refunded", input.orderNumber, buildRefundedEmail(input));
}

/* ---------------------------------------------------------------- owner -- */

/**
 * Where the owner's copy goes.
 *
 * `OWNER_EMAIL` rather than a hardcoded address, and a missing value is a
 * *skip* rather than a failure: a shop that has not set it still takes orders,
 * and the alternative — throwing, or sending to a placeholder — either breaks
 * checkout or emails a stranger a customer's home address.
 */
export function ownerEmailAddress(): string | null {
  return process.env.OWNER_EMAIL?.trim() || null;
}

export async function sendOwnerNewOrder(
  input: Omit<OwnerNewOrderInput, "to">,
): Promise<EmailSendResult> {
  const to = ownerEmailAddress();
  if (!to) {
    console.info(
      `[email] OWNER_EMAIL is not set — no owner notice for ${input.orderNumber}`,
    );
    return { ok: false, via: "unconfigured", reason: "OWNER_EMAIL not set" };
  }
  return dispatch(
    "owner-new-order",
    input.orderNumber,
    buildOwnerNewOrderEmail({ ...input, to }),
  );
}
