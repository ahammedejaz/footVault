import "server-only";

import { buildIncidentEmail } from "@/lib/email/incident";
import { getEmailAdapter, ownerEmailAddress } from "@/lib/email";
import { fingerprint, isControlFlow } from "@/lib/errors/classify";
import { consumeRateLimit } from "@/lib/rate-limit";

/**
 * Where a server error goes.
 *
 * Before this, nowhere. A throw on the live shop was written to the platform's
 * runtime log and that was the end of it: the log is not somewhere anyone
 * looks unless they already know something is wrong, which is precisely the
 * thing an error report is supposed to tell them. `NEXT_PUBLIC_SUPABASE_URL`
 * being unset once cost **two hours and 106 visitors** before anyone found
 * out, and what found it out was a person loading the site, not the system.
 *
 * So the sink is email to the owner. Not Sentry, and the reasoning is worth
 * stating because "use a real error tracker" is the obvious objection: an
 * error tracker is a second account, a second dashboard to remember to open,
 * a DSN to keep in sync, and a bill — for a shop whose owner reads one inbox.
 * The email seam already exists, is already verified against the sending
 * domain, and already fails soft. When the volume justifies a tracker this
 * function is the one place that changes.
 *
 * ## Three things this must never do
 *
 * **Throw.** It is called from `onRequestError`, which runs while a request is
 * already failing. An exception here would replace a useful error with a
 * useless one.
 *
 * **Flood.** A single broken page, crawled, produces the same error thousands
 * of times. Both limits below are load-bearing — see `errorReport` and
 * `errorReportTotal` in `rate-limit.ts`.
 *
 * **Report control flow.** `notFound()` and `redirect()` are implemented as
 * throws, and `onRequestError` sees them. Emailing the owner every time a
 * customer hits a 404 would train them to ignore the alerts inside a day,
 * which is worse than having none.
 */

export type ServerErrorReport = {
  error: unknown;
  path: string;
  method: string;
  routePath: string;
  routeType: string;
};

export async function reportServerError(
  input: ServerErrorReport,
): Promise<void> {
  try {
    const error = input.error;
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown");
    const digest =
      typeof error === "object" && error !== null && "digest" in error
        ? String((error as { digest: unknown }).digest)
        : null;

    if (isControlFlow(digest)) return;

    /*
      The log line happens whatever else does, and happens first. If the email
      is throttled, unconfigured, or refused, this is still the record — and it
      is the line a human greps for after the fact.
    */
    console.error(
      `[server-error] ${input.method} ${input.path} · route ${input.routePath} (${input.routeType})` +
        (digest ? ` · digest ${digest}` : ""),
      { message, stack: error instanceof Error ? error.stack : null },
    );

    const to = ownerEmailAddress();
    if (!to) return;

    // A shop with no provider configured prints instead of sending, and an
    // incident email printed to the log it is trying to escape is noise.
    if (!getEmailAdapter().isConfigured()) return;

    const perError = await consumeRateLimit(
      "errorReport",
      fingerprint(input.routePath, digest, message),
    );
    if (!perError.allowed) return;

    const overall = await consumeRateLimit("errorReportTotal", "all");
    if (!overall.allowed) return;

    const adapter = getEmailAdapter();
    const result = await adapter.send(
      buildIncidentEmail({
        to,
        path: input.path,
        method: input.method,
        routePath: input.routePath,
        routeType: input.routeType,
        message,
        digest,
        stack: error instanceof Error ? (error.stack ?? null) : null,
        occurredAt: new Date().toISOString(),
      }),
    );

    if (!result.ok) {
      console.error(
        `[server-error] could not send the incident email: ${result.reason}`,
      );
    }
  } catch (reportingError) {
    /*
      The catch that matters most in the file. Everything above runs while a
      request is already failing; an exception escaping here would replace a
      real error with an error about reporting errors, and the real one would
      be gone.
    */
    console.error(
      "[server-error] the reporter itself failed:",
      reportingError instanceof Error ? reportingError.message : "unknown",
    );
  }
}
