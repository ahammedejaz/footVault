/**
 * The routes a flat list cannot describe.
 *
 * `AUDIT_ROUTES` in ./routes.ts is every screen reachable by typing a URL with
 * no history behind you. That is a real list and it stays, but it is exactly
 * half the storefront: `/cart` on that list is the empty bag, `/checkout` is the
 * "nothing to check out" panel, `/account/orders` is the sign-in pitch. Every
 * control a customer actually touches — the quantity steppers, the line-item
 * links, the address radios, the failure panels — lives on the other half, and
 * none of it was measured until this file existed. A 98×18px cart line-item
 * link is what that cost.
 *
 * A state is a route plus the identity that makes it interesting, plus
 * optionally one action performed on arrival. `fixtures.ts` builds the
 * identities; this decides which page each one is pointed at.
 *
 * `once: true` marks a state that consumes something it cannot put back — the
 * browser-failure panel places a real order before Razorpay ever opens, which
 * is the whole reason that panel says "resume" rather than "retry". Those are
 * visited at one width instead of six.
 */
import type { Cookie, Page } from "playwright";

import type { QaFixture } from "./fixtures";
import { QA_ADDRESS, QA_EMAIL_PREFIX } from "./fixtures";
import { RAZORPAY_CHECKOUT_SRC } from "../../src/components/checkout/razorpay";

export type AuditState = {
  name: string;
  path: string;
  /** Which of the fixture's cookie jars this state is seen through. */
  as: keyof Pick<QaFixture, "guest" | "guestOrder" | "account"> | "failure" | "browserFailure";
  /** Performed after the page is ready — opens an overlay, submits a form. */
  after?: (page: Page) => Promise<void>;
  /** Visited at the narrowest width only, because it cannot be repeated. */
  once?: boolean;
};

/** Type a delivery address into whichever checkout form is on screen. */
async function fillAddress(page: Page, guest: boolean) {
  await page.fill("#checkout-recipientName", QA_ADDRESS.recipientName);
  await page.fill("#checkout-phone", QA_ADDRESS.phone);
  await page.fill("#checkout-line1", QA_ADDRESS.line1);
  await page.fill("#checkout-city", QA_ADDRESS.city);
  await page.fill("#checkout-postalCode", QA_ADDRESS.postalCode);
  await page.selectOption("#checkout-state", QA_ADDRESS.state);
  if (guest) await page.fill("#checkout-contactEmail", `${QA_EMAIL_PREFIX}guest@example.com`);
}

