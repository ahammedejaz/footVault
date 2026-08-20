import "server-only";

import { deployedCommit } from "@/lib/deploy/version";

/**
 * Whether the build that is answering this request is the one at the tip of the
 * production branch.
 *
 * **This is the check that did not exist on 2026-08-20**, when Vercel refused
 * four deployments in a row before any build started, `main` moved three
 * commits ahead, every CI job stayed green, and the shop quietly went on
 * serving a build from six days earlier. Nothing in the panel, the gates or CI
 * could see it. A person noticed the colour behind a photograph.
 *
 * `unknown` is deliberately not a fourth flavour of `clean`. Determining the
 * *expected* side means asking GitHub for the tip of `main`, and what that
 * takes has changed once already: the check shipped on the morning of
 * 2026-08-20 believing the repository private, was corrected the same night
 * when it turned out to be public — and then the owner **made it private** on
 * 2026-08-20, which is the state it is in now. A private repository answers an
 * unauthenticated request with **404, not 403** (GitHub hides that the
 * repository exists at all), so without `GITHUB_REPO_TOKEN` the card degrades
 * to "unverified" with that exact remedy named. It never falls back to a green
 * verdict: the page's standing rule is that a wrong "fine" teaches the owner to
 * stop opening the page, and there is no version of this check worth having
 * that can be satisfied by not looking.
 *
 * Lives in its own module, importable without the rest of the health page's
 * Supabase machinery, so `audit:deploy-drift` can hold every branch of this
 * verdict — 404, 403, drift, garbage, network failure — against a mocked
 * `fetch` and prove none of them reads as "in sync".
 */
export type DeploymentHealth =
  | {
      state: "in_sync";
      deployed: string;
      ref: string | null;
      environment: string | null;
    }
  | {
      state: "drifted";
      deployed: string;
      expected: string;
      ref: string | null;
      environment: string | null;
    }
  | {
      /** The build knows its commit; nothing could be learned about the branch. */
      state: "expected_unknown";
      deployed: string;
      ref: string | null;
      environment: string | null;
      reason: string;
    }
  | { state: "unknown"; reason: string };

/**
 * The deployed commit, and the tip of the branch it claims to be built from.
 *
 * The deployed side is free — Vercel bakes it into the bundle at build time, so
 * a stale build reports its own staleness rather than something newer.
 *
 * The expected side costs a network call to GitHub, and since 2026-08-20 the
 * repository is **private**, so the call needs `GITHUB_REPO_TOKEN` — a
 * fine-grained PAT with read-only Contents on this one repository; the exact
 * clicks are in `docs/operations.md`. Without it GitHub answers 404 and this
 * returns `expected_unknown` with the remedy in the reason; it does **not**
 * fall back to reporting the deployed commit as correct, because a check that
 * passes when it cannot see is worse than no check — it is a check that lies.
 *
 * Failures here are caught and reported rather than thrown: this is one card on
 * a page whose whole job is to be openable when things are broken, and taking
 * the page down to report that GitHub is slow would be the wrong trade.
 */
export async function readDeployment(): Promise<DeploymentHealth> {
  const commit = deployedCommit();
  if (commit.state === "unknown") {
    return { state: "unknown", reason: commit.reason };
  }

  const token = process.env.GITHUB_REPO_TOKEN;
  const owner = process.env.VERCEL_GIT_REPO_OWNER;
  const repo = process.env.VERCEL_GIT_REPO_SLUG;
  const branch = commit.ref ?? "main";

  const base = {
    deployed: commit.sha,
    ref: commit.ref,
    environment: commit.environment,
  };

  if (!owner || !repo) {
    return {
      state: "expected_unknown",
      ...base,
      reason:
        "VERCEL_GIT_REPO_OWNER / VERCEL_GIT_REPO_SLUG are not set on this build.",
    };
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
      {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          Accept: "application/vnd.github+json",
          "User-Agent": "footvault-health",
        },
        // Never cached. The whole question is "what is true right now", and a
        // cached answer is how this reports the previous tip and passes.
        cache: "no-store",
        signal: AbortSignal.timeout(6_000),
      },
    );
    if (!response.ok) {
      return {
        state: "expected_unknown",
        ...base,
        reason:
          `GitHub answered ${response.status} for ${owner}/${repo}@${branch}.` +
          (response.status === 404 && !token
            ? " The repository is private and no GITHUB_REPO_TOKEN is set — GitHub hides a private repository as 404 rather than 403. Add the token in Vercel (docs/operations.md has the exact clicks) and redeploy."
            : response.status === 403
              ? token
                ? " The token was sent and refused — it may have expired or lost access to the repository."
                : " Likely the unauthenticated rate limit (60/hr per IP, shared on Vercel) — a GITHUB_REPO_TOKEN raises it to 5,000/hr."
              : ""),
      };
    }
    const body: unknown = await response.json();
    const expected =
      typeof body === "object" && body !== null && "sha" in body
        ? String((body as { sha: unknown }).sha).toLowerCase()
        : "";
    if (!/^[0-9a-f]{40}$/.test(expected)) {
      return {
        state: "expected_unknown",
        ...base,
        reason: "GitHub did not return a commit SHA for that branch.",
      };
    }
    return expected === commit.sha
      ? { state: "in_sync", ...base }
      : { state: "drifted", ...base, expected };
  } catch (error) {
    return {
      state: "expected_unknown",
      ...base,
      reason:
        error instanceof Error
          ? `Could not reach GitHub: ${error.message}`
          : "Could not reach GitHub.",
    };
  }
}
