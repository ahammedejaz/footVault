/**
 * Does the focus indicator actually paint?
 *
 * globals.css defines one composite indicator for the whole site — a 2px orange
 * outline at 1px offset, sitting on a 4px halo drawn by `box-shadow` — in
 * `@layer base`. Tailwind's `outline-none` lives in `@layer utilities`, and at
 * equal specificity a later layer wins. So a single `outline-none` in a
 * component's class string silently deletes the orange half of the indicator
 * and leaves only the navy halo, on every instance of that component, site-wide.
 *
 * That is exactly what `button.tsx` and `input.tsx` shipped with. It survived
 * review three times because the comment above each component said the ring was
 * global and the halo still drew, so the control did look focused — just not
 * with the indicator the design system specifies, and not at the contrast the
 * orange was chosen to provide.
 *
 * This is therefore a **regression test, not a one-off check**: it asserts the
 * computed style of a genuinely keyboard-focused control, which is the only
 * form of the question a class-string grep cannot answer.
 *
 *   npx tsx scripts/audit/focus-ring.ts
 */
import { chromium, type Page } from "playwright";

import { buildGuestBag } from "./fixtures";
import { BASE_URL } from "./routes";

const ORANGE = "rgb(254, 147, 1)";

let failures = 0;
function check(name: string, passed: boolean, detail = "") {
  if (!passed) failures++;
  console.log(
    `  ${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`,
  );
}

type Ring = {
  found: boolean;
  tag: string;
  focusVisible: boolean;
  outlineStyle: string;
  outlineWidth: number;
  outlineColor: string;
  boxShadow: string;
};

/**
 * Tab until `selector` holds focus, then measure it.
 *
 * Tab rather than `.focus()` on purpose: `:focus-visible` is a statement about
 * *how* focus arrived, and a programmatic focus does not match it on a button
 * in Chromium. Walking there with the keyboard is also the only version of the
 * question a customer can ask.
 *
 * `ringHost` measures somewhere other than the focused element — the
 * ChoiceCard's real control is an opacity-0 radio stretched over the card, and
 * the indicator is deliberately repeated on the label so it appears where the
 * eye is.
 */
async function tabToRing(
  page: Page,
  selector: string,
  ringHost?: string,
): Promise<Ring> {
  for (let stop = 0; stop < 150; stop++) {
    await page.keyboard.press("Tab");
    const landed = await page.evaluate(
      (match) =>
        Boolean((document.activeElement as HTMLElement | null)?.matches(match)),
      selector,
    );
    if (!landed) continue;

    /*
     * Let the transition finish before reading the colour.
     *
     * Every ui/ primitive carries `transition-colors`, and Tailwind's colour
     * transition list includes `outline-color`. Measured the instant Tab lands,
     * the outline is still interpolating away from `currentColor` and reads
     * navy — which looked exactly like the `outline-none` bug this file exists
     * to catch, and was not. A bare `<a>` in the header has no transition and
     * read orange immediately, which is what gave the artefact away.
     */
    await page.waitForTimeout(500);

    return page.evaluate(
      ([match, host]) => {
        const active = document.activeElement as HTMLElement | null;
        if (!active || !active.matches(match)) {
          return {
            found: false,
            tag: match,
            focusVisible: false,
            outlineStyle: "none",
            outlineWidth: 0,
            outlineColor: "",
            boxShadow: "none",
          };
        }
        const target = host
          ? ((active.closest(host) as HTMLElement | null) ?? active)
          : active;
        const style = getComputedStyle(target);
        return {
          found: true,
          tag: `${active.tagName.toLowerCase()}${
            active.getAttribute("data-slot")
              ? `[${active.getAttribute("data-slot")}]`
              : ""
          }`,
          focusVisible: active.matches(":focus-visible"),
          outlineStyle: style.outlineStyle,
          outlineWidth: Number.parseFloat(style.outlineWidth) || 0,
          outlineColor: style.outlineColor,
          boxShadow: style.boxShadow,
        };
      },
      [selector, ringHost ?? ""] as const,
    );
  }
  return {
    found: false,
    tag: selector,
    focusVisible: false,
    outlineStyle: "none",
    outlineWidth: 0,
    outlineColor: "",
    boxShadow: "none",
  };
}

