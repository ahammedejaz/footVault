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
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { chromium, type Page } from "playwright";

import { buildGuestBag } from "./fixtures";
import { assertServerNotProduction } from "./clients";
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
 * The indicator on whatever is focused right now.
 *
 * Split out of `tabToRing` so a caller that arrived by some other route — the
 * skip link, say — can measure the same five properties without walking there.
 * One implementation, because two would drift on the day the halo changes.
 */
async function ringOf(
  page: Page,
  selector: string,
  ringHost?: string,
): Promise<Ring> {
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
  /*
    The browser writes wherever BASE_URL points, which the credential guard
    cannot see. See clients.ts — this is the half that let production pick up
    two guest carts on 2026-08-14.
  */
  await assertServerNotProduction(BASE_URL, "run audit:focus");

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
    /*
      The two bespoke search inputs.

      These are not built from `ui/input`, which is exactly why the primitives
      above all passed while the search bar was visibly wrong: the gate proved
      the components and the search bar was not one of them. `search-panel`
      carried `outline-none`, which deletes the orange half of the composite
      indicator and leaves the 4px navy halo alone — a hard dark box, which is
      how the owner described it. The /search page's input had no indicator at
      all.
    */
    const searchPage = await browser.newPage();
    await searchPage.goto(`${BASE_URL}/search`, { waitUntil: "load" });

    /**
     * **Through the skip link, because that is the question.**
     *
     * This used to Tab from the top of the document with a budget of 150 stops,
     * and it went red. The diagnosis, 2026-08-15: the input *is* reachable that
     * way — at roughly stop 127, because the site header carries the whole
     * mega-nav and a keyboard walk crosses every category and every brand
     * before it reaches the page. Worse, the count is not stable: focusing a
     * nav trigger opens its panel and inserts more stops, so the total drifts
     * either side of 150 and the check failed intermittently for a reason that
     * had nothing to do with focus indicators.
     *
     * A budget of 150 brute-force stops is not a property worth asserting. It
     * degrades every time the owner adds a category, and it measures a path no
     * keyboard user takes when the page offers a skip link. **How many
     * keystrokes to reach the search box** is the real question, and the answer
     * should be three.
     *
     * Which makes this a stronger check than the one it replaces, because it
     * now fails on the thing that was actually broken: `<main>` had no
     * `tabindex="-1"`, so in Safari "Skip to content" moved neither focus nor
     * the focus starting point and the next Tab went back to the header.
     */
    const skip = searchPage.getByRole("link", { name: /skip to content/i });
    await searchPage.keyboard.press("Tab");
    check(
      "the skip link is the first thing a keyboard reaches",
      await skip.evaluate((el) => el === document.activeElement),
      "on a page whose header carries the whole mega-nav, this link is the difference between three keystrokes and a hundred and thirty",
    );

    await searchPage.keyboard.press("Enter");
    await searchPage.waitForTimeout(300);
    check(
      "and it puts focus inside main, not merely near it",
      await searchPage.evaluate(
        () => document.activeElement?.id === "main",
      ),
      "without tabindex=-1 this is <body>, which Chrome recovers from and Safari does not",
    );

    /**
     * Five, not one: the budget is what matters, not the exact position. A page
     * that grows a "filter" control above its search box is not broken, and a
     * check that hard-codes one keystroke would report that as a regression.
     */
    const SKIP_BUDGET = 5;
    let stopsAfterSkip = -1;
    for (let stop = 1; stop <= SKIP_BUDGET; stop++) {
      await searchPage.keyboard.press("Tab");
      const landed = await searchPage.evaluate(() =>
        Boolean(document.activeElement?.matches("input.h-12")),
      );
      if (landed) {
        stopsAfterSkip = stop;
        break;
      }
    }
    check(
      `the /search input is ${SKIP_BUDGET} keystrokes or fewer past the skip link`,
      stopsAfterSkip > 0,
      stopsAfterSkip > 0
        ? `reached at ${stopsAfterSkip} — Tab, Enter, ${"Tab, ".repeat(stopsAfterSkip).replace(/, $/, "")}`
        : `not reached within ${SKIP_BUDGET}`,
    );

    // And the indicator itself, now that focus is beside it.
    if (stopsAfterSkip > 0) {
      await searchPage.waitForTimeout(500);
      assertRing("the /search input", await ringOf(searchPage, "input.h-12"));
    }

    await searchPage.close();

    await shop.close();
  } finally {
    await browser.close();
  }

  /*
    A source-level rule beside the rendered one.

    The browser checks prove the elements they visit; this stops the next
    bespoke control being written the same way. `outline-hidden` on a menu item
    is allowed by name — those show focus through their background, which is a
    real indicator rather than none — and each exemption says so, because an
    allowlist without reasons is a list of things somebody found annoying.
  */
  const ALLOWED_OUTLINE_OFF = new Map<string, string>([
    [
      "src/components/ui/dropdown-menu.tsx",
      "menu items indicate focus with bg-accent, which is a visible indicator rather than none",
    ],
    [
      "src/components/ui/dialog.tsx",
      "the dialog panel itself takes focus on open; an outline around the whole sheet reads as an error state",
    ],
    [
      "src/components/checkout/checkout-failure.tsx",
      "a programmatically focused alert region, announced rather than operated",
    ],
  ]);

  /*
    Comments are stripped before matching, and that is not a nicety.

    `button.tsx`, `input.tsx` and `select.tsx` each carry a comment saying *"no
    outline-none, and it must stay that way"* — the very reasoning this rule
    enforces. A naive grep flags all three, which would either fail the gate
    forever or teach whoever hit it to delete the explanation. The first version
    of this check did exactly that.
  */
  const offenders = execSync("git ls-files 'src/**/*.tsx'", {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .filter((file) => !ALLOWED_OUTLINE_OFF.has(file))
    .filter((file) => {
      let inBlock = false;
      return readFileSync(file, "utf8")
        .split("\n")
        .some((line) => {
          const trimmed = line.trim();
          if (inBlock) {
            if (trimmed.includes("*/")) inBlock = false;
            return false;
          }
          if (trimmed.startsWith("/*")) {
            if (!trimmed.includes("*/")) inBlock = true;
            return false;
          }
          if (trimmed.startsWith("*") || trimmed.startsWith("//")) return false;
          return /outline-none|outline-hidden/.test(
            line.replace(/\/\/.*$/, ""),
          );
        });
    });

  check(
    "no component switches the focus outline off without a reason",
    offenders.length === 0,
    offenders.length
      ? `${offenders.join(", ")} — add to ALLOWED_OUTLINE_OFF with a reason, or drop the class`
      : `${ALLOWED_OUTLINE_OFF.size} allowed, each with a reason`,
  );

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
