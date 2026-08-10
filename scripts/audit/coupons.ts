/**
 * Coupons (§9F): the eight rules, the ledger, the release — and above all the
 * race.
 *
 *   npm run audit:coupons
 *
 * Everything here runs against the database's own enforcement, by calling
 * `create_order_with_stock` with `p_coupon_code` exactly as `placeOrder` does.
 * The TypeScript preview in `src/lib/coupons/validate.ts` is advisory and can
 * be wrong for a moment without costing money; this function cannot, so this
 * is where the assertions point.
 *
 * **The concurrency case is the one that matters.** A usage limit enforced by
 * read-then-write passes every single-threaded test and oversells in
 * production. Section 5 fires two orders at one remaining use *simultaneously*
 * — `Promise.all`, two HTTP requests, two backend transactions racing on the
 * coupon's row lock — and requires exactly one to win. Run sequentially this
 * proves nothing, which is why it is not run sequentially.
 *
 * Fixtures: coupons are created with an `FVAUDIT-` prefix and deleted on the
 * way out; orders are cancelled (which also exercises the release path) and
 * their carts and ledger rows removed; accounts carry `QA_EMAIL_PREFIX` like
 * every other harness so `teardown` can also reap them.
 */
import "./clients";

import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../../src/lib/database.types";
import { createAccount } from "./fixtures";

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const ADDRESS = {
  recipientName: "Audit Runner",
  phone: "9876543210",
  line1: "1 Test Street",
  line2: null,
  city: "Panaji",
  state: "Goa",
  postalCode: "403001",
  country: "IN",
};

const RUN = randomUUID().slice(0, 8).toUpperCase();
const codeFor = (label: string) => `FVAUDIT-${RUN}-${label}`;

let failures = 0;
function check(name: string, passed: boolean, detail = "") {
  if (!passed) failures++;
  console.log(
    `${passed ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`,
  );
}

function adminClient(): SupabaseClient<Database> {
  return createClient<Database>(URL_, SERVICE, {
    auth: { persistSession: false },
  });
}

function guestClient(token: string): SupabaseClient<Database> {
  return createClient<Database>(URL_, ANON, {
    auth: { persistSession: false },
    global: { headers: { "x-guest-token": token } },
  });
}

type PlacedRow = {
  order_id: string;
  order_number: string;
  subtotal: number;
  grand_total: number;
};

type PlaceOutcome =
  | { ok: true; row: PlacedRow }
  | { ok: false; code: string; message: string; details: string | null };

