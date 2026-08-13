import { NextResponse } from "next/server";

import { parseCspReport } from "@/lib/errors/csp-classify";
import { reportCspViolation } from "@/lib/errors/report-csp-violation";
import { callerIp, consumeRateLimit } from "@/lib/rate-limit";

/**
 * Where browsers post CSP violation reports.
 *
 * Named in `src/lib/csp.ts` as `CSP_REPORT_PATH`, by both `report-uri` and
 * `report-to`. It exists so the Report-Only bake has somewhere to be heard;
 * without it the policy is a header nobody reads and the flip to enforcing
 * would be a guess.
 *
 * ## It is public, unauthenticated, and must stay that way
 *
 * A browser fires this automatically, from a page it may not have finished
 * loading, with no session and no CSRF token. Any guard that needs one would
 * reject exactly the reports worth having. So the assumptions are the same as
 * for the Razorpay webhook's *pre-signature* state: **anyone on the internet
 * can POST anything here**, and nothing downstream may treat the contents as
 * true.
 *
 * What that means concretely, and what each defence is for:
 *
 *   - **A body cap before parsing.** `Content-Length` is checked first and the
 *     stream is read as text with a hard ceiling, because `request.json()` on
 *     an unbounded body is how a public endpoint becomes a memory incident.
 *   - **A per-IP limit before parsing**, spent whatever the body turns out to
 *     be. `cspReportIngest`.
 *   - **Per-violation limits after classification**, in their own buckets so
 *     CSP noise cannot spend the budget a real server error needs. See
 *     `rate-limit.ts`.
 *   - **Nothing is stored.** Reports go to the log and, rarely, to one email
 *     address. There is no table for an attacker to fill.
 *
 * ## What is proven about this endpoint, and what is not
 *
 * **Proven** (`audit:headers` §9, and by hand): it accepts both wire formats,
 * strips the query off the document URI, classifies extension noise out,
 * collapses per-page duplicates onto one fingerprint, answers 204 to malformed
 * and oversized bodies, and writes a `[csp]` line the moment a report arrives.
 *
 * **Not proven: that a browser actually delivers to it.** Chromium driven by
 * Playwright detects violations — the console message appears — and then sends
 * nothing. Verified across headless, headed, and with
 * `--disable-background-networking` removed, watching at CDP level
 * (`Network.requestWillBeSent`) for ninety seconds. Zero report requests in
 * every case.
 *
 * That is very likely the harness rather than the browser: report delivery is
 * background networking, which automation environments routinely suppress, and
 * Chrome prefers the batched `report-to` path over `report-uri` when a policy
 * offers both. But it was not possible to demonstrate delivery here, so it is
 * written down as unproven rather than assumed — a sink nobody has watched
 * receive is exactly the kind of thing that gets trusted by default.
 *
 * **What this means for the bake.** Do not treat silence at this endpoint as
 * "no violations". During the test payment the **browser console is the primary
 * instrument** — a violation always logs there, in every browser, with no
 * delivery step to fail — and this endpoint is the secondary one that keeps
 * listening afterwards for what real customers hit. If `[csp]` lines do appear
 * in the production log, delivery works and the console can be retired as the
 * primary. If they never appear, that is a fact about reporting, not a clean
 * bill of health.
 *
 * ## Always 204
 *
 * Every path returns `204 No Content`, including the rejected ones. A browser
 * does not act on the status — there is no retry, no backoff, no fallback — so
 * a status code here communicates only with whoever is probing the endpoint.
 * A 429 or a 400 would tell them where the limits are and which bodies parse;
 * 204 tells them nothing and costs us nothing. This is the opposite of the
 * reasoning in `api/[...unmatched]`, where the caller is Razorpay and the
 * status is load-bearing — worth noting, because the two rules look
 * contradictory until you ask who is reading the response.
 */

export const dynamic = "force-dynamic";

/**
 * 64 KB. A real violation report is a few hundred bytes; the `original-policy`
 * field is the only large part and this policy is under 1 KB. Batched
 * `reports+json` deliveries can carry several at once, so the ceiling is
 * generous enough for a genuine batch and nowhere near enough to be useful as
 * an upload target.
 */
const MAX_BODY_BYTES = 64 * 1024;

/** One response object, so no path can accidentally answer differently. */
function noContent(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const throttle = await consumeRateLimit("cspReportIngest", await callerIp());
    if (!throttle.allowed) return noContent();

    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return noContent();
    }

    /*
      Read as text and measure, rather than trusting Content-Length — it is a
      client-supplied number and a chunked body has none at all.
    */
    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) return noContent();

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      // Not JSON. A crawler, a scanner, or a browser we do not know about.
      // Silence is the correct amount of attention to pay it.
      return noContent();
    }

    const violations = parseCspReport(payload);

    /*
      Awaited rather than fired and forgotten. On a serverless platform the
      instance can be frozen the moment the response is returned, so an
      un-awaited report is one that sometimes vanishes — and "sometimes" is the
      worst possible property for the instrument the enforce/report decision
      rests on. The reporter's own limits keep the cost bounded.
    */
    for (const violation of violations) {
      await reportCspViolation(violation);
    }

    return noContent();
  } catch (error) {
    console.error(
      "[csp] the report endpoint itself failed:",
      error instanceof Error ? error.message : "unknown",
    );
    return noContent();
  }
}

/**
 * A GET here is somebody poking at the URL, not a browser reporting anything.
 * 204 rather than 405 for the same reason as above: it says nothing.
 */
export async function GET(): Promise<NextResponse> {
  return noContent();
}
