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
import { spawnSync } from "node:child_process";
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
 * **Every harness that can write must be refused if it points at production.**
 *
 * ## What this rule used to be, and why it was the wrong rule
 *
 * It used to read: *a file that names a raw Supabase credential must import
 * `./clients`*. That caught the Phase 9 wave — `checkout-orders.ts`,
 * `cart-merge.ts` and `zero-stock.ts` reading `.env.local` themselves and
 * writing carts, orders and refunds into the **live shop** on every `npm run
 * audit` — and it was believed complete after four waves of fixes.
 *
 * It was not complete, because it checked the wrong property. Importing
 * `./clients` **repoints** the process at staging; it does not **refuse**
 * anything. The only automatic refusal was `assertNotProduction` at
 * `fixtures.ts`'s module scope. So a harness that imported `./clients` and
 * never touched `./fixtures` scored a clean pass here while being entirely
 * unprotected: with `AUDIT_TARGET=env-local`, or on any checkout where
 * `SUPABASE_STAGE_*` is unset and resolution falls back to `.env.local`, it
 * would write to production. Four harnesses were in that state —
 * `server-actions.ts`, which creates accounts and promotes one to **admin**;
 * `admin-security.ts`; `auth-rls.ts`; and `signed-in.ts` — plus
 * `security-checkout.ts` among the excluded gates.
 *
 * The recurring shape, now three times over: **a gate that proves a property of
 * a helper and never proves the callers get the benefit of it.** The old rule
 * was one more instance of it.
 *
 * ## The rule now
 *
 * A harness that can write must be unable to obtain a production client. There
 * are exactly two ways to satisfy that, and the first is the one that scales:
 *
 *   1. take clients only from `adminClient()` / `anonClient()`, which now refuse
 *      production themselves unless the call says `allowProduction` — so the
 *      protection is a property of the credential and nobody has to remember
 *      it; or
 *   2. if the harness hand-rolls its own `createClient`, and several do for
 *      reasons of their own, call `assertNotProduction()` itself.
 *
 * A writing harness that builds its own client and does neither is the hole
 * this phase found, and it is what fails below.
 *
 * The static check is still only as good as its regexes, so it is no longer the
 * only check: the runtime one underneath actually resolves a process to
 * production and proves the factories throw.
 */
