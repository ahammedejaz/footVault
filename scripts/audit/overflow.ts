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
import { chromium, type Browser, type Page } from "playwright";

import { buildFixture, type QaFixture } from "./fixtures";
import { AUDIT_ROUTES, AUDIT_WIDTHS, BASE_URL } from "./routes";
import { auditStates, jarFor, type AuditState } from "./states";

type Finding = { kind: string; detail: string };

/**
 * How much was actually looked at.
 *
 * "No tap target under 44px" is a much weaker sentence when nobody knows
 * whether it measured four controls or four thousand — and the reason this file
 * changed at all is that /cart was in the route list while its line-item
 * controls were never on screen to be counted.
 */
let interactiveSeen = 0;

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
  await settleAnimations(page);
}

/**
 * Wait for every running CSS animation to finish before measuring.
 *
 * The bag drawer slides in from `+40px` and the hero rises on load. Measured
 * part-way through, the drawer's right edge sits 4.8px past the viewport and
 * the harness reports three overflowing children of a panel that is flush by
 * the time anybody sees it. That is a lie about the page, produced by the only
 * observer fast enough to catch the animation.
 *
 * Infinite animations are excluded — a spinner never finishes — and the whole
 * thing races a 2s cap so one stuck animation cannot hang the run.
 */
async function settleAnimations(page: Page) {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((animation) => {
      const timing = animation.effect?.getTiming();
      return timing !== undefined && timing.iterations !== Infinity;
    });
    if (finite.length === 0) return;
    await Promise.race([
      Promise.allSettled(finite.map((animation) => animation.finished)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  });
}


async function inspect(page: Page, width: number): Promise<Finding[]> {
  // No named helper functions inside this body: the TypeScript loader adds a
  // `__name` shim to anything it can name, and that identifier does not exist
  // in the page. Everything the browser side needs is inline.
  const result = await page.evaluate((viewport) => {
    const findings: { kind: string; detail: string }[] = [];
    let interactive = 0;

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
      const isInteractive = el.matches(
        'a[href], button:not([disabled]), input:not([type="hidden"]), select, textarea, [role="radio"], [role="button"], [role="tab"]',
      );
      if (isInteractive) {
        interactive++;
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
    return { findings, interactive };
  }, width);
  interactiveSeen += result.interactive;
  return result.findings;
}

/**
 * The stateful half.
 *
 * A separate context per (width, identity) rather than one per width: the whole
 * point of these is that the cookies differ, and a context can only hold one
 * set. Grouped by identity so the six jars cost six contexts a width, not one
 * per state.
 */
async function walkStates(
  browser: Browser,
  fixture: QaFixture,
  width: number,
  problems: string[],
) {
  const states = auditStates(fixture).filter(
    (state) => !state.once || width === AUDIT_WIDTHS[0],
  );
  const byJar = new Map<AuditState["as"], AuditState[]>();
  for (const state of states) {
    byJar.set(state.as, [...(byJar.get(state.as) ?? []), state]);
  }

  for (const [as, group] of byJar) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      isMobile: width < 768,
      hasTouch: width < 768,
      deviceScaleFactor: 1,
    });
    await context.addCookies(jarFor(fixture, as));
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(60_000);

    for (const state of group) {
      const response = await visit(page, state.path);
      const status = response?.status() ?? 0;
      if (status !== 200) {
        problems.push(`[${width}] ${state.name} — HTTP ${status}, expected 200`);
        continue;
      }
      await waitForReady(page, state.name);
      try {
        if (state.after) await state.after(page);
      } catch (error) {
        problems.push(
          `[${width}] ${state.name} — could not reach the state: ${(error as Error).message.split("\n")[0]}`,
        );
        continue;
      }
      for (const finding of await inspect(page, width)) {
        problems.push(`[${width}] ${state.name} — ${finding.kind}: ${finding.detail}`);
      }
      process.stdout.write("+");
    }
    await context.close();
  }
}

async function main() {
  const browser = await chromium.launch();
  const problems: string[] = [];

  process.stdout.write("building fixtures… ");
  const fixture = await buildFixture(browser);
  process.stdout.write(
    `bag=${fixture.guest.lines} order=${fixture.guestOrder.orderNumber} account=${fixture.account.orderNumber}\n`,
  );

  try {
    for (const width of AUDIT_WIDTHS) {
      // A progress line, because this walks hundreds of pages and a silent ten
      // minutes is indistinguishable from a hang.
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
        const expected = route.status ?? 200;
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

      await walkStates(browser, fixture, width, problems);
      process.stdout.write("\n");
    }
  } finally {
    await browser.close();
  }

  const stateCount = auditStates(fixture).length;
  if (problems.length === 0) {
    console.log(
      `Clean: ${AUDIT_ROUTES.length} routes + ${stateCount} populated states × ${AUDIT_WIDTHS.length} widths, ` +
        `${interactiveSeen} interactive elements measured — no overflow, ` +
        "no tap target under 44px, no input under 16px.",
    );
    console.log(`  (left behind: ${fixture.ledger.emails.join(", ")}, orders ${fixture.ledger.orderNumbers.join(", ")})`);
    return;
  }
  // Deduplicated: the same header button at six widths is one problem.
  const unique = [...new Set(problems)];
  console.log(`${unique.length} findings from ${interactiveSeen} interactive elements measured:\n`);
  for (const problem of unique) console.log("  " + problem);
  console.log(`\n  (left behind: ${fixture.ledger.emails.join(", ")}, orders ${fixture.ledger.orderNumbers.join(", ")})`);
  process.exitCode = 1;
}

void main();
