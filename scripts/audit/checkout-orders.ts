/**
 * Checkout, orders and idempotency — against the live database.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/audit/checkout-orders.ts
 *
 * The condition is not optional. `applyPaymentOutcome` and the admin client are
 * both `server-only`, and that package throws on import unless the resolver is
 * in React Server Component mode. Running without it fails immediately with a
 * message about Client Components, which is confusing rather than wrong.
 *
 * What this proves, in order:
 *
 *   1. A guest order is written whole — stock down, cart converted, snapshots
 *      taken, history started — or not at all.
 *   2. A guest reads their own order and nobody else reads it, by number or by
 *      id, signed in or not. Order numbers are sequential and therefore
 *      guessable, so this is the check that matters most in the file.
 *   3. One cart converts once. A double submit loses.
 *   4. Two customers, one unit: exactly one order exists afterwards.
 *   5. Cancelling restocks exactly once, however many times it is called.
 *   6. Ten deliveries of one webhook confirm one order once.
 *   7. Nobody but the service role can call the checkout functions, and nobody
 *      but an admin can read a payment row.
 *
 * Every read that should return nothing goes through `rows()`, so a *denial*
 * fails the run rather than masquerading as the empty result being asserted.
 *
 * It cleans up after itself: every order it writes is cancelled, restocked and
 * deleted, and stock levels are restored. The two throwaway sign-ups it needs
 * are left behind, same as scripts/audit/cart-merge.ts.
 */
// clients first, before any other import and before anything reads
// process.env: importing it repoints this process at staging and refuses to
// run against production. This file builds its own clients from .env.local and
// therefore wrote guest carts, orders, payments and stock movements into the
// LIVE shop every time it ran — the exact failure clients.ts exists to stop,
// caught in Phase 9 when a new migration was missing from the database the run
// was actually talking to. See scripts/audit/clients.ts.
import "./clients";
import { assertNotProduction } from "./clients";

assertNotProduction("run checkout-orders");

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../../src/lib/database.types";
import { applyPaymentOutcome } from "../../src/lib/orders/payment-state";
import { rows, maybeRow } from "../../src/lib/queries/run";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PASSWORD = "correct-horse-battery-staple-42";

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

let failures = 0;
function check(name: string, passed: boolean, detail = "") {
  if (!passed) failures++;
  console.log(
    `${passed ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`,
  );
}

function guestClient(token: string): SupabaseClient<Database> {
  return createClient<Database>(URL_, ANON, {
    auth: { persistSession: false },
    global: { headers: { "x-guest-token": token } },
  });
}

function adminClient(): SupabaseClient<Database> {
  return createClient<Database>(URL_, SERVICE, {
    auth: { persistSession: false },
  });
}

type Placed = { orderId: string; orderNumber: string; grandTotal: number };

/** What the checkout action does, minus the parts that need a request. */
async function placeOrderAs(
  admin: SupabaseClient<Database>,
  cartId: string,
  guestToken: string | null,
  userId: string | null,
  method: "cod" | "razorpay",
): Promise<
  | { ok: true; order: Placed }
  | { ok: false; code: string; details: string | null }
> {
  const { data, error } = await admin.rpc("create_order_with_stock", {
    p_cart_id: cartId,
    p_shipping_address: ADDRESS,
    p_payment_method: method,
    p_initial_status: method === "cod" ? "confirmed" : "pending",
    p_payment_status: "unpaid",
    p_shipping_flat_fee: 9900,
    p_free_shipping_above: 199900,
    p_user_id: userId ?? undefined,
    p_guest_token: guestToken ?? undefined,
    p_contact_email: "audit@example.com",
    p_contact_phone: "9876543210",
  });

  if (error)
    return {
      ok: false,
      code: error.code ?? "unknown",
      details: error.details ?? null,
    };
  const row = data?.[0];
  if (!row) return { ok: false, code: "no_row", details: null };
  return {
    ok: true,
    order: {
      orderId: row.order_id,
      orderNumber: row.order_number,
      grandTotal: row.grand_total,
    },
  };
}

