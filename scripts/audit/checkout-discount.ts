/**
 * `npm run audit:checkout-discount` — the discount is on the screen, in words.
 *
 *   npm run dev:stage          # a server on :3210, pointed at staging
 *   npm run audit:checkout-discount
 *
 * ## The defect this exists to catch
 *
 * `computeOrderTotals` computed a prepaid discount correctly, the `Totals`
 * component drew a named "Paying online" row correctly, and between them
 * `checkout-flow.tsx` replaced `grandTotal` with the quoted (discounted) figure
 * while leaving `discountTotal` and `prepaidDiscount` at the pre-quote zeros. So
 * a customer buying a ₹3,999 pair with a 20% prepaid discount was charged
 * ₹3,249.20, shown that total, shown a Discount row reading "—", and shown no
 * "Paying online" row at all — because that row only renders above zero.
 *
 * **Every existing gate passed.** `audit:totals` proved the arithmetic in
 * isolation and it was never wrong. `audit:shipping` proved the quote. Nothing
 * anywhere asserted that the number a customer is charged is *explained* by the
 * lines printed above it. That is the assertion here, and it is deliberately
 * made the only way it can be made honestly: by reading the rendered page.
 *
 * ## What it asserts
 *
 * 1. With a prepaid discount configured, the words "Paying online" are on the
 *    checkout page and the discount figure is next to them.
 * 2. The lines add up: `subtotal − discount + delivery = order total`, read out
 *    of the DOM rather than recomputed from settings.
 * 3. The discount is a whole number of rupees, which is the owner's rounding
 *    decision of 2026-08-09 seen from the customer's side.
 * 4. Choosing Pay on Delivery withdraws it — one method, one price, and the
 *    difference is a line the customer can point at.
 *
 * It writes a discount into `site_settings.shipping` on **staging** and puts the
 * original row back in a `finally`, the same discipline `admin-pages.ts` uses.
 */

// clients first, before anything reads process.env: importing it repoints this
// process at staging and refuses to run against production.
import "./clients";

import { chromium, type Page } from "playwright";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Totals } from "../../src/components/checkout/totals";
import type { Json } from "../../src/lib/database.types";
import { adminClient, addToBag, createAccount, sessionCookies } from "./fixtures";
import { BASE_URL } from "./routes";

let passed = 0;
let failed = 0;
const failures: string[] = [];

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

