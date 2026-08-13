/**
 * The door the owner shut stays shut — and the one the fixtures need stays open.
 *
 * Phase 11's audit (11D.1) found production GoTrue with the email provider on
 * and `mailer_autoconfirm` true: anyone holding the anon key that ships in the
 * browser bundle could mint confirmed accounts against addresses they do not
 * own. The owner closed it in the dashboard on 2026-08-11. A dashboard toggle
 * is fixed-until-somebody-clicks-something; this gate turns it into a standing
 * invariant, which is the difference.
 *
 * **Both projects, now the same assertion.** This gate used to require the
 * opposite of each other:
 *
 *   - **Production**: the email provider must be OFF. Every per-account grant
 *     in the loyalty programme is farmable exactly as cheaply as an account, so
 *     accounts must cost a Google identity, not a made-up address. Unchanged.
 *   - **Staging**: the email provider must be **ON** — because
 *     `scripts/audit/fixtures.ts` signed its QA accounts up with email and
 *     password, so the whole suite depended on staging holding a door open that
 *     production had correctly shut.
 *
 * That second assertion was the problem wearing the costume of a test. It
 * pinned a security control to *disabled* on the grounds that the test harness
 * needed it, which is backwards: it made the suite go dark the moment somebody
 * did the right thing, and it made "turn signup off on staging too" look like a
 * regression. Stage 2 removed the dependency — `scripts/audit/accounts.ts`
 * mints through the service-role admin API and works with signup *and* email
 * login disabled — so the door is no longer load-bearing and staging has been
 * closed to match.
 *
 * The staging half therefore now asserts the same thing production does. The
 * two projects no longer differ on this setting at all, which is one fewer
 * divergence to remember and one fewer way for a gate to depend on a weakness.
 *
 * Read-only: one anonymous GET per project against `/auth/v1/settings`, the
 * same endpoint every browser hits before sign-in. No client is built and
 * nothing can write.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { STAGING_PROJECT_REF } from "../staging-env";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The production project, named here for the same reason `clients.ts` names
 * it: an assertion about "whatever .env.local says" would silently assert
 * against staging the day someone repoints the file. This gate is *about*
 * production; if `.env.local` no longer names it, that is a failure to
 * report, not a different project to interrogate.
 */
const PRODUCTION_PROJECT_REF = "ahumjhwqgmskjsitctcj";

/** Raw parse, not process.env: clients.ts rewrites the runtime names. */
function envLocal(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(REPO_ROOT, ".env.local"), "utf8").split(
    "\n",
  )) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2];
  }
  return out;
}

type GoTrueSettings = {
  external?: { email?: boolean; google?: boolean };
  disable_signup?: boolean;
  mailer_autoconfirm?: boolean;
};

async function settings(url: string, anonKey: string): Promise<GoTrueSettings> {
  const response = await fetch(`${url.replace(/\/$/, "")}/auth/v1/settings`, {
    headers: { apikey: anonKey },
  });
  if (!response.ok) {
    throw new Error(`GET /auth/v1/settings → ${response.status}`);
  }
  return (await response.json()) as GoTrueSettings;
}

let failures = 0;

function check(label: string, pass: boolean, detail: string): void {
  if (!pass) failures++;
  console.log(`  ${pass ? "ok  " : "FAIL"}  ${label}${pass ? "" : ` — ${detail}`}`);
}

async function main(): Promise<void> {
  console.log("\nSignup closure gate\n");
  const env = envLocal();

  const prodUrl = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const prodKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  const stageUrl = env.SUPABASE_STAGE_URL ?? "";
  const stageKey = env.SUPABASE_STAGE_ANON_KEY ?? "";

  console.log(" production — accounts must cost a Google identity:");
  check(
    ".env.local names the production project",
    prodUrl.includes(PRODUCTION_PROJECT_REF),
    `NEXT_PUBLIC_SUPABASE_URL is ${prodUrl || "unset"}; this gate asserts ` +
      "against production and refuses to interrogate a stand-in",
  );
  if (prodUrl.includes(PRODUCTION_PROJECT_REF) && prodKey) {
    const prod = await settings(prodUrl, prodKey);
    check(
      "email provider is off",
      prod.external?.email === false,
      `external.email = ${String(prod.external?.email)} — the free-account door is open again`,
    );
    check(
      "google provider is on",
      prod.external?.google === true,
      "google sign-in is the only door and it appears shut — customers cannot sign in",
    );
  }

  console.log("\n staging — closed too; the fixtures no longer need it open:");
  check(
    ".env.local names the staging project",
    stageUrl.includes(STAGING_PROJECT_REF),
    `SUPABASE_STAGE_URL is ${stageUrl || "unset"}`,
  );
  if (stageUrl.includes(STAGING_PROJECT_REF) && stageKey) {
    const stage = await settings(stageUrl, stageKey);
    check(
      "email provider is off",
      stage.external?.email === false,
      `external.email = ${String(stage.external?.email)} — staging no longer ` +
        "needs this open, and an open signup on any internet-reachable " +
        "project is a door with nothing behind it but a bill",
    );
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
