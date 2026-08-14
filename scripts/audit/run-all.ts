/**
 * Run every gate, then report. Not `&&`.
 *
 *   npm run audit
 *
 * ## Why this file exists
 *
 * `npm run audit` was thirty-two `npm run audit:x && …` in one line, and a
 * chain reports the *first* failure and nothing after it. On 2026-08-09
 * `audit:bag` timed out — the harness clicking a quantity stepper that staging's
 * stock had correctly disabled — and the eleven gates behind it never ran. The
 * suite exited 1 having said nothing at all about checkout, admin, shipping,
 * totals, delivery or parcels. A red run has to tell you everything that is
 * red, or the next person fixes one thing and reruns twelve minutes of browser
 * gates to discover the second.
 *
 * Fail-fast is the wrong trade here for a specific reason: these gates are slow
 * and mostly independent. Stopping early saves minutes; not stopping saves the
 * round trip.
 *
 * ## Order is deliberate
 *
 * `fixtures-guard` runs second, before anything that can write a row, because
 * it is the check that the harness is pointed at staging. The pure gates come
 * before the browser gates so a typo in a template fails in two seconds rather
 * than after ten minutes of Playwright.
 *
 * ## The list is explicit, and drift is a failure
 *
 * Deriving it from `package.json` would sweep in `audit:teardown`, which
 * deletes fixtures, and `audit:shots`, which writes screenshots — neither is a
 * gate. So the list is written out, and `EXCLUDED` names the ones deliberately
 * left out. Anything in `package.json` that appears in neither is a *failure*,
 * not a warning: the whole point is that a gate added next month cannot be
 * silently absent from the suite, which is the same trick as `keyFor()` in
 * `src/lib/queries/cached.ts` — make forgetting impossible rather than
 * unlikely.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

/** Every gate, in the order they should run. */
const GATES = [
  // Pure: no browser, no network. Seconds, and they catch the cheap mistakes.
  //
  // `shapes` is not an `audit:*` script, but it is a gate: it fails when a
  // cached return type changed and SHAPE_VERSION did not. Until 2026-08-12 it
  // ran only in ci.yml, so a real shape change (ratings, Phase 11 Batch A)
  // gated green on staging and went red on the PR — a check that only runs
  // where nobody looks. The drift check below polices only `audit:*` names,
  // so this entry is kept by hand, next to the pure gates it belongs with.
  "shapes",
  "audit:literals",
  "audit:headers",
  "audit:fixtures-guard",
  "audit:signup-closed",
  "audit:emails",
  "audit:inbound-email",
  "audit:error-reporting",
  "audit:refund-message",
  "audit:customer-copy",
  "audit:settings-visibility",
  "audit:homepage-tokens",
  "audit:privacy",
  "audit:contact",
  // Database-backed, read-mostly.
  "audit:refunds",
  "audit:coupons",
  "audit:transitions",
  "audit:rto",
  "audit:reconciler",
  "audit:payment-health",
  "audit:delivery-poll",
  "audit:reviews",
  "audit:coins-earning",
  "audit:coins-redemption",
  "audit:images",
  // Browser. Slow, and the reason this file exists.
  "audit:overflow",
  "audit:a11y",
  "audit:keyboard",
  "audit:keyboard-checkout",
  "audit:focus",
  "audit:gallery",
  "audit:hero-media",
  "audit:hydration",
  "audit:interactions",
  "audit:links",
  /*
    HTTP, not a browser. Sections 1-3 run against dev:stage; section 4 drives a
    real Server Action and needs a built artifact, so it skips loudly under dev
    and is exercised in full by the deploy sequence.
  */
  "audit:rate-limit-public",
  "audit:reachability",
  "audit:auth",
  "audit:cart",
  "audit:cart-limit",
  "audit:bag",
  "audit:signedin",
  "audit:address-book",
  "audit:checkout",
  "audit:admin",
  "audit:admin-pages",
  "audit:settings-controls",
  "audit:loyalty",
  "audit:appearance",
  "audit:image-upload",
  "audit:image-editor",
  "audit:security-advance",
  "audit:shipping",
  "audit:courier-choice",
  "audit:totals",
  "audit:checkout-discount",
  "audit:delivery",
  "audit:delivery-estimate",
  "audit:parcel",
] as const;

/** Not gates, and why. Kept here so the drift check has something to check. */
const EXCLUDED: Record<string, string> = {
  "audit:teardown": "deletes fixtures — a tool, and destructive",
  "audit:shots": "writes screenshots for a human to look at",
  "audit:lighthouse": "needs its own server flags and reports numbers, not pass/fail",
  "audit:actions":
    "a DEPLOY gate, not a suite member — and the reason it was excluded used " +
    "to say 'superseded by audit:security-advance', which was false in both " +
    "directions. It is not superseded: security-advance attacks the data " +
    "layer with a customer JWT and its own header says the forged Server " +
    "Action post 'remains the most valuable test still missing'. They test " +
    "different layers. It was also not runnable at all until Stage 2 — it " +
    "died at account creation, so 'superseded' was covering for a gate that " +
    "had never once executed. What actually keeps it out of the suite is the " +
    "server it needs: it reads action ids out of .next/static/chunks and " +
    "routes out of .next/server/server-reference-manifest.json, so it " +
    "requires `npm run build:stage` + `npm run start:stage`, while the suite " +
    "drives `npm run dev:stage`. Run against dev its positive control fails " +
    "with 'Server action not found' — correctly, because every refusal it " +
    "reported would mean 'the request never reached the action'. Excluded " +
    "must not mean forgotten: it is in the deploy sequence in " +
    "docs/staging.md §4.4 beside audit:build-smoke.",
  "audit:security": "superseded by audit:security-advance",
  "audit:zero-stock": "a seeding helper, not an assertion",
  "audit:build-smoke":
    "the DEPLOY gate, not a suite member. It runs a full production build " +
    "against PRODUCTION data and serves the artifact — putting it in the " +
    "suite would add minutes to every run and point a build at the live " +
    "database on every `npm run audit`. It is required before every merge " +
    "to main (= before every deploy); the sequence is written in " +
    "docs/staging.md §4.4. Excluded must not mean forgotten: that section " +
    "is the wiring, and the deploy checklist names this script explicitly.",
};

