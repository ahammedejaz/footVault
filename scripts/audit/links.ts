/**
 * Crawl every internal link and report anything that does not resolve.
 *
 * Also checks the two things a broken link is usually a symptom of: a page with
 * no canonical, and a page whose JSON-LD does not parse.
 *
 *   npx tsx scripts/audit/links.ts
 */
import { chromium } from "playwright";

import { BASE_URL } from "./routes";

const SKIP = /^(mailto:|tel:|https?:\/\/(?!localhost))/;
const MAX_PAGES = 250;

/**
 * Filters are links, and filters combine, so an unbounded crawl of a faceted
 * listing never finishes — the first run queued 2,225 URLs off 120 pages and
 * was still going. Every distinct *path* is crawled; query strings are sampled,
 * because the twentieth combination of size and colour on /shop exercises
 * exactly the same code as the second.
 */
const VARIANTS_PER_PATH = 3;

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // 60s rather than the 30s default: the first pass after a cold
  // `.next/cache/images` has to generate every optimised image on demand, and
  // a product page asking for four at once can sit well past 30s. Nothing
  // about that is a property of the site — it is the optimiser warming up —
  // so it should not read as a failure.
  page.setDefaultNavigationTimeout(60_000);

  const queue = ["/"];
  const seen = new Set(queue);
  const variants = new Map<string, number>();
  const problems: string[] = [];
  let crawled = 0;

  while (queue.length > 0 && crawled < MAX_PAGES) {
    const path = queue.shift()!;
    crawled++;

    const response = await page.goto(`${BASE_URL}${path}`, { waitUntil: "domcontentloaded" });
    const status = response?.status() ?? 0;
    if (status >= 400) {
      problems.push(`${path} — HTTP ${status}`);
      continue;
    }
    await page.locator("h1").first().waitFor({ state: "visible", timeout: 8000 }).catch(() => {
      problems.push(`${path} — no visible <h1>`);
    });

    const found = await page.evaluate(() => {
      const canonical = document
        .querySelector<HTMLLinkElement>('link[rel="canonical"]')
        ?.getAttribute("href");
      const jsonLd = Array.from(
        document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'),
      ).map((node) => node.textContent ?? "");
      const links = Array.from(document.querySelectorAll("a[href]"))
        .map((a) => a.getAttribute("href") ?? "")
        .filter(Boolean);
      const titles = document.title;
      return { canonical, jsonLd, links, titles };
    });

    if (!found.titles) problems.push(`${path} — empty <title>`);
    for (const block of found.jsonLd) {
      try {
        JSON.parse(block);
      } catch {
        problems.push(`${path} — JSON-LD does not parse`);
      }
    }

    for (const href of found.links) {
      if (SKIP.test(href) || href.startsWith("#")) continue;
      const url = new URL(href, `${BASE_URL}${path}`);
      if (url.origin !== BASE_URL) continue;
      const next = `${url.pathname}${url.search}`;
      if (seen.has(next)) continue;
      seen.add(next);

      if (url.search) {
        const taken = variants.get(url.pathname) ?? 0;
        if (taken >= VARIANTS_PER_PATH) continue;
        variants.set(url.pathname, taken + 1);
      }
      queue.push(next);
    }
  }

  await browser.close();

  console.log(
    `Crawled ${crawled} pages (${variants.size} paths with filtered variants sampled at ${VARIANTS_PER_PATH} each), ` +
      `${seen.size} unique internal links seen.`,
  );
  if (queue.length > 0) {
    console.log(`Stopped at the ${MAX_PAGES}-page cap with ${queue.length} still queued.`);
  }
  if (problems.length === 0) {
    console.log("No broken links, no missing titles, no malformed JSON-LD.");
    return;
  }
  for (const problem of [...new Set(problems)]) console.log("  " + problem);
  process.exitCode = 1;
}

void main();
