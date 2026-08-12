/**
 * `npm run audit:coins-redemption` — coins spend like money, under money's rules.
 *
 *   1. THE RACE: two simultaneous checkouts cannot spend the same coins —
 *      `Promise.all`, two transactions racing the account row lock
 *      (audit:coupons §5's shape). Exactly one wins; one redeemed row; the
 *      balance never goes negative through a redemption.
 *   2. the TWO caps, and whichever binds lower binds: the percent cap on a
 *      big balance against a small order, the absolute coin cap when the
 *      percent cap would allow more. planCoinSpend (the preview) and the
 *      function (the law) agree to the coin.
 *   3. coins never enter discount_total — the tender ruling, asserted on an
 *      order carrying a prepaid discount AND coins.
 *   4. Pay on Delivery: the advance is untouched; the collectable falls by
 *      exactly the coins spent; and it stays a whole number of rupees.
 *   5. born paid: a prepaid order settled entirely in coins carries a ₹0
 *      advance, never calls Razorpay, and confirms through
 *      applyPaymentOutcome — the SAME seam as a webhook capture — with one
 *      history row however many times the event replays.
 *   6. the 1–99 paise sliver is refused: Razorpay throws under ₹1 and a
 *      partial settlement landing there is an order that cancels itself.
 *   7. cancellation releases redeemed coins exactly once.
 *   8. every setting unset ⇒ redemption refused loudly ('coins_unset').
 *   9. settlement identity on every order placed here:
 *      advance + balance + coin_paid = grand_total (also a CHECK constraint).
 *
 * Writes the loyalty row on STAGING and restores it; cancels its orders
 * (exercising the release) and deletes its fixtures on the way out.
 *
 * Run as: NODE_OPTIONS=--conditions=react-server tsx scripts/audit/coins-redemption.ts
 */
import "./clients";

import { createAccount, adminClient } from "./fixtures";
import { planCoinSpend } from "../../src/lib/coins/redeem";
import { applyPaymentOutcome } from "../../src/lib/orders/payment-state";

const ADDRESS = {
  recipientName: "Coin Runner",
  phone: "9876500012",
  line1: "5 Audit Street",
  line2: null,
  city: "Panaji",
  state: "Goa",
  postalCode: "403001",
  country: "IN",
};

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

type PlaceOutcome =
  | { ok: true; orderId: string; orderNumber: string }
  | { ok: false; code: string | null; message: string };

