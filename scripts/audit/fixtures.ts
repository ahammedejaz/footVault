/**
 * The state an audit has to be *in* before it can measure anything.
 *
 * A flat route list can express `/cart`. It cannot express "/cart with three
 * lines in it" — which is the only version of that page a customer ever sees,
 * and the version whose controls went unmeasured for the whole of Phase 4. A
 * 98×18px line-item link survived inside it. The same hole opened again the
 * moment checkout landed: `/checkout`, `/order/[orderNumber]` and
 * `/account/orders` all have an empty state that a route list reaches and an
 * interesting state that it cannot.
 *
 * So the interesting state is built here, once per run, over real HTTP against
 * the real database, and handed to every pass as **cookies**. Cookies rather
 * than a shared browser context because overflow.ts needs a fresh context per
 * viewport width and a11y.ts needs one per width too; a cookie jar is the one
 * thing that survives across all of them.
 *
 * Three identities, because one cannot hold all three states at once:
 *
 *   - `guest`   — a bag with three lines that is never converted, so /cart and
 *                 /checkout stay populated for the whole run.
 *   - `order`   — a second guest whose bag *was* converted, so there is a real
 *                 order number to render /order/[orderNumber] with.
 *   - `account` — signed in, holding a placed order, a saved address, and a
 *                 fresh bag on top. That combination is what makes
 *                 /account/orders, /account/addresses and the signed-in
 *                 checkout all non-empty at the same time.
 *
 * Everything created is named `fv-qa.*@example.com` or reported in the ledger
 * this returns, so `scripts/audit/teardown.ts` can find it afterwards.
 */
import { readFileSync } from "node:fs";

import { createServerClient } from "@supabase/ssr";
import {
  createClient,
  type Session,
  type SupabaseClient,
} from "@supabase/supabase-js";
import type { Browser, Cookie, Page } from "playwright";

import type { Database } from "../../src/lib/database.types";
import { BASE_URL } from "./routes";

/** The one prefix teardown sweeps on. Changing it orphans every account. */
export const QA_EMAIL_PREFIX = "fv-qa.";
const PASSWORD = "correct-horse-battery-staple-42";

/** Read once, on import — every harness in this directory needs the same three keys. */
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

export function anonClient(): SupabaseClient<Database> {
  return createClient<Database>(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
  });
}

export function adminClient(): SupabaseClient<Database> {
  if (!SERVICE_KEY)
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is empty — cannot build fixtures",
    );
  return createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });
}

/** The address every fixture ships to. Real enough to pass `checkoutSchema`. */
export const QA_ADDRESS = {
  recipientName: "Quality Runner",
  phone: "9876500011",
  line1: "4 Harness Lane",
  city: "Panaji",
  state: "Goa",
  postalCode: "403001",
} as const;

/* ------------------------------------------------------------- identities -- */

export type Account = { email: string; userId: string; session: Session };

/**
 * A throwaway account, created through the real sign-up path.
 *
 * Email confirmation is off on this project, so `signUp` hands back a session
 * and the whole thing is testable over HTTP without an inbox.
 */
export async function createAccount(label: string): Promise<Account> {
  const email = `${QA_EMAIL_PREFIX}${label}.${Date.now().toString(36)}@example.com`;
  const { data, error } = await anonClient().auth.signUp({
    email,
    password: PASSWORD,
    options: { data: { full_name: "Quality Runner" } },
  });
  if (error || !data.session || !data.user) {
    throw new Error(
      `sign-up failed for ${email}: ${error?.message ?? "no session"}`,
    );
  }
  return { email, userId: data.user.id, session: data.session };
}

/**
 * Session cookies in the format the app actually reads.
 *
 * Produced by `@supabase/ssr` itself rather than hand-rolled, so the chunking
 * and the name prefix are whatever the library does today and stay correct the
 * day it changes them.
 */
export async function sessionCookies(session: Session): Promise<Cookie[]> {
  const jar = new Map<string, string>();
  const client = createServerClient(SUPABASE_URL, ANON_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) =>
        list.forEach((entry) => jar.set(entry.name, entry.value)),
    },
  });
  await client.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  return [...jar].map(([name, value]) => ({
    name,
    value,
    domain: "localhost",
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: "Lax" as const,
  }));
}

/* -------------------------------------------------------------- the bag ---- */

