import { REPLY_TO } from "@/lib/email/shared";
import type { EmailMessage } from "@/lib/email/types";

/**
 * The email nobody wants to receive.
 *
 * Separate from `lifecycle.ts` because it is not an order email: it has no
 * order number, no customer, and no place in the six a purchase sends. Keeping
 * it out of that module also keeps it out of `built` in
 * `scripts/audit/emails.ts`, whose assertions are all about orders — an
 * incident notice failing "names the order number" would be a false failure
 * teaching people to ignore the gate.
 *
 * ## What is deliberately not in here
 *
 * **Request headers.** `onRequestError` is handed the full header map, which on
 * a signed-in request carries the Supabase auth cookie. Forwarding that into an
 * inbox would turn a crash report into a credential leak, and it would do it
 * silently and permanently — mail is not something you can un-send. Path,
 * method and route are enough to find the failure; the headers are not.
 *
 * **The customer.** No email address, no order, no address. An error report is
 * an operational message and does not need to name anyone to be actionable.
 *
 * The error's own message is included, and that is a considered risk rather
 * than an oversight: it can contain a fragment of a query or a row. It goes to
 * one address, the owner's, and without it the report says only that something
 * broke somewhere.
 */

export type IncidentInput = {
  to: string;
  /** Where it broke, e.g. `/checkout` — the resource path, query stripped. */
  path: string;
  method: string;
  /** The route file, e.g. `/product/[slug]`. Groups every instance together. */
  routePath: string;
  /** `render` | `route` | `action` | `proxy`. */
  routeType: string;
  message: string;
  /** The join key to the platform log line, when React produced one. */
  digest: string | null;
  stack: string | null;
  occurredAt: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * One error, described the way it will actually be read: on a phone, at night,
 * by someone deciding whether to get out of bed.
 *
 * The subject carries the route rather than the message, because the message is
 * often a minified React code and the route is what says whether the shop is
 * still taking money. `/checkout` failing is not the same news as
 * `/page/returns` failing, and the subject line is where that difference has to
 * be visible.
 */
export function buildIncidentEmail(input: IncidentInput): EmailMessage {
  const severity = /^\/(checkout|cart|api\/payments)/.test(input.path)
    ? "CHECKOUT"
    : "site";

  const lines = [
    `${input.method} ${input.path}`,
    `route:   ${input.routePath} (${input.routeType})`,
    `when:    ${input.occurredAt}`,
    input.digest ? `digest:  ${input.digest}` : null,
    "",
    input.message,
    "",
    input.digest
      ? `The full server-side error is in the Vercel runtime log on the line carrying digest ${input.digest}.`
      : "No digest — this error was not processed by React, so the message above is the real one.",
    "",
    input.stack ?? "(no stack)",
    "",
    "Reports of this same failure are limited to three an hour, so a page",
    "failing repeatedly will not fill your inbox — and will not stop after",
    "one either.",
  ].filter((line): line is string => line !== null);

  return {
    to: input.to,
    subject:
      severity === "CHECKOUT"
        ? `CHECKOUT FAILING — ${input.path}`
        : `Error on ${input.path} — Foot Vault`,
    text: lines.join("\n"),
    html:
      `<pre style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;` +
      `font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word">` +
      escapeHtml(lines.join("\n")) +
      `</pre>`,
    replyTo: REPLY_TO,
  };
}
