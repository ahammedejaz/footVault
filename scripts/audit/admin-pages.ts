/**
 * `npm run audit:admin-pages` — the admin screens, in a real browser.
 *
 * `audit:admin-security` proves a customer cannot reach the admin actions. This
 * suite proves the opposite half: that an admin *can*, that the screens render
 * what the database holds, and that the two numbers this phase turns on — the
 * advance and the balance — are on screen and correct.
 *
 * It is deliberately a browser suite rather than a unit test. The failure this
 * is written against is a page that type-checks, builds, and throws at render
 * because a server-only module crossed into a Client Component or a nullable
 * column was read without a guard. Only a request catches that.
 *
 * **It mutates as little as it can, and restores what it touches.** The
 * settings round-trip writes a real value and puts the original back in a
 * `finally`; the order it drives is one the checkout suite already abandoned.
 */

// clients first, before any other import and before anything reads
// process.env: importing it repoints this process at staging and refuses to
// run against production. This file used to read .env.local itself and
// therefore built its accounts and admin promotions on the LIVE shop while
// the app under test pointed at staging — found in Batch 3, the exact
// near-miss clients.ts exists to stop. See the batch 3 report.
import "./clients";

import { readFileSync } from "node:fs";

import AxeBuilder from "@axe-core/playwright";
import { chromium, type Page } from "playwright";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