/** Products with enough of a size run to be worth adding. */
export const FIXTURE_SLUGS = [
  "nike-air-max-90-mens",
  "adidas-samba-og-mens",
  "puma-suede-classic-mens",
] as const;

/**
 * Add the first in-stock size of a product to whatever bag this page holds.
 *
 * Selects on the accessible name — "UK 9", "UK 6, sold out" — rather than the
 * visible digit, because the digit alone cannot tell those two apart.
 */
export async function addToBag(
  page: Page,
  slug: string,
): Promise<string | null> {
  await page.goto(`${BASE_URL}/product/${slug}`, { waitUntil: "load" });
  const chip = page
    .locator('button[aria-label^="UK "]:not([aria-label*="sold out"])')
    .first();
  if ((await chip.count()) === 0) return null;
  const size = await chip.getAttribute("aria-label");
  await chip.click();
  await page.getByRole("button", { name: "Add to bag" }).first().click();
  await page.getByText("Added to bag").first().waitFor({ timeout: 15_000 });
  return size;
}

/* ------------------------------------------------------------- checkout ---- */

/**
 * Fill and submit checkout with cash on delivery, and return the order number.
 *
 * Through the form, not through the RPC. `scripts/audit/checkout-orders.ts`
 * already proves the transaction; what this proves is that the *page* can place
 * an order, which is the only way the confirmation and history states get built
 * out of something a customer could have produced.
 */
/**
 * Turn this bag into a placed order.
 *
 * **Written through the database, not through the checkout UI, and that is a
 * consequence of Part 0 rather than a shortcut.** Both payment methods now
 * settle through Razorpay — Pay on Delivery takes an advance before the order
 * is confirmed — so pressing the pay button opens a provider modal and no
 * headless run can complete it. A fixture that tried would be a fixture that
 * depended on a third party's iframe.
 *
 * What the states actually need from this is an order that exists, belongs to
 * the right identity, and renders at `/order/<number>`. Calling the same
 * function checkout calls gives exactly that, with real prices recomputed under
 * the same row lock, real stock decremented, and a real ledger row written.
 *
 * The advance is set to the whole delivery charge, which is what the default
 * `greater_of` rule produces for a real order, so the confirmation page the
 * fixtures screenshot shows the same three figures a customer would see.
 */
export async function placeCodOrder(
  page: Page,
  options: { guest: true } | { guest: false; userId: string },
): Promise<string> {
  const admin = adminClient();
  const jar = await page.context().cookies();
  const token = guestToken(jar);

  if (options.guest && !token) {
    throw new Error("the guest context carries no fv_guest cookie");
  }

  const cart = await maybeRowOrThrow<{ id: string }>(
    admin
      .from("carts")
      .select("id")
      .eq("status", "active")
      .eq(
        options.guest ? "guest_token" : "user_id",
        options.guest ? (token as string) : options.userId,
      )
      .maybeSingle(),
    "no active cart to convert",
  );

  const SHIPPING = 34_900;
  const { data, error } = await admin.rpc("create_order_with_stock", {
    p_cart_id: cart.id,
    p_shipping_address: { ...QA_ADDRESS, line2: null, country: "IN" },
    p_payment_method: "cod",
    // Confirmed and paid: the advance has captured, which is the state a
    // customer is looking at when they reach the confirmation page.
    p_initial_status: "confirmed",
    p_payment_status: "paid",
    p_shipping_flat_fee: SHIPPING,
    p_free_shipping_above: null,
    p_advance_amount: SHIPPING,
    p_cod_handling_fee: 15_000,
    p_guest_token: options.guest ? (token as string) : undefined,
    p_user_id: options.guest ? undefined : options.userId,
    p_contact_email: options.guest
      ? `${QA_EMAIL_PREFIX}guest@example.com`
      : undefined,
    p_contact_phone: QA_ADDRESS.phone,
  });
  if (error) throw new Error(`could not place the fixture order: ${error.message}`);

  const number = data?.[0]?.order_number;
  if (!number) throw new Error("create_order_with_stock returned no order");

  /**
   * Save the address to the account's book, which the UI path used to do.
   *
   * `placeOrder` writes it when "save this address" is ticked, and the
   * signed-in checkout states depend on the result: with no saved address there
   * is no address *choice*, so `checkout-new-address` has no radio to select
   * and the state cannot be reached. Placing the order server-side skipped
   * that side effect, and the harness found it.
   */
  if (!options.guest) {
    const { error: addressError } = await admin.from("addresses").insert({
      user_id: options.userId,
      recipient_name: QA_ADDRESS.recipientName,
      phone: QA_ADDRESS.phone,
      line1: QA_ADDRESS.line1,
      line2: null,
      city: QA_ADDRESS.city,
      state: QA_ADDRESS.state,
      postal_code: QA_ADDRESS.postalCode,
      country: "IN",
      is_default: true,
    });
    if (addressError) {
      throw new Error(`could not save the fixture address: ${addressError.message}`);
    }
  }

  await page.goto(`${BASE_URL}/order/${number}`, { waitUntil: "load" });
  return number;
}

