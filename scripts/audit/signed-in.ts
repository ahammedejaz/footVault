/**
 * The signed-in half of the storefront.
 *
 * `bag-flow.ts` covers the guest path end to end. This covers what only exists
 * once somebody has an account: the saved list rendering, move-to-bag, the
 * account menu, and — the one that matters most — that adding to the bag while
 * signed in uses the *account* cart rather than minting a guest token.
 *
 *   npx next start -p 3210
 *   npx tsx scripts/audit/signed-in.ts
 *
 * The session is minted with a password grant and its cookies are produced by
 * @supabase/ssr itself, so the cookie format is the real one rather than a
 * guess. Google OAuth is not enabled on the project yet; when it is, the one
 * thing this still does not cover is the provider round trip itself.
 *
 * The account is left behind — deleting it needs a service-role key. The
 * teardown is in docs/rls-tests.md §8.
 */
import { readFileSync } from "node:fs";
import { createServerClient } from "@supabase/ssr";
import { createClient, type Session } from "@supabase/supabase-js";
import { chromium } from "playwright";

import { maybeRow } from "../../src/lib/queries/run";
import { BASE_URL } from "./routes";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
// Was a hard-coded 3210. Every other harness honours AUDIT_BASE_URL, and this
// one silently did not — so pointing the suite at an out-of-tree build (the
// only way to audit while somebody else owns the repo's .next) left exactly
// one script measuring whatever stale server happened to be on 3210.
const BASE = BASE_URL;

async function cookieJar(session: Session) {
  const jar = new Map<string, string>();
  const c = createServerClient(URL_, ANON, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (l) => l.forEach((x) => jar.set(x.name, x.value)),
    },
  });
  await c.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  return [...jar].map(([name, value]) => ({
    name,
    value,
    domain: "localhost",
    path: "/",
  }));
}

async function main() {
  let bad = 0;
  const ok = (n: string, p: boolean, d = "") => {
    if (!p) bad++;
    console.log(`  ${p ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  };

  const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
  const email = `fv-signedin.${Date.now().toString(36)}@example.com`;
  const { data: up, error } = await anon.auth.signUp({
    email,
    password: "correct-horse-battery-staple-42",
    options: { data: { full_name: "Signed In Tester" } },
  });
  if (error || !up.session) throw new Error(String(error?.message));

  // Save a product as this user, so the wishlist has something in it.
  const asUser = createClient(URL_, ANON, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${up.session.access_token}` } },
  });
  const product = await maybeRow<{ id: string; name: string }>(
    "pick a product to save",
    asUser
      .from("products")
      .select("id, name")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle(),
  );
  if (!product) throw new Error("no active products to save");
  const { error: saveErr } = await asUser
    .from("wishlist_items")
    .insert({ user_id: up.user!.id, product_id: product.id });
  ok(
    "a signed-in customer can save a product",
    !saveErr,
    saveErr?.message ?? "",
  );

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  await ctx.addCookies(await cookieJar(up.session));
  const page = await ctx.newPage();
  const errs: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));

  await page.goto(`${BASE}/wishlist`, { waitUntil: "load" });
  ok(
    "the saved list renders the saved product",
    (await page.getByText(product.name).count()) > 0,
    product.name,
  );
  ok(
    "move-to-bag is offered",
    (await page.getByRole("button", { name: /move to bag/i }).count()) > 0,
  );
  ok(
    "it does not offer sign-in to somebody already signed in",
    (await page
      .getByRole("button", { name: /continue with google/i })
      .count()) === 0,
  );

  await page.goto(`${BASE}/product/nike-air-max-90-mens`, {
    waitUntil: "load",
  });
  ok(
    "the account menu shows a signed-in state",
    (await page.locator('[aria-label^="Account, signed in as"]').count()) > 0,
    (await page
      .locator('[aria-label^="Account, signed in as"]')
      .first()
      .getAttribute("aria-label")) ?? "absent",
  );

  // Add to bag as a signed-in customer — the account-cart path, not the guest one.
  const chip = page
    .locator('button[aria-label^="UK "]:not([aria-label*="sold out"])')
    .first();
  await chip.click();
  await page.getByRole("button", { name: "Add to bag" }).first().click();
  await page.getByText("Added to bag").first().waitFor({ timeout: 10_000 });
  await page.reload({ waitUntil: "load" });
  const label = await page
    .locator('a[href="/cart"]')
    .first()
    .getAttribute("aria-label");
  ok("the account bag counts it", /1 item/.test(label ?? ""), label ?? "");

  const cookies = await ctx.cookies();
  ok(
    "no guest token was minted for a signed-in customer",
    !cookies.some((c) => c.name === "fv_guest"),
    cookies.map((c) => c.name).join(", "),
  );

  await page.goto(`${BASE}/cart`, { waitUntil: "load" });
  ok(
    "the cart page renders for a signed-in customer",
    (
      (await page.getByRole("heading", { level: 1 }).first().textContent()) ??
      ""
    )
      .toLowerCase()
      .includes("your bag"),
  );
  ok(
    "it does not pitch sign-in to somebody signed in",
    (await page.getByText(/signing in keeps this bag/i).count()) === 0,
  );

  ok(
    "no console errors",
    errs.filter((e) => !/404/.test(e)).length === 0,
    errs.slice(0, 2).join(" | "),
  );

  await browser.close();
  console.log(
    bad === 0 ? "\nAll signed-in checks passed.\n" : `\n${bad} FAILED\n`,
  );
  console.log(`  (account left behind: ${email})`);
  process.exit(bad === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
