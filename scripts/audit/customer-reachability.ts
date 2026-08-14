/**
 * Every customer-facing page, reachable by a customer who only ever clicks.
 *
 *   npm run audit:reachability
 *
 * ## The failure this exists to prevent, which happened
 *
 * Address editing was built, deployed, and reported missing by the owner —
 * because `/account/addresses` had no inbound link anywhere on the site, and
 * neither did `/account`, the only page that linked to it. Every gate passed:
 * `audit:address-book` **operates the edit control and asserts the row
 * changes**, but it arrives by typing the URL, which no customer does; and
 * `audit:links` crawls outward from the home page checking that whatever it
 * finds resolves — an orphan is precisely what an outward crawl never finds.
 * The operate-and-assert discipline covered the 31 admin controls
 * (`audit:settings-controls`, `audit:admin-pages`) and stopped at the shop
 * window.
 *
 * ## What this asserts
 *
 * The list of pages is derived from the filesystem — every `page.tsx` under
 * `src/app/(storefront)` — so a page added next month is expected here the
 * moment it exists, without anyone remembering to register it. The crawl then
 * plays the customer: start at `/`, signed in, and follow only what can be
 * seen and operated — visible links, plus the mobile drawer and the account
 * menu, opened the way a thumb would open them. Run at 390px and at 1440px
 * separately, because "reachable on a laptop, orphaned on the phone that
 * placed the order" is exactly how My Orders shipped.
 *
 * A dynamic segment (`/product/[slug]`) counts as reached when any concrete
 * instance of it is harvested. The exclusions carry their reasons inline and
 * are deliberately few.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import { adminClient, buildFixture } from "./fixtures";
import { whatsappHref } from "../../src/lib/contact";
import { BASE_URL } from "./routes";

let failures = 0;
function check(name: string, passed: boolean, detail = "") {
  if (!passed) failures++;
  console.log(
    `${passed ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`,
  );
}

/* ------------------------------------------------- the expected pages ---- */

const STOREFRONT_DIR = "src/app/(storefront)";

/**
 * Routes a click cannot reach, each with the reason it is allowed to be here.
 * Anything not on this list and not harvested is a failure.
 */
const EXCLUDED: Record<string, string> = {
  "/style-guide":
    "internal design reference; deliberately unlinked from the shop",
  "/order/[orderNumber]":
    "the guest order page — reached by completing a checkout or from the " +
    "confirmation email, both proven by audit:checkout and audit:bag; it has " +
    "no place in idle navigation",
};

function pagesFromFilesystem(): string[] {
  const routes: string[] = [];
  const walk = (dir: string, route: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full, `${route}/${entry}`);
      } else if (entry === "page.tsx") {
        routes.push(route === "" ? "/" : route);
      }
    }
  };
  walk(STOREFRONT_DIR, "");
  return routes.sort();
}

/** `/product/[slug]` → a matcher for any concrete instance. */
function matcherFor(route: string): RegExp {
  const pattern = route
    .split("/")
    .map((segment) =>
      segment.startsWith("[") && segment.endsWith("]")
        ? "[^/]+"
        : segment.replace(/[.*+?^${}()|\\]/g, "\\$&"),
    )
    .join("/");
  return new RegExp(`^${pattern}$`);
}

/* ------------------------------------------------------- the harvest ----- */

/** Visible internal links only — what a customer can actually see to click. */
async function visibleLinks(page: Page): Promise<string[]> {
  return page.$$eval('a[href^="/"]', (anchors) =>
    anchors
      .filter((a) => (a as HTMLElement).offsetParent !== null)
      .map((a) => (a as HTMLAnchorElement).getAttribute("href") ?? ""),
  );
}

/**
 * The two menus, operated rather than inspected. The drawer's panel is a
 * dynamic import that does not exist in the DOM until the button is pressed,
 * and Radix mounts dropdown content only while it is open — so a DOM-only
 * harvest structurally cannot see what these hold. That blindness is the bug
 * this file exists for.
 */
async function linksBehindMenus(page: Page, width: number): Promise<string[]> {
  const harvested: string[] = [];

  if (width < 1024) {
    const burger = page.getByRole("button", { name: "Open menu" });
    if ((await burger.count()) > 0) {
      await burger.first().click();
      await page.waitForTimeout(600);
      harvested.push(...(await visibleLinks(page)));
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }
  } else {
    const account = page.locator('button[aria-label^="Account"]');
    if ((await account.count()) > 0) {
      await account.first().click();
      await page.waitForTimeout(400);
      harvested.push(...(await visibleLinks(page)));
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }
  }
  return harvested;
}

/* --------------------------------------------------------- the crawl ----- */

const MAX_PAGES = 40;

