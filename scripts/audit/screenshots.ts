/**
 * Screenshots at every width in the quality gate.
 *
 *   npx tsx scripts/audit/screenshots.ts [outDir]
 *
 * Full-page, so a layout that only breaks below the fold cannot hide.
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

import { AUDIT_ROUTES, AUDIT_WIDTHS, BASE_URL } from "./routes";

const OUT = process.argv[2] ?? "screenshots";
const ONLY = process.env.ROUTES?.split(",");
const WIDTHS = process.env.WIDTHS
  ? process.env.WIDTHS.split(",").map(Number)
  : AUDIT_WIDTHS;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();

  for (const width of WIDTHS) {
    const context = await browser.newContext({
      // A short viewport on purpose: `fullPage` extends the capture to the
      // document height but never crops it, so a viewport taller than the page
      // leaves a band of blank at the bottom that reads as a layout bug.
      viewport: { width, height: 900 },
      isMobile: width < 768,
      hasTouch: width < 768,
      deviceScaleFactor: 1,
      // Screenshots of a site whose reveals are scroll-linked are otherwise a
      // lottery; this pins them to their finished state.
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    // 60s rather than the 30s default: the first pass after a cold
    // `.next/cache/images` has to generate every optimised image on demand, and
    // a product page asking for four at once can sit well past 30s. Nothing
    // about that is a property of the site — it is the optimiser warming up —
    // so it should not read as a failure.
    page.setDefaultNavigationTimeout(60_000);

    for (const route of AUDIT_ROUTES) {
      if (ONLY && !ONLY.includes(route.name)) continue;
      await page.goto(`${BASE_URL}${route.path}`, {
        waitUntil: "domcontentloaded",
      });
      await page
        .locator("h1")
        .first()
        .waitFor({ state: "visible" })
        .catch(() => {});
      await page.waitForTimeout(400);
      await page.screenshot({
        path: `${OUT}/${route.name}-${width}.png`,
        fullPage: true,
      });
    }
    await context.close();
  }

  await browser.close();
  console.log(
    `Wrote ${OUT}/ — ${AUDIT_ROUTES.length} routes × ${WIDTHS.length} widths.`,
  );
}

void main();