import { ADMIN_NAV } from "../../src/components/admin/nav";
import { adminClient, createAccount, sessionCookies } from "./fixtures";
import { BASE_URL } from "./routes";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed += 1;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const admin = adminClient();

  /** An admin session, made by promoting a throwaway account with the service role. */
  const account = await createAccount("adminpages");
  {
    const { error } = await admin
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", account.userId);
    if (error) throw new Error(`could not promote the probe: ${error.message}`);
  }

  /** A Pay-on-Delivery order to look at. Any will do; the split is what matters. */
  const { data: orders, error: orderError } = await admin
    .from("orders")
    .select(
      "id, order_number, status, grand_total, advance_amount, balance_due_on_delivery, cod_handling_fee",
    )
    .gt("balance_due_on_delivery", 0)
    .order("created_at", { ascending: false })
    .limit(1);
  if (orderError) throw new Error(`could not read an order: ${orderError.message}`);
  const order = orders?.[0];

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies(await sessionCookies(account.session));
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  /** The original, restored in the finally below whatever happens. */
  const { data: originalRow, error: originalError } = await admin
    .from("site_settings")
    .select("value")
    .eq("key", "shipping")
    .maybeSingle();
  if (originalError) {
    throw new Error(
      `could not read site_settings.shipping, refusing to run: ${originalError.message}`,
    );
  }
  const originalShipping = originalRow?.value ?? null;

  try {
    /* ═══ 1 · the order detail page ═════════════════════════════════════════ */
    section("1 · /admin/orders/[id] renders, and the money is right");

    if (!order) {
      check("a Pay-on-Delivery order exists to inspect", false, "none found");
    } else {
      await page.goto(`${BASE_URL}/admin/orders/${order.id}`, {
        waitUntil: "load",
      });
      const body = await page.locator("body").innerText();

      check(
        "the page renders rather than 404ing for an admin",
        !body.includes("could not be found") && body.includes(order.order_number),
        body.slice(0, 120),
      );
      check(
        "the advance is on the page",
        body.includes(rupees(order.advance_amount)),
        `looking for ${rupees(order.advance_amount)}`,
      );
      check(
        "the balance the courier collects is on the page",
        body.includes(rupees(order.balance_due_on_delivery)),
        `looking for ${rupees(order.balance_due_on_delivery)}`,
      );
      check(
        "the order total is on the page",
        body.includes(rupees(order.grand_total)),
        `looking for ${rupees(order.grand_total)}`,
      );
      check(
        "it says the courier collects the balance, not the total",
        /courier will be asked to collect/i.test(body) ||
          /has not been paid for yet/i.test(body),
      );

      /* The five fulfilment steps, and their gating. */
      const stepLabels = await page
        .locator("button", { hasText: /Create shipment|Assign AWB|Book pickup|Generate documents|Refresh tracking/ })
        .allTextContents();
      check(
        "all five fulfilment steps have a button",
        stepLabels.length >= 5,
        `${stepLabels.length} found: ${stepLabels.join(", ")}`,
      );

      const awbButton = page.getByRole("button", { name: /Assign AWB/ });
      check(
        "assigning an AWB is blocked until a shipment exists",
        await awbButton.isDisabled(),
      );

      /* A note is additive and safe to leave behind. */
      const before = await timelineCount(page);
      await page.locator("#order-note").fill("Audit probe: admin page suite");
      await page.getByRole("button", { name: /^Add note$/ }).click();
      await page.waitForTimeout(2500);
      const after = await timelineCount(page);
      check(
        "an admin can add a note and it lands on the timeline",
        after > before,
        `${before} → ${after}`,
      );

      const violations = await axe(page);
      check(
        "axe finds no violations on the order page",
        violations.length === 0,
        violations.join("; "),
      );
    }

    /* ═══ 1b · every admin route renders ═══════════════════════════════════ */
  section("1b · Every screen in the panel opens");

  /**
   * A page that type-checks and builds can still throw at render — a
   * `server-only` module reaching a Client Component, a nullable column read
   * without a guard, a function prop crossing the RSC boundary. Only a request
   * catches those, and until this suite existed nothing made one behind the
   * admin guard.
   *
   * Checked at 768px, which is the tablet the owner will actually hold.
   */
  const { data: someProduct, error: productError } = await admin
    .from("products")
    .select("id")
    .limit(1)
    .maybeSingle();
  check(
    "a product exists to open an edit page for",
    productError === null && someProduct !== null,
    productError?.message ?? "none found",
  );

  const routes = [
    ...ADMIN_NAV.map((item) => item.href),
    "/admin/products/new",
    ...(someProduct ? [`/admin/products/${someProduct.id}`] : []),
  ];

  await page.setViewportSize({ width: 768, height: 1024 });
  for (const route of routes) {
    const before = pageErrors.length;
    const response = await page.goto(`${BASE_URL}${route}`, {
      waitUntil: "load",
    });
    const text = await page.locator("body").innerText();
    const broke =
      /Application error|could not be found|This page could not/i.test(text);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1,
    );
    check(
      `${route} renders`,
      response?.status() === 200 && !broke && pageErrors.length === before,
      `status ${response?.status()} ${broke ? "· error page" : ""} ${pageErrors.slice(before).join("; ")}`,
    );
    check(`${route} does not overflow a tablet`, !overflow);
    const routeViolations = await axe(page);
    check(
      `${route} is axe clean`,
      routeViolations.length === 0,
      routeViolations.join("; "),
    );
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  /* ═══ 2 · settings ══════════════════════════════════════════════════════ */
    section("2 · /admin/settings reads and writes");

    await page.goto(`${BASE_URL}/admin/settings`, { waitUntil: "load" });
    const settingsBody = await page.locator("body").innerText();
    check(
      "the settings page renders for an admin",
      settingsBody.includes("Pay on Delivery"),
      settingsBody.slice(0, 120),
    );
    check(
      "it says plainly that rates are not set here",
      /Delivery rates are not set here/i.test(settingsBody),
    );

    const freeAbove = page.locator("#free-above");
    const originalFree = await freeAbove.inputValue();
    check(
      "the free-delivery threshold is populated from the database",
      originalFree !== "" && Number(originalFree) > 0,
      originalFree,
    );

    /*
     * Round-trip a real change through the action and back out of the
     * database — and prove the save *merges* rather than replaces, with a
     * sentinel this harness plants rather than a key it hopes still exists.
     * The old version asserted `currency`/`regions` and `cod_advance_mode`
     * survived, and all three are dead: the first two were seed fossils
     * nothing ever read, and the third was deleted by 20260809110100 on
     * purpose. Against production's pre-migration row the checks passed;
     * against a rebuilt database they asserted the presence of a bug. A
     * sentinel tests the property itself — "keys this form does not know
     * outlive its save" — and cannot go stale with the schema.
     */
    const sentinel = `qa-${Date.now().toString(36)}`;
    {
      const { data: row, error } = await admin
        .from("site_settings")
        .select("value")
        .eq("key", "shipping")
        .maybeSingle();
      if (error || !row?.value || typeof row.value !== "object") {
        throw new Error(`could not read shipping row to plant sentinel: ${error?.message}`);
      }
      const { error: plantError } = await admin
        .from("site_settings")
        .update({ value: { ...(row.value as object), qa_sentinel: sentinel } })
        .eq("key", "shipping");
      if (plantError) throw new Error(`could not plant sentinel: ${plantError.message}`);
    }

    await freeAbove.fill("3111");
    await page.getByRole("button", { name: /Save delivery settings/ }).click();
    await page.waitForTimeout(3000);

    const { data: saved, error: savedError } = await admin
      .from("site_settings")
      .select("value")
      .eq("key", "shipping")
      .maybeSingle();
    check("the saved settings can be read back", savedError === null, savedError?.message ?? "");
    const savedValue = (saved?.value ?? {}) as Record<string, unknown>;
    check(
      "saving writes paise, not rupees",
      savedValue.free_above_paise === 311_100,
      String(savedValue.free_above_paise),
    );
    check(
      "saving preserves keys the form does not know about",
      savedValue.qa_sentinel === sentinel,
      String(savedValue.qa_sentinel),
    );
    // No restore here: the finally at the end of this run puts back the whole
    // row captured at startup, which predates both the sentinel and the save.

    const settingsViolations = await axe(page);
    check(
      "axe finds no violations on the settings page",
      settingsViolations.length === 0,
      settingsViolations.join("; "),
    );

    /* ═══ 3 · a customer still cannot see any of it ═════════════════════════ */
    section("3 · the same pages, as a plain customer");

    const customer = await createAccount("adminpages-customer");
    const plain = await browser.newContext();
    await plain.addCookies(await sessionCookies(customer.session));
    const plainPage = await plain.newPage();
    const settingsResponse = await plainPage.goto(`${BASE_URL}/admin/settings`, {
      waitUntil: "load",
    });
    const plainBody = await plainPage.locator("body").innerText();
    check(
      "a customer opening /admin/settings sees nothing of it",
      !plainBody.includes("Delivery rates are not set here"),
      `status ${settingsResponse?.status()}`,
    );
    if (order) {
      await plainPage.goto(`${BASE_URL}/admin/orders/${order.id}`, {
        waitUntil: "load",
      });
      const plainOrder = await plainPage.locator("body").innerText();
      check(
        "nor the order detail page",
        !plainOrder.includes(order.order_number),
      );
    }
    await plain.close();
    await admin.auth.admin.deleteUser(customer.userId).catch(() => {});

    /* ═══ 4 · nothing threw in the browser ══════════════════════════════════ */
    section("4 · no client-side errors");
    check(
      "no uncaught page errors across the admin screens",
      pageErrors.length === 0,
      pageErrors.join("; "),
    );
  } finally {
    /* Put the shop back exactly as it was, whatever happened above. */
    if (originalShipping !== null) {
      const { error } = await admin
        .from("site_settings")
        .update({ value: originalShipping })
        .eq("key", "shipping");
      if (error) {
        console.error(
          `\n  !! could not restore site_settings.shipping: ${error.message}`,
        );
      } else {
        console.log("\n  restored site_settings.shipping to its original value");
      }
    }
    await admin.auth.admin.deleteUser(account.userId).catch(() => {});
    await browser.close();
  }

  console.log(
    `\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m` +
      (failures.length ? `\n\n${failures.map((f) => `  · ${f}`).join("\n")}` : ""),
  );
  process.exit(failed > 0 ? 1 : 0);


}

void main();

/* ------------------------------------------------------------------ parts -- */

/** The rendered form of an amount, for a substring match against the page. */
function rupees(paise: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  })
    .format(paise / 100)
    .replace(/ /g, " ");
}

async function timelineCount(page: Page): Promise<number> {
  return page.locator("ol li").count();
}

async function axe(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return result.violations.map((v) => `${v.id} (${v.nodes.length})`);
}
