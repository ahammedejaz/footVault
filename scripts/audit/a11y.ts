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
import { chromium, type Browser, type Page } from "playwright";

import {
  addToBag,
  buildFixture,
  FIXTURE_SLUGS,
  type QaFixture,
} from "./fixtures";
import { AUDIT_ROUTES, BASE_URL } from "./routes";
import { auditStates, jarFor, type AuditState } from "./states";

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
      return await page.goto(`${BASE_URL}${path}`, {
        waitUntil: "domcontentloaded",
      });
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
      throw new Error(
        `${path}: no visible <h1> after 15s — is the page rendering?`,
      );
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

const TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
  "best-practice",
];

/** Surfaces that only exist once something is opened. */
async function openOverlays(page: Page, path: string) {
  if (path.startsWith("/product/")) {
    await page
      .getByRole("button", { name: /size guide/i })
      .click()
      .catch(() => {});
    await page.waitForTimeout(200);
    return;
  }

  // The bag drawer and the sign-in prompt are new in Phase 4 and are the two
  // surfaces most likely to be reached mid-purchase, so neither may go
  // unscanned. Both are opened from the header, which is on every route, so
  // /wishlist stands in for "anywhere".
  if (path === "/wishlist") {
    await page
      .locator('a[href="/cart"]')
      .first()
      .click()
      .catch(() => {});
    await page.waitForTimeout(600);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);
    // The account button is above `sm`; below it, sign-in lives in the drawer.
    await page
      .getByRole("button", { name: "Sign in" })
      .first()
      .click()
      .catch(() => {});
    await page.waitForTimeout(400);
  }
}

/** Report a scan's violations once each, and say how many were new. */
function report(
  label: string,
  results: {
    violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"];
  }[],
): number {
  const seen = new Set<string>();
  let count = 0;
  for (const violation of results.flatMap((result) => result.violations)) {
    if (seen.has(violation.id)) continue;
    seen.add(violation.id);
    count++;
    console.log(
      `\n${label}\n  ${violation.id} (${violation.impact}) — ${violation.help}`,
    );
    for (const node of violation.nodes.slice(0, 3)) {
      console.log(`    ${node.html.replace(/\s+/g, " ").slice(0, 150)}`);
      const reason =
        node.failureSummary?.split("\n").slice(1, 2).join(" ") ?? "";
      if (reason) console.log(`      ${reason.trim().slice(0, 200)}`);
    }
    if (violation.nodes.length > 3) {
      console.log(`    …and ${violation.nodes.length - 3} more`);
    }
  }
  return count;
}

/**
 * The states axe never saw.
 *
 * A dialog nobody has opened is a dialog nobody has checked — and so is a bag
 * with nothing in it. Each state is scanned twice where it has an action: once
 * on arrival and once after, because a Radix modal marks everything outside
 * itself `aria-hidden` and a single scan taken with one open checks the dialog
 * and nothing else.
 */
async function scanStates(
  browser: Browser,
  fixture: QaFixture,
  width: number,
): Promise<number> {
  const states = auditStates(fixture).filter(
    (state) => !state.once || width === 390,
  );
  const byJar = new Map<AuditState["as"], AuditState[]>();
  for (const state of states) {
    byJar.set(state.as, [...(byJar.get(state.as) ?? []), state]);
  }

  let violations = 0;
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
      await visit(page, state.path);
      await waitForReady(page, state.name);
      const passes = [await new AxeBuilder({ page }).withTags(TAGS).analyze()];
      if (state.after) {
        try {
          await state.after(page);
          passes.push(await new AxeBuilder({ page }).withTags(TAGS).analyze());
        } catch (error) {
          console.log(
            `\n[${width}] ${state.name} — could not reach the state: ${(error as Error).message.split("\n")[0]}`,
          );
          violations++;
        }
      }
      violations += report(`[${width}] ${state.name}`, passes);
    }
    await context.close();
  }
  return violations;
}

/**
 * The toast, under both OS colour schemes — because a toast is the one surface
 * axe never sees. It exists for 3.5 seconds after an interaction no scanner
 * performs, which is exactly how "Added to bag" shipped with its product name
 * in white on paper: the toaster followed `prefers-color-scheme` (a `useTheme`
 * with no provider behind it) while its background was pinned to the light
 * token, and sonner's dark stylesheet painted the description near-white. No
 * gate raised a toast, so no gate could have caught it.
 *
 * This one raises the real add-to-bag toast — through the product page, the
 * size chip and the button, same as a customer — in an OS-light context and an
 * OS-dark one, and measures the *rendered* contrast of every text node inside
 * it. The site has one design; the toast must survive both settings.
 */