async function main(): Promise<void> {
  const admin = adminClient();
  const buyer = await createAccount("coins-spender");
  const cartIds: string[] = [];
  const orderIds: string[] = [];

  const { data: originalLoyalty, error: loyaltyError } = await admin
    .from("site_settings")
    .select("value")
    .eq("key", "loyalty")
    .single();
  if (loyaltyError) throw new Error(`loyalty unreadable: ${loyaltyError.message}`);

  async function setLoyalty(value: Record<string, number | boolean>) {
    const { error } = await admin
      .from("site_settings")
      .update({ value })
      .eq("key", "loyalty");
    if (error) throw new Error(`loyalty write failed: ${error.message}`);
  }

  /** Give the buyer coins by minting an earned row with no order behind it. */
  async function mint(coins: number) {
    const { error } = await admin.from("coin_transactions").insert({
      user_id: buyer.userId,
      delta: coins,
      reason: "earned",
      note: "QA mint",
    });
    if (error) throw new Error(`mint failed: ${error.message}`);
  }

  async function balance(): Promise<number> {
    const { data, error } = await admin
      .from("coin_transactions")
      .select("delta")
      .eq("user_id", buyer.userId);
    if (error) throw new Error(`balance read failed: ${error.message}`);
    return (data ?? []).reduce((sum, row) => sum + row.delta, 0);
  }

  async function makeCart(variantId: string): Promise<string> {
    // One ACTIVE cart per user (carts_one_active_per_user_idx), so retire
    // whatever the last section left before opening the next.
    const { error: retireError } = await admin
      .from("carts")
      .update({ status: "converted" })
      .eq("user_id", buyer.userId)
      .eq("status", "active");
    if (retireError) throw new Error(`cart retire failed: ${retireError.message}`);
    // carts_single_owner: a cart belongs to a user XOR a guest token.
    const { data: cart, error } = await admin
      .from("carts")
      .insert({ user_id: buyer.userId })
      .select("id")
      .single();
    if (error || !cart) throw new Error(`cart failed: ${error?.message}`);
    cartIds.push(cart.id);
    const { error: lineError } = await admin
      .from("cart_items")
      .insert({ cart_id: cart.id, variant_id: variantId, quantity: 1 });
    if (lineError) throw new Error(`cart line failed: ${lineError.message}`);
    return cart.id;
  }

  async function place(input: {
    cartId: string;
    coinSpend: number;
    method?: "razorpay" | "cod";
    advance?: number;
    shippingFee?: number;
  }): Promise<PlaceOutcome> {
    const { data, error } = await admin.rpc("create_order_with_stock", {
      p_cart_id: input.cartId,
      p_shipping_address: ADDRESS,
      p_payment_method: input.method ?? "razorpay",
      p_initial_status: "pending",
      p_payment_status: "unpaid",
      p_shipping_flat_fee: input.shippingFee ?? 9_900,
      p_user_id: buyer.userId,
      p_contact_phone: "9876500012",
      p_advance_amount: input.advance,
      p_coin_spend: input.coinSpend,
    });
    if (error) {
      return { ok: false, code: error.code ?? null, message: error.message };
    }
    const row = data?.[0];
    if (!row) return { ok: false, code: null, message: "no row returned" };
    orderIds.push(row.order_id);
    return { ok: true, orderId: row.order_id, orderNumber: row.order_number };
  }

  async function orderRow(orderId: string) {
    const { data, error } = await admin
      .from("orders")
      .select(
        "status, payment_status, subtotal, discount_total, prepaid_discount, shipping_fee, grand_total, advance_amount, balance_due_on_delivery, coin_paid, coin_spent",
      )
      .eq("id", orderId)
      .single();
    if (error || !data) throw new Error(`order read failed: ${error?.message}`);
    return data;
  }

  function settles(row: Awaited<ReturnType<typeof orderRow>>): boolean {
    return (
      row.advance_amount + row.balance_due_on_delivery + row.coin_paid ===
      row.grand_total
    );
  }

  const { data: variants, error: variantError } = await admin
    .from("product_variants")
    .select("id, stock_quantity")
    .eq("is_active", true)
    .gte("stock_quantity", 3)
    .limit(6);
  if (variantError || (variants?.length ?? 0) < 6) {
    throw new Error(`need six stocked variants: ${variantError?.message}`);
  }
  const v = variants!;

  try {
    /* ══ 1 · the percent cap binds a big balance on a small order ═══════ */
    section("1 · the two caps, and the preview agrees with the law");

    await setLoyalty({
      enabled: true,
      coin_value_paise: 10_000, // ₹100 a coin
      coin_max_percent_of_order: 50,
      coin_max_coins_per_order: 100,
      coin_minimum_balance: 10,
    });
    await mint(300);

    // The catalogue's cheapest stocked pair plus flat delivery lands around
    // ₹2,700; 50% room at ₹100 a coin caps in the low tens while the
    // balance (300) and the absolute cap (100) would allow far more — the
    // percent cap is the binding rule here, by construction.
    const cartA = await makeCart(v[0]!.id);

    /*
      Probe the price by placing WITHOUT coins, reading the total, then
      cancelling — the gate must not hardcode catalogue prices.
    */
    const probe = await place({ cartId: cartA, coinSpend: 0 });
    if (!probe.ok) throw new Error(`probe failed: ${probe.message}`);
    const probeRow = await orderRow(probe.orderId);
    const { error: probeCancel } = await admin.rpc("cancel_order_with_restock", {
      p_order_id: probe.orderId,
      p_reason: "QA probe",
      p_require_unpaid: true,
      p_release_cart: false,
    });
    if (probeCancel) throw new Error(`probe cancel failed: ${probeCancel.message}`);

    const total = probeRow.grand_total;
    const pctRoomCoins = Math.floor(Math.floor((total * 50) / 100) / 10_000);
    const plan = await planCoinSpend({
      userId: buyer.userId,
      grandTotalPaise: total,
      advancePaise: total,
      balancePaise: 0,
    });
    ok(
      "the preview picks the percent cap's number and names the rule",
      plan.available && plan.coins === pctRoomCoins && plan.boundBy === "percent_cap",
      JSON.stringify(plan),
    );

    const cartA2 = await makeCart(v[0]!.id);
    const overPct = await place({ cartId: cartA2, coinSpend: pctRoomCoins + 1 });
    ok(
      "one coin over the percent cap is refused by the function",
      !overPct.ok && overPct.code === "CNRJT" && overPct.message === "over_percent_cap",
      overPct.ok ? "placed!" : `${overPct.code}:${overPct.message}`,
    );

    const spentA = await place({ cartId: cartA2, coinSpend: pctRoomCoins });
    ok("exactly the cap's number is accepted", spentA.ok, JSON.stringify(spentA));
    if (spentA.ok) {
      const row = await orderRow(spentA.orderId);
      ok(
        "advance + balance + coin_paid = grand_total",
        settles(row),
        JSON.stringify(row),
      );
      ok(
        "coins never enter discount_total (tender, not discount)",
        row.discount_total === 0 && row.coin_paid === pctRoomCoins * 10_000,
        JSON.stringify(row),
      );
      ok(
        "coin_spent stores the coins beside the paise",
        row.coin_spent === pctRoomCoins,
      );
    }

    /* the absolute cap binds when the percent cap would allow more */
    await setLoyalty({
      enabled: true,
      coin_value_paise: 10_000,
      coin_max_percent_of_order: 100,
      coin_max_coins_per_order: 5,
      coin_minimum_balance: 10,
    });
    const cartB = await makeCart(v[1]!.id);
    const overAbs = await place({ cartId: cartB, coinSpend: 6 });
    ok(
      "one coin over the absolute cap is refused — whichever binds lower binds",
      !overAbs.ok && overAbs.code === "CNRJT" && overAbs.message === "over_coin_cap",
      overAbs.ok ? "placed!" : `${overAbs.code}:${overAbs.message}`,
    );
    const planAbs = await planCoinSpend({
      userId: buyer.userId,
      grandTotalPaise: total,
      advancePaise: total,
      balancePaise: 0,
    });
    ok(
      "and the preview lands on the same bound",
      planAbs.available && planAbs.coins === 5 && planAbs.boundBy === "coin_cap",
      JSON.stringify(planAbs),
    );

    /* ══ 2 · tender beside a discount ═══════════════════════════════════ */
    section("2 · a discount above the line, coins below it");

    const beforeDiscount = await balance();
    const withDiscount = await place({
      cartId: cartB,
      coinSpend: 5,
    });
    ok("an order carrying coins places", withDiscount.ok, JSON.stringify(withDiscount));
    if (withDiscount.ok) {
      const row = await orderRow(withDiscount.orderId);
      ok(
        "grand_total is untouched by coins — they change who pays, not the price",
        row.grand_total === row.subtotal - row.discount_total + row.shipping_fee,
        JSON.stringify(row),
      );
      ok("and the settlement identity holds", settles(row));
      ok(
        "the ledger holds the redeemed row",
        (await balance()) === beforeDiscount - 5,
      );
    }

    /* ══ 3 · Pay on Delivery: the advance is sacred ═════════════════════ */
    section("3 · COD — coins settle the door, never the deposit");

    await setLoyalty({
      enabled: true,
      coin_value_paise: 10_000,
      coin_max_percent_of_order: 50,
      coin_max_coins_per_order: 100,
      coin_minimum_balance: 10,
    });
    const cartC = await makeCart(v[2]!.id);
    const cod = await place({
      cartId: cartC,
      coinSpend: 3,
      method: "cod",
      advance: 30_000,
    });
    ok("a COD order carrying coins places", cod.ok, JSON.stringify(cod));
    if (cod.ok) {
      const row = await orderRow(cod.orderId);
      ok(
        "the advance is exactly what was quoted — coins never touched it",
        row.advance_amount === 30_000,
        `advance = ${row.advance_amount}`,
      );
      ok(
        "the collectable fell by exactly the coins spent",
        row.balance_due_on_delivery ===
          row.grand_total - 30_000 - 3 * 10_000 &&
          row.coin_paid === 30_000,
        JSON.stringify(row),
      );
      ok(
        "and is a whole number of rupees",
        row.balance_due_on_delivery % 100 === 0,
      );
      ok("settlement identity", settles(row));
    }

    /* a spend bigger than the whole balance-at-the-door is refused */
    // Self-calibrating: probe this cart's real total (variant prices differ
    // run to run), then leave exactly ₹150 at the door and ask for ₹200 of
    // coins — inside the 50% cap on any real pair, past the balance on all
    // of them, so the structural rule and not a cap is what must refuse it.
    const cartC2 = await makeCart(v[3]!.id);
    const probeC = await place({ cartId: cartC2, coinSpend: 0 });
    if (!probeC.ok) throw new Error(`door probe failed: ${probeC.message}`);
    const probeCRow = await orderRow(probeC.orderId);
    const { error: probeCCancel } = await admin.rpc("cancel_order_with_restock", {
      p_order_id: probeC.orderId,
      p_reason: "QA probe",
      p_require_unpaid: true,
      p_release_cart: false,
    });
    if (probeCCancel) throw new Error(`door probe cancel: ${probeCCancel.message}`);
    const cartC3 = await makeCart(v[3]!.id);
    const overBalance = await place({
      cartId: cartC3,
      coinSpend: 2,
      method: "cod",
      advance: probeCRow.grand_total - 15_000,
    });
    ok(
      "coins that would eat past the door balance are refused, advance intact",
      !overBalance.ok &&
        overBalance.code === "CNRJT" &&
        overBalance.message === "over_balance",
      overBalance.ok ? "placed!" : `${overBalance.code}:${overBalance.message}`,
    );

    /* ══ 4 · the sliver ═════════════════════════════════════════════════ */
    section("4 · never 1–99 paise on the card");

    await setLoyalty({
      enabled: true,
      coin_value_paise: 100, // ₹1 a coin, to reach the window at all
      coin_max_percent_of_order: 100,
      coin_max_coins_per_order: 100_000,
      coin_minimum_balance: 1,
    });
    await mint(5_000);
    const cartD = await makeCart(v[3]!.id);
    // A ₹…and-50-paise total via an odd flat fee; spending all but 50 paise
    // of the advance lands in Razorpay's forbidden window.
    const probeD = await place({ cartId: cartD, coinSpend: 0, shippingFee: 9_950 });
    if (!probeD.ok) throw new Error(`sliver probe failed: ${probeD.message}`);
    const probeDRow = await orderRow(probeD.orderId);
    const { error: probeDCancel } = await admin.rpc("cancel_order_with_restock", {
      p_order_id: probeD.orderId,
      p_reason: "QA probe",
      p_require_unpaid: true,
      p_release_cart: false,
    });
    if (probeDCancel) throw new Error(`sliver probe cancel: ${probeDCancel.message}`);
    const almostAll = Math.floor(probeDRow.grand_total / 100) - 0; // whole ₹ coins
    const cartD2 = await makeCart(v[3]!.id);
    const sliver = await place({
      cartId: cartD2,
      coinSpend: almostAll, // leaves the 50-paise tail: 0 < remainder < 100
      shippingFee: 9_950,
    });
    ok(
      "a settlement leaving 1–99 paise is refused outright",
      !sliver.ok && sliver.code === "CNRJT" && sliver.message === "sliver",
      sliver.ok ? "placed!" : `${sliver.code}:${sliver.message}`,
    );

    /* ══ 5 · born paid, through the one seam ════════════════════════════ */
    section("5 · a fully coin-settled order is born paid, emails and all");

    const cartE = await makeCart(v[4]!.id);
    const probeE = await place({ cartId: cartE, coinSpend: 0 });
    if (!probeE.ok) throw new Error(`born-paid probe failed: ${probeE.message}`);
    const probeERow = await orderRow(probeE.orderId);
    const { error: probeECancel } = await admin.rpc("cancel_order_with_restock", {
      p_order_id: probeE.orderId,
      p_reason: "QA probe",
      p_require_unpaid: true,
      p_release_cart: false,
    });
    if (probeECancel) throw new Error(`born-paid probe cancel: ${probeECancel.message}`);

    const allCoins = probeERow.grand_total / 100; // ₹1 coins, whole-rupee total
    const cartE2 = await makeCart(v[4]!.id);
    const born = await place({ cartId: cartE2, coinSpend: allCoins });
    ok("the fully-settled order places", born.ok, JSON.stringify(born));
    if (born.ok) {
      let row = await orderRow(born.orderId);
      ok(
        "with a ₹0 advance and the whole total in coin_paid",
        row.advance_amount === 0 &&
          row.coin_paid === row.grand_total &&
          settles(row),
        JSON.stringify(row),
      );

      // The seam, exactly as placeOrder's settleCoinOnlyOrder drives it.
      const reference = `coins:${born.orderId}`;
      const { error: payError } = await admin.from("payments").insert({
        order_id: born.orderId,
        provider: "cod",
        provider_order_id: reference,
        amount: 0,
        currency: "INR",
        status: "created",
      });
      if (payError) throw new Error(`payments row failed: ${payError.message}`);

      for (let i = 0; i < 3; i++) {
        await applyPaymentOutcome({
          eventId: reference,
          provider: "cod",
          providerOrderId: reference,
          eventType: "coins.settled",
          outcome: {
            status: "captured",
            providerPaymentId: null,
            providerOrderId: reference,
            amountPaise: 0,
            rawStatus: "coin_settled",
            message: "Settled in full with Vault Coins",
          },
        });
      }

      row = await orderRow(born.orderId);
      ok(
        "the seam confirmed it — pending→confirmed, paid, no Razorpay anywhere",
        row.status === "confirmed" && row.payment_status === "paid",
        JSON.stringify(row),
      );
      const { count: confirmedRows, error: historyError } = await admin
        .from("order_status_history")
        .select("id", { count: "exact", head: true })
        .eq("order_id", born.orderId)
        .eq("status", "confirmed");
      ok(
        "one confirmed history row across three replays — and the emails hang off that transition, so one email each",
        historyError === null && confirmedRows === 1,
        historyError?.message ?? `${confirmedRows} rows`,
      );
    }

    /* ══ 6 · THE RACE ═══════════════════════════════════════════════════ */
    section("6 · two checkouts race one balance — concurrently");

    // Drain to a balance that covers exactly ONE more order's spend.
    const current = await balance();
    const target = 200; // ₹200 in ₹1 coins
    if (current > target) {
      const { error: drainError } = await admin.from("coin_transactions").insert({
        user_id: buyer.userId,
        delta: -(current - target),
        reason: "adjusted",
        note: "QA drain before the race",
      });
      if (drainError) throw new Error(`drain failed: ${drainError.message}`);
    }

    /*
      One user can hold one ACTIVE cart (carts_one_active_per_user_idx), so
      the reachable double-spend is a DOUBLE SUBMIT: the same cart, two
      placeOrder calls in flight at once — two tabs, or one button pressed
      twice. Both transactions queue on the cart's FOR UPDATE; the loser
      finds it converted and gets cart_unavailable, never a second spend.
      The account row lock stays underneath as the guarantee for any future
      path that reaches the coin block without this cart shape.
    */
    const cartX = await makeCart(v[5]!.id);
    const [x, y] = await Promise.all([
      place({ cartId: cartX, coinSpend: 200 }),
      place({ cartId: cartX, coinSpend: 200 }),
    ]);
    const winners = [x, y].filter((outcome) => outcome.ok).length;
    const stopped = [x, y].filter(
      (outcome) => !outcome.ok && outcome.code === "CNVRT",
    ).length;
    ok("exactly one of two simultaneous submits wins", winners === 1, `${winners} won`);
    ok(
      "the loser is stopped at the cart lock — no second spend exists to race",
      stopped === 1,
      JSON.stringify([x, y]),
    );
    {
      const spentDry = await place({
        cartId: await makeCart(v[0]!.id),
        coinSpend: 50,
      });
      ok(
        "and with the balance emptied, a further spend is refused by name",
        !spentDry.ok &&
          spentDry.code === "CNRJT" &&
          (spentDry.message === "insufficient" ||
            spentDry.message === "below_minimum"),
        spentDry.ok ? "placed!" : `${spentDry.code}:${spentDry.message}`,
      );
    }
    ok(
      "the balance never went negative through redemption",
      (await balance()) >= 0,
      `balance = ${await balance()}`,
    );
    const { data: redeemedRows, error: redeemedError } = await admin
      .from("coin_transactions")
      .select("id, order_id")
      .eq("user_id", buyer.userId)
      .eq("reason", "redeemed")
      .in(
        "order_id",
        [x, y].filter((o) => o.ok).map((o) => (o as { orderId: string }).orderId),
      );
    ok(
      "the ledger holds exactly one redeemed row for the race",
      redeemedError === null && redeemedRows?.length === 1,
      redeemedError?.message ?? `${redeemedRows?.length} rows`,
    );

    /* ══ 7 · cancellation gives the coins back, once ════════════════════ */
    section("7 · release on cancellation, exactly once");

    const raceWinner = [x, y].find((o) => o.ok) as { orderId: string } | undefined;
    if (raceWinner) {
      const beforeRelease = await balance();
      for (let i = 0; i < 2; i++) {
        const { error: cancelError } = await admin.rpc(
          "cancel_order_with_restock",
          {
            p_order_id: raceWinner.orderId,
            p_reason: "QA release",
            p_require_unpaid: true,
            p_release_cart: false,
          },
        );
        if (cancelError) throw new Error(`cancel failed: ${cancelError.message}`);
      }
      ok(
        "the 200 coins came back exactly once across two cancellations",
        (await balance()) === beforeRelease + 200,
        `balance = ${await balance()}`,
      );
      const { count: releasedRows, error: releasedError } = await admin
        .from("coin_transactions")
        .select("id", { count: "exact", head: true })
        .eq("order_id", raceWinner.orderId)
        .eq("reason", "released");
      ok(
        "one released row, mirroring the redeemed one",
        releasedError === null && releasedRows === 1,
        releasedError?.message ?? `${releasedRows} rows`,
      );
    }

    /* ══ 8 · unset means unspendable, loudly ════════════════════════════ */
    section("8 · unset settings refuse redemption by name");

    await setLoyalty({ enabled: true });
    const cartF = await makeCart(v[1]!.id);
    const unset = await place({ cartId: cartF, coinSpend: 5 });
    ok(
      "with no numbers typed, redemption answers 'coins_unset'",
      !unset.ok && unset.code === "CNRJT" && unset.message === "coins_unset",
      unset.ok ? "placed!" : `${unset.code}:${unset.message}`,
    );

    /* ══ 9 · the master switch is a wall, not a label ═══════════════════ */
    section("9 · the master switch, off");

    await setLoyalty({
      coin_value_paise: 100,
      coin_max_percent_of_order: 100,
      coin_max_coins_per_order: 100_000,
      coin_minimum_balance: 1,
      // enabled deliberately absent: off is the resting state.
    });
    const cartG = await makeCart(v[2]!.id);
    const off = await place({ cartId: cartG, coinSpend: 5 });
    ok(
      "with every number set but the programme off, redemption refuses 'programme_off'",
      !off.ok && off.code === "CNRJT" && off.message === "programme_off",
      off.ok ? "placed!" : `${off.code}:${off.message}`,
    );
  } finally {
    const { error: loyaltyRestore } = await admin
      .from("site_settings")
      .update({ value: originalLoyalty.value })
      .eq("key", "loyalty");
    if (loyaltyRestore)
      console.error(`  !! loyalty not restored: ${loyaltyRestore.message}`);

    for (const orderId of orderIds) {
      // Cancel puts stock and coins back where the order still holds them;
      // already-cancelled and confirmed-born-paid rows answer accordingly.
      const { error: sweepCancel } = await admin.rpc("cancel_order_with_restock", {
        p_order_id: orderId,
        p_reason: "QA sweep",
        p_require_unpaid: false,
        p_release_cart: false,
      });
      if (sweepCancel)
        console.error(`  !! sweep cancel failed: ${sweepCancel.message}`);
      for (const sweep of [
        admin.from("coin_transactions").delete().eq("order_id", orderId),
        admin.from("payments").delete().eq("order_id", orderId),
        admin.from("payment_events").delete().eq("order_id", orderId),
        admin.from("order_status_history").delete().eq("order_id", orderId),
        admin.from("order_items").delete().eq("order_id", orderId),
      ]) {
        const { error } = await sweep;
        if (error) console.error(`  !! sweep failed: ${error.message}`);
      }
      const { error: orderGone } = await admin
        .from("orders")
        .delete()
        .eq("id", orderId);
      if (orderGone) console.error(`  !! order not removed: ${orderGone.message}`);
    }
    for (const sweep of [
      admin.from("coin_transactions").delete().eq("user_id", buyer.userId),
      admin.from("coin_accounts").delete().eq("user_id", buyer.userId),
      admin.from("cart_items").delete().in("cart_id", cartIds),
      admin.from("carts").delete().in("id", cartIds),
    ]) {
      const { error } = await sweep;
      if (error) console.error(`  !! fixture sweep failed: ${error.message}`);
    }
    await admin.auth.admin.deleteUser(buyer.userId).catch(() => {});
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
