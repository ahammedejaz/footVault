/**
 * `npm run audit:admin-mobile` — the admin panel on a phone, driven as a phone.
 *
 * ## The hole this fills
 *
 * Every existing browser gate opens a 1280×900 context. That is the desktop
 * rail, the wide table and the roomy dialog, and it is the layout the panel is
 * developed in. None of the failures the owner reported on 2026-08-19 are
 * visible there — all three were about a viewport 390px wide and ~670px tall:
 *
 *   - the drawer's `<nav>` had no `overflow-y-auto`, so with fifteen sections
 *     the last four sat below the fold of a sheet that is exactly one viewport
 *     tall, with `<body>` scroll-locked by Radix. Not awkward: unreachable.
 *   - `DialogContent` had no `max-h`, so a tall form hung off both ends of the
 *     screen with no gesture that could reach the rest of it.
 *   - the tables' action columns sat ~46rem to the right of a sideways-scrolling
 *     wrapper, which is how "add or remove a brand" came to be reported as a
 *     missing feature when the buttons had been there all along.
 *
 * ## What it asserts, and why it is not a snapshot
 *
 * Reachability, measured — every check below asks whether a **specific control
 * is inside the visual viewport and can be clicked**, because that is the
 * question the owner was really asking and the one no gate here was answering.
 * `boundingBox()` against the viewport catches the drawer bug; a screenshot
 * diff would only have caught it if someone looked at the screenshot.
 *
 * The `expect`-free style, the two credential guards and the `check()` counter
 * are the house pattern — see `admin-pages.ts` for why the guards are not
 * optional on a harness that opens a browser.
 */

// clients first, before anything reads process.env. See admin-pages.ts.
import "./clients";

import { readFileSync } from "node:fs";

import { chromium, type Locator, type Page } from "playwright";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

import { ADMIN_NAV } from "../../src/components/admin/nav";
import { adminClient, createAccount, sessionCookies } from "./fixtures";
import { assertNotProduction, assertServerNotProduction } from "./clients";
import { BASE_URL } from "./routes";

assertNotProduction("run audit:admin-mobile");

/**
 * A small phone, and deliberately the smallest one the shop sees rather than a
 * comfortable one.
 *
 * 390×664 is an iPhone 14/15 in portrait once Safari's chrome is showing. The
 * drawer bug is a function of how much vertical room the nav has, so a gate run
 * at 844px tall — the spec height, chrome ignored — would have passed against
 * the broken build. The whole value of this file is in that difference.
 */
const PHONE = { width: 390, height: 664 };

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

/**
 * Is this control actually on the screen, in full, right now?
 *
 * Not `isVisible()`, which is true for an element sitting 900px below a
 * scroll-locked fold — that is precisely the state the drawer was in, and
 * precisely why every existing gate thought the menu was fine. This compares
 * the box against the viewport.
 */
async function withinViewport(
  page: Page,
  locator: Locator,
): Promise<{ ok: boolean; detail: string }> {
  const box = await locator.boundingBox();
  if (!box) return { ok: false, detail: "no box — not rendered" };
  const size = page.viewportSize();
  if (!size) return { ok: false, detail: "no viewport" };
  const ok =
    box.x >= -1 &&
    box.y >= -1 &&
    box.x + box.width <= size.width + 1 &&
    box.y + box.height <= size.height + 1;
  return {
    ok,
    detail: `box ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)} in ${size.width}×${size.height}`,
  };
}

