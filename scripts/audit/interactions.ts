/**
 * The behaviour a screenshot cannot show.
 *
 * Five things that are only ever true or false at runtime, and each of which
 * has a plausible way of silently not working:
 *
 *   1. Dismissing the announcement sticks across a reload, and the strip is
 *      gone from the first frame rather than rendered and then hidden.
 *   2. The mobile filter sheet opens, and tapping a facet inside it keeps it
 *      open with the count updated.
 *   3. Search returns results for a misspelling.
 *   4. A colourway swatch changes the gallery and the size run together.
 *   5. The sticky bar appears only after the real CTA has been scrolled past.
 *
 *   npx tsx scripts/audit/interactions.ts
 */
import { chromium, type Page } from "playwright";

import { BASE_URL } from "./routes";

const problems: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) problems.push(message);
};

async function announcement(page: Page) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "load" });
  const bar = page.locator("[data-announcement]");
  check(await bar.isVisible(), "announcement: not shown on a first visit");

  await page.getByRole("button", { name: /dismiss this announcement/i }).click();
  check(!(await bar.isVisible()), "announcement: still visible after dismissing");

  await page.reload({ waitUntil: "load" });
  check(!(await bar.isVisible()), "announcement: came back after a reload");

  // The strip must never paint and then vanish: the attribute that hides it is
  // set by a blocking script, so it is already there at DOMContentLoaded.
  const early = await page.evaluate(() =>
    document.documentElement.getAttribute("data-fv-announce"),
  );
  check(early === "off", "announcement: hidden attribute not set before paint");

  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());
}

async function filterSheet(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/shop/mens-sneakers`, { waitUntil: "load" });
  await page.locator("h1").first().waitFor({ state: "visible" });

  await page.getByRole("link", { name: /^filters/i }).click();
  const sheet = page.getByRole("dialog", { name: /filters/i });
  await sheet.waitFor({ state: "visible", timeout: 5000 });

  // The facet states its own count; after applying it the sticky action must
  // agree. Comparing "before" with "after" would not catch a wrong number —
  // a facet whose count happens to equal the current total is a legitimate
  // no-change.
  const facet = sheet.getByRole("link", { name: /^UK 9,/ }).first();
  const promised = /(\d+) style/.exec((await facet.getAttribute("aria-label")) ?? (await facet.textContent()) ?? "")?.[1];
  await facet.click();
  await page.waitForURL("**size=9**", { timeout: 8000 });
  await sheet.waitFor({ state: "visible", timeout: 5000 });
  await page.waitForTimeout(400);
  const shown = /(\d+)/.exec(
    (await page.locator("text=/^Show \\d+ styles?$/").first().textContent()) ?? "",
  )?.[1];

  check(page.url().includes("size=9"), "filter sheet: the facet did not reach the URL");
  check(page.url().includes("panel=filters"), "filter sheet: closed itself after a tap");
  check(
    Boolean(promised) && promised === shown,
    `filter sheet: the facet promised ${promised} styles, the action offers ${shown}`,
  );
}

async function search(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/`, { waitUntil: "load" });
  await page.getByRole("button", { name: "Search" }).click();
  const dialog = page.getByRole("dialog", { name: /search the shop/i });
  await dialog.waitFor({ state: "visible", timeout: 5000 });

  await page.getByRole("searchbox").fill("pegasis");
  await dialog.getByRole("link", { name: /pegasus/i }).first().waitFor({ timeout: 5000 })
    .catch(() => problems.push("search: no result for the misspelling 'pegasis'"));
}

async function colourway(page: Page) {
  await page.goto(`${BASE_URL}/product/nike-air-max-90-mens`, { waitUntil: "load" });
  await page.locator("h1").first().waitFor({ state: "visible" });

  const firstFrame = await page.locator("ul[aria-label$='images'] img").first().getAttribute("src");
  await page.getByRole("radio", { name: /black \/ volt/i }).click();
  await page.waitForTimeout(300);
  const nextFrame = await page.locator("ul[aria-label$='images'] img").first().getAttribute("src");

  check(firstFrame !== nextFrame, "colourway: the gallery did not change with the swatch");
  check(page.url().includes("color="), "colourway: the choice did not reach the URL");
}

async function stickyBar(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/product/nike-air-max-90-mens`, { waitUntil: "load" });
  await page.locator("h1").first().waitFor({ state: "visible" });
  await page.waitForTimeout(400);

  const bar = page.locator("div").filter({ hasText: /^Pick a size$/ }).last();
  const hiddenAtFirst = await page.evaluate(
    () => document.querySelector('[aria-hidden="true"] button[disabled]') !== null,
  );
  check(hiddenAtFirst, "sticky bar: showing before the CTA has been seen");

  await page.getByRole("button", { name: "Add to bag" }).first().scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 1200);
  await page.waitForTimeout(500);
  const shown = await page.evaluate(() => {
    const fixed = Array.from(document.querySelectorAll<HTMLElement>("div")).find(
      (el) => getComputedStyle(el).position === "fixed" && el.textContent?.includes("Add to bag"),
    );
    return fixed ? !fixed.className.includes("translate-y-full") : false;
  });
  check(shown, "sticky bar: did not appear after scrolling past the CTA");
  void bar;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await announcement(page);
  await filterSheet(page);
  await search(page);
  await colourway(page);
  await stickyBar(page);

  await browser.close();

  if (problems.length === 0) {
    console.log(
      "Clean: announcement dismissal persists without a flash, the filter sheet " +
        "survives a facet tap, search forgives a misspelling, a swatch changes the " +
        "gallery and the URL, and the sticky bar waits for the CTA.",
    );
    return;
  }
  for (const problem of problems) console.log("  " + problem);
  process.exitCode = 1;
}

void main();
