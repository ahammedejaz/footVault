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

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks\n`,
);
process.exit(failures === 0 ? 0 : 1);
