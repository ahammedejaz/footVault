/**
 * `npm run audit:loyalty` — /admin/loyalty, operated like the owner.
 *
 *   npm run dev:stage          # a server on :3210
 *   npm run audit:loyalty
 *
 * Every control found by its VISIBLE LABEL and operated for real —
 * `audit:settings-controls`' rule, which exists because two toggles were
 * reported built and proved for two phases while the owner could not find
 * them (gates-must-prove-human-reachability). Asserted here:
 *
 *   1. the settings form: numbers typed into labelled fields, the master
 *      switch ticked, Save pressed — and the loyalty ROW holds exactly what
 *      was typed, absent keys staying absent
 *   2. a manual adjustment through the real control writes an `adjusted`
 *      ledger row carrying the actor and the REQUIRED reason; a blank
 *      reason is refused
 *   3. the per-customer disable through the real control flips
 *      coin_accounts.coins_disabled, and credit_order_coins answers
 *      'disabled'
 *   4. the liability figure equals the ledger: positive balances summed,
 *      negative ones NOT netted off
 *   5. the abuse signals see a planted pattern: two accounts sharing one
 *      phone and one canonicalised address
 *
 * Run as: NODE_OPTIONS=--conditions=react-server tsx scripts/audit/loyalty.ts
 */
import { adminClient, assertNotProduction, createAccount, sessionCookies } from "./fixtures";

import { chromium } from "playwright";

import { assertServerNotProduction } from "./clients";
import { BASE_URL } from "./routes";

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail = ""): void {
  checks++;
  if (!condition) failures++;
  console.log(
    `  ${condition ? "ok  " : "FAIL"}  ${label}${condition || !detail ? "" : `\n          ${detail}`}`,
  );
}