/** `maybeSingle` with the error checked, because a silent null here is a lie. */
async function maybeRowOrThrow<T>(
  query: PromiseLike<{ data: unknown; error: { message: string } | null }>,
  whenMissing: string,
): Promise<T> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  if (!data) throw new Error(whenMissing);
  return data as T;
}

/* ------------------------------------------------------ the failing bag ---- */

/** The guest token a jar carries, or null if it holds a session instead. */
function guestToken(jar: Cookie[]): string | null {
  return jar.find((cookie) => cookie.name === "fv_guest")?.value ?? null;
}

/**
 * Ask this bag for one more unit than the shop holds.
 *
 * Written to `cart_items.quantity` rather than to the variant, so the blast
 * radius is one row that belongs to one throwaway guest. `getCart()` clamps the
 * *displayed* quantity to live stock and posts a notice, so the line stays on
 * the page and looks like any other; `assert_cart_stock` reads the stored
 * quantity and refuses. Nothing is written to `orders`, so the state is
 * repeatable at every width and leaves nothing to clean up.
 */
async function overfillLine(
  admin: SupabaseClient<Database>,
  jar: Cookie[],
): Promise<{ sku: string; stock: number; asked: number }> {
  const token = guestToken(jar);
  if (!token) throw new Error("fixture: the failure bag has no guest token");

  const { data: cart, error: cartError } = await admin
    .from("carts")
    .select("id, items:cart_items ( id, variant_id )")
    .eq("guest_token", token)
    .eq("status", "active")
    .maybeSingle();
  if (cartError)
    throw new Error(`fixture: reading the failure cart: ${cartError.message}`);
  const item = cart?.items?.[0];
  if (!item) throw new Error("fixture: the failure bag is empty");

  const { data: variant, error: variantError } = await admin
    .from("product_variants")
    .select("sku, stock_quantity")
    .eq("id", item.variant_id)
    .maybeSingle();
  if (variantError)
    throw new Error(`fixture: reading stock: ${variantError.message}`);
  if (!variant) throw new Error("fixture: the failure variant vanished");

  const asked = variant.stock_quantity + 1;
  const { error: updateError } = await admin
    .from("cart_items")
    .update({ quantity: asked })
    .eq("id", item.id);
  if (updateError)
    throw new Error(`fixture: overfilling the line: ${updateError.message}`);

  return { sku: variant.sku, stock: variant.stock_quantity, asked };
}

/* --------------------------------------------------------------- fixture -- */

export type QaFixture = {
  guest: { cookies: Cookie[]; lines: number };
  guestOrder: { cookies: Cookie[]; orderNumber: string };
  /**
   * A bag asking for one more of something than the shop has.
   *
   * `assert_cart_stock` compares `cart_items.quantity` against
   * `product_variants.stock_quantity`, so this fails checkout with
   * `out_of_stock` *without writing an order* — which makes the failure panel
   * measurable at all six widths instead of once.
   *
   * The overfill is on **this cart's row**, never on the variant's stock. An
   * earlier version lowered the shelf count instead, which works and is two
   * lines shorter, and which also silently sabotages every other agent's
   * checkout test for as long as the run lasts. A cart nobody else can see is
   * the only safe place to put a fixture's lie.
   */
  failure: { cookies: Cookie[]; sku: string; stock: number; asked: number };
  /** One bag for the one state that spends it: the browser-side failure panel. */
  browserFailure: { cookies: Cookie[] };
  account: {
    email: string;
    userId: string;
    cookies: Cookie[];
    orderNumber: string;
    orderId: string;
    bagLines: number;
  };
  /** Everything created, for the report and for teardown. */
  ledger: { emails: string[]; orderNumbers: string[] };
};

