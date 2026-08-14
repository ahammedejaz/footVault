/**
 * Buying something with no mouse.
 *
 * `keyboard.ts` walks the browse half — home → department → filter → product →
 * size. This walks the half that takes money: add to bag → the drawer → the bag
 * → checkout → address → payment method → place a cash-on-delivery order → find
 * it in the order history. Every stop is a real Tab, a real arrow key, a real
 * Enter; nothing here calls `.click()` on something a keyboard could not reach.
 *
 * At every landing it asserts the three things axe cannot see:
 *
 *   1. Focus is on something, and something visible.
 *   2. The composite indicator from globals.css is actually painting — outline
 *      *and* halo, not one of the two. (`focus-ring.ts` proves the same thing
 *      per primitive; here it is proved along the path a customer takes.)
 *   3. Nothing traps. The bag drawer is allowed to hold focus while it is open,
 *      because that is what a modal is for — but Escape has to give it back.
 *
 *   npx next start -p 3210
 *   npx tsx scripts/audit/keyboard-checkout.ts
 *
 * It signs in with a throwaway account, because "view it in account orders" is
 * the last step and a guest has no history to view. The account is left behind
 * for scripts/audit/teardown.ts.
 */
import { chromium, type Page } from "playwright";

import {
  adminClient,
  createAccount,
  QA_ADDRESS,
  sessionCookies,
} from "./fixtures";
import { assertNotProduction, assertServerNotProduction } from "./clients";
import { BASE_URL } from "./routes";

/*
  The credential guard, on a harness that does not write.

  That is the point of it. "This file only reads" is a fact about the file
  *today*, and the next edit that adds one `.insert(` to reproduce a state
  invalidates it — silently, against whatever database `.env.local` happens to
  name. The whole reason the guard moved from a rule about files into a property
  of the credential (see clients.ts) is that a rule of the first kind is only
  ever as complete as the last person to think about it, and it had been
  believed complete four times.

  Two guards, two different questions, and neither answers the other:
  `assertNotProduction` is about the database *this process* holds credentials
  for; `assertServerNotProduction` below is about the database the *server at
  BASE_URL* is backed by. On 2026-08-14 the second was missing and production
  picked up two guest carts while the first one passed.
*/
assertNotProduction("run audit:keyboard-checkout");

let failures = 0;
function check(name: string, passed: boolean, detail = "") {
  if (!passed) failures++;
  console.log(
    `  ${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`,
  );
}

type Stop = {
  tag: string;
  name: string;
  href: string | null;
  role: string | null;
  visible: boolean;
  outline: boolean;
  halo: boolean;
  inDialog: boolean;
  revisits: number;
};

async function focused(page: Page): Promise<Stop | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    // A ChoiceCard's radio is an opacity-0 input stretched over its label, and
    // the indicator is repeated on the label on purpose. Measure whichever of
    // the two is carrying it.
    const host = (el.closest("label") as HTMLElement | null) ?? el;
    const hostStyle = getComputedStyle(host);
    return {
      tag: el.tagName.toLowerCase(),
      name: (
        el.getAttribute("aria-label") ||
        el.textContent ||
        el.getAttribute("name") ||
        ""
      )
        .trim()
        .slice(0, 44),
      href: el.getAttribute("href"),
      role: el.getAttribute("role"),
      visible: box.width > 0 && box.height > 0 && style.visibility !== "hidden",
      outline:
        (style.outlineStyle !== "none" &&
          Number.parseFloat(style.outlineWidth) > 0) ||
        (hostStyle.outlineStyle !== "none" &&
          Number.parseFloat(hostStyle.outlineWidth) > 0),
      halo: style.boxShadow !== "none" || hostStyle.boxShadow !== "none",
      inDialog: Boolean(el.closest('[role="dialog"]')),
      // Identity, not a name. Three cart lines each carry a "Remove" button
      // with the same tag, the same accessible name and no href, so a
      // name-based key says the tab order looped the moment it reached the
      // second line — and the walk gave up on a bag that was working fine.
      revisits: (() => {
        const count = Number(el.getAttribute("data-fv-tab-seen") ?? "0") + 1;
        el.setAttribute("data-fv-tab-seen", String(count));
        return count;
      })(),
    };
  });
}

const problems: string[] = [];

