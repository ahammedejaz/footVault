import "server-only";

import type {
  EmailAdapter,
  EmailMessage,
  EmailSendResult,
} from "@/lib/email/types";

/**
 * Resend, over its HTTP API rather than its SDK.
 *
 * One `fetch` to one documented endpoint is the whole integration, and a
 * dependency here would be a package in the server bundle whose release cadence
 * we do not control, sitting on the path immediately after a customer's money
 * has moved. The SDK's value is types and retries; the types are twelve lines
 * below and the retries are something this deliberately does **not** want — see
 * the timeout note.
 *
 * ## Why it cannot throw
 *
 * `EmailAdapter.send` is contractually not allowed to throw, and this is the
 * implementation where that is load-bearing rather than theoretical: a DNS
 * failure, a 500 from Resend, or a hung socket all have to come back as
 * `{ ok: false }` so the caller logs it and the order carries on. Every failure
 * path below returns a verdict.
 *
 * ## The timeout is the point
 *
 * Without one, an unresponsive provider holds the request open until the
 * platform kills the function — turning a missing email into a failed checkout,
 * which is the exact trade the whole seam exists to prevent. Eight seconds is
 * well past a healthy send and well short of anything a customer would sit
 * through. There is no retry: a duplicate confirmation is worse than a missing
 * one, and the log line is what a human acts on.
 */

const ENDPOINT = "https://api.resend.com/emails";
const TIMEOUT_MS = 8_000;

export function createResendAdapter(
  apiKey: string,
  from: string,
): EmailAdapter {
  return {
    name: "resend",

    isConfigured() {
      return true;
    },

    async send(message: EmailMessage): Promise<EmailSendResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const response = await fetch(ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            html: message.html,
            ...(message.replyTo ? { reply_to: [message.replyTo] } : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          /*
           * The body carries Resend's own reason — an unverified domain, a
           * malformed `from`, a revoked key. It goes in the log verbatim
           * because every one of those is a deployment problem somebody has to
           * fix, and "send failed" without the reason costs an hour.
           */
          const detail = await response.text().catch(() => "");
          return {
            ok: false,
            via: "resend",
            reason: `HTTP ${response.status} ${detail.slice(0, 300)}`.trim(),
          };
        }

        return { ok: true, via: "resend" };
      } catch (error) {
        const reason =
          error instanceof Error && error.name === "AbortError"
            ? `no response in ${TIMEOUT_MS}ms`
            : error instanceof Error
              ? error.message
              : "unknown";
        return { ok: false, via: "resend", reason };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