console.log("\n every harness that can write is refused against production:");
{
  /**
   * `clients.ts` defines the refusal; `refusal-probe.ts` exists to be spawned
   * with the refusal deliberately provoked. Neither can be held to the rule.
   */
  const exempt = new Set(["clients.ts", "refusal-probe.ts"]);
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
   * Does this file build a Supabase client with its own hands?
   *
   * `createClient` from `@supabase/supabase-js` (and the SSR variant) takes a
   * URL and a key and asks nothing. A harness calling it directly is outside
   * the factories' refusal and has to carry its own.
   */
  const HAND_ROLLED = /\bcreateClient[<(]/;
  /**
   * Calls the refusal itself, at any scope.
   *
   * Importing `./fixtures` counts and is not a loophole: `fixtures.ts` calls
   * `assertNotProduction("build QA fixtures")` at **module scope**, so importing
   * it throws on load against the live shop. A harness that gets its client
   * from `fixtures` therefore carries the same guard, and demanding a redundant
   * second call would train people to satisfy a checker rather than to be safe.
   */
  const GUARDED =
    /assertNotProduction\(|(^|\n)import\s+(?:[^;]*\sfrom\s+)?["']\.\/fixtures["']/;

  const readOnly: string[] = [];
  const viaFactories: string[] = [];
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
    /*
      A harness that takes every client from the factories is already refused by
      the factories themselves — that is the whole point of moving the guard
      into the credential. Reporting it rather than asserting on it keeps the
      failing list to the files that genuinely have to carry their own guard.
    */
    if (!HAND_ROLLED.test(source)) {
      viaFactories.push(file);
      continue;
    }
    check(`${file} (hand-rolled client)`, GUARDED.test(source), true);
  }

  if (viaFactories.length > 0) {
    console.log(
      `  —     ${viaFactories.length} harnesses take clients only from the ` +
        `factories\n        and are refused by those, not by this list.`,
    );
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

/**
 * Every harness that drives a browser carries **both** guards.
 *
 * The two answer different questions and neither answers the other.
 * `assertNotProduction` is about the database this *process* holds credentials
 * for; `assertServerNotProduction` is about the database the *server at
 * BASE_URL* is backed by. On 2026-08-14 the second was missing across the suite
 * and production picked up two guest carts while the first passed cleanly — the
 * browser wrote to the live shop through a `next start` reading `.env.local`,
 * and every write the admin client made went to staging.
 *
 * The commit that followed added the server guard to all nineteen. It did not
 * add the credential guard to the four that had never needed one, because those
 * four do not write — `a11y`, `admin-pages`, `keyboard`, `keyboard-checkout`.
 * **"It does not write" is a fact about a file today.** The next edit that adds
 * one `.insert(` to reproduce a state invalidates it, silently, and the harness
 * that had no guard is the one that will not grow one in the same commit.
 *
 * So the rule is about what a harness *drives*, not about what it currently
 * does: if it opens a browser at BASE_URL, it carries both. Importing
 * `./fixtures` satisfies the credential half, because that module calls the
 * refusal at module scope.
 */
console.log("\n every harness that drives a browser carries both guards:");
{
  /*
    This file is exempt from its own rule for a reason worth stating: the
    pattern below is written out here as a regex literal, so the source of this
    gate contains the string it searches for and matches itself. It opens no
    browser.
  */
  const exempt = new Set([
    "clients.ts",
    "refusal-probe.ts",
    "fixtures-guard.ts",
  ]);
  /** Opens a browser. `chromium.launch` is the only way any of them does it. */
  const DRIVES_BROWSER = /chromium\.launch\(/;
  const CREDENTIAL_GUARD =
    /(^|[^r])assertNotProduction\(|(^|\n)import\s+(?:[^;]*\sfrom\s+)?["']\.\/fixtures["']/;
  const SERVER_GUARD = /assertServerNotProduction\(/;

  let drivers = 0;
  for (const file of readdirSync("scripts/audit").sort()) {
    if (!file.endsWith(".ts") || exempt.has(file)) continue;
    const source = readFileSync(`scripts/audit/${file}`, "utf8");
    if (!DRIVES_BROWSER.test(source)) continue;
    drivers += 1;
    check(
      `${file} carries the credential guard`,
      CREDENTIAL_GUARD.test(source),
      true,
    );
    check(`${file} carries the server guard`, SERVER_GUARD.test(source), true);
  }

  /*
    A zero-item scan here would print nothing and pass, which is the failure this
    repository has shipped three times — a shell loop that word-split, a grep
    whose flag did not exist on BSD, and a column list nobody had added to. If
    no harness appears to drive a browser, the pattern is wrong, not the suite.
  */
  if (drivers === 0) {
    console.error(
      "\n  No harness matched `chromium.launch(`. That is not a pass — either\n" +
        "  the suite stopped driving browsers or this pattern is wrong.\n",
    );
    process.exit(1);
  }
  console.log(`  —     ${drivers} browser-driving harnesses checked.`);
}

/**
 * **The factories actually refuse — proved by running them, not by reading.**
 *
 * Everything above this line is a regex over source text, and every wave of
 * this bug so far has been a regex that was satisfied by a file that was not
 * safe. So the last check spawns a process whose credential resolution really
 * does land on the production project and asserts that the client factories
 * throw rather than hand it a live connection.
 *
 * A child process because `clients.ts` resolves credentials once at import into
 * module constants: this process resolved to staging, and no amount of
 * reassigning `process.env` afterwards changes what it already decided. See
 * `refusal-probe.ts`.
 *
 * This is the check that can fail. Delete the guard in `adminClient` and it
 * goes red immediately, which is the property the static rules never had.
 */
console.log("\n the factories refuse a production credential (live check):");
{
  const probe = spawnSync(
    "npx",
    ["tsx", "scripts/audit/refusal-probe.ts"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        // Force resolution onto production: `env-local` takes `.env.local` at
        // its word, and this value is set so it does not matter what that file
        // happens to hold on this machine.
        AUDIT_TARGET: "env-local",
        NEXT_PUBLIC_SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
      },
    },
  );
  checks++;
  const passed = probe.status === 0;
  if (!passed) {
    failures++;
    console.log(
      `  FAIL  a process resolved to production was NOT refused\n` +
        (probe.stderr ?? "")
          .trim()
          .split("\n")
          .map((line) => `          ${line}`)
          .join("\n"),
    );
  } else {
    console.log("  ok    adminClient() and anonClient() both threw");
    console.log("  ok    adminClient({ allowProduction: true }) still works");
    checks++; // the probe asserts the teardown exemption too
  }
}

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks\n`,
);
process.exit(failures === 0 ? 0 : 1);
