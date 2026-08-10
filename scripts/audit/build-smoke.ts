/**
 * `npm run audit:build-smoke` — the deploy gate the 2026-08-10 incident asked
 * for: a production build, against production data, served and curled, before
 * any build like it becomes production.
 *
 * Every other gate runs `next dev` against staging, and the incident lived in
 * exactly the gap that leaves: a *production* build bakes route classification
 * into its manifest at build time, and what it bakes depends on what the
 * database returned during that one build. On 2026-08-10 a Supabase 522 during
 * a Vercel build made `generateStaticParams` for `/product/[slug]` fall back
 * to an empty list; the route shipped as SSG with zero pages rendered, every
 * request attempted a static generation at runtime, hit `cookies()`, and every
 * product page 500ed — from a build that passed. Dev cannot fail that way, so
 * no dev-driven gate could ever catch it. Same lesson as audit:appearance in
 * Batch C, generalised at last.
 *
 * Four proofs, in order:
 *
 *   1. **The outage drill.** `STATIC_PARAMS_SIMULATE_OUTAGE=all next build`
 *      must FAIL. This is the incident replayed on demand: if a build whose
 *      slug collection dies ever starts passing again, someone has re-opened
 *      the landmine (see src/lib/static-params.ts) and this catches them.
 *   2. **The real build.** `next build` with the environment as given — which
 *      in this repo's `.env.local` is production — must pass.
 *   3. **The manifest.** No slug route may sit in `prerender-manifest.json`'s
 *      `dynamicRoutes` (SSG classification) without at least one concretely
 *      prerendered path. SSG-with-zero-paths is the poisoned layout; a healthy
 *      build of this app has these routes fully dynamic instead.
 *   4. **The smoke.** `next start` serves the artifact from step 2, and one
 *      real URL per slug route family — read from the deployment's own
 *      /sitemap.xml, so the paths are production data, not fixtures — must
 *      answer 200, as both a document and an RSC request.
 *
 * What this still cannot see: the artifact Vercel serves is built on Vercel's
 * machines, and a network failure there is invisible from here. The fix in
 * static-params.ts covers that half — such a build now fails instead of
 * deploying — and this gate proves, locally and repeatably, that it does.
 */

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PORT = 3213;
const BASE = `http://localhost:${PORT}`;

/** The slug route families the incident class applies to: everything that
 *  collects params through staticParamsOr. */
const SLUG_ROUTES = [
  "/product/[slug]",
  "/collection/[slug]",
  "/page/[slug]",
  "/shop/[category]",
];

const SITEMAP_FAMILIES = ["/product/", "/collection/", "/page/", "/shop/"];

let failures = 0;
function report(ok: boolean, label: string, detail = "") {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures += 1;
}

function build(env: NodeJS.ProcessEnv, label: string) {
  console.log(`\n[build-smoke] ${label} ...`);
  return spawnSync("npx", ["next", "build"], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
  });
}

async function main() {
  // 1. The outage drill: this build must fail.
  const drill = build(
    { ...process.env, STATIC_PARAMS_SIMULATE_OUTAGE: "all" },
    "outage drill (must fail)",
  );
  report(
    drill.status !== 0,
    "a build that cannot collect slugs fails instead of shipping",
    drill.status === 0
      ? "the outage drill BUILT SUCCESSFULLY — the landmine is back"
      : `exited ${drill.status}`,
  );

  // 2. The real production build.
  const real = build(process.env, "production build against live data");
  report(real.status === 0, "production build passes", `exited ${real.status}`);
  if (real.status !== 0) {
    console.error(real.stdout?.slice(-2000));
    console.error(real.stderr?.slice(-2000));
    process.exit(1);
  }

  // 3. The manifest carries no SSG route with zero prerendered paths.
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, ".next/prerender-manifest.json"), "utf8"),
  ) as {
    routes: Record<string, unknown>;
    dynamicRoutes: Record<string, unknown>;
  };
  for (const route of SLUG_ROUTES) {
    const ssg = route in manifest.dynamicRoutes;
    const prefix = route.slice(0, route.indexOf("["));
    const prerendered = Object.keys(manifest.routes).filter((p) =>
      p.startsWith(prefix),
    ).length;
    report(
      !ssg || prerendered > 0,
      `${route} is not SSG-with-zero-paths`,
      ssg ? `SSG with ${prerendered} prerendered paths` : "dynamic",
    );
  }

  // 4. Serve the artifact and curl real production paths from its own sitemap.
  const server = spawn("npx", ["next", "start", "--port", String(PORT)], {
    cwd: ROOT,
    env: process.env,
    stdio: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 30 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500));
      up = await fetch(`${BASE}/`).then(
        (r) => r.ok,
        () => false,
      );
    }
    report(up, "next start serves the artifact");
    if (!up) process.exit(1);

    const sitemap = await fetch(`${BASE}/sitemap.xml`).then((r) => r.text());
    const paths = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
      (m) => new URL(m[1]).pathname,
    );
    for (const family of SITEMAP_FAMILIES) {
      const sample = paths.find((p) => p.startsWith(family));
      if (!sample) {
        report(false, `sitemap names a ${family} path`, "none found");
        continue;
      }
      const doc = await fetch(`${BASE}${sample}`);
      report(doc.status === 200, `GET ${sample}`, `${doc.status}`);
      const rsc = await fetch(`${BASE}${sample}`, { headers: { RSC: "1" } });
      report(rsc.status === 200, `GET ${sample} (RSC)`, `${rsc.status}`);
    }
  } finally {
    server.kill();
  }

  console.log(
    failures === 0
      ? "\naudit:build-smoke PASS"
      : `\naudit:build-smoke FAIL (${failures})`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
