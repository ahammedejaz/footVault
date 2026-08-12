import "server-only";

import { timingSafeEqual } from "node:crypto";

/**
 * The one bearer-token check every pg_cron-driven route uses.
 *
 * Extracted from `release-abandoned-orders/route.ts` when the delivery poller
 * became the second such route — two copies of a token comparison is how one
 * of them ends up with `===`. The properties, unchanged from the original:
 *
 *  - **Constant-time compare.** `===` on a secret leaks its prefix through
 *    timing; marginal over the public internet, and it costs one function.
 *  - **Absent `CRON_SECRET` denies everything.** The alternative — unset
 *    meaning "open" — is how a route quietly becomes public the first time an
 *    environment variable fails to copy across.
 *  - Length compared first: `timingSafeEqual` throws on a mismatch, which
 *    would itself be a length oracle and a 500.
 */
export function authorisedCronRequest(
  request: Request,
  label: string,
): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) {
    console.error(
      `[${label}] CRON_SECRET is not set, so every request is refused. ` +
        "Set it in the Vercel project and in the Vault secret pg_cron reads.",
    );
    return false;
  }

  const header = request.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (offered.length === 0) return false;

  const a = Buffer.from(offered, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