export function auditStates(fixture: QaFixture): AuditState[] {
  return [
    /* ------------------------------------------------------------- the bag -- */
    { name: "cart-populated", path: "/cart", as: "guest" },
    {
      name: "bag-drawer",
      path: "/",
      as: "guest",
      after: async (page) => {
        await page.locator('a[href="/cart"]').first().click();
        await page.getByRole("dialog").waitFor({ state: "visible", timeout: 15_000 });
        // The drawer fetches its lines after it animates in; measuring before
        // they land measures an empty panel.
        await page.getByRole("button", { name: /^One more/ }).first().waitFor({ timeout: 15_000 });
        // The panel is still sliding in when its lines land. `waitForReady`
        // settles animations on arrival; this state creates one afterwards.
        await page
          .locator('[role="dialog"]')
          .first()
          .evaluate((node) => Promise.allSettled(node.getAnimations().map((a) => a.finished)));
      },
    },

    /* ------------------------------------------------------------ checkout -- */
    { name: "checkout-populated", path: "/checkout", as: "guest" },
    {
      name: "checkout-invalid",
      path: "/checkout",
      as: "guest",
      after: async (page) => {
        // Client-side only: no round trip, so this state is repeatable at every
        // width and leaves nothing behind.
        await page.getByRole("button", { name: /place order|^pay /i }).click();
        await page.locator("#checkout-recipientName-error").waitFor({ timeout: 10_000 });
      },
    },
    {
      name: "checkout-out-of-stock",
      path: "/checkout",
      as: "failure",
      after: async (page) => {
        await fillAddress(page, true);
        await page.locator('input[name="paymentMethod"][value="cod"]').check();
        await page.getByRole("button", { name: /place order/i }).click();
        await page.getByText(/reached the last pair first/i).waitFor({ timeout: 30_000 });
      },
    },
    { name: "checkout-signed-in", path: "/checkout", as: "account" },
    {
      name: "checkout-new-address",
      path: "/checkout",
      as: "account",
      after: async (page) => {
        await page.locator('input[name="addressChoice"][value="new"]').check();
        await page.locator("#checkout-recipientName").waitFor({ timeout: 10_000 });
      },
    },
    {
      name: "checkout-modal-unavailable",
      path: "/checkout",
      as: "browserFailure",
      once: true,
      after: async (page) => {
        /*
         * The order is written before the modal is asked for, so blocking the
         * script is the honest way to reach the panel that has to say "nothing
         * has been charged" and offer a resume rather than a retry.
         *
         * The reload is load-bearing. `<Script strategy="lazyOnload">` fetches
         * checkout.js on the window load event, which has already fired by the
         * time an `after` handler runs — so a route registered here catches
         * nothing, Razorpay initialises, and `rzp.open()` puts *their* modal in
         * our document. A first run did exactly that and the overflow pass duly
         * reported a "Test Mode" ribbon 32px past a 360px viewport, which is a
         * finding about Razorpay's chrome and not about this shop.
         */
        await page.route(`${RAZORPAY_CHECKOUT_SRC}*`, (route) => route.abort());
        await page.route("**/checkout.razorpay.com/**", (route) => route.abort());
        await page.reload({ waitUntil: "load" });
        await page.locator("#checkout-recipientName").waitFor({ timeout: 20_000 });
        await fillAddress(page, true);
        await page.locator('input[name="paymentMethod"][value="razorpay"]').check();
        await page.getByRole("button", { name: /^pay /i }).click();
        await page
          .getByText(/the payment window did not open/i)
          .first()
          .waitFor({ timeout: 60_000 });
        // If any of Razorpay's own DOM reached the page, everything measured
        // after this point is theirs, not ours. Fail loudly rather than report
        // a third party's layout as a defect in the shop.
        const leaked = await page.locator(".razorpay-container, .razorpay-backdrop").count();
        if (leaked > 0) throw new Error(`Razorpay injected ${leaked} node(s) despite the block`);
      },
    },

    /* --------------------------------------------------------- the receipt -- */
    {
      name: "order-confirmation",
      path: `/order/${fixture.guestOrder.orderNumber}?placed=placed`,
      as: "guestOrder",
    },
    {
      name: "order-confirmation-account",
      path: `/order/${fixture.account.orderNumber}`,
      as: "account",
    },

    /* ----------------------------------------------------------- the account */
    { name: "account-signed-in", path: "/account", as: "account" },
    { name: "account-orders-populated", path: "/account/orders", as: "account" },
    {
      name: "account-order-detail",
      path: `/account/orders/${fixture.account.orderId}`,
      as: "account",
    },
    { name: "account-addresses-populated", path: "/account/addresses", as: "account" },
    {
      name: "account-address-form",
      path: "/account/addresses",
      as: "account",
      after: async (page) => {
        await page.getByRole("button", { name: /add an address/i }).click();
        await page.locator("#checkout-recipientName").waitFor({ timeout: 10_000 });
      },
    },
  ];
}

/** The jar a state is seen through. */
export function jarFor(fixture: QaFixture, as: AuditState["as"]): Cookie[] {
  switch (as) {
    case "guest":
      return fixture.guest.cookies;
    case "guestOrder":
      return fixture.guestOrder.cookies;
    case "account":
      return fixture.account.cookies;
    case "failure":
      return fixture.failure.cookies;
    case "browserFailure":
      return fixture.browserFailure.cookies;
  }
}
