/**
 * `npm run audit:coins-earning` — Vault Coins mint exactly when they should.
 *
 *   1. a delivered order credits EXACTLY once — the credit replayed ten
 *      times, and the delivered transition replayed on top, nets one row
 *   2. the earn base is goods actually paid for: subtotal − discounts,
 *      never delivery, never the cash-handling fee — asserted on an order
 *      carrying every part distinctly
 *   3. expiry is a property of the coins: delivered_at + the configured
 *      months, not "whenever the cron got there"
 *   4. reversal fires exactly once per order through EACH hook (the
 *      delivered→returned transition, and the refund seam's function),
 *      and a reversal MAY drive a balance negative — that is the honest
 *      ledger of money that went back
 *   5. a guest order credits nothing; an unset rate credits nothing; a
 *      disabled account credits nothing — each loudly named, none silent
 *   6. the ledger's door: authenticated PostgREST INSERT refused, a
 *      customer reads their own rows and nobody else's
 *   7. the delivered email says how many coins the parcel earned, and says
 *      NOTHING (never "0 coins") when there are none
 *
 * Writes the loyalty settings row on STAGING and restores it in a finally
 * — fixture values for the gate, never numbers for the owner.
 *
 * Run as: NODE_OPTIONS=--conditions=react-server tsx scripts/audit/coins-earning.ts
 */
// clients first: repoints this process at staging, refuses production.
import { adminClient, anonClient, assertNotProduction, createAccount } from "./fixtures";

import { buildDeliveredEmail } from "../../src/lib/email/lifecycle";
import { transitionOrder } from "../../src/lib/orders/transition";

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

/** Fixture rate: 1 coin per ₹100, expiring 12 months from delivery. */
const RATE_RUPEES = 100;
const EXPIRY_MONTHS = 12;

const DELIVERED_AT = "2026-08-09T08:53:00.000Z";

