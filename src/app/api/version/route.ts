import { NextResponse } from "next/server";

import { deployedCommit } from "@/lib/deploy/version";

/**
 * Which commit the shop is serving, readable from outside.
 *
 * ## Why this is public
 *
 * The drift check has to answer "what is production *actually* serving", and
 * every other way of asking is a way of asking something subtly different.
 * `/admin/health` knows, but it is behind the admin guard, so a gate would need
 * an admin session to read it — and a check that needs a login is a check that
 * stops being run. The Vercel API knows which deployment is *aliased*, but that
 * is the deployment record rather than the bytes on the wire, and the whole
 * lesson of 2026-08-20 is that a deployment's own state is not evidence about
 * what a customer receives.
 *
 * So the answer comes from the build itself, over HTTP, with no credentials —
 * which also means the check runs identically from a laptop, from CI, and from
 * a cron.
 *
 * **What this discloses is a commit SHA, and that is all.** The repository is
 * private; a SHA is an opaque 40-hex digest that grants no access to it, and it
 * reveals nothing about the code, the schema or any customer. Vercel already
 * publishes a per-deployment id on every HTML response for the same reason. The
 * ref is included because "which branch is live" is the other half of the
 * question, and it is `main` on production and no secret either.
 *
 * `no-store`, because a cached answer to "what is deployed right now" is the
 * one answer that is worse than none — it is how a check reports the previous
 * deployment as current and passes.
 */
export const dynamic = "force-dynamic";

export function GET() {
  const commit = deployedCommit();

  const body =
    commit.state === "known"
      ? {
          state: "known" as const,
          commit: commit.sha,
          ref: commit.ref,
          environment: commit.environment,
        }
      : { state: "unknown" as const, reason: commit.reason };

  return NextResponse.json(body, {
    // 200 either way. "I do not know which commit I am" is a truthful answer to
    // this question, not a server error, and the caller is required to treat it
    // as a failure of the *check* rather than of the request — see
    // scripts/audit/deploy-drift.ts.
    status: 200,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
