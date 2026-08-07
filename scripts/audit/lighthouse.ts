/**
 * The Lighthouse gate, against any base URL.
 *
 * The gate is **mobile ≥ 90 in all four categories** on the five routes that
 * carry the purchase: home, shop, a product, the bag and checkout. It is
 * written to take a base URL as an argument because the number that counts is
 * measured on the Vercel preview, not on localhost, and the preview URL does
 * not exist until the branch deploys. Point it at either:
 *
 *   npx tsx scripts/audit/lighthouse.ts                       # AUDIT_BASE_URL
 *   npx tsx scripts/audit/lighthouse.ts https://foo.vercel.app
 *
 * **`--throttling-method=devtools`, never `simulate`.** Lighthouse's simulated
 * throttling models a slow network on top of an observed trace, and on
 * localhost the observed trace has no network latency at all to model from. It
 * has reported ~4s LCP on this project against a 1.6s reality. devtools
 * throttling applies the slowdown for real and measures what happens.
 *
 * A local run is a **baseline, not the gate** — a production build served from
 * the same machine as the browser has no CDN, no cold start and no real RTT.
 * Report it as such.
 *
 * Populated `/cart` and `/checkout` need a bag. Lighthouse cannot log in, but
 * it can carry a cookie:
 *
 *   LIGHTHOUSE_COOKIE="fv_guest=<uuid>" npx tsx scripts/audit/lighthouse.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { BASE_URL } from "./routes";

const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"] as const;
type Category = (typeof CATEGORIES)[number];

/** The five routes the gate names. */
const GATE = [
  { path: "/", name: "home" },
  { path: "/shop", name: "shop" },
  { path: "/product/nike-air-max-90-mens", name: "product" },
  { path: "/cart", name: "cart" },
  { path: "/checkout", name: "checkout" },
] as const;

const THRESHOLD = 90;

/** Only the slice of the report this reads. Everything else is ignored. */
type Report = {
  categories: Record<Category, { score: number | null }>;
  audits: Record<string, {
    numericValue?: number;
    displayValue?: string;
    score?: number | null;
    errorMessage?: string;
  }>;
};

function chromePath(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  try {
    readFileSync(mac);
    return mac;
  } catch {
    // Let Lighthouse find its own; chrome-launcher knows more places than this.
    return undefined;
  }
}

function run(url: string, outDir: string, name: string): Report {
  const out = join(outDir, `${name}.json`);
  const args = [
    "--yes",
    "lighthouse",
    url,
    `--only-categories=${CATEGORIES.join(",")}`,
    "--form-factor=mobile",
    "--screenEmulation.mobile",
    // The gate is a phone. Lighthouse's own mobile emulation numbers, not a
    // desktop run with a narrow window.
    "--throttling-method=devtools",
    "--output=json",
    `--output-path=${out}`,
    "--quiet",
    "--chrome-flags=--headless=new --no-sandbox --disable-gpu",
  ];
  if (process.env.LIGHTHOUSE_COOKIE) {
    args.push(`--extra-headers={"Cookie":"${process.env.LIGHTHOUSE_COOKIE}"}`);
  }

  execFileSync("npx", args, {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ...(chromePath() ? { CHROME_PATH: chromePath() } : {}) },
    timeout: 240_000,
  });
  return JSON.parse(readFileSync(out, "utf8")) as Report;
}

/**
 * A category score, or null when Lighthouse could not compute one.
 *
 * The distinction matters and rounding a null to 0 destroys it. `/checkout`
 * scores `null` for performance because Total Blocking Time — thirty per cent
 * of the category — errors with `NO_TTI_NETWORK_IDLE_PERIOD`: Razorpay's
 * checkout script keeps the network busy so the trace never contains a quiet
 * window. Every metric that *can* be measured on that page is good. Printing
 * "0" would have sent somebody optimising a page that is fast.
 */
function score(report: Report, category: Category): number | null {
  const value = report.categories[category]?.score;
  return value === null || value === undefined ? null : Math.round(value * 100);
}

/** Why a category came back unscored — the audit that errored, in its words. */
function unscoredReason(report: Report, category: Category): string {
  const broken = Object.entries(report.audits).find(
    ([, audit]) => audit.score === null && audit.errorMessage,
  );
  return broken ? `${broken[0]}: ${broken[1].errorMessage ?? ""}`.slice(0, 120) : `${category} unscored`;
}

function main() {
  const base = process.argv[2] ?? process.env.LIGHTHOUSE_BASE_URL ?? BASE_URL;
  const local = /localhost|127\.0\.0\.1/.test(base);
  const outDir = join(tmpdir(), `footvault-lighthouse-${Date.now()}`);
  mkdirSync(outDir, { recursive: true });

  console.log(`\nLighthouse · mobile · devtools throttling · ${base}`);
  if (local) {
    console.log(
      "  LOCALHOST BASELINE — no CDN, no real RTT, no cold start. The gate is the\n" +
        "  Vercel preview; treat these as provisional.",
    );
  }
  console.log(
    `\n  ${"route".padEnd(10)}${"perf".padStart(6)}${"a11y".padStart(6)}` +
      `${"best".padStart(6)}${"seo".padStart(6)}${"LCP".padStart(9)}${"CLS".padStart(8)}${"TBT".padStart(8)}`,
  );

  let failures = 0;
  let unscored = 0;
  for (const route of GATE) {
    let report: Report;
    try {
      report = run(`${base}${route.path}`, outDir, route.name);
    } catch (error) {
      console.log(`  ${route.name.padEnd(10)}  run failed: ${(error as Error).message.split("\n")[0]}`);
      failures++;
      continue;
    }

    const scores = CATEGORIES.map((category) => score(report, category));
    const lcp = report.audits["largest-contentful-paint"]?.numericValue ?? 0;
    const cls = report.audits["cumulative-layout-shift"]?.numericValue ?? 0;
    const tbt = report.audits["total-blocking-time"]?.numericValue ?? 0;

    console.log(
      `  ${route.name.padEnd(10)}` +
        scores.map((value) => (value === null ? "—" : String(value)).padStart(6)).join("") +
        `${`${(lcp / 1000).toFixed(2)}s`.padStart(9)}` +
        `${cls.toFixed(3).padStart(8)}` +
        `${`${Math.round(tbt)}ms`.padStart(8)}`,
    );

    for (const [index, value] of scores.entries()) {
      if (value === null) {
        unscored++;
        console.log(`      ${CATEGORIES[index]} unscored — ${unscoredReason(report, CATEGORIES[index])}`);
        continue;
      }
      if (value < THRESHOLD) {
        failures++;
        console.log(`      ${CATEGORIES[index]} ${value} < ${THRESHOLD}`);
      }
    }
  }

  rmSync(outDir, { recursive: true, force: true });

  if (failures === 0 && unscored === 0) {
    console.log(`\n  All four categories ≥ ${THRESHOLD} on all ${GATE.length} routes.\n`);
    return;
  }
  console.log(
    `\n  ${failures} category score(s) under ${THRESHOLD}` +
      `${unscored > 0 ? `, ${unscored} unscored` : ""}.`,
  );
  console.log(
    "  SEO scores below 90 on every route mean SITE_INDEXABLE is off: robots.txt\n" +
      "  disallows everything and next.config.ts sends X-Robots-Tag: noindex, which\n" +
      "  Lighthouse counts as a failure. That is the environment, not the markup —\n" +
      "  measure the gate against a deployment with SITE_INDEXABLE=true.\n",
  );
  // A localhost baseline is information, not a gate, so it does not fail a run.
  if (!local) process.exitCode = 1;
}

main();