async function main() {
  console.log("\nCheckout, orders and idempotency\n");

  const anon = createClient<Database>(URL_, ANON, {
    auth: { persistSession: false },
  });
  const admin = adminClient();
  const placedOrders: string[] = [];
  const stockToRestore = new Map<string, number>();
  /**
   * When this run began, so its own ledger artefacts can be told apart from a
   * genuine one. See the cleanup at the end of the file.
   */
  const runStartedAt = new Date().toISOString();
  const sweepCarts: string[] = [];
  const madeEventIds: string[] = [];
  const madeAccounts: { id: string; email: string }[] = [];

  const stockOf = async (variantId: string): Promise<number> => {
    const row = await maybeRow<{ stock_quantity: number }>(
      "stockOf",
      admin
        .from("product_variants")
        .select("stock_quantity")
        .eq("id", variantId)
        .maybeSingle(),
    );
    return row?.stock_quantity ?? -1;
  };

  const orderStatus = async (
    client: SupabaseClient<Database>,
    orderId: string,
  ): Promise<string> => {
    const row = await maybeRow<{ status: string }>(
      "orderStatus",
      client.from("orders").select("status").eq("id", orderId).maybeSingle(),
    );
    return row?.status ?? "missing";
  };

  // Seven, not three: the E-1 sweep, the E-2 race, the E-3 adoption and the
  // discount split each need a variant of their own, or one section's
  // decrements starve the next.
  const variants = await rows<{ id: string; stock_quantity: number }>(
    "pick variants",
    anon
      .from("product_variants")
      .select(
        "id, stock_quantity, product:products!inner(is_active, deleted_at)",
      )
      .eq("is_active", true)
      .gte("stock_quantity", 8)
      .limit(7)
      .overrideTypes<{ id: string; stock_quantity: number }[]>(),
  );
  if (variants.length < 7) throw new Error("need seven variants with stock >= 8");
  const [main1, contested, forWebhook, forSweep, forRace, forAdopt, forDiscount] =
    variants;

  /* ── 1 · a guest order is written whole ─────────────────────────────────── */
  const tokenA = randomUUID();
  const guestA = guestClient(tokenA);
  const cartA = await maybeRow<{ id: string }>(
    "guest A cart",
    guestA
      .from("carts")
      .insert({ guest_token: tokenA })
      .select("id")
      .maybeSingle(),
  );
  if (!cartA) throw new Error("no guest cart");
  const lineA = (
    await guestA
      .from("cart_items")
      .insert({ cart_id: cartA.id, variant_id: main1.id, quantity: 2 })
  ).error;
  if (lineA) throw new Error(`fill guest A: ${lineA.message}`);

  const placed = await placeOrderAs(admin, cartA.id, tokenA, null, "cod");
  check(
    "a guest order is placed",
    placed.ok,
    placed.ok ? placed.order.orderNumber : placed.code,
  );
  if (!placed.ok) throw new Error("cannot continue without an order");
  placedOrders.push(placed.order.orderId);

  const afterStock = await maybeRow<{ stock_quantity: number }>(
    "stock after",
    admin
      .from("product_variants")
      .select("stock_quantity")
      .eq("id", main1.id)
      .maybeSingle(),
  );
  check(
    "stock is decremented by exactly the quantity ordered",
    afterStock?.stock_quantity === main1.stock_quantity - 2,
    `${main1.stock_quantity} -> ${afterStock?.stock_quantity}`,
  );

  const cartAfter = await maybeRow<{ status: string }>(
    "cart after",
    admin.from("carts").select("status").eq("id", cartA.id).maybeSingle(),
  );
  check(
    "the cart is marked converted",
    cartAfter?.status === "converted",
    cartAfter?.status ?? "",
  );

  const snapshot = await rows<{
    product_name: string;
    sku: string;
    unit_price: number;
  }>(
    "order items",
    admin
      .from("order_items")
      .select("product_name, sku, unit_price")
      .eq("order_id", placed.order.orderId),
  );
  check(
    "the line is snapshotted with a name, a SKU and a price",
    snapshot.length === 1 &&
      !!snapshot[0].product_name &&
      !!snapshot[0].sku &&
      snapshot[0].unit_price > 0,
    JSON.stringify(snapshot[0] ?? null),
  );

  const zeroDiscount = await maybeRow<{ discount_total: number }>(
    "discount",
    admin
      .from("orders")
      .select("discount_total")
      .eq("id", placed.order.orderId)
      .maybeSingle(),
  );
  check(
    "discount is zero — nothing can move it this phase",
    zeroDiscount?.discount_total === 0,
  );

  /* ── 2 · only the owner reads it ────────────────────────────────────────── */
  const mine = await rows<{ id: string }>(
    "guest A reads their order",
    guestA
      .from("orders")
      .select("id")
      .eq("order_number", placed.order.orderNumber),
  );
  check(
    "the guest who placed it can read it",
    mine.length === 1,
    `${mine.length} rows`,
  );

  const myItems = await rows<{ id: string }>(
    "guest A reads their items",
    guestA
      .from("order_items")
      .select("id")
      .eq("order_id", placed.order.orderId),
  );
  check("and its items", myItems.length === 1, `${myItems.length} rows`);

  const myHistory = await rows<{ status: string }>(
    "guest A reads their history",
    guestA
      .from("order_status_history")
      .select("status")
      .eq("order_id", placed.order.orderId),
  );
  check(
    "and its history",
    myHistory.length === 1,
    myHistory.map((h) => h.status).join(","),
  );

  const guestB = guestClient(randomUUID());
  const byNumber = await rows<{ id: string }>(
    "guest B guesses the number",
    guestB
      .from("orders")
      .select("id")
      .eq("order_number", placed.order.orderNumber),
  );
  check(
    "another guest cannot read it by order number",
    byNumber.length === 0,
    `${byNumber.length} rows`,
  );

  const byId = await rows<{ id: string }>(
    "guest B knows the id",
    guestB.from("orders").select("id").eq("id", placed.order.orderId),
  );
  check("nor by id", byId.length === 0, `${byId.length} rows`);

  const itemsB = await rows<{ id: string }>(
    "guest B reads the items",
    guestB
      .from("order_items")
      .select("id")
      .eq("order_id", placed.order.orderId),
  );
  check("nor its items", itemsB.length === 0, `${itemsB.length} rows`);

  const historyB = await rows<{ id: string }>(
    "guest B reads the history",
    guestB
      .from("order_status_history")
      .select("id")
      .eq("order_id", placed.order.orderId),
  );
  check("nor its history", historyB.length === 0, `${historyB.length} rows`);

  const tokenless = await rows<{ id: string }>(
    "anon with no token",
    anon
      .from("orders")
      .select("id")
      .eq("order_number", placed.order.orderNumber),
  );
  check("nor an anonymous caller with no token at all", tokenless.length === 0);

  const email = `fv-checkout.${Date.now().toString(36)}@example.com`;
  const { data: signUp, error: signUpError } = await anon.auth.signUp({
    email,
    password: PASSWORD,
  });
  if (signUpError || !signUp.session)
    throw new Error(`signUp: ${signUpError?.message}`);
  madeAccounts.push({ id: signUp.session.user.id, email });
  const stranger = createClient<Database>(URL_, ANON, {
    auth: { persistSession: false },
    global: {
      headers: { Authorization: `Bearer ${signUp.session.access_token}` },
    },
  });
  const strangerRead = await rows<{ id: string }>(
    "a signed-in stranger",
    stranger
      .from("orders")
      .select("id")
      .eq("order_number", placed.order.orderNumber),
  );
  check(
    "nor a different, signed-in customer",
    strangerRead.length === 0,
    `${strangerRead.length} rows`,
  );

  /* ── 3 · one cart converts once ─────────────────────────────────────────── */
  const second = await placeOrderAs(admin, cartA.id, tokenA, null, "cod");
  check(
    "a second submit of the same cart is refused",
    !second.ok && second.code === "CNVRT",
    second.ok ? "it succeeded" : second.code,
  );
  const forThisCart = await rows<{ id: string }>(
    "orders for this cart",
    admin.from("orders").select("id").eq("cart_id", cartA.id),
  );
  check(
    "and exactly one order exists for it",
    forThisCart.length === 1,
    `${forThisCart.length}`,
  );

  /* ── 4 · two customers, one unit ────────────────────────────────────────── */
  stockToRestore.set(contested.id, contested.stock_quantity);
  const pinned = (
    await admin
      .from("product_variants")
      .update({ stock_quantity: 1 })
      .eq("id", contested.id)
  ).error;
  if (pinned) throw new Error(`pin stock: ${pinned.message}`);

  const racers = await Promise.all(
    [0, 1].map(async () => {
      const token = randomUUID();
      const client = guestClient(token);
      const cart = await maybeRow<{ id: string }>(
        "racer cart",
        client
          .from("carts")
          .insert({ guest_token: token })
          .select("id")
          .maybeSingle(),
      );
      if (!cart) throw new Error("no racer cart");
      const err = (
        await client
          .from("cart_items")
          .insert({ cart_id: cart.id, variant_id: contested.id, quantity: 1 })
      ).error;
      if (err) throw new Error(`fill racer: ${err.message}`);
      return { token, cartId: cart.id };
    }),
  );

  const raced = await Promise.all(
    racers.map((racer) =>
      placeOrderAs(admin, racer.cartId, racer.token, null, "cod"),
    ),
  );
  const winners = raced.filter((r) => r.ok);
  const losers = raced.filter((r) => !r.ok);
  for (const winner of winners)
    if (winner.ok) placedOrders.push(winner.order.orderId);

  check(
    "exactly one of two concurrent checkouts wins",
    winners.length === 1,
    `${winners.length} won`,
  );
  check(
    "the loser is told what sold out, by name and size",
    losers.length === 1 &&
      !losers[0].ok &&
      losers[0].code === "OSTCK" &&
      /productName/.test(losers[0].details ?? ""),
    losers[0] && !losers[0].ok
      ? `${losers[0].code} ${losers[0].details ?? ""}`
      : "",
  );
  const contestedAfter = await maybeRow<{ stock_quantity: number }>(
    "contested stock",
    admin
      .from("product_variants")
      .select("stock_quantity")
      .eq("id", contested.id)
      .maybeSingle(),
  );
  check(
    "and the unit is gone exactly once",
    contestedAfter?.stock_quantity === 0,
    `${contestedAfter?.stock_quantity}`,
  );

  /* ── 5 · cancelling restocks exactly once ───────────────────────────────── */
  const winner = winners[0];
  if (winner.ok) {
    const { data: first, error: firstError } = await admin.rpc(
      "cancel_order_with_restock",
      {
        p_order_id: winner.order.orderId,
        p_reason: "audit",
        p_require_unpaid: true,
        p_release_cart: false,
      },
    );
    if (firstError) throw new Error(`cancel: ${firstError.message}`);

    const { data: again, error: againError } = await admin.rpc(
      "cancel_order_with_restock",
      {
        p_order_id: winner.order.orderId,
        p_reason: "audit again",
        p_require_unpaid: true,
        p_release_cart: false,
      },
    );
    if (againError) throw new Error(`cancel again: ${againError.message}`);

    const restocked = await maybeRow<{ stock_quantity: number }>(
      "restocked",
      admin
        .from("product_variants")
        .select("stock_quantity")
        .eq("id", contested.id)
        .maybeSingle(),
    );
    check(
      "cancelling gives the unit back",
      first === "cancelled" && restocked?.stock_quantity === 1,
      `${first} / stock ${restocked?.stock_quantity}`,
    );
    check(
      "cancelling twice does not give it back twice",
      again === "already_cancelled" && restocked?.stock_quantity === 1,
      `${again} / stock ${restocked?.stock_quantity}`,
    );
  }

  /* ── 6 · ten deliveries of one webhook ──────────────────────────────────── */
  const tokenW = randomUUID();
  const guestW = guestClient(tokenW);
  const cartW = await maybeRow<{ id: string }>(
    "webhook cart",
    guestW
      .from("carts")
      .insert({ guest_token: tokenW })
      .select("id")
      .maybeSingle(),
  );
  if (!cartW) throw new Error("no webhook cart");
  const lineW = (
    await guestW
      .from("cart_items")
      .insert({ cart_id: cartW.id, variant_id: forWebhook.id, quantity: 1 })
  ).error;
  if (lineW) throw new Error(`fill webhook cart: ${lineW.message}`);

  const online = await placeOrderAs(admin, cartW.id, tokenW, null, "razorpay");
  if (!online.ok) throw new Error(`razorpay order: ${online.code}`);
  placedOrders.push(online.order.orderId);

  const providerOrderId = `order_audit_${randomUUID().slice(0, 12)}`;
  const paymentRow = (
    await admin.from("payments").insert({
      order_id: online.order.orderId,
      provider: "razorpay",
      provider_order_id: providerOrderId,
      amount: online.order.grandTotal,
      status: "created",
    })
  ).error;
  if (paymentRow) throw new Error(`payments row: ${paymentRow.message}`);

  const eventId = `evt_audit_${randomUUID().slice(0, 12)}`;
  madeEventIds.push(eventId);
  const deliveries = [];
  for (let i = 0; i < 10; i++) {
    deliveries.push(
      await applyPaymentOutcome({
        eventId,
        provider: "razorpay",
        providerOrderId,
        eventType: "payment.captured",
        outcome: {
          status: "captured",
          providerPaymentId: `pay_audit_${eventId}`,
          providerOrderId,
          amountPaise: online.order.grandTotal,
          rawStatus: "captured",
          message: null,
        },
      }),
    );
  }

  check(
    "the first delivery confirms the order",
    deliveries[0].applied === true,
    JSON.stringify(deliveries[0]),
  );
  check(
    "the other nine are duplicates",
    deliveries.slice(1).every((d) => !d.applied && d.reason === "duplicate"),
    deliveries
      .slice(1)
      .map((d) => (d.applied ? "applied" : d.reason))
      .join(","),
  );

  const settled = await maybeRow<{
    status: string;
    payment_status: string;
    stock_restored_at: string | null;
  }>(
    "order after the webhook storm",
    admin
      .from("orders")
      .select("status, payment_status, stock_restored_at")
      .eq("id", online.order.orderId)
      .maybeSingle(),
  );
  check(
    "the order is confirmed and paid, once",
    settled?.status === "confirmed" && settled?.payment_status === "paid",
    `${settled?.status}/${settled?.payment_status}`,
  );

  const stockOnce = await maybeRow<{ stock_quantity: number }>(
    "webhook variant stock",
    admin
      .from("product_variants")
      .select("stock_quantity")
      .eq("id", forWebhook.id)
      .maybeSingle(),
  );
  check(
    "stock moved exactly once across ten deliveries",
    stockOnce?.stock_quantity === forWebhook.stock_quantity - 1,
    `${forWebhook.stock_quantity} -> ${stockOnce?.stock_quantity}`,
  );

  const events = await rows<{ id: string; result: string | null }>(
    "event ledger",
    admin.from("payment_events").select("id, result").eq("event_id", eventId),
  );
  check(
    "one ledger row for one event",
    events.length === 1 && events[0].result === "applied",
    `${events.length} rows, result ${events[0]?.result}`,
  );

  const history = await rows<{ status: string }>(
    "history after capture",
    admin
      .from("order_status_history")
      .select("status")
      .eq("order_id", online.order.orderId),
  );
  check(
    "two history rows: placed, then confirmed",
    history.length === 2,
    history.map((h) => h.status).join(","),
  );

  /* ── 7 · abandoned orders give their units back (E-1) ───────────────────── */
  {
    // Security review E-1, high: stock is claimed when the order is written and
    // `payment.failed` deliberately does not cancel, so before the sweep existed
    // an anonymous visitor could take the shop out of stock by starting
    // checkouts and closing the tab. Two orders, one abandoned and one with an
    // authorised payment in flight — the sweep must free exactly the first.
    const tokenAb = randomUUID();
    const guestAb = guestClient(tokenAb);
    const cartAb = await maybeRow<{ id: string }>(
      "abandoned cart",
      guestAb
        .from("carts")
        .insert({ guest_token: tokenAb })
        .select("id")
        .maybeSingle(),
    );
    const tokenAuth = randomUUID();
    const guestAuth = guestClient(tokenAuth);
    const cartAuth = await maybeRow<{ id: string }>(
      "authorised cart",
      guestAuth
        .from("carts")
        .insert({ guest_token: tokenAuth })
        .select("id")
        .maybeSingle(),
    );
    if (!cartAb || !cartAuth) throw new Error("no sweep carts");
    sweepCarts.push(cartAb.id, cartAuth.id);

    const beforeSweep = await stockOf(forSweep.id);
    for (const cart of [cartAb.id, cartAuth.id]) {
      const err = (
        await admin
          .from("cart_items")
          .insert({ cart_id: cart, variant_id: forSweep.id, quantity: 1 })
      ).error;
      if (err) throw new Error(`fill sweep cart: ${err.message}`);
    }

    const abandoned = await placeOrderAs(
      admin,
      cartAb.id,
      tokenAb,
      null,
      "razorpay",
    );
    const inFlight = await placeOrderAs(
      admin,
      cartAuth.id,
      tokenAuth,
      null,
      "razorpay",
    );
    if (!abandoned.ok || !inFlight.ok)
      throw new Error("could not place the sweep orders");
    placedOrders.push(abandoned.order.orderId, inFlight.order.orderId);

    // Money committed but not settled. This one must survive the sweep.
    const authRow = (
      await admin.from("payments").insert({
        order_id: inFlight.order.orderId,
        provider: "razorpay",
        provider_order_id: `order_auth_${randomUUID().slice(0, 12)}`,
        amount: inFlight.order.grandTotal,
        status: "pending",
      })
    ).error;
    if (authRow) throw new Error(`authorised payment row: ${authRow.message}`);

    const heldBoth = await stockOf(forSweep.id);
    check(
      "two unpaid online orders hold two units (so the sweep has something to free)",
      heldBoth === beforeSweep - 2,
      `${beforeSweep} -> ${heldBoth}`,
    );

    // Inside the window: nothing is stale yet, so nothing may move.
    const { data: freedEarly, error: earlyError } = await admin.rpc(
      "release_abandoned_orders",
    );
    if (earlyError) throw new Error(`early sweep: ${earlyError.message}`);
    check(
      "a fresh order is inside the window and is left alone",
      freedEarly === 0 && (await stockOf(forSweep.id)) === heldBoth,
      `freed ${freedEarly}`,
    );

    const backdated = (
      await admin
        .from("orders")
        .update({
          placed_at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
        })
        .in("id", [abandoned.order.orderId, inFlight.order.orderId])
    ).error;
    if (backdated) throw new Error(`backdate: ${backdated.message}`);

    const { data: freed, error: sweepError } = await admin.rpc(
      "release_abandoned_orders",
    );
    if (sweepError) throw new Error(`sweep: ${sweepError.message}`);

    const abandonedRow = await orderStatus(admin, abandoned.order.orderId);
    const inFlightRow = await orderStatus(admin, inFlight.order.orderId);
    const afterSweep = await stockOf(forSweep.id);

    check(
      "a six-hour-old unpaid order is cancelled and gives its unit back",
      freed === 1 && abandonedRow === "cancelled",
      `freed ${freed}, order ${abandonedRow}`,
    );
    check(
      "an order with an authorised payment in flight is never swept",
      inFlightRow === "pending",
      `${inFlightRow}`,
    );
    check(
      "exactly one unit came back, not both",
      afterSweep === beforeSweep - 1,
      `${beforeSweep} -> ${heldBoth} -> ${afterSweep}`,
    );

    const { data: freedAgain, error: againError } = await admin.rpc(
      "release_abandoned_orders",
    );
    if (againError) throw new Error(`second sweep: ${againError.message}`);
    check(
      "sweeping twice frees nothing the second time",
      freedAgain === 0 && (await stockOf(forSweep.id)) === afterSweep,
      `freed ${freedAgain}`,
    );

    const { error: sweepAnon } = await anon.rpc("release_abandoned_orders");
    check(
      "anon cannot call release_abandoned_orders",
      !!sweepAnon,
      sweepAnon?.code ?? "no error",
    );
  }

  /* ── 8 · a capture racing a cancellation (E-2) ──────────────────────────── */
  {
    // Security review E-2: `applyPaymentOutcome` read the order, then wrote it,
    // with no guard on what it had read. A cancellation committing in the gap
    // was silently overwritten, leaving a *confirmed, paid* order whose units
    // were already back on the shelf. The invariant below is the one that must
    // never break: a live order never carries stock_restored_at.
    // Spread across the window Agent E measured through the HTTP route (the
    // lost update landed at 200-225ms there); in-process the gap is shorter, so
    // the sweep covers both.
    const raceDelays = [0, 40, 90, 150, 220, 300];
    const observed: string[] = [];
    let live = 0;

    for (let i = 0; i < raceDelays.length; i++) {
      const token = randomUUID();
      const client = guestClient(token);
      const cart = await maybeRow<{ id: string }>(
        "race cart",
        client
          .from("carts")
          .insert({ guest_token: token })
          .select("id")
          .maybeSingle(),
      );
      if (!cart) throw new Error("no race cart");
      sweepCarts.push(cart.id);
      const fill = (
        await client
          .from("cart_items")
          .insert({ cart_id: cart.id, variant_id: forRace.id, quantity: 1 })
      ).error;
      if (fill) throw new Error(`fill race cart: ${fill.message}`);

      const order = await placeOrderAs(admin, cart.id, token, null, "razorpay");
      if (!order.ok) throw new Error(`race order: ${order.code}`);
      placedOrders.push(order.order.orderId);

      const providerOrderId = `order_race_${randomUUID().slice(0, 12)}`;
      const payRow = (
        await admin.from("payments").insert({
          order_id: order.order.orderId,
          provider: "razorpay",
          provider_order_id: providerOrderId,
          amount: order.order.grandTotal,
          status: "created",
        })
      ).error;
      if (payRow) throw new Error(`race payment row: ${payRow.message}`);

      const raceEventId = `evt_race_${randomUUID().slice(0, 12)}`;
      madeEventIds.push(raceEventId);

      const capture = applyPaymentOutcome({
        eventId: raceEventId,
        provider: "razorpay",
        providerOrderId,
        eventType: "payment.captured",
        outcome: {
          status: "captured",
          providerPaymentId: `pay_race_${randomUUID().slice(0, 10)}`,
          providerOrderId,
          amountPaise: order.order.grandTotal,
          rawStatus: "captured",
          message: null,
        },
      }).catch(() => null);

      await new Promise((resolve) => setTimeout(resolve, raceDelays[i]));
      const cancelling = (async () => {
        const { error } = await admin.rpc("cancel_order_with_restock", {
          p_order_id: order.order.orderId,
          p_reason: "audit: abandoned mid-capture",
          p_require_unpaid: true,
          p_release_cart: false,
        });
        if (error) console.error(`  race cancel failed: ${error.message}`);
      })();
      await Promise.all([capture, cancelling]);

      const row = await maybeRow<{
        status: string;
        payment_status: string;
        stock_restored_at: string | null;
      }>(
        "order after the race",
        admin
          .from("orders")
          .select("status, payment_status, stock_restored_at")
          .eq("id", order.order.orderId)
          .maybeSingle(),
      );
      observed.push(
        `${raceDelays[i]}ms:${row?.status}/${row?.payment_status}${row?.stock_restored_at ? "+restocked" : ""}`,
      );
      if (row && row.status !== "cancelled" && row.stock_restored_at !== null)
        live++;
    }

    check(
      "no cancel-vs-capture race leaves a live order whose stock has been given back",
      live === 0,
      observed.join(" "),
    );
  }

  /* ── 9 · signing in keeps the order (E-3) ───────────────────────────────── */
  {
    // Security review E-3: accepting the confirmation page's own offer to create
    // an account used to destroy the customer's access to the order they had
    // just paid for. Adoption is what makes that offer honest.
    const tokenG = randomUUID();
    const guestG = guestClient(tokenG);
    const cartG = await maybeRow<{ id: string }>(
      "adoption cart",
      guestG
        .from("carts")
        .insert({ guest_token: tokenG })
        .select("id")
        .maybeSingle(),
    );
    if (!cartG) throw new Error("no adoption cart");
    sweepCarts.push(cartG.id);
    const fillG = (
      await guestG
        .from("cart_items")
        .insert({ cart_id: cartG.id, variant_id: forAdopt.id, quantity: 1 })
    ).error;
    if (fillG) throw new Error(`fill adoption cart: ${fillG.message}`);

    const guestOrder = await placeOrderAs(admin, cartG.id, tokenG, null, "cod");
    if (!guestOrder.ok) throw new Error(`adoption order: ${guestOrder.code}`);
    placedOrders.push(guestOrder.order.orderId);

    const emailG = `fv-adopt.${Date.now().toString(36)}@example.com`;
    const { data: signUpG, error: signUpGError } = await anon.auth.signUp({
      email: emailG,
      password: PASSWORD,
    });
    if (signUpGError || !signUpG.session)
      throw new Error(`adoption signUp: ${signUpGError?.message}`);
    madeAccounts.push({ id: signUpG.session.user.id, email: emailG });

    // Exactly the client /auth/callback holds: the new session *and* the guest
    // header it was constructed with.
    const callback = createClient<Database>(URL_, ANON, {
      auth: { persistSession: false },
      global: {
        headers: {
          Authorization: `Bearer ${signUpG.session.access_token}`,
          "x-guest-token": tokenG,
        },
      },
    });

    // A stranger holding a *different* token must not be able to take it first.
    const thiefEmail = `fv-thief.${Date.now().toString(36)}@example.com`;
    const { data: thief } = await anon.auth.signUp({
      email: thiefEmail,
      password: PASSWORD,
    });
    if (thief?.session) {
      madeAccounts.push({ id: thief.session.user.id, email: thiefEmail });
      const thiefClient = createClient<Database>(URL_, ANON, {
        auth: { persistSession: false },
        global: {
          headers: {
            Authorization: `Bearer ${thief.session.access_token}`,
            "x-guest-token": randomUUID(),
          },
        },
      });
      const { data: stolen, error: thiefError } =
        await thiefClient.rpc("adopt_guest_orders");
      check(
        "another account carrying its own token adopts nothing",
        !thiefError && stolen === 0,
        thiefError ? (thiefError.code ?? "error") : `${stolen} adopted`,
      );
    }

    const { data: adopted, error: adoptError } =
      await callback.rpc("adopt_guest_orders");
    check(
      "adopt_guest_orders moves the guest's order to the account",
      !adoptError && adopted === 1,
      adoptError ? adoptError.message : `${adopted} adopted`,
    );

    const asAccount = createClient<Database>(URL_, ANON, {
      auth: { persistSession: false },
      global: {
        headers: { Authorization: `Bearer ${signUpG.session.access_token}` },
      },
    });
    const owned = await rows<{ id: string; guest_token: string | null }>(
      "the account's orders after adoption",
      asAccount
        .from("orders")
        .select("id, guest_token")
        .eq("id", guestOrder.order.orderId),
    );
    check(
      "the customer can read it with no guest cookie at all",
      owned.length === 1 && owned[0].guest_token === null,
      `${owned.length} rows, token ${owned[0]?.guest_token ?? "null"}`,
    );

    const staleToken = await rows<{ id: string }>(
      "the old token after adoption",
      guestClient(tokenG)
        .from("orders")
        .select("id")
        .eq("id", guestOrder.order.orderId),
    );
    check(
      "and the retired token reads nothing",
      staleToken.length === 0,
      `${staleToken.length} rows`,
    );

    const { data: again, error: againAdoptError } =
      await callback.rpc("adopt_guest_orders");
    check(
      "adopting twice is a no-op",
      !againAdoptError && again === 0,
      againAdoptError ? againAdoptError.message : `${again}`,
    );
  }

  /* ── 10 · nobody else can reach any of it ───────────────────────────────── */
  const paymentsAnon = await rows<{ id: string }>(
    "anon reads payments",
    anon.from("payments").select("id").eq("order_id", online.order.orderId),
  );
  check(
    "anon reads zero payment rows",
    paymentsAnon.length === 0,
    `${paymentsAnon.length}`,
  );

  const eventsUser = await rows<{ id: string }>(
    "a customer reads the event ledger",
    stranger.from("payment_events").select("id"),
  );
  check(
    "a signed-in customer reads zero payment events",
    eventsUser.length === 0,
    `${eventsUser.length}`,
  );

  // These three read `error` and nothing else: being refused *is* the result.
  const { error: rpcAnonError } = await anon.rpc("create_order_with_stock", {
    p_cart_id: cartA.id,
    p_shipping_address: ADDRESS,
    p_payment_method: "cod",
    p_initial_status: "confirmed",
    p_payment_status: "unpaid",
    p_shipping_flat_fee: 0,
    p_free_shipping_above: 0,
  });
  check(
    "anon cannot call create_order_with_stock",
    !!rpcAnonError,
    rpcAnonError?.code ?? "no error",
  );

  const { error: cancelUserError } = await stranger.rpc(
    "cancel_order_with_restock",
    {
      p_order_id: online.order.orderId,
      p_reason: "attack",
    },
  );
  check(
    "a customer cannot call cancel_order_with_restock",
    !!cancelUserError,
    cancelUserError?.code ?? "no error",
  );

  const { error: guardUserError } = await stranger.rpc("assert_cart_stock", {
    p_cart_id: cartA.id,
  });
  check(
    "a customer cannot call assert_cart_stock",
    !!guardUserError,
    guardUserError?.code ?? "no error",
  );

  /* ── 11 · the discount split is recorded, and it adds up ────────────────── */
  /*
    9E's database half. The display half is `audit:checkout-discount`, in a
    browser; this is the assertion that the *row* carries the reason money came
    off, because four surfaces read the order back long after the checkout that
    produced it and none of them can infer a prepaid incentive from
    `discount_total` alone.

    `p_prepaid_discount` is passed larger than it should be on purpose in the
    second case. The function clamps it inside `p_discount_total` under the row
    lock, which is what makes `orders_prepaid_discount_within_total`
    unreachable from the checkout rather than merely unlikely — and a CHECK
    violation there is a customer seeing "something went wrong" after their
    stock has already been claimed.
  */
  {
    const tokenD = randomUUID();
    const guestD = guestClient(tokenD);
    const cartD = await maybeRow<{ id: string }>(
      "discount cart",
      guestD
        .from("carts")
        .insert({ guest_token: tokenD })
        .select("id")
        .maybeSingle(),
    );
    if (!cartD) throw new Error("no discount cart");
    const lineD = (
      await guestD
        .from("cart_items")
        .insert({ cart_id: cartD.id, variant_id: forDiscount.id, quantity: 1 })
    ).error;
    if (lineD) throw new Error(`fill discount cart: ${lineD.message}`);

    const DISCOUNT = 25_000;
    const PREPAID = 25_000;
    const { data: madeRows, error: madeError } = await admin.rpc(
      "create_order_with_stock",
      {
        p_cart_id: cartD.id,
        p_shipping_address: ADDRESS,
        p_payment_method: "razorpay",
        p_initial_status: "pending",
        p_payment_status: "unpaid",
        p_shipping_flat_fee: 9_900,
        p_guest_token: tokenD,
        p_contact_email: "audit@example.com",
        p_contact_phone: "9876543210",
        p_discount_total: DISCOUNT,
        p_prepaid_discount: PREPAID,
      },
    );
    check(
      "an order with a prepaid discount is placed",
      !madeError && !!madeRows?.[0],
      madeError?.message ?? "",
    );
    const made = madeRows?.[0];
    if (made) {
      placedOrders.push(made.order_id);
      const row = await maybeRow<{
        subtotal: number;
        discount_total: number;
        prepaid_discount: number;
        shipping_fee: number;
        grand_total: number;
        advance_amount: number;
        balance_due_on_delivery: number;
      }>(
        "discounted order",
        admin
          .from("orders")
          .select(
            "subtotal, discount_total, prepaid_discount, shipping_fee, grand_total, advance_amount, balance_due_on_delivery",
          )
          .eq("id", made.order_id)
          .maybeSingle(),
      );
      check(
        "the discount is stored, not just applied",
        row?.discount_total === DISCOUNT,
        String(row?.discount_total),
      );
      check(
        "and so is the part of it that was for paying online",
        row?.prepaid_discount === PREPAID && (row?.prepaid_discount ?? 0) > 0,
        String(row?.prepaid_discount),
      );
      check(
        "subtotal − discount + delivery = grand total",
        !!row &&
          row.subtotal - row.discount_total + row.shipping_fee ===
            row.grand_total,
        row
          ? `${row.subtotal} − ${row.discount_total} + ${row.shipping_fee} ≠ ${row.grand_total}`
          : "no row",
      );
      check(
        "advance + balance = grand total, unchanged by any of this",
        !!row &&
          row.advance_amount + row.balance_due_on_delivery === row.grand_total,
        row ? `${row.advance_amount} + ${row.balance_due_on_delivery}` : "no row",
      );
    }

    // The clamp: a prepaid part larger than the whole is held inside it rather
    // than raising a constraint violation at the customer.
    const tokenE = randomUUID();
    const guestE = guestClient(tokenE);
    const cartE = await maybeRow<{ id: string }>(
      "clamp cart",
      guestE
        .from("carts")
        .insert({ guest_token: tokenE })
        .select("id")
        .maybeSingle(),
    );
    if (cartE) {
      const lineE = (
        await guestE
          .from("cart_items")
          .insert({ cart_id: cartE.id, variant_id: forDiscount.id, quantity: 1 })
      ).error;
      if (lineE) throw new Error(`fill clamp cart: ${lineE.message}`);
      const { data: clampRows, error: clampError } = await admin.rpc(
        "create_order_with_stock",
        {
          p_cart_id: cartE.id,
          p_shipping_address: ADDRESS,
          p_payment_method: "razorpay",
          p_initial_status: "pending",
          p_payment_status: "unpaid",
          p_shipping_flat_fee: 9_900,
          p_guest_token: tokenE,
          p_contact_email: "audit@example.com",
          p_contact_phone: "9876543210",
          p_discount_total: 10_000,
          p_prepaid_discount: 999_999,
        },
      );
      check(
        "a prepaid part larger than the discount does not raise a constraint",
        !clampError,
        clampError?.message ?? "",
      );
      const clamped = clampRows?.[0];
      if (clamped) {
        placedOrders.push(clamped.order_id);
        const row = await maybeRow<{
          discount_total: number;
          prepaid_discount: number;
        }>(
          "clamped order",
          admin
            .from("orders")
            .select("discount_total, prepaid_discount")
            .eq("id", clamped.order_id)
            .maybeSingle(),
        );
        check(
          "it is clamped to the discount it is part of",
          row?.prepaid_discount === row?.discount_total &&
            row?.prepaid_discount === 10_000,
          `${row?.prepaid_discount} of ${row?.discount_total}`,
        );
      }
    }
  }

  /* ── cleanup ────────────────────────────────────────────────────────────── */
  for (const orderId of placedOrders) {
    // Cancel first so the units go back, then delete the row; order_items and
    // order_status_history cascade.
    const undone = (
      await admin.rpc("cancel_order_with_restock", {
        p_order_id: orderId,
        p_reason: "audit cleanup",
        p_release_cart: false,
      })
    ).error;
    if (undone)
      console.error(
        `  cleanup: could not cancel ${orderId}: ${undone.message}`,
      );

    const removed = (await admin.from("orders").delete().eq("id", orderId))
      .error;
    if (removed)
      console.error(
        `  cleanup: could not delete order ${orderId}: ${removed.message}`,
      );
  }
  for (const [variantId, stock] of stockToRestore) {
    const restored = (
      await admin
        .from("product_variants")
        .update({ stock_quantity: stock })
        .eq("id", variantId)
    ).error;
    if (restored)
      console.error(`  cleanup: could not restore stock for ${variantId}`);
  }

  /**
   * Remove the ledger rows this suite's own fixtures produced.
   *
   * Setting a variant's stock directly — which is how the contested-stock case
   * is set up — trips the movement trigger with none of the `app.inventory_*`
   * GUCs set, so it records `unspecified` with no actor and no reference. The
   * quantity is restored above, so nothing *drifts*; but `reconcile_inventory()`
   * reports unattributed rows as well as drift, and it is right to. The result
   * was that running this suite made `audit:admin` fail afterwards — and since
   * `npm run audit` runs checkout before admin, the full suite could never go
   * green.
   *
   * Deleting them is the honest repair rather than loosening the check: they are
   * artefacts of the harness, not of the shop, and the ledger is left exactly as
   * this run found it. Scoped to rows created since this run began, so a real
   * unattributed movement from before it is never touched.
   */
  const artefacts = (
    await admin
      .from("inventory_movements")
      .delete()
      .eq("reason", "unspecified")
      .gte("created_at", runStartedAt)
  ).error;
  if (artefacts)
    console.error(`  cleanup: could not clear fixture movements: ${artefacts.message}`);
  const carts = (
    await admin
      .from("carts")
      .delete()
      .in("id", [cartA.id, cartW.id, ...racers.map((r) => r.cartId)])
  ).error;
  if (carts)
    console.error(
      `  cleanup: could not delete the test carts: ${carts.message}`,
    );

  if (sweepCarts.length > 0) {
    const extra = (await admin.from("carts").delete().in("id", sweepCarts))
      .error;
    if (extra)
      console.error(
        `  cleanup: could not delete the sweep/race carts: ${extra.message}`,
      );
  }

  // payment_events deliberately has no foreign key to orders — an event for an
  // order we cannot resolve still has to be recordable — so deleting the order
  // leaves the ledger row behind. Swept explicitly rather than by cascade.
  const ledger = (
    await admin.from("payment_events").delete().in("event_id", madeEventIds)
  ).error;
  if (ledger)
    console.error(
      `  cleanup: could not delete the test events: ${ledger.message}`,
    );

  // The throwaway sign-ups go too. Leaving them was a documented wart in the
  // first version of this file and Agent E's suite showed it is avoidable: the
  // service role can delete an auth user, and a harness that litters is a
  // harness somebody eventually stops running.
  let deleted = 0;
  for (const account of madeAccounts) {
    const { error } = await admin.auth.admin.deleteUser(account.id);
    if (error)
      console.error(
        `  cleanup: could not delete ${account.email}: ${error.message}`,
      );
    else deleted++;
  }

  console.log(
    `\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`,
  );
  console.log(
    `  accounts created ${madeAccounts.length}, deleted ${deleted}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
