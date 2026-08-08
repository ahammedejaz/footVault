import "server-only";

import type {
  EmailAdapter,
  EmailMessage,
  EmailSendResult,
} from "@/lib/email/types";

/**
 * The adapter that runs when nothing is configured.
 *
 * It writes a line to the server log saying an email *would* have been sent,
 * and returns ok. That is deliberate: the order succeeded, so the send is not a
 * failure of the order — it is a gap in the deployment, and the log is where a
 * gap in the deployment belongs.
 *
 * **The body is not logged by default.** An order confirmation contains a name,
 * an address and a phone number, and Vercel's log drain is not the place for a
 * customer's address to accumulate. Set EMAIL_LOG_BODY=1 in development when
 * you actually want to read what would have gone out; leave it unset in
 * production. The recipient is logged either way, because "did we try to email
 * this person" is the question support will ask.
 */
export function createConsoleEmailAdapter(): EmailAdapter {
  return {
    name: "console",

    // False on purpose. Nothing left the building, and a caller that says "check
    // your inbox" on the strength of a true here would be lying.
    isConfigured() {
      return false;
    },

    async send(message: EmailMessage): Promise<EmailSendResult> {
      const detail =
        process.env.EMAIL_LOG_BODY === "1" ? `\n${message.text}` : "";
      console.info(
        `[email] no provider configured — would send "${message.subject}" to ${message.to}${detail}`,
      );
      return { ok: true, via: "console" };
    },
  };
}
