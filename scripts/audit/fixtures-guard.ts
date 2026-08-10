/**
 * The guard that stands between `npm run audit` and the live shop.
 *
 * This is the test for a bug that had not fired yet and was one command away
 * from firing. `.env.local` was pointed at production during Phase 8 — live
 * Razorpay keys included — and `fixtures.ts` builds its clients from whatever
 * it finds there. `npm run audit` would have signed up QA accounts, filled
 * carts and placed real orders inside the shop, beside real customers, and
 * reported a pass.
 *
 * So the assertions below are deliberately about the *shapes a project ref
 * arrives in* rather than one spelling of one URL. The guard is worth having
 * only if it recognises production however it is written down.
 *
 * Read-only. It writes nothing, anywhere, by construction — it never builds a
 * client at all.
 */
import { readdirSync, readFileSync } from "node:fs";

import {
  isProductionUrl,
  PRODUCTION_PROJECT_REF,
  supabaseUrl,
} from "./clients";

let failures = 0;
let checks = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  checks++;
  const pass = actual === expected;
  if (!pass) failures++;
  console.log(
    `  ${pass ? "ok  " : "FAIL"}  ${label}` +
      (pass ? "" : `\n          expected ${expected}, got ${actual}`),
  );
}

console.log("\nFixtures production guard\n");

console.log(" recognises production in every shape it is written:");
for (const url of [
  `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
  `https://${PRODUCTION_PROJECT_REF}.supabase.co/`,
  `HTTPS://${PRODUCTION_PROJECT_REF}.supabase.co`.toLowerCase(),
  `postgresql://postgres.${PRODUCTION_PROJECT_REF}:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`,
  `https://${PRODUCTION_PROJECT_REF}.supabase.co/rest/v1/orders`,
]) {
  check(url.slice(0, 72), isProductionUrl(url), true);
}

console.log("\n does not fire on anything else:");
for (const url of [
  "https://footvault-staging.supabase.co",
  "http://127.0.0.1:54321",
  "http://localhost:54321",
  "",
]) {
  check(url === "" ? "(empty)" : url, isProductionUrl(url), false);
}

/**
 * The one that matters most, and the only one that can catch a real mistake
 * rather than a logic slip: what is `.env.local` pointed at *right now*?
 *
 * Not an assertion — pointing at production is a legitimate state for the repo
 * to be in, and `teardown.ts` needs it. It is reported so that anybody running
 * the suite knows which database they are about to measure, and so that a
 * `SAFE` line is never printed while the live shop is the target.
 */
console.log("\n current .env.local target:");
const current = supabaseUrl();
if (isProductionUrl(current)) {
  console.log(
    `  ⚠  PRODUCTION (${current})\n` +
      "     fixtures.ts will refuse to run. That is correct — point .env.local\n" +
      "     at staging before running the fixture-building audits.",
  );
} else {
  console.log(`  SAFE (${current || "unset"})`);
}

/**
 * **Every harness that can write must go through `clients.ts`.**
 *
 * The guard above proves `clients.ts` recognises production. It cannot prove
 * that the harnesses actually *ask* it — and for the whole of Phases 7 and 8
 * three of them did not. `checkout-orders.ts`, `cart-merge.ts` and
 * `zero-stock.ts` each read `.env.local` themselves, built a service-role
 * client from `NEXT_PUBLIC_SUPABASE_URL`, and therefore wrote guest carts,
 * orders, payments, refunds and stock movements into the **live shop** on every
 * run of `npm run audit`. Nothing failed. The suite reported a pass. It was
 * found in Phase 9 only because a new migration was missing from the database
 * a run was really talking to.
 *
 * That is the same shape as this phase's headline finding: a gate that proves a
 * property of a helper, and never proves the callers use the helper. So this
 * check reads the directory rather than trusting anyone to remember.
 *
 * The rule: a file in `scripts/audit/` that names a raw Supabase credential must
 * import `./clients`, which repoints the process at staging and gives
 * `assertNotProduction` somewhere to stand. `clients.ts` itself is exempt — it
 * is the thing being imported.
 */
console.log("\n every harness that can write goes through ./clients:");
{
  /** `clients.ts` is the thing being imported; it cannot import itself. */
  const exempt = new Set(["clients.ts"]);
  /**
   * Anything that can change a row. `.rpc(` counts: most of them mutate.
   *
   * **The write is the trigger, not the credential.** The first version of this
   * check also required the file to *name* `NEXT_PUBLIC_SUPABASE_URL` or a key,
   * which missed `shipping.ts` entirely: it gets its database through the app's
   * own `createAdminClient()` and names nothing — while creating and deleting
   * `shipments` rows in the live shop. How a harness obtains a client is not the
   * question. Whether it can write is.
   */
  const WRITES = /\.(insert|update|upsert|delete|rpc)\(/;
  /** Kept only to describe the read-only files in the summary line. */
  const CREDENTIAL =
    /NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|NEXT_PUBLIC_SUPABASE_ANON_KEY|createAdminClient|adminClient\(/;
  /**
   * `./clients` directly, or `./fixtures` — which is not a loophole.
   *
   * `fixtures.ts` imports `./clients` and calls `assertNotProduction("build QA
   * fixtures")` at **module scope**, so importing it throws on load against the
   * live shop. A harness that gets its client from `fixtures` therefore carries
   * the same guard, and demanding a redundant second import would train people
   * to add imports to satisfy a checker rather than to be safe.
   */
  const IMPORTS_CLIENTS =
    /(^|\n)import\s+(?:[^;]*\sfrom\s+)?["']\.\/(clients|fixtures)["']/;

  const readOnly: string[] = [];
  for (const file of readdirSync("scripts/audit").sort()) {
    if (!file.endsWith(".ts") || exempt.has(file)) continue;
    const source = readFileSync(`scripts/audit/${file}`, "utf8");
    /*
      A write only counts when the file can reach a database at all. The
      WRITES pattern alone false-positived on `createHmac(...).update(...)`
      in inbound-email.ts — a pure gate with no Supabase anywhere — and the
      suite sat red on it from the day that gate learned to sign a webhook.
      Requiring a credential *and* a write keeps the shipping.ts lesson (it
      reaches production through `createAdminClient` and names no raw env
      var, which is why CREDENTIAL lists the factories) without flagging
      method names that merely collide with PostgREST's.
    */
    const writes = WRITES.test(source) && CREDENTIAL.test(source);
    if (!writes) {
      if (CREDENTIAL.test(source)) readOnly.push(file);
      continue;
    }
    check(file, IMPORTS_CLIENTS.test(source), true);
  }

  /*
    Printed rather than passed over. Two harnesses read `.env.local` verbatim on
    purpose — `literals.ts` checks the *shop's own* owner-edited copy for
    currency literals and `payment-health.ts` runs the dashboard's query against
    real rows — and pointing either at a seeded staging database would quietly
    turn a real assertion into an assertion about fixtures. That is a defensible
    exemption and it is exactly the kind of thing that stops being defensible the
    moment it stops being visible, so it is named on every run.
  */
  if (readOnly.length > 0) {
    console.log(
      `  —     read-only, exempt: ${readOnly.join(", ")}\n` +
        "        these may reach production; they never write.",
    );
  }
}

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks\n`,
);
process.exit(failures === 0 ? 0 : 1);
