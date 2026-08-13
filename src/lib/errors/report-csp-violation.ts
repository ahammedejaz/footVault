import "server-only";

import { buildCspViolationEmail } from "@/lib/email/csp-violation";
import { getEmailAdapter, ownerEmailAddress } from "@/lib/email";
import {
  cspFingerprint,
  isCritical,
  isNoise,
  type CspViolation,
} from "@/lib/errors/csp-classify";
import { consumeRateLimit } from "@/lib/rate-limit";

/**
 * Where a CSP violation goes.
 *
 * Built to the shape of `report-server-error.ts` on purpose — same order, same
 * three prohibitions, same in-process backstop — because that file already
 * solved this problem for server errors and a second, differently-shaped
 * reporter is a second set of ways to get it wrong. Read that file's header
 * first; this one only records where the two differ.
 *
 * ## Three things this must never do
 *
 * **Throw.** It is called from a public route handler that browsers fire at us
 * automatically. An exception here would turn a report about a broken page into
 * a broken page.
 *
 * **Flood.** A CSP header applies to every page view, so the input volume
 * scales with *traffic*, not with breakage — the opposite of a server error.
 * `cspReport` and `cspReportTotal` are its own buckets rather than the error
 * reporter's, so a noisy afternoon cannot starve the budget a real 500 needs.
 * See the note in `rate-limit.ts`.
 *
 * **Report other people's browser extensions.** By volume this is most of what
 * arrives on any public site, and on a shop the coupon extensions are
 * guaranteed. `isNoise` in `csp-classify.ts` drops them before they cost
 * anything.
 *
 * ## The one real difference from the server-error reporter
 *
 * That one is an alarm. This one is an **instrument**, and only for as long as
 * the policy is Report-Only. Its job is to answer one question — did a real
 * customer's browser block something the shop needs — and the answer is read
 * from the log after a deliberate test payment, not from an inbox.
 *
 * So the log line is the product here, not the fallback. It happens for every
 * non-noise violation, before any limit is consulted and whether or not mail is
 * configured, and it is prefixed `[csp]` so one grep answers the question the
 * bake exists to ask. The email is the exception path, for the violation nobody
 * was watching for.
 */

/**
 * The same in-process backstop, and the same reasoning: `consumeRateLimit`
 * fails open, so the scenario that produces a flood — the database being
 * unreachable — is the scenario in which the counter does not bind.
 *
 * Lower than the server-error reporter's five. A CSP email is never the thing
 * that gets somebody out of bed, and the log has the full picture.
 */
const IN_PROCESS_LIMIT = 3;
const IN_PROCESS_WINDOW_MS = 3_600_000;
let sentInThisProcess = 0;
let windowStartedAt = 0;

function withinProcessBudget(now: number): boolean {
  if (now - windowStartedAt > IN_PROCESS_WINDOW_MS) {
    windowStartedAt = now;
    sentInThisProcess = 0;
  }
  if (sentInThisProcess >= IN_PROCESS_LIMIT) return false;
  sentInThisProcess += 1;
  return true;
}

export async function reportCspViolation(
  violation: CspViolation,
): Promise<void> {
  try {
    if (isNoise(violation)) return;

    const critical = isCritical(violation);
    const fingerprint = cspFingerprint(violation);

    /*
      First, unconditionally, and the point of the whole exercise. `[csp]` is
      the grep; `CRITICAL` marks the ones that would have broken checkout had
      the policy been enforcing, which is the only line anybody needs to find
      after a test payment.
    */
    console.error(
      `[csp]${critical ? " CRITICAL" : ""} ${violation.effectiveDirective} ` +
        `blocked ${violation.blockedUri} on ${violation.documentUri}` +
        (violation.sourceFile
          ? ` · ${violation.sourceFile}:${violation.lineNumber ?? "?"}`
          : "") +
        ` · disposition=${violation.disposition}`,
    );

    const to = ownerEmailAddress();
    if (!to) return;
    if (!getEmailAdapter().isConfigured()) return;

    const perViolation = await consumeRateLimit("cspReport", fingerprint);
    if (!perViolation.allowed) return;

    const overall = await consumeRateLimit("cspReportTotal", "all");
    if (!overall.allowed) return;

    if (!withinProcessBudget(Date.now())) {
      console.error(
        "[csp] in-process email budget spent — logging only. Grep [csp] for " +
          "the full set; the log is not rate-limited.",
      );
      return;
    }

    const result = await getEmailAdapter().send(
      buildCspViolationEmail({
        to,
        directive: violation.effectiveDirective,
        blockedUri: violation.blockedUri,
        documentUri: violation.documentUri,
        sourceFile: violation.sourceFile,
        lineNumber: violation.lineNumber,
        disposition: violation.disposition,
        critical,
        occurredAt: new Date().toISOString(),
      }),
    );

    if (!result.ok) {
      console.error(`[csp] could not send the violation email: ${result.reason}`);
    }
  } catch (reportingError) {
    /*
      Same catch, same reason. Everything above runs to explain a page that may
      already be misbehaving; an exception escaping here would replace that with
      an error about error reporting.
    */
    console.error(
      "[csp] the reporter itself failed:",
      reportingError instanceof Error ? reportingError.message : "unknown",
    );
  }
}