async function scanToastContrast(browser: Browser): Promise<number> {
  let violations = 0;

  for (const scheme of ["light", "dark"] as const) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 900 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1,
      colorScheme: scheme,
    });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(60_000);

    try {
      const added = await addToBag(page, FIXTURE_SLUGS[0]);
      if (!added) {
        console.log(
          `\n[toast/${scheme}] could not add ${FIXTURE_SLUGS[0]} to the bag — no in-stock size`,
        );
        violations++;
        continue;
      }
      await page.locator("[data-sonner-toast]").first().waitFor({
        timeout: 5_000,
      });
      await settleAnimations(page);

      /*
        A string, not a closure. tsx keeps function names by injecting a
        `__name` helper into transpiled arrow-function consts, and that helper
        does not exist inside the page — every audit that ships a closure with
        named inner functions to `evaluate` dies with "__name is not defined".
        Source passed as text goes to the browser untranspiled.
      */
      const readings = (await page.evaluate(`(() => {
        const parse = (color) => {
          const m = /rgba?\\(([\\d.]+)[, ]+([\\d.]+)[, ]+([\\d.]+)(?:[,/ ]+([\\d.]+))?\\)/.exec(color);
          return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : [255, 255, 255, 1];
        };
        const luminance = ([r, g, b]) => {
          const channel = (v) => {
            const s = v / 255;
            return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
          };
          return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
        };
        const backgroundOf = (start) => {
          let node = start;
          while (node) {
            const bg = parse(getComputedStyle(node).backgroundColor);
            if (bg[3] > 0.99) return bg;
            node = node.parentElement;
          }
          return [255, 255, 255, 1];
        };
        const contrast = (element) => {
          const pair = [luminance(parse(getComputedStyle(element).color)), luminance(backgroundOf(element))].sort((a, b) => b - a);
          return (pair[0] + 0.05) / (pair[1] + 0.05);
        };
        const toast = document.querySelector("[data-sonner-toast]");
        if (!toast) return null;
        const parts = [];
        for (const [part, selector] of [["title", "[data-title]"], ["description", "[data-description]"], ["action", "[data-button]"]]) {
          const element = toast.querySelector(selector);
          if (element) {
            parts.push({ part, ratio: Math.round(contrast(element) * 100) / 100, text: (element.textContent ?? "").slice(0, 40) });
          }
        }
        return parts;
      })()`)) as { part: string; ratio: number; text: string }[] | null;

      if (!readings || readings.length < 2) {
        console.log(
          `\n[toast/${scheme}] the toast rendered without measurable parts`,
        );
        violations++;
        continue;
      }
      for (const { part, ratio, text } of readings) {
        // 4.5:1, the AA floor for normal-size text. The description is the
        // line that carried the invisible product name.
        if (ratio < 4.5) {
          console.log(
            `\n[toast/${scheme}] ${part} "${text}" contrast ${ratio}:1 — below 4.5:1`,
          );
          violations++;
        }
      }
      console.log(
        `  toast/${scheme}: ${readings
          .map(({ part, ratio }) => `${part} ${ratio}:1`)
          .join(", ")}`,
      );
    } finally {
      await context.close();
    }
  }
  return violations;
}

async function main() {
  const browser = await chromium.launch();
  let violations = 0;

  process.stdout.write("building fixtures… ");
  const fixture = await buildFixture(browser);
  process.stdout.write(
    `bag=${fixture.guest.lines} order=${fixture.guestOrder.orderNumber} account=${fixture.account.orderNumber}\n`,
  );

  try {
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
        const passes = [
          await new AxeBuilder({ page }).withTags(TAGS).analyze(),
        ];
        await openOverlays(page, route.path);
        if (route.path.startsWith("/product/")) {
          passes.push(await new AxeBuilder({ page }).withTags(TAGS).analyze());
        }
        violations += report(`[${width}] ${route.path}`, passes);
      }
      await context.close();

      violations += await scanStates(browser, fixture, width);
    }

    violations += await scanToastContrast(browser);
  } finally {
    await browser.close();
  }

  const stateCount = auditStates(fixture).length;
  if (violations === 0) {
    console.log(
      `Clean: axe found no WCAG 2.2 A/AA violations across ${AUDIT_ROUTES.length} routes and ` +
        `${stateCount} populated states at 390px and 1440px.`,
    );
  } else {
    console.log(`\n${violations} violation groups.`);
    process.exitCode = 1;
  }
  console.log(
    `  (left behind: ${fixture.ledger.emails.join(", ")}, orders ${fixture.ledger.orderNumbers.join(", ")})`,
  );
}

void main();
