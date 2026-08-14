/**
 * Does the product gallery show a sliver of the next image at rest?
 *
 * `product-gallery.tsx` pulls its scroller full-bleed with `-mx-4` inside a
 * `px-4` container. That is the same utility that caused the homepage rail to
 * overflow, and the visual-repair pass flagged it as the same bug. The counter
 * argument is that every slide is `w-full` and snaps to the scroller, so the
 * scroller being exactly viewport-wide is the *point* and no sliver can appear.
 *
 * Both are plausible readings of the CSS and neither settles it, so this
 * measures instead. Reported as geometry, not as a verdict:
 *
 *   - the scroller's own box against the viewport (is it full-bleed, or past it)
 *   - each slide's width against the scroller's
 *   - where slide 2 starts, at rest. Anything less than the viewport width is a
 *     sliver on screen; anything at or beyond it is off-screen.
 *
 *   npx tsx scripts/audit/gallery.ts
 */
import { chromium } from "playwright";

import { BASE_URL } from "./routes";
import { scanned } from "./scanned";
import { assertNotProduction, assertServerNotProduction } from "./clients";

/*
  Both guards, on a harness that reads.

  `assertNotProduction` refuses the *credential* this process resolved;
  `assertServerNotProduction` refuses the *database the server at BASE_URL is
  backed by*. They are different questions and neither answers the other — on
  2026-08-14 the first passed while a browser driven at a production build put
  two guest carts into the live shop.

  Added here even though this file only reads, because "it only reads" is a fact
  about the file today and the next edit that reproduces a state with one
  `.insert(` invalidates it. `audit:fixtures-guard` now requires both of every
  harness that opens a browser, so the next one is covered on the day it is
  written rather than after the next incident.
*/
assertNotProduction("run audit:gallery");

const SLUG = "nike-air-max-90-mens";
const WIDTHS = [360, 390] as const;

let failures = 0;

async function main() {
  // The browser writes wherever BASE_URL points, which the credential
  // guard cannot see. See clients.ts.
  await assertServerNotProduction(BASE_URL, "run audit:gallery");

  console.log(`\nThe product gallery at rest — /product/${SLUG}\n`);

  const browser = await chromium.launch();

  /**
   * Two viewports, and the gate is meaningless at one.
   *
   * 390 is the iPhone the owner photographs on and 360 is the commonest Android
   * width in India; the whole point of this harness is the *pair*, because the
   * sliver that tells a customer the gallery scrolls is present at one and was
   * absent at the other.
   */
  scanned("viewport widths", WIDTHS.length, 2);

  for (const width of WIDTHS) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(60_000);
    await page.goto(`${BASE_URL}/product/${SLUG}`, { waitUntil: "load" });
    await page.locator("h1").first().waitFor({ state: "visible" });
    await page.waitForTimeout(500);

    const geometry = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(
        'ul[aria-label$="images"]',
      );
      if (!scroller) return null;
      const box = scroller.getBoundingClientRect();
      const slides = Array.from(
        scroller.querySelectorAll<HTMLElement>(":scope > li"),
      ).map((slide) => {
        const slideBox = slide.getBoundingClientRect();
        return {
          left: slideBox.left,
          right: slideBox.right,
          width: slideBox.width,
        };
      });
      return {
        viewport: window.innerWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        scroller: { left: box.left, right: box.right, width: box.width },
        scrollLeft: scroller.scrollLeft,
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        slides,
      };
    });

    if (!geometry) {
      console.log(`  [${width}] FAIL  no gallery scroller found`);
      failures++;
      await context.close();
      continue;
    }

    /**
     * An empty scroller used to reach `first.left` and die with a TypeError.
     * That is not a silent pass — the harness exits non-zero either way — but
     * "Cannot read properties of undefined" sends the next person to this file
     * rather than to the product with no photographs, which is where the
     * problem is. It is reported as the failure it is.
     */
    if (geometry.slides.length === 0) {
      console.log(
        `  [${width}] FAIL  the gallery rendered no slides — ` +
          `/product/${SLUG} has no photographs the viewer will show`,
      );
      failures++;
      await context.close();
      continue;
    }

    const first = geometry.slides[0];
    const second = geometry.slides[1];
    // How much of the next slide is inside the viewport at rest. Positive means
    // a visible sliver; zero or negative means it starts at or past the edge.
    const sliver = second ? geometry.viewport - second.left : 0;

    console.log(
      `  [${width}] viewport ${geometry.viewport}px, ${geometry.slides.length} slides`,
    );
    console.log(
      `         scroller  left ${first ? geometry.scroller.left.toFixed(1) : "?"}  ` +
        `right ${geometry.scroller.right.toFixed(1)}  width ${geometry.scroller.width.toFixed(1)}`,
    );
    console.log(
      `         slide 1   left ${first.left.toFixed(1)}  right ${first.right.toFixed(1)}  ` +
        `width ${first.width.toFixed(1)}`,
    );
    if (second) {
      console.log(
        `         slide 2   left ${second.left.toFixed(1)}  width ${second.width.toFixed(1)}  ` +
          `→ ${sliver > 0.5 ? `${sliver.toFixed(1)}px VISIBLE at rest` : "off-screen"}`,
      );
    }
    console.log(
      `         document scrollWidth ${geometry.documentScrollWidth} (viewport ${geometry.viewport})`,
    );

    if (sliver > 0.5) {
      console.log(
        `  [${width}] FAIL  a ${sliver.toFixed(1)}px sliver of slide 2 is on screen at rest`,
      );
      failures++;
    }
    if (Math.abs(first.width - geometry.viewport) > 0.5) {
      console.log(
        `  [${width}] FAIL  slide 1 is ${first.width.toFixed(1)}px against a ${geometry.viewport}px viewport`,
      );
      failures++;
    }
    if (geometry.documentScrollWidth > geometry.viewport + 1) {
      console.log(`  [${width}] FAIL  the document scrolls horizontally`);
      failures++;
    }

    await context.close();
  }

  await browser.close();
  console.log(
    failures === 0
      ? "\n  Each slide is exactly one viewport wide and lands flush. `-mx-4` is full-bleed, not overflow.\n"
      : `\n  ${failures} measurement(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nHarness error:", error);
  process.exit(1);
});
