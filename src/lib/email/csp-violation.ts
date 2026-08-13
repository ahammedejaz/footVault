import { REPLY_TO } from "@/lib/email/shared";
import type { EmailMessage } from "@/lib/email/types";

/**
 * The email that says a policy is about to break something.
 *
 * Its own builder rather than a reuse of `buildIncidentEmail`, because that
 * one's fields are `method`, `routePath` and `routeType` and a CSP violation
 * has none of them. Mapping a directive into a field named `method` would make
 * every future reader trust a label that is wrong, which is the failure this
 * codebase keeps finding in its own comments.
 *
 * Kept out of `lifecycle.ts` for the same reason the incident email is: it has
 * no order, no customer, and no place in the six a purchase sends, and
 * `scripts/audit/emails.ts` asserts things about orders that this would fail
 * for no useful reason.
 *
 * ## What is deliberately not in here
 *
 * **The original policy.** The browser sends the entire header back with every
 * report. It is long, it is identical in every message, and it is already in
 * the repo — putting it in the mail would bury the one line that changed.
 *
 * **Request headers, the customer, the session.** Same as the incident email:
 * a report that leaks a cookie into an inbox is a credential leak that cannot
 * be un-sent. The document URI arrives with its query already stripped by
 * `csp-classify.ts`, so an order number in a URL does not ride along.
 */

export type CspViolationInput = {
  to: string;
  /** The directive that blocked, e.g. `script-src-elem`. */
  directive: string;
  /** What it blocked. A URL, or `inline` / `eval`. */
  blockedUri: string;
  /** The page it happened on, query already stripped. */
  documentUri: string;
  sourceFile: string | null;
  lineNumber: number | null;
  /** `report` during the bake. `enforce` means it is really being blocked. */
  disposition: string;
  /** Whether the blocked origin is one the shop cannot function without. */
  critical: boolean;
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
 * One violation, written for someone who did not set the policy and should not
 * have to read the spec to act on it.
 *
 * The subject carries the blocked origin rather than the directive, because
 * "checkout.razorpay.com" tells the owner whether the shop can still take money
 * and "script-src-elem" does not.
 */
export function buildCspViolationEmail(
  input: CspViolationInput,
): EmailMessage {
  const enforcing = input.disposition === "enforce";

  const lines = [
    `${input.directive} blocked ${input.blockedUri}`,
    `page:    ${input.documentUri}`,
    `when:    ${input.occurredAt}`,
    input.sourceFile
      ? `source:  ${input.sourceFile}:${input.lineNumber ?? "?"}`
      : null,
    `mode:    ${enforcing ? "ENFORCING — this was really blocked" : "report-only — nothing was blocked"}`,
    "",
    input.critical
      ? "This origin is one the shop needs. If the policy were enforcing, this\n" +
        "would have broken something a customer was doing — most likely paying.\n" +
        "Do not switch Content-Security-Policy-Report-Only to\n" +
        "Content-Security-Policy until this stops appearing."
      : "This origin is not one the shop is known to need. It may be a genuine\n" +
        "block worth allowing, or something that has no business loading here —\n" +
        "which is the policy doing its job.",
    "",
    "The policy lives in src/lib/csp.ts. Every violation is in the runtime log",
    "under [csp], and the log is not rate-limited — these emails are (two an",
    "hour per directive-and-origin), so this is a sample, not a count.",
  ].filter((line): line is string => line !== null);

  const origin = (() => {
    try {
      return new URL(input.blockedUri).host;
    } catch {
      return input.blockedUri.slice(0, 40);
    }
  })();

  return {
    to: input.to,
    subject: input.critical
      ? `CSP would block ${origin} — Foot Vault`
      : `CSP report: ${input.directive} · ${origin}`,
    text: lines.join("\n"),
    html:
      `<pre style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;` +
      `font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word">` +
      escapeHtml(lines.join("\n")) +
      `</pre>`,
    replyTo: REPLY_TO,
  };
}
