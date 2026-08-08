import "server-only";

import { createConsoleEmailAdapter } from "@/lib/email/console-adapter";
import {
  buildOrderConfirmationEmail,
  type OrderConfirmationInput,
} from "@/lib/email/order-confirmation";
import type { EmailAdapter, EmailSendResult } from "@/lib/email/types";

export type {
  EmailAdapter,
  EmailMessage,
  EmailSendResult,
} from "@/lib/email/types";
export type { OrderConfirmationInput } from "@/lib/email/order-confirmation";

/**
 * Which adapter is in play.
 *
 * Exactly one today. The function exists rather than a bare export so that
 * adding a real provider is a branch here and nothing else changes — the same
 * shape `getPaymentAdapter()` has, for the same reason.
 *
 * **Wiring a real provider — owner task, four steps.** None of it is code we
 * are missing; it is credentials we do not have.
 *
 *   1. Pick a provider that will send from your own domain. Resend is the
 *      least work with Vercel; any SMTP host works too.
 *   2. Verify the sending domain (an SPF and a DKIM record on footvault's DNS).
 *      Skipping this is what puts order confirmations in spam.
 *   3. Put the key in the Vercel project as EMAIL_API_KEY, separately for
 *      Preview and Production, plus EMAIL_FROM (e.g. "Foot Vault
 *      <orders@your-domain>"). Add both names — names only — to .env.example.
 *   4. Add src/lib/email/<provider>-adapter.ts implementing EmailAdapter and
 *      return it below when the key is present. Nothing else changes: the
 *      checkout action already treats a failed send as a log line.
 *
 * Until then every confirmation is printed to the server log, and the order is
 * unaffected — which is the correct trade, not a workaround.
 */
export function getEmailAdapter(): EmailAdapter {
  return createConsoleEmailAdapter();
}

/**
 * Send the order confirmation, and never let it matter.
 *
 * The try/catch is not belt and braces. `send` is contractually not allowed to
 * throw, but an adapter is a third-party client under a thin wrapper, and the
 * one place in this codebase where a broken dependency must not surface is
 * immediately after a customer's money has moved.
 */
export async function sendOrderConfirmation(
  input: OrderConfirmationInput,
): Promise<EmailSendResult> {
  const adapter = getEmailAdapter();
  try {
    const result = await adapter.send(buildOrderConfirmationEmail(input));
    if (!result.ok) {
      console.error(
        `[email] ${adapter.name} refused order ${input.orderNumber}: ${result.reason}`,
      );
    }
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    console.error(
      `[email] ${adapter.name} threw for order ${input.orderNumber}: ${reason}`,
    );
    return { ok: false, via: adapter.name, reason };
  }
}