/** The four assertions that together mean "the indicator is on screen". */
function assertRing(label: string, ring: Ring) {
  if (!ring.found) {
    check(`${label} is reachable by Tab`, false, "never focused in 150 stops");
    return;
  }
  check(`${label} matches :focus-visible`, ring.focusVisible, ring.tag);
  check(
    `${label} has an outline style`,
    ring.outlineStyle !== "none",
    `outline-style: ${ring.outlineStyle}`,
  );
  check(
    `${label} outline is at least 2px`,
    ring.outlineWidth >= 2,
    `outline-width: ${ring.outlineWidth}px`,
  );
  check(
    `${label} outline is the brand orange`,
    ring.outlineColor === ORANGE,
    `outline-color: ${ring.outlineColor}`,
  );
  // "not none" is too weak: Tailwind composes an all-transparent shadow chain
  // when its shadow variables are empty, which is not a halo. The 4px spread is
  // the thing globals.css actually draws.
  check(
    `${label} carries the 4px halo`,
    /0px 0px 0px 4px/.test(ring.boxShadow),
    ring.boxShadow.slice(0, 70),
  );
}

async function main() {
  console.log(
    "\nThe composite focus indicator, measured on focused controls\n",
  );

  const browser = await chromium.launch();
  // A bag, not the full fixture: nothing here reads an order, and the full
  // fixture costs two real ones.
  const bag = await buildGuestBag(browser);

  try {
    /* The header, on a page anybody can reach signed out. */
    const plain = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const home = await plain.newPage();
    await home.goto(`${BASE_URL}/`, { waitUntil: "load" });
    assertRing("a header link", await tabToRing(home, "a[href]"));
    await plain.close();

    /* Every ui/ primitive that carries a focusable control, on one page. */
    const shop = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    await shop.addCookies(bag.cookies);
    const checkout = await shop.newPage();
    await checkout.goto(`${BASE_URL}/checkout`, { waitUntil: "load" });
    await checkout
      .locator("#checkout-recipientName")
      .waitFor({ state: "visible" });

    assertRing(
      "ui/input",
      await tabToRing(checkout, 'input[data-slot="input"]'),
    );

    await checkout.goto(`${BASE_URL}/checkout`, { waitUntil: "load" });
    await checkout.locator("#checkout-state").waitFor({ state: "visible" });
    assertRing(
      "ui/select",
      await tabToRing(checkout, 'select[data-slot="select"]'),
    );

    await checkout.goto(`${BASE_URL}/checkout`, { waitUntil: "load" });
    await checkout
      .locator("#checkout-customerNote")
      .waitFor({ state: "visible" });
    assertRing(
      "the delivery-note textarea",
      await tabToRing(checkout, "textarea"),
    );

    await checkout.goto(`${BASE_URL}/checkout`, { waitUntil: "load" });
    await checkout.locator('input[name="paymentMethod"]').first().waitFor();
    assertRing(
      "a payment ChoiceCard",
      await tabToRing(checkout, 'input[name="paymentMethod"]', "label"),
    );

    await checkout.goto(`${BASE_URL}/checkout`, { waitUntil: "load" });
    /**
     * Waited for by *role*, not by name — and that is a fix, not a loosening.
     *
     * This waited for `/place order|^pay /i`, which the submit button cannot say
     * until a delivery quote exists, which needs a postcode. The fixture is a
     * **guest with a bag and no address**, so the label is "Enter a delivery
     * address" and the wait could only ever time out. Measured on a fresh guest
     * checkout, on this branch and on `main`:
     *
     *     submit buttons: ["", "Enter a delivery address"]
     *
     * A pre-existing failure rather than a Phase 7 regression —
     * `checkout-flow.tsx` is byte-identical to `main` — but it means
     * `npm run audit` has not completed for some time, because `audit:focus` is
     * in that chain. What this assertion is actually for is that a `ui/button`
     * paints the composite ring; the button's *copy* is the keyboard-checkout
     * suite's business, and it asserts the pay label there with an address
     * filled in.
     */
    await checkout
      .locator('button[data-slot="button"][type="submit"]')
      .first()
      .waitFor({ state: "visible" });
    assertRing(
      "ui/button",
      await tabToRing(checkout, 'button[data-slot="button"]'),
    );
    await shop.close();
  } finally {
    await browser.close();
  }

  console.log(
    failures === 0
      ? "\nThe indicator paints: outline present, 2px, orange, on a halo, on every primitive.\n"
      : `\n${failures} check(s) FAILED — the focus indicator is not what globals.css says it is.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nHarness error:", error);
  process.exit(1);
});
