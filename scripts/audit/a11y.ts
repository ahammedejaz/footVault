/**
 * Automated accessibility pass.
 *
 * axe-core over every audit route, at a phone width and a desktop width,
 * against WCAG 2.2 A and AA. It is not a substitute for walking the keyboard
 * path by hand — axe cannot tell whether a focus order makes sense — but it
 * catches the whole class of things that are invisible in review: a colour that
 * misses by 0.2, a heading that skips a level, an ARIA attribute on an element
 * whose role does not support it.
 *
 * The interactive surfaces are opened before scanning, because a dialog nobody
 * has opened is a dialog nobody has checked.
 *
 *   npx tsx scripts/audit/a11y.ts
 */
import AxeBuilder from "@axe-core/playwright";
import { chromium, type Page } from "playwright";

import { AUDIT_ROUTES, BASE_URL } from "./routes";


/**
 * Wait for the real page, not its skeleton.
 *
 * A dynamic route streams its `loading.tsx` fallback first; at the `load` event
 * the real content is in the DOM but still inside a hidden container waiting to
 * be swapped in. Auditing then measures the skeleton — which is how a first run
 * of this reported "no level-one heading" on every listing page.
 *
 * Every page on the site has exactly one h1, so a visible h1 is the signal.
 */
/**
 * Navigate, with one retry.
 *
 * Against a locally started production server this occasionally stalls — the
 * server log fills with "The destination stream closed early" as earlier
 * streamed renders are aborted, and a later navigation never starts. It is a
 * property of the harness, not of a page: the same URL serves in 3ms to curl
 * and loads first time in a fresh context. One retry keeps the gate honest —
 * a page that is genuinely broken fails both attempts — without a flake in the
 * runner reading as a defect in the site.
 */
async function visit(page: Page, path: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await page.goto(`${BASE_URL}${path}`, { waitUntil: "domcontentloaded" });
    } catch (error) {
      if (attempt === 1) throw error;
      await page.goto("about:blank");
    }
  }
  return null;
}

async function waitForReady(page: Page, path: string) {
  await page
    .locator("h1")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {
      throw new Error(`${path}: no visible <h1> after 15s — is the page rendering?`);
    });
  // Let images settle into their reserved boxes before measuring.
  await page.waitForTimeout(250);
}

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

/** Surfaces that only exist once something is opened. */
async function openOverlays(page: Page, path: string) {
  if (path.startsWith("/product/")) {
    await page.getByRole("button", { name: /size guide/i }).click().catch(() => {});
    await page.waitForTimeout(200);
  }
}

async function main() {
  const browser = await chromium.launch();
  let violations = 0;

  for (const width of [390, 1440]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      isMobile: width < 768,
      hasTouch: width < 768,
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    // 60s rather than the 30s default: the first pass after a cold
    // `.next/cache/images` has to generate every optimised image on demand, and
    // a product page asking for four at once can sit well past 30s. Nothing
    // about that is a property of the site — it is the optimiser warming up —
    // so it should not read as a failure.
    page.setDefaultNavigationTimeout(60_000);

    for (const route of AUDIT_ROUTES) {
      await visit(page, route.path);
      await waitForReady(page, route.path);

      // Scan the page, *then* the overlays. A Radix modal marks everything
      // outside itself `aria-hidden`, so scanning only after opening one checks
      // the dialog and nothing else — which is how a broken <dl> on the product
      // page survived a "clean" run of this script.
      const passes = [await new AxeBuilder({ page }).withTags(TAGS).analyze()];
      await openOverlays(page, route.path);
      if (route.path.startsWith("/product/")) {
        passes.push(await new AxeBuilder({ page }).withTags(TAGS).analyze());
      }

      const seen = new Set<string>();
      for (const violation of passes.flatMap((r) => r.violations)) {
        if (seen.has(violation.id)) continue;
        seen.add(violation.id);
        violations++;
        console.log(
          `\n[${width}] ${route.path}\n  ${violation.id} (${violation.impact}) — ${violation.help}`,
        );
        for (const node of violation.nodes.slice(0, 3)) {
          console.log(`    ${node.html.replace(/\s+/g, " ").slice(0, 150)}`);
          const reason = node.failureSummary?.split("\n").slice(1, 2).join(" ") ?? "";
          if (reason) console.log(`      ${reason.trim().slice(0, 200)}`);
        }
        if (violation.nodes.length > 3) {
          console.log(`    …and ${violation.nodes.length - 3} more`);
        }
      }
    }
    await context.close();
  }

  await browser.close();
  if (violations === 0) {
    console.log(
      `Clean: axe found no WCAG 2.2 A/AA violations across ${AUDIT_ROUTES.length} routes at 390px and 1440px.`,
    );
  } else {
    console.log(`\n${violations} violation groups.`);
    process.exitCode = 1;
  }
}

void main();
