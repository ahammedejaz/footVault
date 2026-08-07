/**
 * The whole purchase path, in a real browser, on a phone-sized screen.
 *
 * "Browse on a phone, add three items in different sizes, close the browser,
 * come back, still have your cart" — the sentence the phase is finished
 * against. Run against a production build:
 *
 *   npx next start -p 3210
 *   npx tsx scripts/audit/bag-flow.ts
 *
 * The "close the browser" step is a new browser context reusing only the
 * cookies, which is what surviving a restart actually means: nothing in memory,
 * nothing in localStorage, just the httpOnly guest token.
 */
import { chromium, type Page } from "playwright";

const BASE = process.env.AUDIT_BASE_URL ?? "http://localhost:3210";
const PHONE = { width: 390, height: 844 };

let failures = 0;
function check(name: string, passed: boolean, detail = "") {
  if (!passed) failures++;
  console.log(`${passed ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** Add the first in-stock size of a product to the bag. */
async function addFirstAvailableSize(page: Page, slug: string): Promise<string | null> {
  await page.goto(`${BASE}/product/${slug}`, { waitUntil: "load" });

  // The chips carry their meaning in the accessible name — "UK 9", "UK 6, sold
  // out" — so that is what to select on rather than the visible digit.
  const chip = page.locator('button[aria-label^="UK "]:not([aria-label*="sold out"])').first();
  if ((await chip.count()) === 0) return null;

  const size = (await chip.getAttribute("aria-label")) ?? null;
  await chip.click();

  await page.getByRole("button", { name: "Add to bag" }).first().click();
  await page.getByText("Added to bag").first().waitFor({ timeout: 10_000 });
  return size;
}

async function bagCount(page: Page): Promise<number> {
  const label = await page.locator('a[href="/cart"]').first().getAttribute("aria-label");
  const match = /(\d+)/.exec(label ?? "");
  return match ? Number(match[1]) : 0;
}

async function main() {
  console.log("\nThe bag, in a browser at 390px\n");

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: PHONE });
  const page = await context.newPage();

  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  /* 1 ── three shoes, three sizes ─────────────────────────────────────────── */
  const slugs = ["nike-air-max-90-mens", "adidas-samba-og-mens", "puma-suede-classic-mens"];
  const added: string[] = [];
  for (const slug of slugs) {
    const size = await addFirstAvailableSize(page, slug);
    if (size) added.push(`${slug} ${size}`);
  }
  check("three items added from three product pages", added.length === 3, added.join(", "));

  await page.reload({ waitUntil: "load" });
  check("the header badge counts them", (await bagCount(page)) === 3, `badge = ${await bagCount(page)}`);

  /* 2 ── close the browser, come back ─────────────────────────────────────── */
  const cookies = await context.cookies();
  const guest = cookies.find((c) => c.name === "fv_guest");
  check("the guest token is an httpOnly cookie", Boolean(guest?.httpOnly), guest ? `httpOnly=${guest.httpOnly}` : "absent");
  check("the bag is not in localStorage",
    !(await page.evaluate(() => JSON.stringify(Object.keys(localStorage)))).includes("bag"),
    await page.evaluate(() => JSON.stringify(Object.keys(localStorage))));

  await context.close();

  // A brand new context — no memory, no storage — carrying only the cookies a
  // restarted browser would still have.
  const revisit = await browser.newContext({ viewport: PHONE });
  await revisit.addCookies(cookies);
  const back = await revisit.newPage();
  back.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  back.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  await back.goto(`${BASE}/`, { waitUntil: "load" });
  check("the bag survived closing the browser", (await bagCount(back)) === 3, `badge = ${await bagCount(back)}`);

  /* 3 ── the drawer ───────────────────────────────────────────────────────── */
  await back.locator('a[href="/cart"]').first().click();
  const drawer = back.getByRole("dialog");
  await drawer.waitFor({ timeout: 10_000 });
  check("the bag drawer opens from the header", await drawer.isVisible());

  const rows = drawer.locator("li").filter({ has: back.locator("button[aria-label^='One more']") });
  await rows.first().waitFor({ timeout: 10_000 });
  check("the drawer lists all three lines", (await rows.count()) === 3, `${await rows.count()} rows`);

  await drawer.locator("button[aria-label^='One more']").first().click();
  await back.waitForTimeout(1500);
  check("the stepper adds a unit", (await bagCount(back)) === 4, `badge = ${await bagCount(back)}`);

  await back.keyboard.press("Escape");

  /* 4 ── the cart page ────────────────────────────────────────────────────── */
  await back.goto(`${BASE}/cart`, { waitUntil: "load" });
  const heading = await back.getByRole("heading", { level: 1 }).first().textContent();
  check("the cart page renders", (heading ?? "").toLowerCase().includes("your bag"), heading ?? "");
  check("free shipping progress is shown",
    (await back.getByText(/free shipping/i).count()) > 0);
  check("the coupon field is present and plainly not live",
    (await back.locator("#coupon").count()) > 0 && (await back.locator("#coupon").isDisabled()));
  check("checkout is reachable", (await back.getByRole("link", { name: /checkout/i }).count()) > 0);

  /* 5 ── remove, with an undo ─────────────────────────────────────────────── */
  await back.getByRole("button", { name: /^Remove/ }).first().click();
  await back.getByText("Removed from bag").first().waitFor({ timeout: 10_000 });
  check("removing offers an undo", (await back.getByRole("button", { name: "Undo" }).count()) > 0);
  await back.getByRole("button", { name: "Undo" }).first().click();
  await back.waitForTimeout(2000);
  check("undo puts it back", (await bagCount(back)) === 4, `badge = ${await bagCount(back)}`);

  /* 6 ── the wishlist asks for an account ─────────────────────────────────── */
  await back.goto(`${BASE}/wishlist`, { waitUntil: "load" });
  check("signed out, saved items offers Google sign-in",
    (await back.getByRole("button", { name: /continue with google/i }).count()) > 0);

  const real = errors.filter((e) => !/favicon|404 \(Not Found\)/.test(e));
  check("no console errors anywhere in the flow", real.length === 0, real.slice(0, 3).join(" | "));

  await browser.close();
  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nHarness error:", error);
  process.exit(1);
});