function section(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/**
 * A percentage with a half in it, on purpose.
 *
 * A round 20% against a whole-rupee catalogue would round to itself and prove
 * nothing about the rounding rule. 12.5% of almost any price in this shop lands
 * on a fraction of a rupee, so the figure on screen is only whole if
 * `roundedDiscountPaise` actually ran.
 */
const DISCOUNT_PERCENT = 12.5;

/** ₹1,234.56 → 123456. The page prints "₹1,234.56"; the assertions need paise. */
function toPaise(rendered: string): number | null {
  const digits = rendered.replace(/[^\d.]/g, "");
  if (!digits) return null;
  return Math.round(Number(digits) * 100);
}

/**
 * The amount printed against a label in the totals list.
 *
 * Located by the **visible label**, never by an id or a nth-child. That is the
 * standing rule from §G of the phase 9 plan: a locator that does not go through
 * something a human reads can pass on a page a human cannot use.
 */
async function amountFor(page: Page, label: string): Promise<string | null> {
  return page.evaluate((wanted) => {
    const rows = Array.from(document.querySelectorAll("dl div, dl > *"));
    for (const row of rows) {
      const text = (row as HTMLElement).innerText ?? "";
      if (!text.toLowerCase().includes(wanted.toLowerCase())) continue;
      // The label and the amount are the two halves of the row; the amount is
      // whatever carries a rupee sign.
      const parts = text.split("\n").map((s) => s.trim()).filter(Boolean);
      const amount = parts.find(
        (s) => s.includes("₹") || s === "—" || /^free$/i.test(s),
      );
      if (amount) return amount;
    }
    return null;
  }, label);
}

/**
 * **Every money row reads its own field — the component itself, proven.**
 *
 * Pure, no browser: `Totals` is rendered directly with a fixture where every
 * part is distinct, non-zero, and — the part that matters — `discountTotal`
 * carries ₹300 belonging to neither the coupon nor the prepaid line, the shape
 * a third discount part (coins) would have. The retired derivation
 * `discountTotal − prepaidDiscount` would print the coupon as ₹700; the field
 * says ₹400. A fixture where parts can alias proves nothing (11C.2's whole
 * mechanism), so no two figures here format alike.
 */
function assertNamedLines() {
  console.log("\n\x1b[1m0 · every rendered row is a field, not arithmetic\x1b[0m");
  const html = renderToStaticMarkup(
    createElement(Totals, {
      couponCode: "SAVE400",
      totals: {
        subtotal: 974_600,
        discountTotal: 130_000,
        prepaidDiscount: 60_000,
        couponDiscount: 40_000,
        shippingFee: 16_000,
        forwardShippingFee: 11_000,
        codHandlingFee: 5_000,
        taxTotal: 0,
        grandTotal: 860_600,
        advanceAmount: 30_000,
        balanceDueOnDelivery: 830_600,
        coinPaid: 0,
      },
    }),
  );
  for (const [label, value] of [
    ["Subtotal", "₹9,746"],
    ["Shipping (forward leg, not the fee total)", "₹110"],
    ["Cash-handling fee", "₹50"],
    ["Paying online", "−₹600"],
    ["Coupon SAVE400", "−₹400"],
    ["Order total", "₹8,606"],
    ["Pay now", "₹300"],
    ["Pay in cash on delivery", "₹8,306"],
  ] as const) {
    check(`${label} renders its own field's value ${value}`, html.includes(value));
  }
  check("Coupon SAVE400 is the row's label", html.includes("Coupon SAVE400"));
  check(
    "nothing renders the ₹700 the retired subtraction would derive",
    !html.includes("₹700"),
  );
  check(
    "nothing renders the ₹160 fee total in Shipping's place",
    !html.includes("₹160"),
  );
}

async function main() {
  assertNamedLines();

  const admin = adminClient();

  const { data: originalRow, error: readError } = await admin
    .from("site_settings")
    .select("value")
    .eq("key", "shipping")
    .maybeSingle();
  if (readError || !originalRow?.value) {
    throw new Error(
      `could not read site_settings.shipping, refusing to run: ${readError?.message}`,
    );
  }
  const original = originalRow.value as Record<string, Json>;

  const browser = await chromium.launch();
  const account = await createAccount("discount");
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
  });
  await context.addCookies(await sessionCookies(account.session));
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    const { error: writeError } = await admin
      .from("site_settings")
      .update({
        value: {
          ...original,
          prepaid_discount: { mode: "percent", value: DISCOUNT_PERCENT },
        },
      })
      .eq("key", "shipping");
    if (writeError) throw new Error(`could not set the discount: ${writeError.message}`);

    /* ═══ 1 · a bag, and a destination ═════════════════════════════════════ */
    section("1 · a prepaid bag at a real destination");

    const size = await addToBag(page, "nike-air-max-90-mens");
    check("a pair is in the bag", size !== null, String(size));

    await page.goto(`${BASE_URL}/checkout`, { waitUntil: "load" });
    await page.locator("#checkout-recipientName").fill("QA Discount");
    await page.locator("#checkout-phone").fill("9876543210");
    await page.locator("#checkout-line1").fill("2 Test Street");
    await page.locator("#checkout-city").fill("Bengaluru");
    // A <select>, not a text field — the state list is fixed.
    await page.locator("#checkout-state").selectOption({ label: "Karnataka" });
    await page.locator("#checkout-postalCode").fill("560001");

    // Paying online, which is the only method the discount applies to.
    await page.locator('input[name="paymentMethod"][value="razorpay"]').check();

    // The quote is debounced at 400ms and then makes a live serviceability
    // call. Waited for by its effect on the page rather than by a fixed sleep.
    await page
      .getByText(/Paying online/)
      .first()
      .waitFor({ timeout: 30_000 })
      .catch(() => {});

    /* ═══ 2 · the discount is on the screen ════════════════════════════════ */
    section("2 · the customer can see what came off, and why");

    const body = await page.locator("body").innerText();
    check(
      'the words "Paying online" are on the page',
      /Paying online/.test(body),
      body.slice(0, 200).replace(/\n/g, " · "),
    );

    const prepaidRow = await amountFor(page, "Paying online");
    const subtotalRow = await amountFor(page, "Subtotal");
    // "Shipping" is the label the component actually prints. Looking for
    // "Delivery" found nothing and silently scored it as zero, which happened
    // to be the right number here and would not have been on a paid delivery.
    const deliveryRow = await amountFor(page, "Shipping");

    const prepaid = prepaidRow ? toPaise(prepaidRow) : null;
    const subtotal = subtotalRow ? toPaise(subtotalRow) : null;
    // "Free" is a price, not a missing one. Above the free-delivery threshold
    // the row says the word rather than ₹0, and reading that as "no row found"
    // would let a broken delivery line pass as zero.
    const delivery = /^free$/i.test(deliveryRow ?? "")
      ? 0
      : deliveryRow
        ? toPaise(deliveryRow)
        : null;

    check(
      "the prepaid discount has a figure beside it, not a dash",
      prepaid !== null && prepaid > 0,
      String(prepaidRow),
    );
    check(
      "and it is the discount the settings describe",
      prepaid !== null &&
        subtotal !== null &&
        Math.abs(prepaid - (subtotal * DISCOUNT_PERCENT) / 100) < 100,
      `${prepaidRow} against ${DISCOUNT_PERCENT}% of ${subtotalRow}`,
    );
    check(
      "it is a whole number of rupees — the rounding rule, from the outside",
      prepaid !== null && prepaid % 100 === 0,
      String(prepaid),
    );

    /* ═══ 3 · the lines explain the total ══════════════════════════════════ */
    section("3 · the total is the sum of the lines above it");

    /*
      Case-insensitively, because `innerText` returns *rendered* text and the
      label carries `text-transform: uppercase`. Matching "Total" against
      "TOTAL" is how the first version of this check reported a total that was
      plainly on the screen as missing.
    */
    const totalText = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("div"));
      for (const node of nodes) {
        const text = (node as HTMLElement).innerText ?? "";
        if (!/^(order )?total\n/i.test(text)) continue;
        const amount = text.split("\n")[1];
        if (amount?.includes("₹")) return amount.trim();
      }
      return null;
    });
    const total = totalText ? toPaise(totalText) : null;

    check(
      "the order total is on screen",
      total !== null && total > 0,
      String(totalText),
    );
    check(
      "subtotal − discount + delivery = total, as printed",
      total !== null &&
        subtotal !== null &&
        prepaid !== null &&
        delivery !== null &&
        subtotal - prepaid + delivery === total,
      `${subtotal} − ${prepaid} + ${delivery} ≠ ${total} (shipping row read as "${deliveryRow}")`,
    );

    /* ═══ 4 · Pay on Delivery does not get it ══════════════════════════════ */
    section("4 · the discount belongs to the method, and says so");

    const codRadio = page.locator('input[name="paymentMethod"][value="cod"]');
    if ((await codRadio.count()) === 0) {
      console.log(
        "  — Pay on Delivery is not offered for this bag; skipping, and that " +
          "is a real answer rather than a pass",
      );
    } else {
      await codRadio.check();
      await page.waitForTimeout(2_500);
      const codBody = await page.locator("body").innerText();
      check(
        "choosing Pay on Delivery removes the prepaid line entirely",
        !/Paying online/.test(codBody),
      );
    }

    /* ═══ 5 · nothing threw ════════════════════════════════════════════════ */
    section("5 · no client-side errors");
    check(
      "no uncaught page errors while the totals were changing",
      pageErrors.length === 0,
      pageErrors.join("; "),
    );
  } finally {
    const { error } = await admin
      .from("site_settings")
      .update({ value: original })
      .eq("key", "shipping");
    if (error) {
      console.error(`\n  !! could not restore site_settings.shipping: ${error.message}`);
    } else {
      console.log("\n  restored site_settings.shipping to its original value");
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