/**
 * Tab until `match` holds focus, checking the indicator at every landing.
 *
 * There is deliberately no "possible trap" guess in here. Tabbing off the end
 * of a document wraps back to the top in a headless browser — there is no
 * browser chrome to hand focus to — so "focus returned to something it has
 * already visited" describes normal behaviour just as often as it describes a
 * trap, and the version that guessed reported one on a three-line cart. The two
 * questions that *are* answerable are asked directly instead: an open modal
 * must keep focus, and a page with nothing open must let it go.
 */
async function tabTo(
  page: Page,
  match: (stop: Stop) => boolean,
  label: string,
  limit = 150,
): Promise<Stop | null> {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("[data-fv-tab-seen]")) {
      el.removeAttribute("data-fv-tab-seen");
    }
  });
  let distinct = 0;
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press("Tab");
    const stop = await focused(page);
    if (!stop) continue;
    if (stop.revisits === 1) distinct++;
    if (!stop.visible)
      problems.push(
        `${label}: focus landed on an invisible ${stop.tag} "${stop.name}"`,
      );
    if (!stop.outline)
      problems.push(`${label}: no outline on ${stop.tag} "${stop.name}"`);
    if (!stop.halo)
      problems.push(`${label}: no focus halo on ${stop.tag} "${stop.name}"`);
    if (match(stop)) return stop;
  }
  problems.push(
    `${label}: never reached the target in ${limit} tab stops (${distinct} distinct controls in the ring)`,
  );
  return null;
}

/**
 * Wait for the drawer to have finished reading the bag.
 *
 * `[role="dialog"]` is visible the instant the store flips `drawerOpen` — see
 * `openDrawer()` in `src/lib/stores/bag.ts`, which sets the flag and *then*
 * fires the fetch. Until that answers, the panel is the "Reading your bag"
 * placeholder whose only focusable control is Close, and Radix loops a
 * one-control ring straight back onto it. Tabbing then reports "never reached
 * the target (1 distinct controls in the ring)" about a drawer that is working
 * perfectly and simply has not been filled in yet.
 *
 * So wait for the contents, the way every navigation here waits for its <h1>.
 * It bites on a cold dev server, where the first /api/cart pays the on-demand
 * compile, and passes on a warm one — which is exactly the kind of flake that
 * gets blamed on the last commit rather than on the harness.
 *
 * A drawer that never fills in is a real defect, so it is recorded rather than
 * thrown: the run keeps its remaining checks either way.
 */
async function drawerFilled(page: Page) {
  await page
    .getByRole("dialog")
    .getByRole("link", { name: "Go to your bag" })
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {
      problems.push("the bag drawer never finished reading the bag");
    });
}

/**
 * Wait for checkout to know what delivery costs.
 *
 * Same class of problem, one step later. The Place Order button is
 * `aria-disabled` until a Shiprocket quote lands, because nothing may be placed
 * at a price the customer has not been shown, and its label is the amount about
 * to be charged — neither of which exists yet while the quote is in flight.
 * Tabbing to it before then finds a control whose label does not match and
 * whose state refuses the press.
 */
async function deliveryPriced(page: Page) {
  /**
   * Poll the *pay* button, not "any submit button that is not disabled".
   *
   * The header search is also a submit button, so
   * `button[type=submit]:not([aria-disabled=true])` matched it and resolved
   * instantly — the wait never waited, and every assertion after it read a
   * checkout that had not been priced yet. The page has exactly one pay button
   * and it is the last one.
   */
  await page
    .waitForFunction(
      () => {
        const buttons = [
          ...document.querySelectorAll('button[type="submit"]'),
        ];
        const pay = buttons[buttons.length - 1];
        return pay ? pay.getAttribute("aria-disabled") !== "true" : false;
      },
      undefined,
      { timeout: 25_000 },
    )
    .catch(() => {
      problems.push("checkout never settled on a delivery price");
    });
}

/**
 * The order the keypress just created, once the server has written it.
 *
 * Polled rather than awaited on a navigation, because there is no navigation:
 * the Razorpay modal opens over the checkout. The row appears within a second
 * or two of the press, so a short poll is honest and a long one would hide a
 * real failure to place.
 */