async function main() {
  await assertServerNotProduction(BASE_URL, "run audit:admin-mobile");

  const admin = adminClient();
  const account = await createAccount("adminmobile");
  {
    const { error } = await admin
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", account.userId);
    if (error) throw new Error(`could not promote the probe: ${error.message}`);
  }

  const browser = await chromium.launch();
  /*
    `hasTouch` but deliberately **not** `isMobile`.

    `isMobile: true` turns on Chromium's mobile layout emulation, and with it the
    page lays out against a viewport of its own choosing — measured here at
    850px tall inside a context declared as 664. Playwright then computes click
    points against the declared size while the document is laid out against the
    other one, so a click aimed at the last nav item lands three rows above it.
    That is an artefact of the harness, not of the panel: `elementFromPoint` at
    the same coordinates returns the right link.

    Touch events are the part that is actually wanted here, and `hasTouch` gives
    those on its own without moving the viewport out from under the assertions.
  */
  const context = await browser.newContext({
    viewport: PHONE,
    hasTouch: true,
  });
  await context.addCookies(await sessionCookies(account.session));
  const page = await context.newPage();

  try {
    /* ═══ 1 · the drawer ═══════════════════════════════════════════════════ */
    section("1 · every admin section is reachable from the phone drawer");

    await page.goto(`${BASE_URL}/admin`, { waitUntil: "load" });

    const menuButton = page.getByRole("button", { name: "Open admin menu" });
    check(
      "the menu button is on screen at 390px",
      (await withinViewport(page, menuButton)).ok,
      (await withinViewport(page, menuButton)).detail,
    );

    await menuButton.click();
    const drawer = page.getByRole("dialog");
    await drawer.waitFor({ state: "visible" });

    const drawerNav = drawer.getByRole("navigation", {
      name: "Admin sections",
    });

    /*
      The measurement the fix is actually about: the list is taller than the box
      that holds it, and the box scrolls. If scrollHeight ever equals
      clientHeight here the nav has stopped being a scroll container — either
      because the overflow rule was dropped, or because `min-h-0` was, which
      looks identical in the diff and is the easier of the two to lose.
    */
    const metrics = await drawerNav.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
    }));
    check(
      "the drawer's nav is a scroll container",
      metrics.overflowY === "auto" || metrics.overflowY === "scroll",
      `overflow-y: ${metrics.overflowY}`,
    );
    check(
      "the list really is taller than the box, so scrolling is load-bearing",
      metrics.scrollHeight > metrics.clientHeight,
      `${metrics.scrollHeight}px of list in ${metrics.clientHeight}px of box`,
    );

    /*
      And then the part a person cares about: the last item in the nav — the one
      furthest below the fold — can be scrolled to and is fully on screen when it
      gets there. `Health` is last today; taking it from ADMIN_NAV rather than
      naming it means adding a sixteenth section keeps this honest.
    */
    const last = ADMIN_NAV[ADMIN_NAV.length - 1];
    /*
      By href, not by accessible name. Each drawer link renders its label *and*
      its hint, so `Health` is really "Health Is the machinery alive" to the
      accessibility tree — and a name match here would break every time someone
      reworded a hint, which is a thing this gate should have no opinion about.
    */
    const lastLink = drawer.locator(`a[href="${last.href}"]`);
    await lastLink.scrollIntoViewIfNeeded();
    const lastBox = await withinViewport(page, lastLink);
    check(
      `the last section ("${last.label}") is fully on screen once scrolled to`,
      lastBox.ok,
      lastBox.detail,
    );

    /*
      Guarded, and the timeout is short on purpose.

      Against the pre-fix build this click never lands — Playwright reports
      "element is outside of the viewport" and retries for the full default 30s
      before throwing, which would abort the run and leave sections 2 and 3
      unreported. A gate that cannot finish is a gate that tells you one thing
      when it could have told you three. Five seconds is far longer than a click
      that is going to work ever needs.
    */
    let navigated = false;
    try {
      await lastLink.click({ timeout: 5_000 });
      await page.waitForURL(`**${last.href}`, { timeout: 5_000 });
      navigated = new URL(page.url()).pathname === last.href;
    } catch {
      navigated = false;
    }
    check(
      `tapping it navigates to ${last.href}`,
      navigated,
      navigated ? page.url() : "the link could not be clicked — off-viewport",
    );
    if (!navigated) await page.goto(`${BASE_URL}${last.href}`);

    /* ═══ 2 · the brands table ═════════════════════════════════════════════ */
    section("2 · brands can be added and removed from a phone");

    await page.goto(`${BASE_URL}/admin/brands`, { waitUntil: "load" });

    const addBrand = page.getByRole("button", { name: "Add brand" });
    const addBox = await withinViewport(page, addBrand);
    check("the Add brand button is on screen", addBox.ok, addBox.detail);

    /*
      The pinned column. The delete control lives in the last cell of a 46rem
      table inside a 390px wrapper, so without `stickyEnd` its box sits roughly
      two screen-widths to the right — visible to Playwright, invisible to a
      person, and the exact shape of the owner's report.
    */
    const firstDelete = page
      .getByRole("button", { name: /^Delete / })
      .first();
    const deleteBox = await withinViewport(page, firstDelete);
    check(
      "a brand's delete control is on screen without scrolling the table sideways",
      deleteBox.ok,
      deleteBox.detail,
    );

    const wrapperScroll = await page
      .getByRole("region", { name: "Brands" })
      .evaluate((element) => element.scrollLeft);
    check(
      "and the table has not been scrolled to get there",
      wrapperScroll === 0,
      `scrollLeft ${wrapperScroll}`,
    );

    /* ═══ 3 · dialogs ══════════════════════════════════════════════════════ */
    section("3 · a dialog can be read and confirmed on a phone");

    await firstDelete.click();
    const confirmDialog = page.getByRole("dialog");
    await confirmDialog.waitFor({ state: "visible" });

    const dialogFits = await confirmDialog.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        maxHeight: style.maxHeight,
        overflowY: style.overflowY,
        height: element.getBoundingClientRect().height,
        viewport: window.innerHeight,
      };
    });
    check(
      "the dialog is height-capped rather than free to overflow the screen",
      dialogFits.maxHeight !== "none",
      `max-height: ${dialogFits.maxHeight}`,
    );
    check(
      "the dialog scrolls its own content",
      dialogFits.overflowY === "auto" || dialogFits.overflowY === "scroll",
      `overflow-y: ${dialogFits.overflowY}`,
    );
    check(
      "and it does not stand taller than the phone screen",
      dialogFits.height <= dialogFits.viewport,
      `${Math.round(dialogFits.height)}px tall in ${dialogFits.viewport}px`,
    );

    /*
      The button at the very bottom of the dialog, which is the one that was
      unreachable. Scrolled to inside the dialog, then measured against the
      screen — the two halves of "a person can press this".
    */
    const confirmButton = confirmDialog.getByRole("button", {
      name: /Delete it/,
    });
    await confirmButton.scrollIntoViewIfNeeded();
    const confirmBox = await withinViewport(page, confirmButton);
    check(
      "the confirm button can be scrolled to and is fully on screen",
      confirmBox.ok,
      confirmBox.detail,
    );

    // Closed with Escape. This gate reads; it does not delete the owner's data.
    await page.keyboard.press("Escape");
    await confirmDialog.waitFor({ state: "hidden" });
    check("Escape closes it without deleting anything", true);

    /* ═══ 4 · the sweep ════════════════════════════════════════════════════ */
    section(
      "4 · every control on every admin page is on screen or scrollably reachable, at 360px and 390px",
    );

    /*
      Sections 1–3 are the three bugs the owner reported, preserved as
      regression tests. This section is the generalisation, added 2026-08-20:
      the brands delete button at x=728 and the drawer nav with no overflow
      rule were both *instances*, and a gate that only knows the instances
      finds the third one the way the first two were found — by the owner, on
      a phone, mid-task.

      Every page in ADMIN_NAV, at both widths the shop actually sees (360 is
      the small-Android floor, 390 the iPhone), every interactive element in
      the DOM, measured with boundingBox against the viewport — isVisible()
      is exactly the lie this file exists to reject. The verdict per element:

        - fully inside the viewport → fine;
        - beyond it horizontally, inside an ancestor that really scrolls
          sideways → fine for data (a wide table is allowed to scroll), but a
          FAILURE for a button — an action you have to discover by dragging a
          table sideways is the brands bug again;
        - beyond it with no scrollable path, clipped by an overflow-hidden
          ancestor, or position:fixed outside the screen → unreachable, the
          drawer bug again.

      Elements ≤1px in both dimensions are skipped as sr-only furniture —
      intentionally invisible is the opposite of built-but-unreachable.
    */
    type SweepProblem = { kind: string; label: string; box: string };
    const WIDTHS = [360, 390] as const;
    for (const width of WIDTHS) {
      const sweepContext = await browser.newContext({
        viewport: { width, height: 664 },
        hasTouch: true,
      });
      await sweepContext.addCookies(await sessionCookies(account.session));
      const sweepPage = await sweepContext.newPage();

      for (const item of ADMIN_NAV) {
        await sweepPage.goto(`${BASE_URL}${item.href}`, { waitUntil: "load" });
        const { counted, problems } = await sweepPage.evaluate(() => {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const problems: { kind: string; label: string; box: string }[] = [];
          let counted = 0;
          const controls = Array.from(
            document.querySelectorAll<HTMLElement>(
              'button, a[href], input, select, textarea, summary, [role="button"], [role="link"]',
            ),
          );
          for (const el of controls) {
            const cs = getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden") continue;
            if (el.closest('[aria-hidden="true"]')) continue;
            // An inert subtree is intentionally non-interactive — a preview,
            // not a control surface. Nothing inside it is "unreachable"; it
            // is unreachable BY DESIGN, which is the opposite finding.
            if (el.closest("[inert]")) continue;
            if (el instanceof HTMLInputElement && el.type === "hidden") continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 1 && r.height <= 1) continue; // sr-only furniture
            counted += 1;

            const label =
              `<${el.tagName.toLowerCase()}> ` +
              (
                el.getAttribute("aria-label") ||
                el.textContent ||
                el.getAttribute("name") ||
                ""
              )
                .trim()
                .slice(0, 48);
            const box = `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`;

            // A fixed element outside the screen scrolls with nothing.
            if (
              cs.position === "fixed" &&
              (r.top >= vh || r.bottom <= 0 || r.left >= vw || r.right <= 0)
            ) {
              problems.push({ kind: "fixed off-screen", label, box });
              continue;
            }

            // Clipped by an overflow-hidden ancestor: no gesture reaches it.
            let clipped = false;
            let sidewaysScroller: HTMLElement | null = null;
            for (
              let a = el.parentElement;
              a && a !== document.body;
              a = a.parentElement
            ) {
              const acs = getComputedStyle(a);
              const ar = a.getBoundingClientRect();
              if (
                (acs.overflowY === "hidden" || acs.overflowY === "clip") &&
                (r.top >= ar.bottom - 1 || r.bottom <= ar.top + 1)
              ) {
                clipped = true;
                break;
              }
              if (
                (acs.overflowX === "hidden" || acs.overflowX === "clip") &&
                (r.left >= ar.right - 1 || r.right <= ar.left + 1)
              ) {
                clipped = true;
                break;
              }
              if (
                !sidewaysScroller &&
                (acs.overflowX === "auto" || acs.overflowX === "scroll") &&
                a.scrollWidth > a.clientWidth + 1
              ) {
                sidewaysScroller = a;
              }
            }
            if (clipped) {
              problems.push({ kind: "clipped by overflow-hidden", label, box });
              continue;
            }

            // Horizontal: the axis a page never scrolls on its own.
            const beyond = r.right > vw + 1 || r.left < -1;
            if (!beyond) continue;
            if (!sidewaysScroller) {
              problems.push({ kind: "off-screen, no scroll path", label, box });
            } else if (el.matches('button, [role="button"]')) {
              problems.push({
                kind: "action needs sideways table scroll (the brands bug)",
                label,
                box,
              });
            }
            // Data beyond the fold of a real sideways scroller is allowed.
          }
          return { counted, problems };
        });

        check(
          `${item.href} at ${width}px — ${counted} controls, all reachable`,
          counted > 0 && problems.length === 0,
          counted === 0
            ? "scanned 0 controls — the page did not render, which is not a pass"
            : (problems as SweepProblem[])
                .slice(0, 6)
                .map((p) => `${p.kind}: ${p.label} @ ${p.box}`)
                .join("; ") +
              (problems.length > 6 ? ` … and ${problems.length - 6} more` : ""),
        );
      }
      await sweepContext.close();
    }
  } finally {
    await browser.close();
  }

  console.log(
    `\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m`,
  );
  if (failed > 0) {
    console.log("\nFailures:");
    for (const failure of failures) console.log(`  · ${failure}`);
    process.exit(1);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
