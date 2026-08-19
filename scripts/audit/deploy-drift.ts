/**
 * `npm run audit:deploy-drift` — is the shop serving what was merged?
 *
 * ## The failure this is written against
 *
 * On 2026-08-20 Vercel refused four deployments in a row with `readyState:
 * BLOCKED` and `buildingAt == ready == createdAt`. No build ever started, so
 * there were no logs to read and nothing failed in any way that looked like a
 * failure. `main` moved three commits ahead. Every CI job stayed green. The
 * shop went on serving a build from six days earlier, and the *only* reason
 * anybody found out was a person opening the storefront and noticing the colour
 * behind a photograph.
 *
 * Every check this project owns asks whether the code is correct. **None of
 * them asked whether the code is running**, and those are different questions
 * with the same answer almost all of the time — which is exactly what makes the
 * gap so hard to notice.
 *
 * ## What it compares, and why from these two places
 *
 * - **served**: `GET /api/version` on the live site. Not the Vercel deployment
 *   record, which says which deployment is *aliased* — a fact about Vercel's
 *   intent rather than about the bytes a customer receives. The build reports
 *   its own identity, baked in at build time, so a stale build cannot claim to
 *   be a newer one.
 * - **expected**: `git rev-parse origin/main`, after a fetch. Local git is the
 *   one place the branch tip is knowable for free and without a credential.
 *
 * ## The rule that makes it worth having
 *
 * **It exits non-zero whenever it cannot establish either side.** "Could not
 * read" is not "in sync". A check that goes quiet when the network is down, or
 * when an env var was renamed, or when the endpoint 404s, is the same shape of
 * bug as the one it exists to catch: something that reports no problem because
 * it is not looking.
 *
 * ## Proving it red
 *
 *   npm run audit:deploy-drift -- --expect <a-deliberately-stale-sha>
 *
 * overrides the expected side so the failure path can be exercised on demand.
 * It announces the override in its output, so an overridden run can never be
 * mistaken for a real green one.
 */

import { execFileSync } from "node:child_process";

/** Production, and www rather than the apex — the apex is a redirect. */
const DEFAULT_BASE = "https://www.footvault.in";
const BASE = (process.env.DRIFT_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, "");

const args = process.argv.slice(2);
const expectFlag = args.indexOf("--expect");
const expectOverride =
  expectFlag !== -1 ? (args[expectFlag + 1] ?? "").toLowerCase() : null;

const dim = "\x1b[2m";
const red = "\x1b[31m";
const green = "\x1b[32m";
const bold = "\x1b[1m";
const off = "\x1b[0m";

function fail(headline: string, detail: string): never {
  console.log(`\n${red}${bold}✗ ${headline}${off}`);
  console.log(`  ${detail}\n`);
  process.exit(1);
}

/** The tip of the production branch, or a refusal. Never a guess. */
function expectedSha(): string {
  if (expectOverride !== null) {
    if (!/^[0-9a-f]{7,40}$/.test(expectOverride)) {
      fail(
        "the --expect override is not a SHA",
        `got ${JSON.stringify(expectOverride)}`,
      );
    }
    return expectOverride;
  }
  try {
    // Fetched first: a stale remote ref would compare the deployment against
    // whatever this machine last happened to see, which is a green tick that
    // means nothing.
    execFileSync("git", ["fetch", "origin", "main", "--quiet"], {
      stdio: "ignore",
      timeout: 60_000,
    });
  } catch {
    fail(
      "could not fetch origin/main",
      "The expected side is unknown, so this check cannot pass. Fix the network or the remote and run it again.",
    );
  }
  try {
    return execFileSync("git", ["rev-parse", "origin/main"], {
      encoding: "utf8",
      timeout: 30_000,
    })
      .trim()
      .toLowerCase();
  } catch (error) {
    fail(
      "could not read origin/main",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** What the live site says it is, or a refusal. */
async function servedSha(): Promise<{ sha: string; ref: string | null }> {
  const url = `${BASE}/api/version`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    fail(
      `could not reach ${url}`,
      `${error instanceof Error ? error.message : String(error)}\n  The served side is unknown, so this check cannot pass.`,
    );
  }
  if (!response.ok) {
    fail(
      `${url} answered ${response.status}`,
      "The served side is unknown, so this check cannot pass. If this is a 404 the deployed build predates /api/version — which is itself drift.",
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    fail(`${url} did not return JSON`, "The served side is unknown.");
  }
  const record = body as Record<string, unknown>;
  if (record.state !== "known") {
    fail(
      "the live build does not know which commit it is",
      `${String(record.reason ?? "no reason given")}\n  The served side is unknown, so this check cannot pass.`,
    );
  }
  const sha = String(record.commit ?? "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    fail(
      "the live build reported a malformed commit",
      JSON.stringify(record).slice(0, 200),
    );
  }
  return { sha, ref: record.ref === null ? null : String(record.ref) };
}

async function main() {
  console.log(`\n${bold}deploy drift${off}  ${dim}${BASE}${off}`);
  if (expectOverride !== null) {
    console.log(
      `${red}  ⚠ --expect override in use (${expectOverride}); this is a control run, not a real check.${off}`,
    );
  }

  const expected = expectedSha();
  const served = await servedSha();

  // Compare on the shorter of the two, so a 7-character override still means
  // something against a 40-character served SHA.
  const width = Math.min(expected.length, served.sha.length);
  const same = expected.slice(0, width) === served.sha.slice(0, width);

  console.log(`  serving   ${served.sha}${served.ref ? `  (${served.ref})` : ""}`);
  console.log(`  origin/main ${expected}`);

  if (!same) {
    fail(
      "production is NOT serving the tip of main",
      `serving      ${served.sha}\n  origin/main  ${expected}\n\n  Merged work is not live. The usual cause is a deployment that never\n  built — Vercel reports those as BLOCKED with no logs, and \`gh pr checks\`\n  renders them indistinguishably from a compile error. Check the project's\n  production target and read \`readyStateReason\`, not the check name.`,
    );
  }

  console.log(`\n${green}${bold}✓ production is serving the tip of main${off}\n`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