async function crawl(
  browser: Browser,
  cookies: Parameters<
    Awaited<ReturnType<Browser["newContext"]>>["addCookies"]
  >[0],
  width: number,
  expected: { route: string; matcher: RegExp }[],
): Promise<Set<string>> {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    isMobile: width < 768,
    hasTouch: width < 768,
  });
  await context.addCookies(cookies);
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(60_000);

  const seenPaths = new Set<string>(["/"]);
  const queue = ["/"];
  const harvested = new Set<string>(["/"]);
  let visited = 0;

  while (queue.length > 0 && visited < MAX_PAGES) {
    const path = queue.shift()!;
    visited++;
    try {
      await page.goto(`${BASE_URL}${path}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(300);
    } catch {
      continue;
    }

    const found = [
      ...(await visibleLinks(page)),
      // The header menus are identical on every route; operating them once
      // per crawl, on the home page, keeps the run under a minute.
      ...(path === "/" ? await linksBehindMenus(page, width) : []),
    ];

    for (const href of found) {
      const clean = href.split("?")[0]!.split("#")[0]!;
      if (!clean.startsWith("/")) continue;
      harvested.add(clean);
      // Visit it only if it is a page we are accounting for — following
      // every filtered listing would be audit:links' unbounded crawl again.
      if (
        !seenPaths.has(clean) &&
        expected.some(({ matcher }) => matcher.test(clean))
      ) {
        seenPaths.add(clean);
        queue.push(clean);
      }
    }
  }

  await context.close();
  return harvested;
}

/**
 * The WhatsApp number the shop publishes, from the same row the page renders.
 *
 * Read through the audit client factories, so it is staging's value against
 * staging's pages. `audit:contact` is the one that asks whether the production
 * value is real; this one asks only whether the link mechanism works.
 */
async function storedWhatsApp(): Promise<string> {
  const { data, error } = await adminClient()
    .from("site_settings")
    .select("value")
    .eq("key", "contact")
    .maybeSingle();
  /*
    Thrown rather than swallowed to "". An unreadable row and an unset number
    are different problems with the same empty string, and reporting the second
    when it is the first is how a gate tells you the shop is broken while the
    real answer is that the harness could not reach the database.
  */
  if (error) throw new Error(`site_settings.contact unreadable: ${error.message}`);
  const value = data?.value;
  if (!value || typeof value !== "object") return "";
  const held = (value as Record<string, unknown>).whatsapp;
  return typeof held === "string" ? held : "";
}

/* --------------------------------------------------------------- main ---- */

async function main() {
  console.log("\nCustomer-facing reachability\n");

  const routes = pagesFromFilesystem();
  console.log(`  ${routes.length} pages under ${STOREFRONT_DIR}\n`);

  const browser = await chromium.launch();
  try {
    process.stdout.write("building fixtures… ");
    const fixture = await buildFixture(browser);
    console.log(`account=${fixture.account.email}\n`);

    const expected = routes
      .filter((route) => !(route in EXCLUDED))
      .map((route) => ({ route, matcher: matcherFor(route) }));

    for (const width of [390, 1440]) {
      console.log(`— at ${width}px, signed in —`);
      const harvested = await crawl(
        browser,
        fixture.account.cookies,
        width,
        expected,
      );

      for (const { route, matcher } of expected) {
        const hit = [...harvested].find((path) => matcher.test(path));
        check(
          `[${width}] ${route} is reachable by clicking`,
          hit !== undefined,
          hit ?? "no visible link leads there",
        );
      }
    }

    for (const [route, reason] of Object.entries(EXCLUDED)) {
      console.log(`  SKIP  ${route} — ${reason}`);
    }

    /**
     * The one channel the crawl above structurally cannot see.
     *
     * `visibleLinks` harvests `a[href^="/"]` — internal links, which is the
     * right harvest for "can a customer click their way to every page". A
     * WhatsApp link is external, so it was invisible to this harness, and on
     * 2026-08-14 the audit found there were **zero** `wa.me` links anywhere on
     * the site while the returns policy told a customer with a damaged parcel
     * to "Call or WhatsApp the store" inside 24 hours. Reachability was green
     * throughout.
     *
     * That is this gate's own failure mode, described in its header: a check
     * that reports on the shape it looks for rather than on the thing that
     * matters. So the shop's warranty channel is asserted directly, on the two
     * surfaces that carry it, and the href is compared against what
     * `whatsappHref` builds from the setting rather than merely existing —
     * a link to a mistyped number is worse than no link, because it looks
     * answered.
     */
    console.log(`\n— the WhatsApp route the returns policy relies on —`);
    let stored = "";
    let readFailure: string | null = null;
    try {
      stored = await storedWhatsApp();
    } catch (error) {
      readFailure = error instanceof Error ? error.message : "unknown";
    }
    const expectedHref = readFailure ? null : whatsappHref(stored);
    if (!expectedHref) {
      check(
        "site_settings.contact.whatsapp normalises to a wa.me link",
        false,
        readFailure ?? "unset or unusable — audit:contact explains which",
      );
    } else {
      const page = await browser.newPage();
      try {
        for (const path of ["/page/contact", "/"]) {
          await page.goto(`${BASE_URL}${path}`, {
            waitUntil: "domcontentloaded",
          });
          const hrefs = await page.$$eval('a[href^="https://wa.me/"]', (as) =>
            as.map((a) => (a as HTMLAnchorElement).href),
          );
          check(
            `${path} links to WhatsApp`,
            hrefs.some((href) => href.startsWith(expectedHref)),
            hrefs.length === 0
              ? "no wa.me link on the page"
              : `found ${hrefs.join(", ")}, expected ${expectedHref}`,
          );
        }
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  console.log(
    failures === 0
      ? "\nPASS — every customer-facing page is reachable by clicking, at both widths."
      : `\n${failures} pages are orphaned.`,
  );
  if (failures > 0) process.exitCode = 1;
}

void main();