async function waitForPlacedOrder(userId: string) {
  const admin = adminClient();
  for (let attempt = 0; attempt < 20; attempt++) {
    const { data, error } = await admin
      .from("orders")
      .select(
        "order_number, status, payment_status, grand_total, advance_amount, balance_due_on_delivery",
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      problems.push(`could not read the placed order: ${error.message}`);
      return null;
    }
    if (data) return data;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

/** Type into whatever holds focus. Asserts it landed where it was aimed. */
async function typeInto(page: Page, id: string, value: string, label: string) {
  const stop = await tabTo(
    page,
    (s) => s.tag === "input" || s.tag === "textarea",
    `${label} field`,
  );
  const actualId = await page.evaluate(() => document.activeElement?.id ?? "");
  if (actualId !== id) {
    problems.push(
      `${label}: Tab reached #${actualId || stop?.tag} rather than #${id}`,
    );
    return;
  }
  await page.keyboard.type(value);
}

async function main() {
  /*
    The browser writes wherever BASE_URL points, which the credential guard
    cannot see. See clients.ts — this is the half that let production pick up
    two guest carts on 2026-08-14.
  */
  await assertServerNotProduction(BASE_URL, "run audit:keyboard-checkout");

  console.log(
    "\nBrowse → bag → checkout → COD order → order history, by keyboard only\n",
  );

  const account = await createAccount("keyboard");
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await context.addCookies(await sessionCookies(account.session));
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(60_000);

  /* 1 ── home → a department, then a product ──────────────────────────────── */
  await page.goto(`${BASE_URL}/`, { waitUntil: "load" });
  await tabTo(page, (s) => s.href === "/shop/men", "home → Men");
  await page.keyboard.press("Enter");
  await page.waitForURL("**/shop/men");
  await page.locator("h1").first().waitFor({ state: "visible" });

  await tabTo(
    page,
    (s) => Boolean(s.href?.startsWith("/product/")),
    "listing → a product",
  );
  await page.keyboard.press("Enter");
  await page.waitForURL("**/product/**");
  await page.locator("h1").first().waitFor({ state: "visible" });

  /* 2 ── a size, with the arrow keys ──────────────────────────────────────── */
  const group = page.locator(
    '[role="radiogroup"][aria-labelledby="size-label"]',
  );
  await group.waitFor({ state: "visible" });
  /**
   * The *size* radios, by their accessible name, not the first radio on the
   * page. A product with more than one colour renders a colour radiogroup
   * before the sizes, and each group is one Tab stop under roving tabindex —
   * so "the first radio" is a colour swatch there, and fourteen ArrowRights
   * inside that group never meet a size. This matched by role alone until the
   * staging rebuild reordered the listing and put a two-colour product first,
   * which is the closest a harness gets to a fuzzer.
   */
  await tabTo(
    page,
    (s) => s.role === "radio" && /^UK /.test(s.name),
    "product → the size run",
  );

  // Arrow past anything sold out. A roving tabindex means one Tab reaches the
  // group and the arrows move inside it, which is the whole point of the shape.
  let chosen = "";
  for (let i = 0; i < 14; i++) {
    const label = await page.evaluate(
      () => document.activeElement?.getAttribute("aria-label") ?? "",
    );
    if (label.startsWith("UK ") && !label.includes("sold out")) {
      chosen = label;
      break;
    }
    await page.keyboard.press("ArrowRight");
  }
  /**
   * Space, because this group uses manual activation: the arrows move focus
   * and deliberately do not select (the APG's selection-follows-focus is a
   * *should*, and a size picker that buys stockroom queries on every arrow
   * press is the argument for not following it). The harness used to skip
   * this and still pass — the first product on /shop/men had its first size
   * in stock, so zero arrows were pressed and the click… did not happen
   * there either; what actually saved it was never proven and the state was
   * never asserted. Now it is: the chip must end *checked*, not merely
   * focused, or the Add to bag below is Enter on a button that will refuse.
   */
  await page.keyboard.press("Space");
  const checked = await page.evaluate(
    () =>
      document
        .querySelector(
          '[role="radiogroup"][aria-labelledby="size-label"] [aria-checked="true"]',
        )
        ?.getAttribute("aria-label") ?? "",
  );
  check(
    "an in-stock size is selectable with the arrow keys",
    chosen !== "" && checked === chosen,
    chosen ? `${chosen}${checked === chosen ? "" : " focused but not selected"}` : "none found",
  );
  await page.waitForTimeout(600);

  /* 3 ── add to bag ───────────────────────────────────────────────────────── */
  await tabTo(page, (s) => /add to bag/i.test(s.name), "product → Add to bag");
  await page.keyboard.press("Enter");
  await page.getByText("Added to bag").first().waitFor({ timeout: 15_000 });
  check("Enter on Add to bag put something in the bag", true, chosen);

  /* 4 ── the drawer, and out of it again ──────────────────────────────────── */
  await page.goto(`${BASE_URL}/`, { waitUntil: "load" });
  await tabTo(page, (s) => s.href === "/cart", "header → the bag");
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog");
  await drawer.waitFor({ state: "visible", timeout: 15_000 });
  check("the bag drawer opens from the keyboard", await drawer.isVisible());
  await drawerFilled(page);

  // A modal is *supposed* to hold focus. What must not happen is focus escaping
  // to the page behind it while it is open.
  let escaped = 0;
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    const stop = await focused(page);
    if (stop && !stop.inDialog) escaped++;
  }
  check(
    "focus stays inside the open drawer",
    escaped === 0,
    `${escaped} of 25 stops outside it`,
  );

  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden", timeout: 10_000 });
  const returned = await focused(page);
  check(
    "Escape closes the drawer and returns focus to the header bag",
    returned?.href === "/cart",
    returned
      ? `${returned.tag} "${returned.name}"`
      : "focus was lost to the body",
  );

  /* 5 ── the bag page → checkout ──────────────────────────────────────────── */
  // Re-focus the bag link by hand rather than assuming Escape left focus on it.
  // It does not — see the check above — and a harness that assumed otherwise
  // stopped dead at the one failure it had just found, taking the six checks
  // after it down with it. Report the defect, then keep walking.
  await page.locator('a[href="/cart"]').first().focus();
  await page.keyboard.press("Enter");
  await drawer.waitFor({ state: "visible", timeout: 15_000 });
  await drawerFilled(page);
  await tabTo(
    page,
    (s) => /go to your bag/i.test(s.name),
    "drawer → Go to your bag",
    40,
  );
  await page.keyboard.press("Enter");
  await page.waitForURL("**/cart");
  await page.locator("h1").first().waitFor({ state: "visible" });

  await tabTo(page, (s) => s.href === "/checkout", "bag → Checkout");
  await page.keyboard.press("Enter");
  await page.waitForURL("**/checkout");
  await page
    .locator("#checkout-recipientName")
    .waitFor({ state: "visible", timeout: 20_000 });
  check("checkout is reachable by keyboard from the bag", true, page.url());

  /* 6 ── the address ──────────────────────────────────────────────────────── */
  await page.locator("h1").first().focus();
  await typeInto(
    page,
    "checkout-recipientName",
    QA_ADDRESS.recipientName,
    "recipient",
  );
  await typeInto(page, "checkout-phone", QA_ADDRESS.phone, "phone");
  await typeInto(page, "checkout-line1", QA_ADDRESS.line1, "line 1");
  await typeInto(page, "checkout-line2", "", "line 2");
  await typeInto(page, "checkout-city", QA_ADDRESS.city, "city");
  await typeInto(
    page,
    "checkout-postalCode",
    QA_ADDRESS.postalCode,
    "PIN code",
  );

  // The state field is a native <select> precisely so the keyboard already
  // works: focus it and type the name.
  const state = await tabTo(page, (s) => s.tag === "select", "address → State");
  await page.keyboard.type(QA_ADDRESS.state);
  const stateValue = await page.locator("#checkout-state").inputValue();
  check(
    "the state select takes a typed value",
    stateValue === QA_ADDRESS.state,
    stateValue || "empty",
  );
  check(
    "the state select shows a focus indicator",
    Boolean(state?.outline && state?.halo),
  );

  /* 7 ── the payment method ───────────────────────────────────────────────── */
  const radio = await tabTo(
    page,
    (s) => s.tag === "input" && s.name === "paymentMethod",
    "checkout → payment method",
  );
  check(
    "the payment choice shows a focus indicator on its card",
    Boolean(radio?.outline),
  );
  const codChecked = await page
    .locator('input[name="paymentMethod"][value="cod"]')
    .isChecked();
  check("cash on delivery is the reachable default", codChecked);

  /* 8 ── place it ─────────────────────────────────────────────────────────── */
  // Nothing may be placed at a price the customer has not been shown, so the
  // button is aria-disabled and unlabelled until the courier quote lands.
  await deliveryPriced(page);
  const payLabel = await page
    .locator('button[type="submit"]')
    .last()
    .textContent();
  check(
    "the button names the amount about to be charged",
    /^Pay ₹/.test((payLabel ?? "").trim()),
    (payLabel ?? "").trim(),
  );

  await tabTo(
    page,
    (s) => /place order|^pay /i.test(s.name),
    "checkout → Place order",
  );
  await page.keyboard.press("Enter");

  /**
   * **Pressing pay no longer lands on the receipt, and that is the feature.**
   *
   * Pay on Delivery takes an advance through Razorpay before the order is
   * confirmed, so the button opens a provider modal. The order itself is
   * written first — `pending` and `unpaid`, holding its stock — and only the
   * webhook confirms it. A headless run cannot complete a payment inside
   * Razorpay's iframe, so what is asserted here is the half this shop owns:
   * that the keypress created a real order with the right money on it.
   */
  const placed = await waitForPlacedOrder(account.userId);
  check(
    "Enter on the pay button placed a Pay-on-Delivery order",
    placed !== null,
    placed?.order_number ?? "no order appeared",
  );
  const orderNumber = placed?.order_number ?? "";
  if (placed) {
    check(
      "it waits for the advance rather than confirming itself",
      placed.status === "pending" && placed.payment_status === "unpaid",
      `${placed.status}/${placed.payment_status}`,
    );
    check(
      "the advance and the balance sum to the total",
      placed.advance_amount + placed.balance_due_on_delivery ===
        placed.grand_total,
      `${placed.advance_amount} + ${placed.balance_due_on_delivery} = ${placed.grand_total}`,
    );
    check(
      "the courier is left something to collect",
      placed.balance_due_on_delivery > 0,
      String(placed.balance_due_on_delivery),
    );
  }

  /* 9 ── find it in the history ───────────────────────────────────────────── */
  await page.goto(`${BASE_URL}/account/orders`, { waitUntil: "load" });
  await page.locator("h1").first().waitFor({ state: "visible" });
  check(
    "the order is in the account history",
    orderNumber !== "" && (await page.getByText(orderNumber).count()) > 0,
    orderNumber,
  );

  /* 10 ── the page itself does not trap ───────────────────────────────────── */
  // With no modal open, tabbing off the end of the document hands focus back to
  // the browser and `document.activeElement` falls to <body>. Never reaching
  // that in 200 stops is what an accidental trap looks like from outside.
  let reachedEnd = false;
  for (let i = 0; i < 200; i++) {
    await page.keyboard.press("Tab");
    if ((await focused(page)) === null) {
      reachedEnd = true;
      break;
    }
  }
  check("tabbing off the end of the order history is possible", reachedEnd);

  await browser.close();
  await releaseOrder(orderNumber);

  for (const problem of [...new Set(problems)]) {
    failures++;
    console.log(`  FAIL  ${problem}`);
  }

  console.log(
    failures === 0
      ? `\nThe whole purchase is possible with a keyboard. Order ${orderNumber}, ` +
          "focus visible at every stop, no unintended traps.\n"
      : `\n${failures} check(s) FAILED.\n`,
  );
  console.log(`  (account left behind: ${account.email})\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Give the stock back.
 *
 * This suite now places a real order, and a Pay-on-Delivery order holds its
 * units from the moment it is written until the advance captures or the sweep
 * cancels it thirty minutes later. Run the suite a few times in a row without
 * this and the fixture product sells out — which is exactly what happened, and
 * the next run failed at "an in-stock size is selectable" with no clue why.
 */
async function releaseOrder(orderNumber: string): Promise<void> {
  if (!orderNumber) return;
  const admin = adminClient();
  const { data, error } = await admin
    .from("orders")
    .select("id, status")
    .eq("order_number", orderNumber)
    .maybeSingle();
  if (error || !data || data.status !== "pending") return;

  const { error: cancelError } = await admin.rpc("cancel_order_with_restock", {
    p_order_id: data.id,
    p_reason: "Audit fixture cleanup: releasing stock held by a test order",
    p_require_unpaid: true,
    p_release_cart: true,
  });
  if (cancelError) {
    console.error(
      `  !! ${orderNumber} still holds its stock: ${cancelError.message}`,
    );
  }
}

main().catch((error) => {
  // The findings so far are the point of the run; losing them because a later
  // step could not proceed is how one defect hides the six checks behind it.
  for (const problem of [...new Set(problems)])
    console.log(`  FAIL  ${problem}`);
  console.error(
    "\nHarness stopped early:",
    (error as Error).message.split("\n")[0],
  );
  process.exit(1);
});
