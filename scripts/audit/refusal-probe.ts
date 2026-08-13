/**
 * The subject of `audit:fixtures-guard`'s runtime check. Not a gate itself.
 *
 * `fixtures-guard` spawns this file with `NEXT_PUBLIC_SUPABASE_URL` forced to
 * the production project and `AUDIT_TARGET=env-local`, so credential resolution
 * in `./clients` lands on the live shop. It then asserts on this process's exit
 * code.
 *
 * ## Why a child process
 *
 * `clients.ts` resolves its credentials once, at import, into module constants.
 * A test inside the guard's own process could therefore only ever measure the
 * one resolution that process already made — which is staging, which is the
 * case that is *supposed* to pass. Proving the refusal requires a process that
 * genuinely resolved to production, and that means a new one.
 *
 * ## Why this exists at all
 *
 * For four waves the guard proved that `clients.ts` *recognises* production and
 * that harnesses *import* it. It never proved that anything **refuses**, and
 * the fifth wave was a harness that imported the chokepoint, resolved to
 * production, and would have written there — passing the guard the whole time.
 * The refusal now lives in the client factories, and this is how that claim is
 * checked by running it rather than by reading the source.
 *
 * Exits 0 only if the factories behaved correctly. Nothing here touches the
 * network: a refusal throws before any client is constructed, and the
 * `allowProduction` case builds a client object without issuing a request.
 */
import { adminClient, anonClient, supabaseUrl } from "./clients";

const failures: string[] = [];

/** The environment the guard set up must actually have taken effect. */
if (!supabaseUrl().includes("ahumjhwqgmskjsitctcj")) {
  failures.push(
    `the probe did not resolve to production (got ${supabaseUrl() || "unset"}) — ` +
      `the check below would have proved nothing`,
  );
}

/** Both factories must refuse by default. */
for (const [name, build] of [
  ["adminClient", () => adminClient()],
  ["anonClient", () => anonClient()],
] as const) {
  try {
    build();
    failures.push(`${name}() returned a production client instead of throwing`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("production database")) {
      failures.push(
        `${name}() threw, but not the production refusal: ${message.split("\n")[0]}`,
      );
    }
  }
}

/**
 * And the one documented exemption must still work.
 *
 * Asserted so that a future change which "fixes" the guard by making the
 * refusal unconditional fails here instead of silently breaking `teardown.ts`,
 * which is the only way to clean QA rows out of the live shop.
 */
try {
  adminClient({ allowProduction: true });
} catch (error) {
  failures.push(
    `adminClient({ allowProduction: true }) threw — teardown can no longer ` +
      `reach production: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
  );
}

for (const failure of failures) console.error(failure);
process.exit(failures.length === 0 ? 0 : 1);