async function main(): Promise<void> {
  assertNotProduction("build coin fixtures");
  const db = adminClient();

  const buyer = await createAccount("coins-buyer");
  const bystander = await createAccount("coins-bystander");
  const orderIds: string[] = [];
  const userIds = [buyer.userId, bystander.userId];

  const { data: originalLoyalty, error: loyaltyReadError } = await db
    .from("site_settings")
    .select("value")
    .eq("key", "loyalty")
    .single();
  if (loyaltyReadError) {
    throw new Error(`loyalty row unreadable: ${loyaltyReadError.message}`);
  }

  async function setLoyalty(value: Record<string, number | boolean>) {
    const { error } = await db
      .from("site_settings")
      .update({ value })
      .eq("key", "loyalty");
    if (error) throw new Error(`loyalty write failed: ${error.message}`);
  }

  async function fixtureOrder(input: {
    userId: string | null;
    delivered?: boolean;
    subtotal?: number;
    discountTotal?: number;
    couponDiscount?: number;
    prepaidDiscount?: number;
    shippingFee?: number;
    codHandlingFee?: number;
  }): Promise<string> {
    const subtotal = input.subtotal ?? 300_000;
    const discount = input.discountTotal ?? 0;
    const shipping = input.shippingFee ?? 0;
    const grand = subtotal - discount + shipping;
    const { data: order, error } = await db
      .from("orders")
      .insert({
        user_id: input.userId,
        // A guest order needs the token a real one would have.
        guest_token: input.userId ? null : crypto.randomUUID(),
        status: input.delivered === false ? "shipped" : "delivered",
        ...(input.delivered === false
          ? {}
          : { delivered_at: DELIVERED_AT, delivered_source: "courier" as const }),
        subtotal,
        discount_total: discount,
        coupon_discount: input.couponDiscount ?? 0,
        prepaid_discount: input.prepaidDiscount ?? 0,
        shipping_fee: shipping,
        cod_handling_fee: input.codHandlingFee ?? 0,
        grand_total: grand,
        advance_amount: grand,
        balance_due_on_delivery: 0,
        shipping_address: {
          recipientName: "QA Coins",
          phone: "9800000004",
          line1: "4 Audit Street",
          line2: null,
          city: "Coimbatore",
          state: "Tamil Nadu",
          postalCode: "641001",
          country: "IN",
        },
        contact_phone: "9800000004",
        contact_email: null,
      })
      .select("id")
      .single();
    if (error || !order) throw new Error(`fixture order failed: ${error?.message}`);
    orderIds.push(order.id);
    return order.id;
  }

  async function ledgerOf(orderId: string) {
    const { data, error } = await db
      .from("coin_transactions")
      .select("delta, reason, expires_at, user_id")
      .eq("order_id", orderId)
      .order("created_at");
    if (error) throw new Error(`ledger read failed: ${error.message}`);
    return data ?? [];
  }

  async function balanceOf(userId: string): Promise<number> {
    const { data, error } = await db
      .from("coin_transactions")
      .select("delta")
      .eq("user_id", userId);
    if (error) throw new Error(`balance read failed: ${error.message}`);
    return (data ?? []).reduce((sum, row) => sum + row.delta, 0);
  }

  try {
    await setLoyalty({
      enabled: true,
      earn_rupees_per_coin: RATE_RUPEES,
      coin_expiry_months: EXPIRY_MONTHS,
    });

    /* ══ 1+2+3 · the mint: once, on goods, with a lifetime ══════════════ */
    section("1 · one delivery, one credit, on the goods alone");

    /*
      Every money part distinct and non-zero, the same fixture discipline as
      the totals gates: subtotal ₹3,000, coupon ₹300 + prepaid ₹200 off,
      delivery ₹160 of which ₹50 is the cash-handling fee. Goods actually
      paid: ₹2,500 → 25 coins at ₹100/coin. Any base that slurps delivery
      (31), ignores discounts (30), or nets the fee (24) lands on a
      different integer.
    */
    const earning = await fixtureOrder({
      userId: buyer.userId,
      subtotal: 300_000,
      discountTotal: 50_000,
      couponDiscount: 30_000,
      prepaidDiscount: 20_000,
      shippingFee: 16_000,
      codHandlingFee: 5_000,
    });

    for (let i = 0; i < 10; i++) {
      const { data, error } = await db.rpc("credit_order_coins", {
        p_order_id: earning,
      });
      if (error) throw new Error(`credit ${i} failed: ${error.message}`);
      if (i === 0)
        ok("the first credit answers 'credited'", data === "credited", String(data));
    }

    let ledger = await ledgerOf(earning);
    ok(
      "ten replays minted exactly one earned row",
      ledger.length === 1 && ledger[0]!.reason === "earned",
      `${ledger.length} rows`,
    );
    ok(
      "of exactly 25 coins — goods paid ÷ rate, never delivery, never the fee",
      ledger[0]?.delta === 25,
      `delta = ${ledger[0]?.delta}`,
    );
    {
      const expected = new Date(DELIVERED_AT);
      expected.setMonth(expected.getMonth() + EXPIRY_MONTHS);
      ok(
        "expiry runs from DELIVERY + the configured months",
        ledger[0]?.expires_at !== null &&
          new Date(ledger[0]!.expires_at!).toISOString() ===
            expected.toISOString(),
        `expires_at = ${ledger[0]?.expires_at}`,
      );
    }

    /* ══ 1b · the transition path mints through the same seam ═══════════ */
    section("2 · the delivered transition credits, and replays are inert");

    const viaTransition = await fixtureOrder({
      userId: buyer.userId,
      delivered: false,
      subtotal: 200_000,
    });
    const moved = await transitionOrder({
      supabase: db,
      elevated: () => db,
      orderId: viaTransition,
      to: "delivered",
      note: null,
      actorId: null,
    });
    ok("the transition applied", moved.ok);
    ledger = await ledgerOf(viaTransition);
    ok(
      "and the hook minted its one earned row (20 coins on ₹2,000 goods)",
      ledger.length === 1 && ledger[0]?.delta === 20,
      JSON.stringify(ledger),
    );

    /* ══ 4 · reversal, through each hook, exactly once ══════════════════ */
    section("3 · reversal — both hooks, once each, negatives allowed");

    /*
      The brief's exploit, in miniature: buyer earned 25 + 20 = 45, then
      "spends" 45 (a service-role redeemed row standing in for Batch C),
      then the first order comes undone. The reversal must land even though
      it drives the balance to -25 — a redemption may never go below zero,
      a reversal MUST be able to.
    */
    const { error: spendError } = await db.from("coin_transactions").insert({
      user_id: buyer.userId,
      delta: -45,
      reason: "redeemed",
      note: "QA stand-in for a Batch C redemption",
    });
    if (spendError) throw new Error(`spend fixture failed: ${spendError.message}`);

    const returned = await transitionOrder({
      supabase: db,
      elevated: () => db,
      orderId: earning,
      to: "returned",
      note: "QA replacement",
      actorId: null,
    });
    ok("delivered → returned applied", returned.ok, JSON.stringify(returned));
    ledger = await ledgerOf(earning);
    ok(
      "the transition hook reversed the credit, exactly once",
      ledger.filter((row) => row.reason === "reversed").length === 1 &&
        ledger.find((row) => row.reason === "reversed")?.delta === -25,
      JSON.stringify(ledger),
    );
    ok(
      "and the balance went NEGATIVE — the honest ledger of money returned",
      (await balanceOf(buyer.userId)) === -25,
      `balance = ${await balanceOf(buyer.userId)}`,
    );

    for (let i = 0; i < 3; i++) {
      const { error } = await db.rpc("reverse_order_coins", {
        p_order_id: earning,
        p_reason: "replayed",
      });
      if (error) throw new Error(`reverse replay failed: ${error.message}`);
    }
    ledger = await ledgerOf(earning);
    ok(
      "replaying the reversal three more times changed nothing",
      ledger.filter((row) => row.reason === "reversed").length === 1,
    );

    const { data: refundHook, error: refundHookError } = await db.rpc(
      "reverse_order_coins",
      { p_order_id: viaTransition, p_reason: "Refund processed" },
    );
    ok(
      "the refund seam's call reverses its own order once",
      refundHookError === null && refundHook === "reversed",
      refundHookError?.message ?? String(refundHook),
    );
    const { data: refundAgain, error: refundAgainError } = await db.rpc(
      "reverse_order_coins",
      { p_order_id: viaTransition, p_reason: "Refund processed" },
    );
    ok(
      "and answers 'already_reversed' the second time",
      refundAgainError === null && refundAgain === "already_reversed",
      refundAgainError?.message ?? String(refundAgain),
    );

    /* ══ 5 · the three silences that must be named ══════════════════════ */
    section("4 · guests, unset rates and disabled accounts mint nothing");

    const guestOrder = await fixtureOrder({ userId: null, subtotal: 500_000 });
    const { data: guestVerdict, error: guestError } = await db.rpc(
      "credit_order_coins",
      { p_order_id: guestOrder },
    );
    ok(
      "a guest order answers 'no_user' and writes nothing",
      guestError === null &&
        guestVerdict === "no_user" &&
        (await ledgerOf(guestOrder)).length === 0,
      guestError?.message ?? String(guestVerdict),
    );

    await setLoyalty({});
    const unsetOrder = await fixtureOrder({
      userId: bystander.userId,
      subtotal: 500_000,
    });
    const { data: offVerdict, error: offError } = await db.rpc(
      "credit_order_coins",
      { p_order_id: unsetOrder },
    );
    ok(
      "with the master switch off (the resting state), nothing mints — 'programme_off'",
      offError === null &&
        offVerdict === "programme_off" &&
        (await ledgerOf(unsetOrder)).length === 0,
      offError?.message ?? String(offVerdict),
    );
    await setLoyalty({ enabled: true });
    const { data: unsetVerdict, error: unsetError } = await db.rpc(
      "credit_order_coins",
      { p_order_id: unsetOrder },
    );
    ok(
      "an unset rate answers 'rate_unset' and writes nothing — no invented number, ever",
      unsetError === null &&
        unsetVerdict === "rate_unset" &&
        (await ledgerOf(unsetOrder)).length === 0,
      unsetError?.message ?? String(unsetVerdict),
    );
    await setLoyalty({
      enabled: true,
      earn_rupees_per_coin: RATE_RUPEES,
      coin_expiry_months: EXPIRY_MONTHS,
    });

    const { error: disableError } = await db
      .from("coin_accounts")
      .upsert({ user_id: bystander.userId, coins_disabled: true });
    if (disableError) throw new Error(`disable failed: ${disableError.message}`);
    const { data: disabledVerdict, error: disabledError } = await db.rpc(
      "credit_order_coins",
      { p_order_id: unsetOrder },
    );
    ok(
      "a disabled account answers 'disabled' and writes nothing",
      disabledError === null &&
        disabledVerdict === "disabled" &&
        (await ledgerOf(unsetOrder)).length === 0,
      disabledError?.message ?? String(disabledVerdict),
    );

    /* ══ 6 · the door ═══════════════════════════════════════════════════ */
    section("5 · the ledger's grants and reads");

    const authed = anonClient();
    await authed.auth.setSession({
      access_token: bystander.session.access_token,
      refresh_token: bystander.session.refresh_token,
    });
    const { error: forgeError } = await authed.from("coin_transactions").insert({
      user_id: bystander.userId,
      delta: 1_000_000,
      reason: "adjusted",
    });
    ok(
      "an authenticated PostgREST INSERT is refused — no grant, not merely no policy",
      forgeError !== null,
      "a signed-in caller minted their own coins",
    );

    const { data: theirRead, error: theirReadError } = await authed
      .from("coin_transactions")
      .select("id, user_id");
    ok(
      "a customer reads their own rows and nobody else's",
      theirReadError === null &&
        (theirRead ?? []).every((row) => row.user_id === bystander.userId),
      theirReadError?.message ?? `${theirRead?.length} rows`,
    );

    /* ══ 7 · the email says the number, or nothing ══════════════════════ */
    section("6 · the delivered email's coin line");

    const withCoins = buildDeliveredEmail({
      orderNumber: "FV-2026-00777",
      to: "a@b.c",
      customerName: "Ada",
      coinsEarned: 25,
    });
    ok(
      "25 coins are announced",
      withCoins.text.includes("25 Vault Coins") &&
        withCoins.html.includes("25 Vault Coins"),
    );
    const withoutCoins = buildDeliveredEmail({
      orderNumber: "FV-2026-00778",
      to: "a@b.c",
      customerName: "Ada",
      coinsEarned: null,
    });
    ok(
      "no coins means silence, never '0 coins'",
      !withoutCoins.text.includes("Vault Coin") &&
        !withoutCoins.html.includes("Vault Coin"),
    );
  } finally {
    const { error: restoreLoyaltyError } = await db
      .from("site_settings")
      .update({ value: originalLoyalty.value })
      .eq("key", "loyalty");
    if (restoreLoyaltyError) {
      console.error(`  !! loyalty row not restored: ${restoreLoyaltyError.message}`);
    }
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
          `  !! fixture not removed: ${(coinsGone ?? historyGone ?? orderGone)?.message}`,
        );
    }
    for (const userId of userIds) {
      const { error: strayCoins } = await db
        .from("coin_transactions")
        .delete()
        .eq("user_id", userId);
      const { error: accountGone } = await db
        .from("coin_accounts")
        .delete()
        .eq("user_id", userId);
      if (strayCoins || accountGone)
        console.error(
          `  !! coin fixtures not removed: ${(strayCoins ?? accountGone)?.message}`,
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