function section(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function main(): Promise<void> {
  /*
    The browser writes wherever BASE_URL points, which the credential guard
    cannot see. See clients.ts — this is the half that let production pick up
    two guest carts on 2026-08-14.
  */
  await assertServerNotProduction(BASE_URL, "run audit:loyalty");

  assertNotProduction("build loyalty fixtures");
  const db = adminClient();
  const owner = await createAccount("loyalty-owner");
  const holder = await createAccount("loyalty-holder");
  const debtor = await createAccount("loyalty-debtor");
  const twin = await createAccount("loyalty-twin");
  const userIds = [owner.userId, holder.userId, debtor.userId, twin.userId];
  const orderIds: string[] = [];

  {
    const { error } = await db
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", owner.userId);
    if (error) throw new Error(`could not promote the probe: ${error.message}`);
  }

  const { data: originalLoyalty, error: loyaltyError } = await db
    .from("site_settings")
    .select("value")
    .eq("key", "loyalty")
    .single();
  if (loyaltyError) throw new Error(`loyalty unreadable: ${loyaltyError.message}`);

  /* Planted arithmetic: holder +120, debtor −20 → liability is 120, not 100. */
  {
    const { error } = await db.from("coin_transactions").insert([
      { user_id: holder.userId, delta: 120, reason: "earned", note: "QA plant" },
      { user_id: debtor.userId, delta: -20, reason: "reversed", note: "QA plant" },
    ]);
    if (error) throw new Error(`plant failed: ${error.message}`);
  }

  /* Two accounts, one phone, one address — the shared-signal pattern. */
  const SHARED_PHONE = `98${Date.now().toString().slice(-8)}`;
  async function plantOrder(userId: string) {
    const { data, error } = await db
      .from("orders")
      .insert({
        user_id: userId,
        status: "confirmed",
        subtotal: 100_000,
        grand_total: 100_000,
        advance_amount: 100_000,
        balance_due_on_delivery: 0,
        contact_phone: SHARED_PHONE,
        shipping_address: {
          recipientName: "QA Twin",
          phone: SHARED_PHONE,
          line1: "77, Shared. Street!",
          line2: null,
          city: "Panaji",
          state: "Goa",
          postalCode: "403001",
          country: "IN",
        },
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`order plant failed: ${error?.message}`);
    orderIds.push(data.id);
  }
  await plantOrder(holder.userId);
  await plantOrder(twin.userId);

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1400, height: 1200 },
    });
    await context.addCookies(await sessionCookies(owner.session));
    const page = await context.newPage();

    /* ══ 1 · the settings, by their visible labels ══════════════════════ */
    section("1 · the switchboard, operated by label");

    await page.goto(`${BASE_URL}/admin/loyalty`, { waitUntil: "load" });
    const masterSwitch = page.getByLabel(/Vault Coins are switched on/);
    await masterSwitch.waitFor({ state: "visible", timeout: 20_000 });
    ok("the master switch is on screen and labelled", true);

    if (!(await masterSwitch.isChecked())) await masterSwitch.check();
    await page.getByLabel("Rupees spent to earn 1 coin").fill("100");
    await page
      .getByLabel(/What 1 coin is worth at checkout/)
      .fill("10000");
    await page.getByLabel(/Most of an order payable in coins/).fill("20");
    await page.getByLabel("Most coins spendable on one order").fill("100");
    await page.getByLabel("Coins needed before spending any").fill("50");
    // Expiry left EMPTY on purpose: absent must stay absent.
    await page.getByLabel(/Months before earned coins expire/).fill("");
    await page.getByRole("button", { name: "Save loyalty settings" }).click();
    await page.getByText(/Loyalty settings saved/).waitFor({ timeout: 15_000 });

    const { data: savedRow, error: savedError } = await db
      .from("site_settings")
      .select("value")
      .eq("key", "loyalty")
      .single();
    const saved = (savedRow?.value ?? {}) as Record<string, unknown>;
    ok(
      "the row holds exactly what was typed",
      savedError === null &&
        saved.enabled === true &&
        saved.earn_rupees_per_coin === 100 &&
        saved.coin_value_paise === 10_000 &&
        saved.coin_max_percent_of_order === 20 &&
        saved.coin_max_coins_per_order === 100 &&
        saved.coin_minimum_balance === 50,
      JSON.stringify(saved),
    );
    ok(
      "and the empty expiry stayed ABSENT — unset is a state, not a zero",
      !("coin_expiry_months" in saved),
      JSON.stringify(saved),
    );

    /* ══ 2 · the liability figure is the ledger's answer ════════════════ */
    section("2 · the liability, un-netted");

    await page.goto(`${BASE_URL}/admin/loyalty`, { waitUntil: "load" });
    const liabilityText = await page
      .locator("section[aria-labelledby='liability-heading']")
      .innerText();
    ok(
      "positive balances only: 120 coins at ₹100 = ₹12,000, the −20 not netted",
      liabilityText.includes("12,000") && liabilityText.includes("120 coins"),
      liabilityText.replace(/\s+/g, " ").slice(0, 160),
    );

    /* ══ 3 · adjustment, with the reason the ledger requires ════════════ */
    section("3 · a manual adjustment through the real control");

    await page
      .getByRole("button", { name: "Adjust coins…" })
      .first()
      .click();
    await page.getByLabel("Coins to add, negative to remove").fill("15");
    // Blank reason first: the refusal is part of the control.
    await page.getByRole("button", { name: "Write it" }).click();
    await page.getByText(/Say why/).waitFor({ timeout: 15_000 });
    ok("a blank reason is refused with the rule spelled out", true);

    await page.getByLabel(/Why — written into the ledger/).fill("QA goodwill");
    await page.getByRole("button", { name: "Write it" }).click();
    await page.getByText(/Adjustment written/).waitFor({ timeout: 15_000 });

    const { data: adjusted, error: adjustedError } = await db
      .from("coin_transactions")
      .select("delta, reason, actor, note")
      .eq("user_id", holder.userId)
      .eq("reason", "adjusted")
      .maybeSingle();
    ok(
      "the ledger row carries the delta, the actor and the reason",
      adjustedError === null &&
        adjusted?.delta === 15 &&
        adjusted?.actor === owner.userId &&
        adjusted?.note === "QA goodwill",
      adjustedError?.message ?? JSON.stringify(adjusted),
    );

    /* ══ 4 · the per-customer switch ════════════════════════════════════ */
    section("4 · disable one customer, and the mint refuses them");

    await page
      .getByRole("button", { name: "Disable coins" })
      .first()
      .click();
    await page.getByText(/Coins disabled for this customer/).waitFor({
      timeout: 15_000,
    });
    const { data: account, error: accountError } = await db
      .from("coin_accounts")
      .select("coins_disabled")
      .eq("user_id", holder.userId)
      .single();
    ok(
      "coin_accounts.coins_disabled flipped",
      accountError === null && account?.coins_disabled === true,
      accountError?.message ?? JSON.stringify(account),
    );

    const { data: deliveredOrder, error: deliveredError } = await db
      .from("orders")
      .insert({
        user_id: holder.userId,
        status: "delivered",
        delivered_at: new Date().toISOString(),
        delivered_source: "courier",
        subtotal: 200_000,
        grand_total: 200_000,
        advance_amount: 200_000,
        balance_due_on_delivery: 0,
        contact_phone: SHARED_PHONE,
        shipping_address: {
          recipientName: "QA Twin",
          phone: SHARED_PHONE,
          line1: "77 Shared Street",
          line2: null,
          city: "Panaji",
          state: "Goa",
          postalCode: "403001",
          country: "IN",
        },
      })
      .select("id")
      .single();
    if (deliveredError || !deliveredOrder)
      throw new Error(`delivered plant failed: ${deliveredError?.message}`);
    orderIds.push(deliveredOrder.id);
    const { data: verdict, error: verdictError } = await db.rpc(
      "credit_order_coins",
      { p_order_id: deliveredOrder.id },
    );
    ok(
      "a delivered order for a disabled customer mints nothing — 'disabled'",
      verdictError === null && verdict === "disabled",
      verdictError?.message ?? String(verdict),
    );

    /* ══ 5 · the signals see the plant ══════════════════════════════════ */
    section("5 · the abuse signals");

    await page.goto(`${BASE_URL}/admin/loyalty`, { waitUntil: "load" });
    const signalsText = await page
      .locator("section[aria-labelledby='signals-heading']")
      .innerText();
    ok(
      "two accounts sharing one phone are named",
      signalsText.includes(SHARED_PHONE) && /2 accounts/.test(signalsText),
      signalsText.replace(/\s+/g, " ").slice(0, 200),
    );
    ok(
      "and the shared address collapses punctuation to match",
      signalsText.includes("77sharedstreet:403001"),
      signalsText.replace(/\s+/g, " ").slice(0, 200),
    );

    await context.close();
  } finally {
    await browser.close();
    const { error: restoreError } = await db
      .from("site_settings")
      .update({ value: originalLoyalty.value })
      .eq("key", "loyalty");
    if (restoreError)
      console.error(`  !! loyalty not restored: ${restoreError.message}`);
    for (const orderId of orderIds) {
      const { error: coinsGone } = await db
        .from("coin_transactions")
        .delete()
        .eq("order_id", orderId);
      const { error: historyGone } = await db
        .from("order_status_history")
        .delete()
        .eq("order_id", orderId);
      const { error: orderGone } = await db
        .from("orders")
        .delete()
        .eq("id", orderId);
      if (coinsGone || historyGone || orderGone)
        console.error(
          `  !! order fixture not removed: ${(coinsGone ?? historyGone ?? orderGone)?.message}`,
        );
    }
    for (const userId of userIds) {
      const { error: coinsGone } = await db
        .from("coin_transactions")
        .delete()
        .eq("user_id", userId);
      const { error: accountGone } = await db
        .from("coin_accounts")
        .delete()
        .eq("user_id", userId);
      if (coinsGone || accountGone)
        console.error(
          `  !! coin fixture not removed: ${(coinsGone ?? accountGone)?.message}`,
        );
      await db.auth.admin.deleteUser(userId).catch(() => {});
    }
  }

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
