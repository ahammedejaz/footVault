/**
 * Is the console clean?
 *
 * The open question from Phase 4 was whether the hydration warnings seen in a
 * real browser were ours or a browser extension rewriting the DOM before React
 * got to it. **Headless Chromium has no extensions**, so anything that appears
 * here is genuinely ours and there is nothing left to blame.
 *
 * `<body suppressHydrationWarning>` in app/layout.tsx is not a get-out. That
 * attribute suppresses **one level** — the body element's own attributes, which
 * is exactly the surface `next-themes` and extensions write to. A mismatch
 * anywhere inside the tree still reports, which is why this check still means
 * something with it in place.
 *
 * Run against a production build, because the messages differ: development
 * prints a diff, production prints a minified React error code. Both are
 * matched below.
 *
 *   npx tsx scripts/audit/hydration.ts
 */
import { chromium, type Page } from "playwright";

import { buildFixture } from "./fixtures";
import { AUDIT_ROUTES, BASE_URL } from "./routes";
import { auditStates, jarFor } from "./states";

/**
 * What a hydration mismatch says, in every dialect React speaks.
 *
 * 418/423/425 are the minified codes a production build prints instead of the
 * prose: "hydration failed", "there was an error while hydrating", and "text
 * content does not match". Matching only the prose would make this script pass
 * silently against the build it is meant to be run on.
 */
const HYDRATION = [
  /hydration failed/i,
  /hydrating/i,
  /did not match/i,
  /text content does not match/i,
  /server rendered html/i,
  /server-rendered html/i,
  /tree hydrated but some attributes/i,
  /minified react error #(418|422|423|425)/i,
];

type Message = { where: string; kind: string; text: string };

function listen(page: Page, where: string, sink: Message[]) {
  page.on("console", (message) => {
    const kind = message.type();
    if (kind !== "error" && kind !== "warning") return;
    sink.push({ where, kind, text: message.text() });
  });
  page.on("pageerror", (error) => {
    sink.push({ where, kind: "pageerror", text: error.message });
  });
}

async function settle(page: Page, path: string) {
  await page
    .locator("h1")
    .first()
    .waitFor({ state: "visible", timeout: 20_000 })
    .catch(() => {
      throw new Error(`${path}: no visible <h1> after 20s`);
    });
  // Hydration is asynchronous and a mismatch is reported when React reaches the
  // offending node, which can be well after the h1 paints.
  await page.waitForTimeout(1_200);
}

async function main() {
  console.log("\nConsole cleanliness, in a browser with no extensions\n");

  const browser = await chromium.launch();
  const messages: Message[] = [];
  const fixture = await buildFixture(browser);

  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(60_000);

    for (const route of AUDIT_ROUTES) {
      listen(page, route.path, messages);
      await page.goto(`${BASE_URL}${route.path}`, { waitUntil: "load" });
      await settle(page, route.path);
      page.removeAllListeners("console");
      page.removeAllListeners("pageerror");
    }
    await context.close();

    for (const state of auditStates(fixture).filter((entry) => !entry.once)) {
      const stateContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await stateContext.addCookies(jarFor(fixture, state.as));
      const statePage = await stateContext.newPage();
      statePage.setDefaultNavigationTimeout(60_000);
      listen(statePage, state.name, messages);
      await statePage.goto(`${BASE_URL}${state.path}`, { waitUntil: "load" });
      await settle(statePage, state.name);
      if (state.after) await state.after(statePage).catch(() => {});
      await statePage.waitForTimeout(600);
      await stateContext.close();
    }
  } finally {
    await browser.close();
  }

  const hydration = messages.filter((message) =>
    HYDRATION.some((pattern) => pattern.test(message.text)),
  );
  /*
   * Noise about the fixture rather than about the page, and one third party.
   *
   * The exception worth arguing about is `web-share`: Razorpay's checkout
   * iframe ships a Permissions-Policy header naming a feature Chromium does not
   * recognise, and Chromium warns once per load. It appears on all five
   * /checkout states, it is emitted by code we do not control and cannot
   * configure, and it says nothing about our markup.
   *
   * It is matched exactly rather than by origin, and it is the only third-party
   * string allowed through. A gate that is permanently red for a reason nobody
   * can fix is a gate people stop reading, which is how a real console error
   * gets shipped — but an allowlist that grows by pattern is the same failure
   * with extra steps. If a second one of these turns up, it gets its own line
   * and its own justification here.
   */
  const IGNORED = [
    /favicon|404 \(Not Found\)|ERR_ABORTED/,
    /^Unrecognized feature: 'web-share'\.$/,
  ];
  const other = messages.filter(
    (message) =>
      !hydration.includes(message) &&
      !IGNORED.some((pattern) => pattern.test(message.text.trim())),
  );

  const states = auditStates(fixture).filter((entry) => !entry.once).length;
  console.log(
    `  ${AUDIT_ROUTES.length} routes + ${states} populated states walked at 390px.`,
  );
  console.log(`  hydration warnings: ${hydration.length}`);
  console.log(`  other console errors/warnings: ${other.length}`);

  for (const message of [...hydration, ...other].slice(0, 25)) {
    console.log(`    [${message.kind}] ${message.where} — ${message.text.replace(/\s+/g, " ").slice(0, 180)}`);
  }

  if (hydration.length === 0 && other.length === 0) {
    console.log("\n  The console is clean. No hydration mismatch is ours.\n");
    return;
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error("\nHarness error:", error);
  process.exit(1);
});
