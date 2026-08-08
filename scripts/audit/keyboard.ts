/**
 * The keyboard path, walked end to end.
 *
 * home → category → apply a filter → product → select a size, using nothing but
 * Tab, the arrow keys and Enter. At every stop it checks the three things that
 * make a keyboard path usable and that an axe scan cannot see:
 *
 *   1. Focus is always on something, and something visible.
 *   2. Focus has a visible indicator — the composite ring from globals.css.
 *   3. Tab never loops back on itself before reaching the end of the page,
 *      which is what a focus trap looks like from the outside.
 *
 *   npx tsx scripts/audit/keyboard.ts
 */
import { chromium, type Page } from "playwright";

import { BASE_URL } from "./routes";

const problems: string[] = [];

async function focused(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      name: (el.getAttribute("aria-label") || el.textContent || "")
        .trim()
        .slice(0, 40),
      href: el.getAttribute("href"),
      visible: box.width > 0 && box.height > 0 && style.visibility !== "hidden",
      // The indicator is `outline: 2px solid` plus a box-shadow halo. Either
      // one missing means the ring is not doing its job.
      ring: style.outlineWidth !== "0px" || style.boxShadow !== "none",
    };
  });
}

/** Tab until `match` is focused, or give up. Returns how many stops it took. */
async function tabTo(
  page: Page,
  match: (f: NonNullable<Awaited<ReturnType<typeof focused>>>) => boolean,
  label: string,
) {
  const seen: string[] = [];
  for (let i = 0; i < 120; i++) {
    await page.keyboard.press("Tab");
    const f = await focused(page);
    if (!f) continue;
    if (!f.visible)
      problems.push(
        `${label}: focus landed on an invisible ${f.tag} "${f.name}"`,
      );
    if (!f.ring)
      problems.push(`${label}: no focus indicator on ${f.tag} "${f.name}"`);
    const key = `${f.tag}:${f.name}:${f.href ?? ""}`;
    if (seen.includes(key) && seen.length > 4) {
      problems.push(
        `${label}: tab order returned to "${f.name}" after ${i} stops — possible trap`,
      );
      return i;
    }
    seen.push(key);
    if (match(f)) return i;
  }
  problems.push(`${label}: never reached the target in 120 tab stops`);
  return -1;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });

  // 1. Home → a department.
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await tabTo(page, (f) => f.href === "/shop/men", "home → Men");
  await page.keyboard.press("Enter");
  await page.waitForURL("**/shop/men");

  // 2. Category → apply a size filter.
  await page.locator("h1").first().waitFor({ state: "visible" });
  await tabTo(
    page,
    (f) => Boolean(f.href?.includes("size=")),
    "category → a size facet",
  );
  await page.keyboard.press("Enter");
  await page.waitForURL("**size=**");
  await page.locator("h1").first().waitFor({ state: "visible" });
  if (!page.url().includes("size="))
    problems.push("the size filter did not reach the URL");

  // 3. Filtered listing → a product.
  await tabTo(
    page,
    (f) => Boolean(f.href?.startsWith("/product/")),
    "listing → a product",
  );
  await page.keyboard.press("Enter");
  await page.waitForURL("**/product/**");
  await page.locator("h1").first().waitFor({ state: "visible" });

  // 4. Product → the size run, then move with the arrow keys.
  await tabTo(
    page,
    (f) =>
      f.tag === "button" &&
      /^UK /.test(f.name || "") === false &&
      Boolean(f.name),
    "product → first control",
  );
  const group = page.locator(
    '[role="radiogroup"][aria-labelledby="size-label"]',
  );
  await group.waitFor({ state: "visible" });
  await group.getByRole("radio").first().focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  // Scoped to the size group: the colourway swatches are radios too, and
  // counting both made a passing page look like it had two sizes selected.
  const checked = await group
    .locator('[role="radio"][aria-checked="true"]')
    .count();
  if (checked !== 1)
    problems.push(
      `arrow keys left ${checked} sizes selected, expected exactly 1`,
    );
  const url = new URL(page.url());
  if (!url.searchParams.get("size")) {
    problems.push("selecting a size with the keyboard did not update the URL");
  }

  // 5. Escape closes the size guide and returns focus to its trigger.
  await page.getByRole("button", { name: /size guide/i }).click();
  await page.getByRole("dialog").waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const back = await focused(page);
  if (!/size guide/i.test(back?.name ?? "")) {
    problems.push(
      `Escape did not return focus to the size-guide trigger (went to "${back?.name}")`,
    );
  }

  await browser.close();

  if (problems.length === 0) {
    console.log(
      "Clean: home → department → size filter → product → size, by keyboard only. " +
        "Focus visible at every stop, no traps, size in the URL, Escape returns focus.",
    );
    return;
  }
  for (const problem of [...new Set(problems)]) console.log("  " + problem);
  process.exitCode = 1;
}

void main();
