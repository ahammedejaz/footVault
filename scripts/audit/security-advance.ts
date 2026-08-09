/**
 * `npm run audit:security-advance` — attacking the money split.
 *
 * The brief names these attempts specifically, because the Pay-on-Delivery
 * model adds two numbers that decide how much a customer pays online and how
 * much a courier collects at the door. If either can be moved from a browser,
 * the shop ships goods for a rupee.
 *
 * Every attempt below is made as a **real signed-in customer over the real
 * PostgREST endpoint**, with their own JWT — not as an anonymous caller, and
 * not through the application's own code. That is the threat: somebody who
 * legitimately has an account, has read the JavaScript bundle, and is now
 * talking to the database directly.
 *
 * **Known gap, stated rather than hidden:** this suite reaches the data layer,
 * not Next's Server Action endpoints. An action's authorization is re-checked
 * inside `adminAction`, which `audit:admin-security` covers by calling the RPCs
 * those actions depend on — but neither suite drives an action over HTTP with a
 * forged payload. That remains the most valuable test still missing, and it is
 * carried in the report rather than quietly omitted.
 */

import { adminClient, anonClient, createAccount } from "./fixtures";

let held = 0;
let holes = 0;
const found: string[] = [];

function section(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

function check(label: string, blocked: boolean, detail = "") {
  if (blocked) {
    held += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    holes += 1;
    found.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  \x1b[31m✗ HOLE\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const admin = adminClient();
  const attacker = await createAccount("advance-attacker");
  const victim = await createAccount("advance-victim");

  const attackerClient = anonClient();
  await attackerClient.auth.setSession({
    access_token: attacker.session.access_token,
    refresh_token: attacker.session.refresh_token,
  });

  /** A real order belonging to the victim, written with the service role. */
  const { data: variant, error: variantError } = await admin
    .from("product_variants")
    .select("id, price_override, product_id")
    .gt("stock_quantity", 0)
    .limit(1)
    .maybeSingle();
  if (variantError || !variant) {
    throw new Error(`no variant to build a fixture from: ${variantError?.message}`);
  }

  const { data: victimOrder, error: orderError } = await admin
    .from("orders")
    .insert({
      user_id: victim.userId,
      status: "pending",
      payment_status: "unpaid",
      payment_method: "cod",
      subtotal: 500_000,
      shipping_fee: 34_900,
      cod_handling_fee: 15_000,
      grand_total: 534_900,
      advance_amount: 34_900,
      balance_due_on_delivery: 500_000,
      shipping_address: {
        recipientName: "Victim",
        phone: "9000000001",
        line1: "1 Test Street",
        line2: null,
        city: "Panaji",
        state: "Goa",
        postalCode: "403001",
        country: "IN",
      },
    })
    .select("id, order_number, advance_amount, balance_due_on_delivery")
    .single();
  if (orderError || !victimOrder) {
    throw new Error(`could not build the victim order: ${orderError?.message}`);
  }

  try {
    /* ═══ 1 · moving the split on somebody else's order ════════════════════ */
    section("1 · Another customer's advance and balance");

    for (const [label, patch] of [
      ["advance_amount", { advance_amount: 100 }],
      ["balance_due_on_delivery", { balance_due_on_delivery: 0 }],
      ["both at once", { advance_amount: 100, balance_due_on_delivery: 534_800 }],
      ["grand_total", { grand_total: 100 }],
      ["cash_collected_at", { cash_collected_at: new Date().toISOString() }],
      ["payment_status", { payment_status: "paid" as const }],
    ] as const) {
      const { error } = await attackerClient
        .from("orders")
        .update(patch)
        .eq("id", victimOrder.id);
      const { data: after, error: afterError } = await admin
        .from("orders")
        .select("advance_amount, balance_due_on_delivery, grand_total, payment_status, cash_collected_at")
        .eq("id", victimOrder.id)
        .single();
      const unchanged =
        afterError === null &&
        after?.advance_amount === 34_900 &&
        after?.balance_due_on_delivery === 500_000 &&
        after?.grand_total === 534_900 &&
        after?.payment_status === "unpaid" &&
        after?.cash_collected_at === null;
      check(
        `a customer cannot rewrite ${label} on an order that is not theirs`,
        unchanged,
        `error=${error?.code ?? "none"} advance=${after?.advance_amount}`,
      );
    }

    /* ═══ 2 · the same, on an order they do own ════════════════════════════ */
    section("2 · Their own order");

    const victimClient = anonClient();
    await victimClient.auth.setSession({
      access_token: victim.session.access_token,
      refresh_token: victim.session.refresh_token,
    });

    const { error: ownError } = await victimClient
      .from("orders")
      .update({ advance_amount: 100, balance_due_on_delivery: 534_800 })
      .eq("id", victimOrder.id);
    const { data: ownAfter, error: ownAfterError } = await admin
      .from("orders")
      .select("advance_amount, balance_due_on_delivery")
      .eq("id", victimOrder.id)
      .single();
    check(
      "owning an order does not permit rewriting what you owe on it",
      ownAfterError === null &&
        ownAfter?.advance_amount === 34_900 &&
        ownAfter?.balance_due_on_delivery === 500_000,
      `error=${ownError?.code ?? "none"} advance=${ownAfter?.advance_amount}`,
    );

    /* ═══ 3 · the function that decides the split ══════════════════════════ */
    section("3 · create_order_with_stock, called directly");

    const { error: rpcError } = await attackerClient.rpc(
      "create_order_with_stock",
      {
        p_cart_id: victimOrder.id,
        p_shipping_address: {},
        p_payment_method: "cod",
        p_initial_status: "confirmed",
        p_payment_status: "paid",
        p_shipping_flat_fee: 0,
        p_free_shipping_above: undefined,
        p_advance_amount: 100,
      },
    );
    check(
      "a customer cannot call create_order_with_stock at all",
      rpcError !== null,
      `error=${rpcError?.code ?? "NONE"}`,
    );

    /* ═══ 4 · the quote the order is priced from ═══════════════════════════ */
    section("4 · shipping_quotes, where the fee is stored");

    const { data: quoteRows, error: quoteReadError } = await attackerClient
      .from("shipping_quotes")
      .select("id")
      .limit(1);
    check(
      "a customer cannot read anybody's stored quote",
      quoteReadError !== null || (quoteRows?.length ?? 0) === 0,
      `error=${quoteReadError?.code ?? "none"} rows=${quoteRows?.length ?? 0}`,
    );

    const { error: quoteWriteError } = await attackerClient
      .from("shipping_quotes")
      .insert({
        cart_id: victimOrder.id,
        postal_code: "403001",
        payment_method: "cod",
        subtotal_paise: 500_000,
        fee_paise: 0,
        shipping_fee_paise: 0,
        cod_handling_paise: 0,
        deliverable: true,
        cod_available: true,
        source: "shiprocket",
      });
    check(
      "nor write themselves a free-delivery quote",
      quoteWriteError !== null,
      `error=${quoteWriteError?.code ?? "NONE"}`,
    );

    /* ═══ 5 · the settings the advance rule comes from ═════════════════════ */
    section("5 · The rule itself");

    /*
      **The row is unchanged**, asserted against what it actually holds rather
      than against a key that used to be in it.

      This check read back `cod_advance_minimum_paise === 9_900`. Phase 7
      replaced the advance rule entirely and deleted that key from
      `site_settings` on purpose — so against production's older row the check
      passed by reading a fossil, and against a rebuilt database it failed while
      the security property it names was perfectly intact.

      `admin-pages.ts` already learned this lesson and wrote it down: "A sentinel
      tests the property itself and cannot go stale with the schema." Same fix
      here. The property is that an attacker's write does not land, so the
      before-and-after of the whole row is the only thing worth comparing.
    */
    const { data: settingsBefore, error: beforeError } = await admin
      .from("site_settings")
      .select("value")
      .eq("key", "shipping")
      .single();
    if (beforeError) throw new Error(`could not read shipping: ${beforeError.message}`);

    const { error: settingsError } = await attackerClient
      .from("site_settings")
      .update({ value: { cod_advance_minimum_paise: 100 } })
      .eq("key", "shipping");

    const { data: settingsAfter, error: settingsAfterError } = await admin
      .from("site_settings")
      .select("value")
      .eq("key", "shipping")
      .single();
    const stillRight =
      settingsAfterError === null &&
      JSON.stringify(settingsAfter?.value) === JSON.stringify(settingsBefore?.value);
    check(
      "a customer cannot rewrite the settings the advance rule comes from",
      stillRight,
      `error=${settingsError?.code ?? "none"}, changed=${!stillRight}`,
    );

    /* ═══ 6 · the shipment, and what the courier is told to collect ════════ */
    section("6 · The COD collectable");

    const { error: shipmentError } = await attackerClient
      .from("shipments")
      .insert({
        order_id: victimOrder.id,
        status: "created",
        cod_collectable_amount: 0,
      });
    check(
      "a customer cannot invent a shipment collecting nothing",
      shipmentError !== null,
      `error=${shipmentError?.code ?? "NONE"}`,
    );

    /* ═══ 7 · the ledger that would show the tampering ═════════════════════ */
    section("7 · The audit trail");

    const { error: historyError } = await attackerClient
      .from("order_status_history")
      .insert({
        order_id: victimOrder.id,
        status: "delivered",
        note: "forged",
      });
    check(
      "a customer cannot forge a line on somebody's timeline",
      historyError !== null,
      `error=${historyError?.code ?? "NONE"}`,
    );
  } finally {
    const { error: cleanupError } = await admin
      .from("orders")
      .delete()
      .eq("id", victimOrder.id);
    if (cleanupError) {
      console.error(
        `  !! left a fixture order behind (${victimOrder.order_number}): ${cleanupError.message}`,
      );
    }
    await admin.auth.admin.deleteUser(attacker.userId).catch(() => {});
    await admin.auth.admin.deleteUser(victim.userId).catch(() => {});
  }

  console.log(
    `\n\x1b[1m${held} held, ${holes} holes\x1b[0m` +
      (found.length ? `\n\n${found.map((f) => `  · ${f}`).join("\n")}` : ""),
  );
  process.exit(holes > 0 ? 1 : 0);
}

void main();