type Outcome = { gate: string; code: number; ms: number };

function runGate(gate: string): Promise<Outcome> {
  const started = Date.now();
  return new Promise((resolve) => {
    // stdio inherited: the gates' own output is the log, unchanged. This file
    // adds a summary, it does not reformat what the gates say.
    const child = spawn("npm", ["run", gate], { stdio: "inherit" });
    child.on("close", (code) =>
      resolve({ gate, code: code ?? 1, ms: Date.now() - started }),
    );
    child.on("error", () =>
      resolve({ gate, code: 1, ms: Date.now() - started }),
    );
  });
}

/**
 * Give the run a clean database before the first gate.
 *
 * The gates place real orders in staging, and an order *holds* stock until it
 * is cancelled or deleted. Nothing used to put it back, so every suite run left
 * the next one with less: on 2026-08-09 the whole Nike Air Max 90 "BLACKV"
 * colourway sat at zero — `0 of 8 — 8 held by a live order`, six variants of it
 * — and the harness's "first size not marked sold out" found nothing to click.
 * Seven gates failed in a row for that reason and not one of them was a defect
 * in the shop.
 *
 * That is the same failure this whole batch is about: a harness reporting
 * something other than the thing it claims to measure. Stock exhaustion is
 * worse than a stale cache, though, because it degrades *gradually* — the suite
 * passes, passes, passes, then starts failing in ways that read like real bugs.
 *
 * `teardown.ts` already knew how to fix it (restock, then delete, in that
 * order) and was simply never called. It deletes only rows whose email carries
 * a known QA prefix at `@example.com`, so it cannot touch a real customer.
 *
 * Skipped when `AUDIT_TARGET=env-local`, which is teardown's own route to
 * production: nothing here should delete rows in the live shop as a side effect
 * of someone running the test suite.
 */
function resetFixtures(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", "scripts/audit/teardown.ts"], {
      stdio: "inherit",
    });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

/** Every `audit:*` script must be a gate or be excluded on purpose. */
function checkForDrift(): string[] {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  const declared = new Set<string>([...GATES, ...Object.keys(EXCLUDED)]);
  return Object.keys(pkg.scripts)
    .filter((name) => name.startsWith("audit:"))
    .filter((name) => !declared.has(name))
    .sort();
}

async function main(): Promise<void> {
  const drift = checkForDrift();

  if (process.env.AUDIT_TARGET === "env-local") {
    console.log(
      "\n\u001b[1m\u2501\u2501 fixtures \u001b[0m\n\n" +
        "  AUDIT_TARGET=env-local \u2014 not resetting fixtures. Stock held by\n" +
        "  leftover orders will make later gates fail for reasons that are not\n" +
        "  defects. See resetFixtures().",
    );
  } else {
    console.log("\n\u001b[1m\u2501\u2501 fixtures \u001b[0m");
    const code = await resetFixtures();
    if (code !== 0) {
      console.log(
        "\n\u001b[31m  teardown failed \u2014 refusing to run the suite on a " +
          "database whose stock is unknown.\u001b[0m",
      );
      process.exit(1);
    }
  }

  const results: Outcome[] = [];
  for (const gate of GATES) {
    console.log(`\n[1m━━ ${gate} [0m`);
    results.push(await runGate(gate));
  }

  const failed = results.filter((r) => r.code !== 0);
  const width = Math.max(...results.map((r) => r.gate.length));

  console.log(`\n[1m━━ summary [0m\n`);
  for (const r of results) {
    const mark = r.code === 0 ? "[32m✓[0m" : "[31m✗[0m";
    const secs = `${(r.ms / 1000).toFixed(1)}s`.padStart(7);
    console.log(`  ${mark} ${r.gate.padEnd(width)} ${secs}`);
  }

  const total = (results.reduce((sum, r) => sum + r.ms, 0) / 1000 / 60).toFixed(1);
  console.log(
    `\n  ${results.length - failed.length}/${results.length} gates green in ${total} min`,
  );

  if (drift.length > 0) {
    console.log(
      `\n[31m  ${drift.length} audit script(s) in package.json are in neither ` +
        `GATES nor EXCLUDED:[0m`,
    );
    for (const name of drift) console.log(`    ${name}`);
    console.log(
      "  Add it to the suite, or say why it is not a gate. A gate nobody runs\n" +
        "  is worse than no gate: it reads as coverage.",
    );
  }

  if (failed.length > 0) {
    console.log(`\n[31m  failed: ${failed.map((f) => f.gate).join(", ")}[0m`);
  }

  process.exit(failed.length > 0 || drift.length > 0 ? 1 : 0);
}

void main();
