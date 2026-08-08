/**
 * The email seam.
 *
 * Same shape and same reasoning as `src/lib/payments/types.ts`: order code
 * states what it wants sent, and something else decides how it leaves the
 * building. Today that is a console adapter. Tomorrow it is Resend or SMTP,
 * and the change is a new file plus an env var rather than an edit to checkout.
 *
 * The rule that matters more than the interface: **a missing email provider
 * must never fail an order.** A customer whose payment went through and whose
 * order exists has bought a pair of shoes; failing their checkout because a
 * mail server was unreachable would turn our operational problem into their
 * problem. Every implementation of `send` therefore returns a verdict and does
 * not throw, and the caller logs the verdict and carries on.
 */

export type EmailMessage = {
  to: string;
  subject: string;
  /** Always present. The plain-text part is what a screen reader and a
   *  text-only client actually get, so it is written, not generated. */
  text: string;
  html: string;
  /** Where a reply goes. Null means the provider's default. */
  replyTo?: string | null;
};

export type EmailSendResult =
  | { ok: true; via: string }
  /** Never thrown. `reason` is for our logs, never for a customer. */
  | { ok: false; via: string; reason: string };

export interface EmailAdapter {
  /** Appears in logs, so it has to say which one actually ran. */
  readonly name: string;

  /**
   * True when this adapter can really deliver.
   *
   * The console adapter answers false: it is a stand-in, and a caller that
   * wants to tell the customer "we have emailed you a receipt" needs to know
   * the difference between sent and printed.
   */
  isConfigured(): boolean;

  send(message: EmailMessage): Promise<EmailSendResult>;
}
