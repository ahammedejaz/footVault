/**
 * Horizontal overflow and tap-target audit.
 *
 * "Zero horizontal overflow at six widths" is not something to check by eye —
 * a 2px overflow is invisible in a screenshot and obvious to a thumb. This
 * walks every route at every width and reports the elements wider than the
 * viewport, the tap targets under 44×44, and any form input under 16px (which
 * is what makes iOS Safari zoom the page on focus).
 *
 *   npx tsx scripts/audit/overflow.ts
 */
import { chromium, type Page } from "playwright";

import { AUDIT_ROUTES, AUDIT_WIDTHS, BASE_URL } from "./routes";

type Finding = { kind: string; detail: string };

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


async function inspect(page: Page, width: number): Promise<Finding[]> {
  // No named helper functions inside this body: the TypeScript loader adds a
  // `__name` shim to anything it can name, and that identifier does not exist
  // in the page. Everything the browser side needs is inline.
  return page.evaluate((viewport) => {
    const findings: { kind: string; detail: string }[] = [];

    if (document.documentElement.scrollWidth > viewport + 1) {
      findings.push({
        kind: "page-overflow",
        detail: `document scrollWidth ${document.documentElement.scrollWidth} > ${viewport}`,
      });
    }

    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;

      // Overflow: something whose box extends past the viewport and is not
      // inside a scroll container that owns the overflow on purpose.
      if (box.right > viewport + 1 || box.left < -1) {
        const scroller = el.closest<HTMLElement>(
          "[data-swipe-scroller], .rail, [style*='overflow'], .overflow-x-auto, .overflow-auto",
        );
        const inScroller =
          scroller !== null &&
          scroller !== el &&
          ["auto", "scroll"].includes(getComputedStyle(scroller).overflowX);
        if (!inScroller && style.position !== "fixed") {
          findings.push({
            kind: "element-overflow",
            detail: `${`${el.tagName.toLowerCase()}${
              typeof el.className === "string" && el.className
                ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
                : ""
            }${(el.textContent ?? "").trim() ? ` "${(el.textContent ?? "").trim().slice(0, 32)}"` : ""}`} — ${Math.round(box.left)}…${Math.round(box.right)}`,
          });
        }
      }

      // Tap targets.
      //
      // Two shapes have a hit area larger than their box, and both are
      // deliberate: a stretched link (`::after { position: absolute; inset: 0 }`)
      // covers its whole card, and a thin control can carry an invisible 44px
      // pad through `::before`. Measure the effective area, not the text.
      const interactive = el.matches(
        'a[href], button:not([disabled]), input:not([type="hidden"]), select, textarea, [role="radio"], [role="button"], [role="tab"]',
      );
      if (interactive) {
        // sr-only until focused — a skip link is 1×1 by design and grows to a
        // real control the moment it is reachable.
        const hidden =
          style.clipPath !== "none" || (box.width <= 1 && box.height <= 1);

        // WCAG 2.5.8 exempts a target "in a sentence or otherwise constrained
        // by the line-height of non-target text". A link inside a paragraph of
        // prose is that exemption; padding it to 44px would space the sentence
        // out around it.
        const inSentence =
          el.tagName === "A" &&
          style.display.startsWith("inline") &&
          Boolean(el.parentElement?.closest("p, li, dd, figcaption")) &&
          (el.parentElement?.textContent ?? "").trim().length >
            (el.textContent ?? "").trim().length;
        const after = getComputedStyle(el, "::after");
        const before = getComputedStyle(el, "::before");
        const stretched =
          after.content !== "none" &&
          after.position === "absolute" &&
          after.inset.startsWith("0px");

        let effectiveWidth = box.width;
        let effectiveHeight = box.height;

        if (stretched) {
          const host = el.closest("article, li, [data-card]") ?? el.offsetParent;
          if (host) {
            const hostBox = host.getBoundingClientRect();
            effectiveWidth = Math.max(effectiveWidth, hostBox.width);
            effectiveHeight = Math.max(effectiveHeight, hostBox.height);
          }
        }
        if (before.content !== "none" && before.position === "absolute") {
          effectiveWidth = Math.max(
            effectiveWidth,
            Number.parseFloat(before.minWidth) || Number.parseFloat(before.width) || 0,
          );
          effectiveHeight = Math.max(
            effectiveHeight,
            Number.parseFloat(before.minHeight) || Number.parseFloat(before.height) || 0,
          );
        }

        if (
          !hidden &&
          !inSentence &&
          el.getAttribute("aria-hidden") !== "true" &&
          (effectiveWidth < 44 || effectiveHeight < 44)
        ) {
          findings.push({
            kind: "tap-target",
            detail: `${`${el.tagName.toLowerCase()}${
              typeof el.className === "string" && el.className
                ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
                : ""
            }${(el.textContent ?? "").trim() ? ` "${(el.textContent ?? "").trim().slice(0, 32)}"` : ""}`} — ${Math.round(effectiveWidth)}×${Math.round(effectiveHeight)}`,
          });
        }
      }

      // iOS zooms any focused field under 16px.
      if (el.matches("input, select, textarea")) {
        const size = Number.parseFloat(style.fontSize);
        if (size < 16) {
          findings.push({ kind: "input-font", detail: `${`${el.tagName.toLowerCase()}${
              typeof el.className === "string" && el.className
                ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
                : ""
            }${(el.textContent ?? "").trim() ? ` "${(el.textContent ?? "").trim().slice(0, 32)}"` : ""}`} — ${size}px` });
        }
      }
    }
    return findings;
  }, width);
}

async function main() {
  const browser = await chromium.launch();
  const problems: string[] = [];

  for (const width of AUDIT_WIDTHS) {
    // A progress line, because this walks 90 pages and a silent ten minutes is
    // indistinguishable from a hang.
    process.stdout.write(`${width}px `);
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
      const response = await visit(page, route.path);
      const status = response?.status() ?? 0;
      const expected = route.name === "not-found" ? 404 : 200;
      if (status !== expected) {
        problems.push(`[${width}] ${route.path} — HTTP ${status}, expected ${expected}`);
      }
      await waitForReady(page, route.path);

      for (const finding of await inspect(page, width)) {
        problems.push(`[${width}] ${route.path} — ${finding.kind}: ${finding.detail}`);
      }
      process.stdout.write(".");
    }
    await context.close();
    process.stdout.write("\n");
  }

  await browser.close();

  if (problems.length === 0) {
    console.log(
      `Clean: ${AUDIT_ROUTES.length} routes × ${AUDIT_WIDTHS.length} widths, no overflow, no tap target under 44px, no input under 16px.`,
    );
    return;
  }
  // Deduplicated: the same header button at six widths is one problem.
  const unique = [...new Set(problems)];
  console.log(`${unique.length} findings:\n`);
  for (const problem of unique) console.log("  " + problem);
  process.exitCode = 1;
}

void main();