/**
 * A guest bag and nothing else.
 *
 * Separated out because most harnesses only need "a page with lines on it" and
 * the full fixture costs two real orders and two units of stock. Anything that
 * does not read an order should ask for this instead.
 */
export async function buildGuestBag(
  browser: Browser,
  slugs: readonly string[] = FIXTURE_SLUGS,
): Promise<{ cookies: Cookie[]; lines: number }> {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(60_000);
  let lines = 0;
  for (const slug of slugs) {
    if (await addToBag(page, slug)) lines++;
  }
  const cookies = await context.cookies();
  await context.close();
  return { cookies, lines };
}

/**
 * Build every identity the states need. Roughly a minute of real browser work;
 * run it once per harness and inject the cookies wherever they are needed.
 */
export async function buildFixture(browser: Browser): Promise<QaFixture> {
  const phone = { width: 390, height: 844 };

  /* guest — a bag that stays a bag */
  const guest = await buildGuestBag(browser);
  const guestCookies = guest.cookies;
  const lines = guest.lines;

  /* guestOrder — a bag that becomes an order */
  const orderContext = await browser.newContext({ viewport: phone });
  const orderPage = await orderContext.newPage();
  orderPage.setDefaultNavigationTimeout(60_000);
  await addToBag(orderPage, FIXTURE_SLUGS[0]);
  const guestOrderNumber = await placeCodOrder(orderPage, { guest: true });
  const orderCookies = await orderContext.cookies();
  await orderContext.close();

  /* account — an order, an address, and a fresh bag on top of both */
  const account = await createAccount("fixture");
  const accountContext = await browser.newContext({ viewport: phone });
  await accountContext.addCookies(await sessionCookies(account.session));
  const accountPage = await accountContext.newPage();
  accountPage.setDefaultNavigationTimeout(60_000);
  await addToBag(accountPage, FIXTURE_SLUGS[0]);
  const accountOrderNumber = await placeCodOrder(accountPage, {
    guest: false,
    userId: account.userId,
  });
  // The order converted that cart. A second bag on top is what makes the
  // signed-in /checkout state — saved address plus lines — reachable at all.
  let accountLines = 0;
  for (const slug of FIXTURE_SLUGS.slice(1)) {
    if (await addToBag(accountPage, slug)) accountLines++;
  }
  const accountCookies = await accountContext.cookies();
  await accountContext.close();

  /* failure — a bag asking for more than the shop holds */
  const admin = adminClient();
  const failureContext = await browser.newContext({ viewport: phone });
  const failurePage = await failureContext.newPage();
  failurePage.setDefaultNavigationTimeout(60_000);
  await addToBag(failurePage, FIXTURE_SLUGS[2]);
  const failureCookies = await failureContext.cookies();
  await failureContext.close();
  const overfilled = await overfillLine(admin, failureCookies);

  /* browserFailure — spent once, on the panel that has to say "not charged" */
  const browserFailureContext = await browser.newContext({ viewport: phone });
  const browserFailurePage = await browserFailureContext.newPage();
  browserFailurePage.setDefaultNavigationTimeout(60_000);
  await addToBag(browserFailurePage, FIXTURE_SLUGS[1]);
  const browserFailureCookies = await browserFailureContext.cookies();
  await browserFailureContext.close();

  const { data: orderRow, error: orderError } = await admin
    .from("orders")
    .select("id")
    .eq("order_number", accountOrderNumber)
    .maybeSingle();
  if (orderError)
    throw new Error(
      `fixture: could not resolve ${accountOrderNumber}: ${orderError.message}`,
    );
  if (!orderRow)
    throw new Error(`fixture: ${accountOrderNumber} is not in the database`);

  return {
    guest: { cookies: guestCookies, lines },
    guestOrder: { cookies: orderCookies, orderNumber: guestOrderNumber },
    failure: { cookies: failureCookies, ...overfilled },
    browserFailure: { cookies: browserFailureCookies },
    account: {
      email: account.email,
      userId: account.userId,
      cookies: accountCookies,
      orderNumber: accountOrderNumber,
      orderId: orderRow.id,
      bagLines: accountLines,
    },
    ledger: {
      emails: [account.email],
      orderNumbers: [guestOrderNumber, accountOrderNumber],
    },
  };
}