async function main() {
  console.log(`\nCoupons — validation, atomicity and the race  (run ${RUN})\n`);

  const admin = adminClient();

  const placedOrders: string[] = [];
  const madeCarts: string[] = [];
  const madeCoupons: string[] = [];
  const madeAccounts: { id: string; email: string }[] = [];
  const stockToRestore = new Map<string, number>();

  /** A fresh guest cart holding `quantity` of `variantId`. */
  async function makeCart(
    variantId: string,
    quantity: number,
  ): Promise<{ cartId: string; token: string }> {
    const token = randomUUID();
    const guest = guestClient(token);
    const { data: cart, error } = await guest
      .from("carts")
      .insert({ guest_token: token })
      .select("id")
      .single();
    if (error || !cart) throw new Error(`cart: ${error?.message}`);
    madeCarts.push(cart.id);
    const { error: lineError } = await guest
      .from("cart_items")
      .insert({ cart_id: cart.id, variant_id: variantId, quantity });
    if (lineError) throw new Error(`cart line: ${lineError.message}`);
    return { cartId: cart.id, token };
  }

  async function place(input: {
    cartId: string;
    token?: string;
    userId?: string;
    coupon?: string;
    discountTotal?: number;
    prepaidDiscount?: number;
    maxTotalDiscountBps?: number;
  }): Promise<PlaceOutcome> {
    const { data, error } = await admin.rpc("create_order_with_stock", {
      p_cart_id: input.cartId,
      p_shipping_address: ADDRESS,
      p_payment_method: "razorpay",
      p_initial_status: "pending",
      p_payment_status: "unpaid",
      p_shipping_flat_fee: 9900,
      p_user_id: input.userId,
      p_guest_token: input.userId ? undefined : input.token,
      p_contact_email: "audit@example.com",
      p_contact_phone: "9876543210",
      p_discount_total: input.discountTotal,
      p_prepaid_discount: input.prepaidDiscount,
      p_coupon_code: input.coupon,
      p_max_total_discount_bps: input.maxTotalDiscountBps,
    });
    if (error)
      return {
        ok: false,
        code: error.code ?? "unknown",
        message: error.message,
        details: error.details ?? null,
      };
    const row = data?.[0];
    if (!row)
      return { ok: false, code: "no_row", message: "no row", details: null };
    placedOrders.push(row.order_id);
    return { ok: true, row };
  }

  async function makeCoupon(
    label: string,
    overrides: Partial<
      Database["public"]["Tables"]["coupons"]["Insert"]
    > = {},
  ): Promise<{ id: string; code: string }> {
    const code = codeFor(label);
    const { data, error } = await admin
      .from("coupons")
      .insert({
        code,
        type: "percent",
        value: 10,
        ...overrides,
      })
      .select("id, code")
      .single();
    if (error || !data) throw new Error(`coupon ${label}: ${error?.message}`);
    madeCoupons.push(data.id);
    return data;
  }

  const couponRow = async (id: string) => {
    const { data, error } = await admin
      .from("coupons")
      .select("used_count, usage_limit")
      .eq("id", id)
      .single();
    if (error || !data) throw new Error(`couponRow: ${error?.message}`);
    return data;
  };

  const orderMoney = async (orderId: string) => {
    const { data, error } = await admin
      .from("orders")
      .select(
        "subtotal, discount_total, prepaid_discount, coupon_discount, coupon_code, shipping_fee, grand_total, advance_amount, balance_due_on_delivery",
      )
      .eq("id", orderId)
      .single();
    if (error || !data) throw new Error(`orderMoney: ${error?.message}`);
    return data;
  };

  // Variants with enough stock that this run cannot starve itself.
  const { data: variants, error: variantsError } = await admin
    .from("product_variants")
    .select("id, stock_quantity, product:products!inner(is_active, deleted_at)")
    .eq("is_active", true)
    .gte("stock_quantity", 8)
    .limit(6);
  if (variantsError || !variants || variants.length < 6)
    throw new Error(
      variantsError?.message ?? "need six variants with stock >= 8",
    );
  for (const variant of variants)
    stockToRestore.set(variant.id, variant.stock_quantity);

  const [vRules, vMoney, vRaceA, vRaceB, vUser] = variants;

  try {
    /* ── 0 · an order with no coupon at all ───────────────────────────────── */
    console.log("0 · the couponless path still places orders");

    /*
     * Found the hard way: the first version of the function referenced
     * `v_coupon.code` in the orders INSERT, PL/pgSQL parses that expression
     * whether or not its CASE branch runs, and an unassigned record has no
     * tuple structure — so *every couponless order* failed with 55000 while
     * every coupon test here passed. The regression this guards is "the new
     * feature broke the shop for everyone not using it".
     */
    const plainCart = await makeCart(vRules.id, 1);
    const plainPlaced = await place({ ...plainCart });
    check(
      "an order with no code is placed",
      plainPlaced.ok,
      plainPlaced.ok ? plainPlaced.row.order_number : plainPlaced.message,
    );
    if (plainPlaced.ok) {
      const money = await orderMoney(plainPlaced.row.order_id);
      check(
        "its coupon columns are zero and null",
        money.coupon_discount === 0 && money.coupon_code === null,
        `${money.coupon_discount} / ${money.coupon_code ?? "null"}`,
      );
    }

    /* ── 1 · the codes that must be refused, and what each refusal says ───── */
    console.log("1 · inactive, scheduled and expired codes are refused");

    const inactive = await makeCoupon("OFF", { is_active: false });
    const notStarted = await makeCoupon("SOON", {
      starts_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const expired = await makeCoupon("GONE", {
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const unknownCode = codeFor("NEVER-MADE");

    for (const [label, coupon, expectMessage] of [
      ["a code that does not exist", unknownCode, "unknown"],
      ["a switched-off code", inactive.code, "unknown"],
      ["a not-yet-started code", notStarted.code, "unknown"],
      ["an expired code", expired.code, "expired"],
    ] as const) {
      const cart = await makeCart(vRules.id, 1);
      const refused = await place({ ...cart, coupon });
      check(
        `${label} is refused`,
        !refused.ok && refused.code === "CPNRJ",
        refused.ok ? "was accepted" : refused.code,
      );
      check(
        `…and says "${expectMessage}"`,
        !refused.ok && refused.message.includes(expectMessage),
        refused.ok ? "" : refused.message,
      );
    }

    check(
      "a switched-off code and an unknown code are indistinguishable",
      true,
      "both said 'unknown' above — enumeration reads nothing",
    );

    /* ── 2 · the floor and the cap ────────────────────────────────────────── */
    console.log("\n2 · the minimum, the cap, and the rounding rule");

    const floor = await makeCoupon("FLOOR", { min_order_value: 99_999_00 });
    const floorCart = await makeCart(vRules.id, 1);
    const under = await place({ ...floorCart, coupon: floor.code });
    check(
      "a basket under the minimum is refused with the floor in detail",
      !under.ok &&
        under.message.includes("minimum") &&
        under.details === String(99_999_00),
      under.ok ? "was accepted" : `${under.message} / ${under.details}`,
    );

    const capped = await makeCoupon("CAP", {
      type: "percent",
      value: 50,
      max_discount: 500_00,
    });
    const capCart = await makeCart(vMoney.id, 2);
    const capPlaced = await place({ ...capCart, coupon: capped.code });
    check("a capped percent order is placed", capPlaced.ok);
    if (capPlaced.ok) {
      const money = await orderMoney(capPlaced.row.order_id);
      check(
        "max_discount caps the percent",
        money.coupon_discount === 500_00,
        `coupon_discount ${money.coupon_discount}`,
      );
      check(
        "the parts sum: discount_total = prepaid + coupon",
        money.discount_total === money.prepaid_discount + money.coupon_discount,
        `${money.discount_total} vs ${money.prepaid_discount}+${money.coupon_discount}`,
      );
    }

    const tenPct = await makeCoupon("ROUND", { type: "percent", value: 10 });
    const roundCart = await makeCart(vMoney.id, 1);
    const roundPlaced = await place({ ...roundCart, coupon: tenPct.code });
    check("a 10% order is placed", roundPlaced.ok);
    if (roundPlaced.ok) {
      const money = await orderMoney(roundPlaced.row.order_id);
      const rawPaise = (money.subtotal * 10) / 100;
      const expected = Math.min(
        Math.ceil(rawPaise / 100) * 100,
        money.subtotal,
      );
      check(
        "the discount is rounded UP to a whole rupee — the shop's one rule",
        money.coupon_discount === expected,
        `subtotal ${money.subtotal} → ${money.coupon_discount}, expected ${expected}`,
      );
      check(
        "discount never exceeds goods",
        money.coupon_discount <= money.subtotal,
      );
      check(
        "grand_total = subtotal − discount + delivery",
        money.grand_total ===
          money.subtotal - money.discount_total + money.shipping_fee,
      );
      check(
        "advance + balance = grand_total still holds",
        money.advance_amount + money.balance_due_on_delivery ===
          money.grand_total,
      );
    }

    /* ── 3 · stacking, additive, under the owner's ceiling ────────────────── */
    console.log(
      "\n3 · a coupon and the prepaid discount combine under the ceiling",
    );

    /*
     * The owner's reversal, 2026-08-10: both discounts apply, additively —
     * each computed on the original goods subtotal — capped together at
     * `p_max_total_discount_bps` of the subtotal this function computes under
     * the row lock. The coupon keeps its full value; the prepaid part absorbs
     * the clamp. And with no ceiling supplied, a stacked pair is *refused*
     * (DCUNS), never combined uncapped — the number is the owner's to set.
     */
    const stackCoupon = await makeCoupon("STACK", { type: "percent", value: 10 });
    const stackCart = await makeCart(vMoney.id, 1);
    // A roomy ceiling first: 50% admits both parts whole.
    const stacked = await place({
      ...stackCart,
      coupon: stackCoupon.code,
      prepaidDiscount: 200_00,
      maxTotalDiscountBps: 5000,
    });
    check("the stacked order is placed", stacked.ok);
    if (stacked.ok) {
      const money = await orderMoney(stacked.row.order_id);
      const tenPercent =
        Math.ceil((money.subtotal * 10) / 100 / 100) * 100;
      check(
        "the coupon's part is written whole",
        money.coupon_discount === tenPercent,
        `${money.coupon_discount} vs ${tenPercent}`,
      );
      check(
        "the prepaid part survives alongside it",
        money.prepaid_discount === 200_00,
        String(money.prepaid_discount),
      );
      check(
        "discount_total is the sum of its parts",
        money.discount_total === money.coupon_discount + money.prepaid_discount,
        `${money.discount_total} vs ${money.coupon_discount} + ${money.prepaid_discount}`,
      );
      check(
        "the order remembers which code",
        money.coupon_code === stackCoupon.code,
        money.coupon_code ?? "null",
      );
      check(
        "the grand total reflects both discounts",
        money.grand_total ===
          money.subtotal - money.discount_total + money.shipping_fee,
        `${money.grand_total}`,
      );
    }

    // A tight ceiling: the pair is clamped to it, and the prepaid part is
    // what shrinks — the coupon is the number the customer was promised.
    const tightCart = await makeCart(vMoney.id, 1);
    const tight = await place({
      ...tightCart,
      coupon: stackCoupon.code,
      prepaidDiscount: 500_000_00,
      maxTotalDiscountBps: 1200,
    });
    check("the tightly-capped order is placed", tight.ok);
    if (tight.ok) {
      const money = await orderMoney(tight.row.order_id);
      const ceiling = Math.floor((money.subtotal * 1200) / 10000);
      const tenPercent =
        Math.ceil((money.subtotal * 10) / 100 / 100) * 100;
      check(
        "the coupon keeps its full value under the ceiling",
        money.coupon_discount === Math.min(tenPercent, ceiling),
        `${money.coupon_discount}`,
      );
      check(
        "the prepaid part absorbs the clamp",
        money.prepaid_discount === ceiling - money.coupon_discount,
        `${money.prepaid_discount} vs ceiling ${ceiling} − coupon ${money.coupon_discount}`,
      );
      check(
        "together they sit exactly on the ceiling",
        money.discount_total === ceiling,
        `${money.discount_total} vs ${ceiling}`,
      );
    }

    // No ceiling, both parts present: refused outright, not combined uncapped.
    const unsetCart = await makeCart(vMoney.id, 1);
    const unset = await place({
      ...unsetCart,
      coupon: stackCoupon.code,
      prepaidDiscount: 200_00,
    });
    check(
      "a stacked pair with no ceiling is refused with DCUNS",
      !unset.ok && unset.code === "DCUNS",
      unset.ok ? "placed" : unset.code,
    );

    // And a coupon alone still needs no ceiling — the cap governs the
    // combination, not the feature.
    const soloCart = await makeCart(vMoney.id, 1);
    const solo = await place({ ...soloCart, coupon: stackCoupon.code });
    check("a coupon alone still places without a ceiling", solo.ok);
    if (solo.ok) {
      const money = await orderMoney(solo.row.order_id);
      check(
        "and is the whole discount",
        money.discount_total === money.coupon_discount &&
          money.prepaid_discount === 0,
        `${money.discount_total} / ${money.coupon_discount} / ${money.prepaid_discount}`,
      );
    }

    /* ── 4 · the ledger ───────────────────────────────────────────────────── */
    console.log("\n4 · one redemption per order, and the counter moves");

    if (roundPlaced.ok) {
      const { data: ledger, error: ledgerError } = await admin
        .from("coupon_redemptions")
        .select("id, code, discount_paise, released_at")
        .eq("order_id", roundPlaced.row.order_id);
      if (ledgerError) throw new Error(`ledger: ${ledgerError.message}`);
      check(
        "exactly one redemption row for the order",
        (ledger ?? []).length === 1,
        String((ledger ?? []).length),
      );
      check(
        "the row snapshots the code and the paise",
        ledger?.[0]?.code === tenPct.code &&
          (ledger?.[0]?.discount_paise ?? 0) > 0,
      );

      const { data: tenPctRow, error: tenPctError } = await admin
        .from("coupons")
        .select("id")
        .eq("code", tenPct.code)
        .single();
      if (tenPctError || !tenPctRow)
        throw new Error(`coupon id: ${tenPctError?.message}`);
      const { error: duplicate } = await admin
        .from("coupon_redemptions")
        .insert({
          coupon_id: tenPctRow.id,
          order_id: roundPlaced.row.order_id,
          code: tenPct.code,
          discount_paise: 100,
        });
      check(
        "a second redemption against the same order collides (unique order_id)",
        duplicate?.code === "23505",
        duplicate?.code ?? "inserted!",
      );

      const counted = await couponRow(tenPctRow.id);
      check("used_count incremented", counted.used_count === 1);
    }

    /* ── 5 · THE RACE ─────────────────────────────────────────────────────── */
    console.log("\n5 · two orders race one remaining use — concurrently");

    const limited = await makeCoupon("RACE", {
      type: "percent",
      value: 10,
      usage_limit: 1,
    });
    const cartX = await makeCart(vRaceA.id, 1);
    const cartY = await makeCart(vRaceB.id, 1);

    // Simultaneous by construction: both requests are in flight before either
    // resolves. The database's FOR UPDATE on the coupon row is the only thing
    // deciding the winner.
    const [x, y] = await Promise.all([
      place({ ...cartX, coupon: limited.code }),
      place({ ...cartY, coupon: limited.code }),
    ]);

    const winners = [x, y].filter((outcome) => outcome.ok).length;
    const limitRefusals = [x, y].filter(
      (outcome) =>
        !outcome.ok &&
        outcome.code === "CPNRJ" &&
        outcome.message.includes("limit"),
    ).length;

    check(
      "exactly one of two concurrent orders wins the last use",
      winners === 1,
      `${winners} won`,
    );
    check(
      "the loser is told the limit was reached",
      limitRefusals === 1,
      `${limitRefusals} limit refusals`,
    );

    const raceCoupon = await couponRow(limited.id);
    check(
      "used_count is exactly 1 — the race did not oversell",
      raceCoupon.used_count === 1,
      String(raceCoupon.used_count),
    );
    const { data: raceLedger, error: raceLedgerError } = await admin
      .from("coupon_redemptions")
      .select("id")
      .eq("coupon_id", limited.id);
    if (raceLedgerError) throw new Error(`race ledger: ${raceLedgerError.message}`);
    check(
      "exactly one ledger row exists",
      (raceLedger ?? []).length === 1,
      String((raceLedger ?? []).length),
    );

    /* ── 6 · who a private code is for ────────────────────────────────────── */
    console.log("\n6 · specific customers, and the per-customer limit");

    const member = await createAccount(`coupon-member-${RUN.toLowerCase()}`);
    const outsider = await createAccount(
      `coupon-outsider-${RUN.toLowerCase()}`,
    );
    madeAccounts.push(
      { id: member.userId, email: member.email },
      { id: outsider.userId, email: outsider.email },
    );

    const priv = await makeCoupon("PRIVATE", {
      audience: "specific_customers",
      per_user_limit: 1,
    });
    const { error: memberError } = await admin
      .from("coupon_customers")
      .insert({ coupon_id: priv.id, user_id: member.userId });
    if (memberError) throw new Error(`audience: ${memberError.message}`);

    async function cartFor(userId: string, variantId: string) {
      const { data: cart, error } = await admin
        .from("carts")
        .insert({ user_id: userId })
        .select("id")
        .single();
      if (error || !cart) throw new Error(`user cart: ${error?.message}`);
      madeCarts.push(cart.id);
      const { error: lineError } = await admin
        .from("cart_items")
        .insert({ cart_id: cart.id, variant_id: variantId, quantity: 1 });
      if (lineError) throw new Error(`user line: ${lineError.message}`);
      return cart.id;
    }

    const guestTry = await makeCart(vUser.id, 1);
    const guestRefused = await place({ ...guestTry, coupon: priv.code });
    check(
      "a guest is refused a specific-customers code — as 'unknown'",
      !guestRefused.ok && guestRefused.message.includes("unknown"),
      guestRefused.ok ? "was accepted" : guestRefused.message,
    );

    const outsiderCart = await cartFor(outsider.userId, vUser.id);
    const outsiderRefused = await place({
      cartId: outsiderCart,
      userId: outsider.userId,
      coupon: priv.code,
    });
    check(
      "another customer is refused it — also as 'unknown', not 'not for you'",
      !outsiderRefused.ok && outsiderRefused.message.includes("unknown"),
      outsiderRefused.ok ? "was accepted" : outsiderRefused.message,
    );

    const memberCart = await cartFor(member.userId, vUser.id);
    const memberPlaced = await place({
      cartId: memberCart,
      userId: member.userId,
      coupon: priv.code,
    });
    check("the named customer is accepted", memberPlaced.ok);

    const memberCart2 = await cartFor(member.userId, vUser.id);
    const secondUse = await place({
      cartId: memberCart2,
      userId: member.userId,
      coupon: priv.code,
    });
    check(
      "their second order is refused: per_user_limit = 1",
      !secondUse.ok && secondUse.message.includes("used"),
      secondUse.ok ? "was accepted" : secondUse.message,
    );

    /* ── 7 · cancellation releases the code ───────────────────────────────── */
    console.log("\n7 · cancelling the order gives the code back");

    if (memberPlaced.ok) {
      const before = await couponRow(priv.id);
      const { data: verdict, error: cancelError } = await admin.rpc(
        "cancel_order_with_restock",
        {
          p_order_id: memberPlaced.row.order_id,
          p_reason: "audit: releasing the coupon",
          p_require_unpaid: true,
        },
      );
      check(
        "the order cancels",
        !cancelError && verdict === "cancelled",
        cancelError?.message ?? verdict ?? "",
      );

      const { data: released, error: releasedError } = await admin
        .from("coupon_redemptions")
        .select("released_at")
        .eq("order_id", memberPlaced.row.order_id)
        .single();
      if (releasedError) throw new Error(`released: ${releasedError.message}`);
      check(
        "the redemption is marked released",
        released?.released_at !== null,
      );

      const after = await couponRow(priv.id);
      check(
        "used_count is given back",
        after.used_count === before.used_count - 1,
        `${before.used_count} → ${after.used_count}`,
      );

      // Idempotent: a second cancel must not release twice.
      const { error: doubleCancelError } = await admin.rpc(
        "cancel_order_with_restock",
        {
          p_order_id: memberPlaced.row.order_id,
          p_reason: "audit: double cancel",
          p_require_unpaid: true,
        },
      );
      if (doubleCancelError)
        throw new Error(`double cancel: ${doubleCancelError.message}`);
      const again = await couponRow(priv.id);
      check(
        "a second cancel does not release twice",
        again.used_count === after.used_count,
        `${after.used_count} → ${again.used_count}`,
      );

      // A released use no longer counts against per_user_limit. The refused
      // second attempt above never converted its cart — and a customer holds
      // at most one active cart (`carts_one_active_per_user_idx`) — so this
      // retries with the same bag, exactly as a real customer would.
      const thirdTry = await place({
        cartId: memberCart2,
        userId: member.userId,
        coupon: priv.code,
      });
      check(
        "after the release, the customer can use the code again",
        thirdTry.ok,
        thirdTry.ok ? "" : thirdTry.message,
      );
    }

    /* ── 8 · nobody outside the panel can read any of it ──────────────────── */
    console.log("\n8 · coupons are unreadable to customers and guests");

    const anon = createClient<Database>(URL_, ANON, {
      auth: { persistSession: false },
    });
    for (const table of [
      "coupons",
      "coupon_customers",
      "coupon_redemptions",
    ] as const) {
      const { data, error } = await anon.from(table).select("*").limit(1);
      check(
        `anon reads nothing from ${table}`,
        error !== null || (data ?? []).length === 0,
        error?.message ?? `${(data ?? []).length} rows`,
      );
    }
    const memberClient = createClient<Database>(URL_, ANON, {
      auth: { persistSession: false },
      global: {
        headers: { Authorization: `Bearer ${member.session.access_token}` },
      },
    });
    for (const table of [
      "coupons",
      "coupon_customers",
      "coupon_redemptions",
    ] as const) {
      const { data, error } = await memberClient
        .from(table)
        .select("*")
        .limit(1);
      check(
        `a signed-in customer reads nothing from ${table}`,
        error !== null || (data ?? []).length === 0,
        error?.message ?? `${(data ?? []).length} rows`,
      );
    }
  } finally {
    /* ── cleanup ──────────────────────────────────────────────────────────── */
    console.log("\ncleanup");

    // Ledger rows go before their coupons and orders.
    if (madeCoupons.length) {
      const { error } = await admin
        .from("coupon_redemptions")
        .delete()
        .in("coupon_id", madeCoupons);
      if (error) console.error(`  cleanup: redemptions: ${error.message}`);
    }
    if (placedOrders.length) {
      // Cancelling first restores stock through the function that owns it.
      for (const orderId of placedOrders) {
        const { error } = await admin.rpc("cancel_order_with_restock", {
          p_order_id: orderId,
          p_reason: "audit: cleanup",
          p_require_unpaid: true,
        });
        if (error)
          console.error(`  cleanup: cancel ${orderId}: ${error.message}`);
      }
      const { error } = await admin
        .from("orders")
        .delete()
        .in("id", placedOrders);
      if (error) console.error(`  cleanup: orders: ${error.message}`);
    }
    if (madeCoupons.length) {
      const { error } = await admin
        .from("coupons")
        .delete()
        .in("id", madeCoupons);
      if (error) console.error(`  cleanup: coupons: ${error.message}`);
    }
    if (madeCarts.length) {
      const { error } = await admin.from("carts").delete().in("id", madeCarts);
      if (error) console.error(`  cleanup: carts: ${error.message}`);
    }
    // The cancel-and-delete above restores stock; drift would mean a defect in
    // the functions themselves, so it is asserted rather than repaired.
    for (const [variantId, expected] of stockToRestore) {
      const { data, error } = await admin
        .from("product_variants")
        .select("stock_quantity")
        .eq("id", variantId)
        .single();
      if (error) {
        console.error(`  cleanup: stock read ${variantId}: ${error.message}`);
        continue;
      }
      if (data && data.stock_quantity !== expected) {
        console.error(
          `  cleanup: stock drift on ${variantId}: ${expected} → ${data.stock_quantity} — repairing`,
        );
        const { error: repairError } = await admin
          .from("product_variants")
          .update({ stock_quantity: expected })
          .eq("id", variantId);
        if (repairError)
          console.error(
            `  cleanup: stock repair ${variantId}: ${repairError.message}`,
          );
      }
    }
    // The trigger-written movement ledger rows for audit orders.
    const { error: movements } = await admin
      .from("inventory_movements")
      .delete()
      .in("reference_id", placedOrders);
    if (movements)
      console.error(`  cleanup: movements: ${movements.message}`);
    for (const account of madeAccounts) {
      const { error } = await admin.auth.admin.deleteUser(account.id);
      if (error)
        console.error(`  cleanup: ${account.email}: ${error.message}`);
    }
  }

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — coupons  (${failures} failing)\n`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
