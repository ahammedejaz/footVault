/**
 * Adversarial checks on checkout, orders and payments — Agent E.
 *
 *   RAZORPAY_WEBHOOK_SECRET=<the value your server was started with> \
 *   FV_BASE_URL=http://localhost:3491 \
 *   npm run audit:security
 *
 * This is the regression suite for `claudeExecutionReport/phase-5-security-review.md`.
 * It differs from `scripts/audit/checkout-orders.ts` in two ways that matter.
 *
 *   **It goes through the real webhook route over HTTP.** Agent B's harness
 *   calls `applyPaymentOutcome` directly, which skips the pre-claim in
 *   `recordAndApply` and the signature check in the adapter — that is, it skips
 *   the two things an attacker actually meets. Everything here posts to
 *   `/api/payments/razorpay/webhook` with a real HMAC, so the seam between the
 *   two idempotency schemes is exercised the way Razorpay exercises it.
 *
 *   **It re-implements the HMAC rather than importing `verifyHexSignature`.** A
 *   test that signs with the code under test proves the code agrees with itself.
 *   `node:crypto` is used directly below, so a change to the signing message
 *   fails this file.
 *
 * Nothing here writes feature code. It reads, it attacks, and it cleans up:
 * every order is cancelled, restocked and deleted, every cart and ledger row is
 * removed, every pinned stock level is put back, and the throwaway accounts are
 * deleted through the admin API. The counts are printed at the end so the sweep
 * can be checked rather than believed.
 *
 * A check that could not run prints SKIP and fails the suite. "I could not test
 * this" is a result, not a pass.
 */
import { readFileSync } from "node:fs";
import { createHmac, randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../../src/lib/database.types";
import { rows, maybeRow } from "../../src/lib/queries/run";
import { checkoutSchema } from "../../src/lib/validations/checkout";

/* ------------------------------------------------------------------ setup -- */

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
// Defaults to the same port the rest of the suite uses (scripts/audit/routes.ts)
// rather than the ephemeral one this file was written against. A default that
// nothing is listening on turns thirteen HTTP checks into SKIPs, and a SKIP is
// only honest if somebody reads it — the harness counts them as failures for
// exactly that reason, but the right fix is to point at a port that exists.
const BASE = (process.env.FV_BASE_URL ?? "http://localhost:3210").replace(
  /\/$/,
  "",
);
const WEBHOOK_SECRET = (process.env.RAZORPAY_WEBHOOK_SECRET ?? "").trim();
const PASSWORD = "correct-horse-battery-staple-42";
const GUEST_COOKIE = "fv_guest";

const ADDRESS = {
  recipientName: "Security Runner",
  phone: "9876543210",
  line1: "1 Adversary Lane",
  line2: null,
  city: "Panaji",
  state: "Goa",
  postalCode: "403001",
  country: "IN",
};

let failures = 0;
let skipped = 0;

function check(name: string, passed: boolean, detail = "") {
  if (!passed) failures++;
  console.log(
    `${passed ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`,
  );
}

/** A check that could not run. Counts against the suite, loudly. */
function skip(name: string, why: string) {
  skipped++;
  failures++;
  console.log(`  SKIP  ${name}  — ${why}`);
}

function section(title: string) {
  console.log(`\n${title}`);
}

function guestClient(token: string): SupabaseClient<Database> {
  return createClient<Database>(URL_, ANON, {
    auth: { persistSession: false },
    global: { headers: { "x-guest-token": token } },
  });
}

function bearerClient(accessToken: string): SupabaseClient<Database> {
  return createClient<Database>(URL_, ANON, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/* ------------------------------------------------------------- the webhook -- */

/** Razorpay signs the exact bytes it sends. So does this. */
function sign(rawBody: string): string {
  return createHmac("sha256", WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("hex");
}

type WebhookReply = { status: number; body: string };

async function postWebhook(
  rawBody: string,
  signature: string | null,
  extraHeaders: Record<string, string> = {},
): Promise<WebhookReply> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...extraHeaders,
  };
  if (signature !== null) headers["x-razorpay-signature"] = signature;

  const response = await fetch(`${BASE}/api/payments/razorpay/webhook`, {
    method: "POST",
    headers,
    body: rawBody,
  });
  return { status: response.status, body: await response.text() };
}

/** A `payment.*` envelope, serialised once so the signature covers these bytes. */
function paymentEvent(args: {
  event: "payment.captured" | "payment.failed" | "payment.authorized";
  paymentId: string;
  providerOrderId: string;
  amountPaise: number;
  currency?: string;
  status?: string;
}): string {
  return JSON.stringify({
    entity: "event",
    account_id: "acc_audit",
    event: args.event,
    contains: ["payment"],
    payload: {
      payment: {
        entity: {
          id: args.paymentId,
          entity: "payment",
          amount: args.amountPaise,
          currency: args.currency ?? "INR",
          status:
            args.status ??
            (args.event === "payment.failed" ? "failed" : "captured"),
          order_id: args.providerOrderId,
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  });
}

function orderPaidEvent(args: {
  providerOrderId: string;
  amountPaise: number;
  amountPaidPaise: number;
  orderCurrency?: string;
  paymentEntity?: { id: string; amountPaise: number; currency?: string } | null;
}): string {
  const payload: Record<string, unknown> = {
    order: {
      entity: {
        id: args.providerOrderId,
        entity: "order",
        amount: args.amountPaise,
        amount_paid: args.amountPaidPaise,
        amount_due: Math.max(args.amountPaise - args.amountPaidPaise, 0),
        currency: args.orderCurrency ?? "INR",
        status: "paid",
        receipt: "FV-AUDIT",
      },
    },
  };
  if (args.paymentEntity) {
    payload.payment = {
      entity: {
        id: args.paymentEntity.id,
        entity: "payment",
        amount: args.paymentEntity.amountPaise,
        currency: args.paymentEntity.currency ?? "INR",
        status: "captured",
        order_id: args.providerOrderId,
      },
    };
  }
  return JSON.stringify({
    entity: "event",
    account_id: "acc_audit",
    event: "order.paid",
    contains: args.paymentEntity ? ["payment", "order"] : ["order"],
    payload,
    created_at: Math.floor(Date.now() / 1000),
  });
}

/* ------------------------------------------------------------- the fixture -- */

type Placed = { orderId: string; orderNumber: string; grandTotal: number };

/**
 * What `abandonUnpaidOrder` does once it has proved ownership — the other side
 * of the cancel-vs-capture race. Wrapped so the query's `error` is read at one
 * place rather than dropped inside a `Promise.all`.
 */
async function cancelOrder(orderId: string, reason: string): Promise<string> {
  const { data, error } = await admin.rpc("cancel_order_with_restock", {
    p_order_id: orderId,
    p_reason: reason,
    p_require_unpaid: true,
    p_release_cart: false,
  });
  if (error) return `error:${error.code ?? "unknown"}`;
  return data ?? "no_verdict";
}

/** What the checkout action does, minus the parts that need a request object. */
async function placeOrder(
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
    p_contact_email: "security-audit@example.com",
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

const anon = createClient<Database>(URL_, ANON, {
  auth: { persistSession: false },
});
const admin = createClient<Database>(URL_, SERVICE, {
  auth: { persistSession: false },
});

/**
 * Everything to undo, at module scope so the sweep runs from a `finally`.
 *
 * The first version of this file kept them inside main() and cleaned up at the
 * end. A throw in the middle of section 13 then left fourteen orders, fourteen
 * carts, ten ledger rows, three accounts and one pinned stock level behind, all
 * of which had to be found by hand. A cleanup that only runs on the happy path
 * is not a cleanup.
 */
const madeOrders: string[] = [];
const madeCarts: string[] = [];
const madeEventIds: string[] = [];
const madeUsers: string[] = [];
const stockToRestore = new Map<string, number>();
const flagsToRestore: { id: string; is_active: boolean }[] = [];

async function main() {
  console.log("\nAdversarial security review — checkout, orders, payments\n");
  console.log(`  target: ${BASE}`);

  let serverUp = false;
  try {
    const probe = await fetch(`${BASE}/`, { method: "GET" });
    serverUp = probe.ok;
  } catch {
    serverUp = false;
  }
  if (!serverUp)
    console.log(`  WARNING: ${BASE} is not answering. HTTP checks will SKIP.`);
  if (!WEBHOOK_SECRET)
    console.log("  WARNING: RAZORPAY_WEBHOOK_SECRET is empty in this process.");

  const variants = await rows<{
    id: string;
    stock_quantity: number;
    is_active: boolean;
  }>(
    "pick variants",
    anon
      .from("product_variants")
      .select(
        "id, stock_quantity, is_active, product:products!inner(is_active, deleted_at)",
      )
      .eq("is_active", true)
      .gte("stock_quantity", 6)
      .limit(12)
      .overrideTypes<
        { id: string; stock_quantity: number; is_active: boolean }[]
      >(),
  );
  if (variants.length < 10)
    throw new Error("need ten variants with stock >= 6");

  /** A fresh guest bag holding one unit of `variantId`. */
  async function guestBag(variantId: string, quantity = 1) {
    const token = randomUUID();
    const client = guestClient(token);
    const cart = await maybeRow<{ id: string }>(
      "guest cart",
      client
        .from("carts")
        .insert({ guest_token: token })
        .select("id")
        .maybeSingle(),
    );
    if (!cart) throw new Error("could not create a guest cart");
    madeCarts.push(cart.id);
    const error = (
      await client
        .from("cart_items")
        .insert({ cart_id: cart.id, variant_id: variantId, quantity })
    ).error;
    if (error) throw new Error(`fill guest cart: ${error.message}`);
    return { token, client, cartId: cart.id };
  }

  /** An order paid for online, with the `payments` row the webhook resolves through. */
  async function razorpayOrder(variantId: string) {
    const bag = await guestBag(variantId);
    const placed = await placeOrder(
      admin,
      bag.cartId,
      bag.token,
      null,
      "razorpay",
    );
    if (!placed.ok)
      throw new Error(`could not place a razorpay order: ${placed.code}`);
    madeOrders.push(placed.order.orderId);
    const providerOrderId = `order_sec${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    const error = (
      await admin.from("payments").insert({
        order_id: placed.order.orderId,
        provider: "razorpay",
        provider_order_id: providerOrderId,
        amount: placed.order.grandTotal,
        currency: "INR",
        status: "created",
      })
    ).error;
    if (error) throw new Error(`payments row: ${error.message}`);
    return { ...bag, order: placed.order, providerOrderId };
  }

  async function orderRow(orderId: string) {
    return maybeRow<{
      status: string;
      payment_status: string;
      grand_total: number;
      subtotal: number;
      shipping_fee: number;
      discount_total: number;
      coupon_code: string | null;
      stock_restored_at: string | null;
      payment_reference: string | null;
    }>(
      "order row",
      admin
        .from("orders")
        .select(
          "status, payment_status, grand_total, subtotal, shipping_fee, discount_total, coupon_code, stock_restored_at, payment_reference",
        )
        .eq("id", orderId)
        .maybeSingle(),
    );
  }

  async function historyCount(orderId: string, status?: string) {
    const all = await rows<{ status: string }>(
      "history",
      admin
        .from("order_status_history")
        .select("status")
        .eq("order_id", orderId),
    );
    return status
      ? all.filter((row) => row.status === status).length
      : all.length;
  }

  async function ledger(eventId: string) {
    return rows<{
      id: string;
      result: string | null;
      processed_at: string | null;
    }>(
      "ledger",
      admin
        .from("payment_events")
        .select("id, result, processed_at")
        .eq("event_id", eventId),
    );
  }

  async function stockOf(variantId: string) {
    const row = await maybeRow<{ stock_quantity: number }>(
      "stock",
      admin
        .from("product_variants")
        .select("stock_quantity")
        .eq("id", variantId)
        .maybeSingle(),
    );
    return row?.stock_quantity ?? -1;
  }

  /* ═══ 1 · the amount, tampered with from the browser ═══════════════════════ */
  section("1 · Tampering with the amount from the client");

  {
    // The only price-shaped column a customer may write. RLS grants a guest ALL
    // on their own cart_items, so this is not a hypothetical: they can set it.
    const v = variants[0];
    const bag = await guestBag(v.id, 2);
    const tampered = (
      await bag.client
        .from("cart_items")
        .update({ unit_price_seen: 1 })
        .eq("cart_id", bag.cartId)
    ).error;
    check(
      "a guest really can write cart_items.unit_price_seen (so the next check matters)",
      !tampered,
      tampered?.message ?? "",
    );

    const catalogRow = await maybeRow<{
      price_override: number | null;
      product: { effective_price: number | null; base_price: number };
    }>(
      "catalog price",
      admin
        .from("product_variants")
        .select("price_override, product:products(effective_price, base_price)")
        .eq("id", v.id)
        .maybeSingle()
        .overrideTypes<{
          price_override: number | null;
          product: { effective_price: number | null; base_price: number };
        }>(),
    );
    // The same coalesce create_order_with_stock uses. Written out here rather
    // than imported, so a change to the precedence fails this check.
    const catalogPrice = catalogRow
      ? (catalogRow.price_override ??
        catalogRow.product.effective_price ??
        catalogRow.product.base_price)
      : 0;

    const placed = await placeOrder(admin, bag.cartId, bag.token, null, "cod");
    check("the order is still placed", placed.ok, placed.ok ? "" : placed.code);
    if (placed.ok) {
      madeOrders.push(placed.order.orderId);
      const row = await orderRow(placed.order.orderId);
      const expectedSubtotal = catalogPrice * 2;
      check(
        "the tampered unit_price_seen does not reach the order subtotal",
        row?.subtotal === expectedSubtotal,
        `subtotal ${row?.subtotal} vs catalog ${expectedSubtotal}`,
      );
      check(
        "grand_total = subtotal + shipping, recomputed server-side",
        row !== null && row.grand_total === row.subtotal + row.shipping_fee,
        `${row?.subtotal} + ${row?.shipping_fee} = ${row?.grand_total}`,
      );
    }
  }

  {
    // The trust boundary is the schema, so attack the schema directly: a payload
    // carrying prices must come out the other side without them.
    const parsed = checkoutSchema({ requireContactEmail: true }).safeParse({
      paymentMethod: "cod",
      address: { ...ADDRESS, line2: "" },
      contactEmail: "attacker@example.com",
      // Every field an attacker would reach for.
      grandTotal: 1,
      subtotal: 1,
      shippingFee: 0,
      amount: 1,
      amountPaise: 1,
      discountTotal: 999999,
      coupon: "FREESHOES",
      couponCode: "FREESHOES",
      cartId: randomUUID(),
      lines: [{ variantId: randomUUID(), quantity: 1, unitPrice: 1 }],
    });
    const keys = parsed.success ? Object.keys(parsed.data).sort() : [];
    const smuggled = keys.filter((key) =>
      /total|amount|price|coupon|cart|line|shipping|discount/i.test(key),
    );
    check(
      "checkoutSchema strips every price, total, coupon and cart field",
      parsed.success && smuggled.length === 0,
      parsed.success ? `kept: ${keys.join(",")}` : "payload rejected outright",
    );
  }

  {
    const { error } = await anon.rpc("create_order_with_stock", {
      p_cart_id: randomUUID(),
      p_shipping_address: ADDRESS,
      p_payment_method: "cod",
      p_initial_status: "confirmed",
      p_payment_status: "unpaid",
      // The two numbers a caller could use to zero out shipping.
      p_shipping_flat_fee: 0,
      p_free_shipping_above: 0,
    });
    check(
      "anon cannot call create_order_with_stock with its own shipping policy",
      !!error,
      error?.code ?? "NO ERROR — it ran",
    );
  }

  /* ═══ 2 · ten deliveries of one webhook, over HTTP ═════════════════════════ */
  section("2 · Replaying a captured webhook ten times, through the route");

  const replay = await razorpayOrder(variants[1].id);
  const stockBeforeReplay = await stockOf(variants[1].id);
  {
    if (!serverUp || !WEBHOOK_SECRET) {
      skip(
        "ten sequential deliveries",
        "no reachable server or no webhook secret",
      );
    } else {
      const paymentId = `pay_sec${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const body = paymentEvent({
        event: "payment.captured",
        paymentId,
        providerOrderId: replay.providerOrderId,
        amountPaise: replay.order.grandTotal,
      });
      const eventId = `payment.captured:${paymentId}`;
      madeEventIds.push(eventId);

      const replies: WebhookReply[] = [];
      for (let i = 0; i < 10; i++)
        replies.push(await postWebhook(body, sign(body)));

      check(
        "all ten deliveries answer 200",
        replies.every((r) => r.status === 200),
        replies.map((r) => r.status).join(","),
      );
      check(
        "the first applies and the other nine are marked duplicate",
        replies[0].body.includes('"ok":true') &&
          replies.slice(1).every((r) => r.body.includes("duplicate")),
        replies.map((r) => r.body).join(" "),
      );

      const row = await orderRow(replay.order.orderId);
      check(
        "the order is confirmed and paid",
        row?.status === "confirmed" && row?.payment_status === "paid",
        `${row?.status}/${row?.payment_status}`,
      );
      check(
        "stock did not move at all on a payment event",
        (await stockOf(variants[1].id)) === stockBeforeReplay,
        `${stockBeforeReplay} -> ${await stockOf(variants[1].id)}`,
      );
      check(
        "exactly one ledger row for ten deliveries",
        (await ledger(eventId)).length === 1,
        `${(await ledger(eventId)).length} rows`,
      );
      check(
        "exactly one 'confirmed' history row",
        (await historyCount(replay.order.orderId, "confirmed")) === 1,
        `${await historyCount(replay.order.orderId, "confirmed")}`,
      );
      const payments = await rows<{
        status: string;
        provider_payment_id: string | null;
      }>(
        "payments after replay",
        admin
          .from("payments")
          .select("status, provider_payment_id")
          .eq("order_id", replay.order.orderId),
      );
      check(
        "one payment row, captured, with the payment id claimed once",
        payments.length === 1 &&
          payments[0].status === "captured" &&
          payments[0].provider_payment_id === paymentId,
        JSON.stringify(payments),
      );
    }
  }

  /* ═══ 3 · forged and malformed signatures ═════════════════════════════════ */
  section("3 · Forging the signature");

  {
    const forge = await razorpayOrder(variants[2].id);
    if (!serverUp || !WEBHOOK_SECRET) {
      skip("signature forgery", "no reachable server or no webhook secret");
    } else {
      const paymentId = `pay_forge${randomUUID().replace(/-/g, "").slice(0, 10)}`;
      const body = paymentEvent({
        event: "payment.captured",
        paymentId,
        providerOrderId: forge.providerOrderId,
        amountPaise: forge.order.grandTotal,
      });
      const good = sign(body);
      const other = paymentEvent({
        event: "payment.captured",
        paymentId,
        providerOrderId: forge.providerOrderId,
        amountPaise: 1,
      });

      const attempts: [string, WebhookReply][] = [
        ["no signature header at all", await postWebhook(body, null)],
        ["an empty signature", await postWebhook(body, "")],
        ["64 zeroes", await postWebhook(body, "0".repeat(64))],
        [
          "the signature of a different body",
          await postWebhook(body, sign(other)),
        ],
        // The classic: sign a cheap body, then send an expensive one.
        ["a body swapped after signing", await postWebhook(body, sign(other))],
        [
          "the correct signature upper-cased",
          await postWebhook(body, good.toUpperCase()),
        ],
        [
          "the correct signature, one character short",
          await postWebhook(body, good.slice(0, 63)),
        ],
        [
          "an HMAC made with the API key secret instead",
          await postWebhook(
            body,
            createHmac("sha256", process.env.RAZORPAY_KEY_SECRET ?? "x")
              .update(body, "utf8")
              .digest("hex"),
          ),
        ],
      ];

      for (const [label, reply] of attempts) {
        check(
          `rejected with 400: ${label}`,
          reply.status === 400,
          `status ${reply.status}`,
        );
      }

      const row = await orderRow(forge.order.orderId);
      check(
        "no forged attempt moved the order",
        row?.status === "pending" && row?.payment_status === "unpaid",
        `${row?.status}/${row?.payment_status}`,
      );
      check(
        "and none of them wrote a ledger row",
        (await ledger(`payment.captured:${paymentId}`)).length === 0,
      );

      // A correctly signed event we do not handle must be ignored, not applied
      // and not 400'd (a 400 makes Razorpay retry until it disables the hook).
      const unhandled = JSON.stringify({
        entity: "event",
        event: "payment.downtime.started",
        payload: {},
        created_at: 1,
      });
      const ignored = await postWebhook(unhandled, sign(unhandled));
      check(
        "a signed but unhandled event type is ignored with 200",
        ignored.status === 200 && ignored.body.includes("ignored"),
        `${ignored.status} ${ignored.body}`,
      );
    }
  }

  /* ═══ 4 · the variant goes inactive mid-flow ══════════════════════════════ */
  section("4 · Deactivating a variant mid-flow");

  {
    const v = variants[3];
    const bag = await guestBag(v.id, 1);
    flagsToRestore.push({ id: v.id, is_active: true });
    const off = (
      await admin
        .from("product_variants")
        .update({ is_active: false })
        .eq("id", v.id)
    ).error;
    if (off) throw new Error(`deactivate: ${off.message}`);

    const stockBefore = await stockOf(v.id);
    const refused = await placeOrder(admin, bag.cartId, bag.token, null, "cod");
    check(
      "checkout refuses a withdrawn variant with OSTCK",
      !refused.ok && refused.code === "OSTCK",
      refused.ok ? "it succeeded" : refused.code,
    );
    check(
      "and reports it as available: 0, not as its stock count",
      !refused.ok &&
        /"available":0/.test((refused.details ?? "").replace(/\s/g, "")),
      refused.ok ? "" : (refused.details ?? "no detail"),
    );
    check(
      "no stock moved on the refusal",
      (await stockOf(v.id)) === stockBefore,
    );

    const cart = await maybeRow<{ status: string }>(
      "cart after refusal",
      admin.from("carts").select("status").eq("id", bag.cartId).maybeSingle(),
    );
    check(
      "the bag is left active for the customer",
      cart?.status === "active",
      cart?.status ?? "",
    );

    // The other direction: withdraw it *after* the order exists.
    const back = (
      await admin
        .from("product_variants")
        .update({ is_active: true })
        .eq("id", v.id)
    ).error;
    if (back) throw new Error(`reactivate: ${back.message}`);
    const bag2 = await guestBag(v.id, 1);
    const placed = await placeOrder(
      admin,
      bag2.cartId,
      bag2.token,
      null,
      "cod",
    );
    if (!placed.ok) throw new Error(`could not place: ${placed.code}`);
    madeOrders.push(placed.order.orderId);
    const before = await rows<{
      product_name: string;
      unit_price: number;
      sku: string;
    }>(
      "snapshot before",
      admin
        .from("order_items")
        .select("product_name, unit_price, sku")
        .eq("order_id", placed.order.orderId),
    );
    const off2 = (
      await admin
        .from("product_variants")
        .update({ is_active: false })
        .eq("id", v.id)
    ).error;
    if (off2) throw new Error(`deactivate 2: ${off2.message}`);
    const after = await rows<{
      product_name: string;
      unit_price: number;
      sku: string;
    }>(
      "snapshot after",
      admin
        .from("order_items")
        .select("product_name, unit_price, sku")
        .eq("order_id", placed.order.orderId),
    );
    check(
      "an order already placed keeps its snapshot when the variant is withdrawn",
      JSON.stringify(before) === JSON.stringify(after) && before.length === 1,
      JSON.stringify(after),
    );
    const restored = (
      await admin
        .from("product_variants")
        .update({ is_active: true })
        .eq("id", v.id)
    ).error;
    if (restored) console.error(`  could not reactivate ${v.id}`);
  }

  /* ═══ 5 · concurrent checkouts on the last unit ═══════════════════════════ */
  section("5 · Five concurrent checkouts on one unit");

  {
    const v = variants[4];
    stockToRestore.set(v.id, v.stock_quantity);
    const pinned = (
      await admin
        .from("product_variants")
        .update({ stock_quantity: 1 })
        .eq("id", v.id)
    ).error;
    if (pinned) throw new Error(`pin stock: ${pinned.message}`);

    const bags = await Promise.all(
      [0, 1, 2, 3, 4].map(() => guestBag(v.id, 1)),
    );
    const raced = await Promise.all(
      bags.map((bag) => placeOrder(admin, bag.cartId, bag.token, null, "cod")),
    );
    const won = raced.filter((r) => r.ok);
    for (const r of won) if (r.ok) madeOrders.push(r.order.orderId);

    check("exactly one of five wins", won.length === 1, `${won.length} won`);
    check(
      "the four losers are all told what sold out",
      raced.filter((r) => !r.ok && r.code === "OSTCK").length === 4,
      raced.map((r) => (r.ok ? "won" : r.code)).join(","),
    );
    const left = await stockOf(v.id);
    check(
      "stock lands on exactly zero and never goes negative",
      left === 0,
      `${left}`,
    );
    const orderCount = await rows<{ id: string }>(
      "orders on the contested variant",
      admin
        .from("order_items")
        .select("id, order:orders!inner(status)")
        .eq("variant_id", v.id)
        .in(
          "order_id",
          won.filter((r) => r.ok).map((r) => (r.ok ? r.order.orderId : "")),
        ),
    );
    check(
      "exactly one order line exists for the unit",
      orderCount.length === 1,
    );
  }

  /* ═══ 6 · reading somebody else's order ═══════════════════════════════════ */
  section("6 · Customer A's order, requested by customer B");

  const victim = await guestBag(variants[5].id, 1);
  const victimOrder = await placeOrder(
    admin,
    victim.cartId,
    victim.token,
    null,
    "cod",
  );
  if (!victimOrder.ok) throw new Error("could not place the victim order");
  madeOrders.push(victimOrder.order.orderId);

  {
    const attackerToken = randomUUID();
    const attacker = guestClient(attackerToken);

    const byNumber = await rows<{ id: string }>(
      "attacker by number",
      attacker
        .from("orders")
        .select("id")
        .eq("order_number", victimOrder.order.orderNumber),
    );
    const byId = await rows<{ id: string }>(
      "attacker by id",
      attacker.from("orders").select("id").eq("id", victimOrder.order.orderId),
    );
    const items = await rows<{ id: string }>(
      "attacker items",
      attacker
        .from("order_items")
        .select("id")
        .eq("order_id", victimOrder.order.orderId),
    );
    const history = await rows<{ id: string }>(
      "attacker history",
      attacker
        .from("order_status_history")
        .select("id")
        .eq("order_id", victimOrder.order.orderId),
    );
    const noToken = await rows<{ id: string }>(
      "no token at all",
      anon
        .from("orders")
        .select("id")
        .eq("order_number", victimOrder.order.orderNumber),
    );

    check(
      "API — another guest reads nothing by order number",
      byNumber.length === 0,
    );
    check("API — nor by order id", byId.length === 0);
    check("API — nor its items", items.length === 0);
    check("API — nor its history", history.length === 0);
    check(
      "API — nor an anonymous caller carrying no token",
      noToken.length === 0,
    );

    // Two throwaway accounts, so the signed-in half of the question is real.
    const emailA = `fv-sec-a.${Date.now().toString(36)}@example.com`;
    const emailB = `fv-sec-b.${Date.now().toString(36)}@example.com`;
    const signA = await anon.auth.signUp({ email: emailA, password: PASSWORD });
    const signB = await anon.auth.signUp({ email: emailB, password: PASSWORD });
    if (
      signA.error ||
      !signA.data.session ||
      signB.error ||
      !signB.data.session
    ) {
      skip(
        "the signed-in half of the IDOR check",
        "sign-up did not return a session",
      );
    } else {
      madeUsers.push(signA.data.session.user.id, signB.data.session.user.id);
      const clientA = bearerClient(signA.data.session.access_token);
      const clientB = bearerClient(signB.data.session.access_token);

      // A places an order of their own.
      const cartA = await maybeRow<{ id: string }>(
        "A cart",
        clientA
          .from("carts")
          .insert({ user_id: signA.data.session.user.id })
          .select("id")
          .maybeSingle(),
      );
      if (!cartA) throw new Error("no cart for A");
      madeCarts.push(cartA.id);
      const fill = (
        await clientA.from("cart_items").insert({
          cart_id: cartA.id,
          variant_id: variants[6].id,
          quantity: 1,
        })
      ).error;
      if (fill) throw new Error(`fill A: ${fill.message}`);
      const owned = await placeOrder(
        admin,
        cartA.id,
        null,
        signA.data.session.user.id,
        "cod",
      );
      if (!owned.ok) throw new Error(`A could not order: ${owned.code}`);
      madeOrders.push(owned.order.orderId);
      const ordersOfA = owned.order;

      const bReadsA = await rows<{ id: string }>(
        "B reads A by number",
        clientB
          .from("orders")
          .select("id")
          .eq("order_number", ordersOfA.orderNumber),
      );
      const bReadsAById = await rows<{ id: string }>(
        "B reads A by id",
        clientB.from("orders").select("id").eq("id", ordersOfA.orderId),
      );
      const aReadsA = await rows<{ id: string }>(
        "A reads A",
        clientA
          .from("orders")
          .select("id")
          .eq("order_number", ordersOfA.orderNumber),
      );
      check(
        "API — signed-in B cannot read A's order by number",
        bReadsA.length === 0,
      );
      check("API — nor by id", bReadsAById.length === 0);
      check("API — and A can still read their own", aReadsA.length === 1);

      // B tries to become the owner by writing the columns the policies key on.
      const stolen = (
        await clientB
          .from("orders")
          .update({ user_id: signB.data.session.user.id })
          .eq("id", ordersOfA.orderId)
      ).error;
      const stillA = await maybeRow<{ user_id: string | null }>(
        "owner after the attempt",
        admin
          .from("orders")
          .select("user_id")
          .eq("id", ordersOfA.orderId)
          .maybeSingle(),
      );
      check(
        "API — B cannot reassign A's order to themselves",
        stillA?.user_id === signA.data.session.user.id,
        stolen
          ? `refused: ${stolen.code}`
          : "no error, but the row did not change",
      );

      const marked = (
        await clientB
          .from("orders")
          .update({ payment_status: "paid" })
          .eq("id", ordersOfA.orderId)
      ).error;
      const paid = await orderRow(ordersOfA.orderId);
      check(
        "API — a customer cannot mark any order paid",
        paid?.payment_status === "unpaid",
        marked
          ? `refused: ${marked.code}`
          : `payment_status ${paid?.payment_status}`,
      );

      // The page, not just the API.
      if (!serverUp) {
        skip("the page-level IDOR checks", `${BASE} is not answering`);
      } else {
        const asVictim = await fetch(
          `${BASE}/order/${victimOrder.order.orderNumber}`,
          {
            headers: { cookie: `${GUEST_COOKIE}=${victim.token}` },
            redirect: "manual",
          },
        );
        const asStranger = await fetch(
          `${BASE}/order/${victimOrder.order.orderNumber}`,
          {
            headers: { cookie: `${GUEST_COOKIE}=${randomUUID()}` },
            redirect: "manual",
          },
        );
        const asNobody = await fetch(
          `${BASE}/order/${victimOrder.order.orderNumber}`,
          {
            redirect: "manual",
          },
        );
        check(
          "page — the guest who placed it gets 200",
          asVictim.status === 200,
          `${asVictim.status}`,
        );
        check(
          "page — a guest with another token gets 404",
          asStranger.status === 404,
          `${asStranger.status}`,
        );
        check(
          "page — no cookie at all gets 404",
          asNobody.status === 404,
          `${asNobody.status}`,
        );

        const detailAsStranger = await fetch(
          `${BASE}/account/orders/${ordersOfA.orderId}`,
          {
            headers: { cookie: `${GUEST_COOKIE}=${randomUUID()}` },
            redirect: "manual",
          },
        );
        check(
          "page — /account/orders/<A's id> is 404 (or a redirect to sign in) for a stranger",
          detailAsStranger.status === 404 ||
            detailAsStranger.status === 307 ||
            detailAsStranger.status === 302,
          `${detailAsStranger.status}`,
        );

        const html = await asVictim.text();
        check(
          "page — the owner's page really renders the order (so the 404s mean something)",
          html.includes(victimOrder.order.orderNumber),
          `${html.length} bytes`,
        );
      }
    }
  }

  /* ═══ 7 · guessing a guest order ══════════════════════════════════════════ */
  section("7 · Order numbers are enumerable; the token is what gates access");

  {
    const numbers = [victimOrder.order.orderNumber];
    const seq = /^(FV-\d{4}-)(\d+)$/.exec(victimOrder.order.orderNumber);
    check(
      "order numbers are a padded sequence, so neighbours are predictable",
      seq !== null,
      victimOrder.order.orderNumber,
    );
    if (seq) {
      const width = seq[2].length;
      for (let delta = -3; delta <= 3; delta++) {
        if (delta === 0) continue;
        const n = Number(seq[2]) + delta;
        if (n > 0) numbers.push(`${seq[1]}${String(n).padStart(width, "0")}`);
      }
    }

    const stranger = guestClient(randomUUID());
    const found = await rows<{ order_number: string }>(
      "walking the sequence",
      stranger
        .from("orders")
        .select("order_number")
        .in("order_number", numbers),
    );
    check(
      `API — walking ${numbers.length} neighbouring order numbers yields nothing`,
      found.length === 0,
      `${found.length} rows`,
    );

    if (!serverUp) {
      skip("page — walking the sequence", `${BASE} is not answering`);
    } else {
      const statuses = await Promise.all(
        numbers.map(async (n) => {
          const r = await fetch(`${BASE}/order/${n}`, {
            headers: { cookie: `${GUEST_COOKIE}=${randomUUID()}` },
            redirect: "manual",
          });
          return r.status;
        }),
      );
      check(
        "page — every neighbour is 404, including the one that exists",
        statuses.every((s) => s === 404),
        statuses.join(","),
      );
      // An existing-but-not-yours order must be indistinguishable from a
      // nonexistent one, or the 404 itself is the oracle.
      const nonexistent = await fetch(`${BASE}/order/FV-1999-99999`, {
        headers: { cookie: `${GUEST_COOKIE}=${randomUUID()}` },
        redirect: "manual",
      });
      check(
        "page — a real order and an imaginary one answer identically",
        nonexistent.status === 404 && statuses[0] === 404,
        `${statuses[0]} vs ${nonexistent.status}`,
      );
    }

    // The token itself must not be discoverable from anything a stranger reads.
    const leak = await rows<{ guest_token: string | null }>(
      "can anyone select guest_token",
      stranger.from("orders").select("guest_token").limit(5),
    );
    check(
      "API — no stranger can list guest tokens",
      leak.length === 0,
      `${leak.length} rows`,
    );
  }

  /* ═══ 8 · the coupon field ════════════════════════════════════════════════ */
  section("8 · The coupon field must not move the total");

  {
    const row = await orderRow(victimOrder.order.orderId);
    check(
      "discount_total is zero on a placed order",
      row?.discount_total === 0,
      `${row?.discount_total}`,
    );
    check(
      "coupon_code is null — nothing writes it yet",
      row?.coupon_code === null,
      `${row?.coupon_code}`,
    );

    const parsed = checkoutSchema({ requireContactEmail: false }).safeParse({
      paymentMethod: "cod",
      address: { ...ADDRESS, line2: "" },
      coupon: "FREESHOES",
      couponCode: "FREESHOES",
      discountTotal: 500000,
    });
    check(
      "a coupon in the checkout payload is dropped before the server sees it",
      parsed.success &&
        !("coupon" in parsed.data) &&
        !("couponCode" in parsed.data),
      parsed.success ? Object.keys(parsed.data).join(",") : "rejected",
    );

    const coupons = await rows<{ id: string }>(
      "anon reads coupons",
      anon.from("coupons").select("id").limit(5),
    );
    check(
      "the coupons table is unreadable from the client",
      coupons.length === 0,
      `${coupons.length} rows`,
    );
  }

  /* ═══ 9 · secrets in the built bundle ═════════════════════════════════════ */
  section("9 · Secrets in the built client bundle");

  {
    const { existsSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    if (!existsSync(".next/static")) {
      skip(
        "grepping the built output",
        "run `npm run build` first — .next/static is missing",
      );
    } else {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) walk(full);
          else files.push(full);
        }
      };
      walk(".next/static");

      const needles: [string, string][] = [
        ["SUPABASE_SERVICE_ROLE_KEY", SERVICE],
        ["RAZORPAY_KEY_SECRET", process.env.RAZORPAY_KEY_SECRET ?? ""],
        ["RAZORPAY_WEBHOOK_SECRET", WEBHOOK_SECRET],
      ];
      for (const [label, value] of needles) {
        if (!value) {
          skip(
            `${label} is not reachable in the bundle`,
            "the value is blank in this environment",
          );
          continue;
        }
        const hits = files.filter((file) =>
          readFileSync(file, "utf8").includes(value),
        );
        check(
          `${label} does not appear in .next/static`,
          hits.length === 0,
          hits.slice(0, 3).join(" "),
        );
      }
      const named = files.filter((file) => {
        const text = readFileSync(file, "utf8");
        return /RAZORPAY_KEY_SECRET|RAZORPAY_WEBHOOK_SECRET|SUPABASE_SERVICE_ROLE_KEY/.test(
          text,
        );
      });
      check(
        "no client chunk even names a server-only secret variable",
        named.length === 0,
        named.slice(0, 3).join(" "),
      );
    }
  }

  /* ═══ 10 · SECURITY DEFINER functions ═════════════════════════════════════ */
  section("10 · What anon can execute");

  {
    // These four must be unreachable from any client role. Being refused *is*
    // the result, so `error` is destructured and read at every call site —
    // which is also what keeps footvault/no-unchecked-supabase-error happy.
    const refusals: [string, string][] = [];
    {
      const { error } = await anon.rpc("assert_cart_stock", {
        p_cart_id: randomUUID(),
      });
      refusals.push(["assert_cart_stock", error?.code ?? "NO ERROR"]);
    }
    {
      const { error } = await anon.rpc("cancel_order_with_restock", {
        p_order_id: victimOrder.order.orderId,
        p_reason: "attack",
      });
      refusals.push(["cancel_order_with_restock", error?.code ?? "NO ERROR"]);
    }
    {
      const { error } = await anon.rpc("next_order_number");
      refusals.push(["next_order_number", error?.code ?? "NO ERROR"]);
    }
    {
      const { error } = await anon.rpc("merge_guest_cart", {
        p_guest_token: victim.token,
        p_max_line_quantity: 5,
      });
      refusals.push(["merge_guest_cart", error?.code ?? "NO ERROR"]);
    }
    for (const [name, code] of refusals) {
      check(`anon cannot execute ${name}()`, code !== "NO ERROR", code);
    }

    // owns_order() is SECURITY DEFINER and *is* executable by anon, because the
    // order_items and order_status_history policies call it. What must hold is
    // that it answers no for an order that is not the caller's — including for
    // a caller carrying a guest token for a different bag.
    const { data: notMine, error: ownsError } = await anon.rpc("owns_order", {
      order_ref: victimOrder.order.orderId,
    });
    check(
      "owns_order() is callable by anon but answers false for somebody else's order",
      !ownsError && notMine === false,
      ownsError ? (ownsError.code ?? "error") : `returned ${notMine}`,
    );
    const { data: mine, error: mineError } = await guestClient(
      victim.token,
    ).rpc("owns_order", {
      order_ref: victimOrder.order.orderId,
    });
    check(
      "owns_order() answers true for the token that placed it",
      !mineError && mine === true,
      mineError ? (mineError.code ?? "error") : `${mine}`,
    );

    const { data: notAdmin, error: adminError } = await anon.rpc("is_admin");
    check(
      "is_admin() answers false for anon",
      !adminError && notAdmin === false,
      adminError ? (adminError.code ?? "error") : `${notAdmin}`,
    );

    // A signed-in caller asking merge_guest_cart to fold in a bag whose token
    // they are not carrying must be refused by the function, not by the client.
    const email = `fv-sec-m.${Date.now().toString(36)}@example.com`;
    const signed = await anon.auth.signUp({ email, password: PASSWORD });
    if (signed.error || !signed.data.session) {
      skip(
        "merge_guest_cart parameter spoofing",
        "sign-up did not return a session",
      );
    } else {
      madeUsers.push(signed.data.session.user.id);
      const client = createClient<Database>(URL_, ANON, {
        auth: { persistSession: false },
        global: {
          headers: {
            Authorization: `Bearer ${signed.data.session.access_token}`,
            "x-guest-token": randomUUID(),
          },
        },
      });
      const { error } = await client.rpc("merge_guest_cart", {
        p_guest_token: victim.token,
        p_max_line_quantity: 5,
      });
      check(
        "merge_guest_cart refuses a token that is not in the request header",
        !!error && error.code === "42501",
        error ? (error.code ?? "error") : "NO ERROR — it merged",
      );
      const stillTheirs = await rows<{ id: string }>(
        "victim cart after the spoof",
        admin.from("carts").select("id").eq("guest_token", victim.token),
      );
      check(
        "and the victim's bag is untouched",
        stillTheirs.length <= 1,
        `${stillTheirs.length} carts`,
      );
    }
  }

  /* ═══ 11 · the double-claim seam, under real concurrency ══════════════════ */
  section(
    "11 · The double claim: recordAndApply's pre-claim vs applyPaymentOutcome's",
  );

  {
    const target = await razorpayOrder(variants[7].id);
    if (!serverUp || !WEBHOOK_SECRET) {
      skip(
        "simultaneous deliveries of one event",
        "no reachable server or no webhook secret",
      );
    } else {
      const paymentId = `pay_race${randomUUID().replace(/-/g, "").slice(0, 11)}`;
      const body = paymentEvent({
        event: "payment.captured",
        paymentId,
        providerOrderId: target.providerOrderId,
        amountPaise: target.order.grandTotal,
      });
      const signature = sign(body);
      const eventId = `payment.captured:${paymentId}`;
      madeEventIds.push(eventId);

      // Ten at once, not ten in a row. This is the shape the pre-claim exists
      // for, and the shape that adoption inside applyPaymentOutcome could undo.
      const replies = await Promise.all(
        Array.from({ length: 10 }, () => postWebhook(body, signature)),
      );
      check(
        "all ten simultaneous deliveries answer 200",
        replies.every((r) => r.status === 200),
        replies.map((r) => r.status).join(","),
      );
      const ledgerRows = await ledger(eventId);
      check(
        "exactly one ledger row survives the storm",
        ledgerRows.length === 1,
        `${ledgerRows.length}`,
      );
      check(
        "the surviving row is processed and marked applied",
        ledgerRows[0]?.processed_at !== null &&
          ledgerRows[0]?.result === "applied",
        `${ledgerRows[0]?.result} / ${ledgerRows[0]?.processed_at}`,
      );
      const confirms = await historyCount(target.order.orderId, "confirmed");
      check(
        "exactly one 'confirmed' history row — no duplicate timeline entry",
        confirms === 1,
        `${confirms} rows`,
      );
      const payments = await rows<{ id: string }>(
        "payment rows after the storm",
        admin
          .from("payments")
          .select("id")
          .eq("order_id", target.order.orderId),
      );
      check(
        "still exactly one payment row",
        payments.length === 1,
        `${payments.length}`,
      );
    }
  }

  {
    // The other seam: two *different* event ids describing the same capture.
    // Razorpay sends payment.captured and order.paid for the same money, and
    // the browser callback records a third key. Fired together, they are three
    // concurrent writers of one transition.
    const target = await razorpayOrder(variants[8].id);
    if (!serverUp || !WEBHOOK_SECRET) {
      skip(
        "payment.captured racing order.paid",
        "no reachable server or no webhook secret",
      );
    } else {
      const paymentId = `pay_pair${randomUUID().replace(/-/g, "").slice(0, 11)}`;
      const captured = paymentEvent({
        event: "payment.captured",
        paymentId,
        providerOrderId: target.providerOrderId,
        amountPaise: target.order.grandTotal,
      });
      const paid = orderPaidEvent({
        providerOrderId: target.providerOrderId,
        amountPaise: target.order.grandTotal,
        amountPaidPaise: target.order.grandTotal,
        paymentEntity: { id: paymentId, amountPaise: target.order.grandTotal },
      });
      madeEventIds.push(
        `payment.captured:${paymentId}`,
        `order.paid:${target.providerOrderId}`,
      );

      const replies = await Promise.all([
        postWebhook(captured, sign(captured)),
        postWebhook(paid, sign(paid)),
        postWebhook(captured, sign(captured)),
        postWebhook(paid, sign(paid)),
      ]);
      check(
        "both event types answer 200",
        replies.every((r) => r.status === 200),
        replies.map((r) => r.status).join(","),
      );
      const row = await orderRow(target.order.orderId);
      check(
        "the order is confirmed and paid exactly once",
        row?.status === "confirmed" && row?.payment_status === "paid",
        `${row?.status}/${row?.payment_status}`,
      );
      const confirms = await historyCount(target.order.orderId, "confirmed");
      check(
        "one 'confirmed' history row despite two distinct event ids for one capture",
        confirms === 1,
        `${confirms} rows — a second row is a duplicate timeline entry, not a wrong order`,
      );
      const payments = await rows<{ status: string }>(
        "payments after the pair",
        admin
          .from("payments")
          .select("status")
          .eq("order_id", target.order.orderId),
      );
      check(
        "one payment row, captured",
        payments.length === 1 && payments[0].status === "captured",
      );
    }
  }

  /* ═══ 12 · the amount, attacked from the provider side ════════════════════ */
  section("12 · Amount mismatch, both directions");

  {
    const under = await razorpayOrder(variants[9].id);
    if (!serverUp || !WEBHOOK_SECRET) {
      skip("under-payment", "no reachable server or no webhook secret");
    } else {
      const paymentId = `pay_under${randomUUID().replace(/-/g, "").slice(0, 10)}`;
      const short = 100;
      const body = paymentEvent({
        event: "payment.captured",
        paymentId,
        providerOrderId: under.providerOrderId,
        amountPaise: under.order.grandTotal - short,
      });
      madeEventIds.push(`payment.captured:${paymentId}`);
      const reply = await postWebhook(body, sign(body));

      check(
        "an under-paid capture still answers 200 (no retry storm)",
        reply.status === 200,
        `${reply.status}`,
      );
      const row = await orderRow(under.order.orderId);
      check(
        "an order under-paid by 1 rupee is NOT confirmed",
        row?.status === "pending",
        `${row?.status}`,
      );
      check(
        "and is NOT marked paid",
        row?.payment_status === "unpaid",
        `${row?.payment_status}`,
      );
      const rec = await ledger(`payment.captured:${paymentId}`);
      check(
        "the ledger records the mismatch with both numbers",
        (rec[0]?.result ?? "").startsWith("amount_mismatch:"),
        rec[0]?.result ?? "no row",
      );
      const payments = await rows<{ status: string; amount: number }>(
        "payments after under-payment",
        admin
          .from("payments")
          .select("status, amount")
          .eq("order_id", under.order.orderId),
      );
      check(
        "the payment attempt is still recorded as captured, for a human to reconcile",
        payments[0]?.status === "captured",
        JSON.stringify(payments),
      );

      // A later, correct capture on the same provider order must still work —
      // otherwise a mismatch is a permanent denial of the customer's order.
      const goodPaymentId = `pay_fix${randomUUID().replace(/-/g, "").slice(0, 11)}`;
      const goodBody = paymentEvent({
        event: "payment.captured",
        paymentId: goodPaymentId,
        providerOrderId: under.providerOrderId,
        amountPaise: under.order.grandTotal,
      });
      madeEventIds.push(`payment.captured:${goodPaymentId}`);
      await postWebhook(goodBody, sign(goodBody));
      const fixed = await orderRow(under.order.orderId);
      check(
        "a correct capture afterwards still confirms the order",
        fixed?.status === "confirmed" && fixed?.payment_status === "paid",
        `${fixed?.status}/${fixed?.payment_status}`,
      );
    }
  }

  {
    const over = await razorpayOrder(variants[0].id);
    if (!serverUp || !WEBHOOK_SECRET) {
      skip("over-payment", "no reachable server or no webhook secret");
    } else {
      const paymentId = `pay_over${randomUUID().replace(/-/g, "").slice(0, 11)}`;
      const body = paymentEvent({
        event: "payment.captured",
        paymentId,
        providerOrderId: over.providerOrderId,
        amountPaise: over.order.grandTotal + 100,
      });
      madeEventIds.push(`payment.captured:${paymentId}`);
      await postWebhook(body, sign(body));
      const row = await orderRow(over.order.orderId);
      check(
        "over-payment confirms the order (the documented decision)",
        row?.status === "confirmed" && row?.payment_status === "paid",
        `${row?.status}/${row?.payment_status}`,
      );
      const rec = await ledger(`payment.captured:${paymentId}`);
      check(
        "and the overpayment is written into the ledger, not swallowed",
        (rec[0]?.result ?? "").startsWith("amount_mismatch:"),
        rec[0]?.result ?? "no row",
      );
      const note = await rows<{ note: string | null }>(
        "history note",
        admin
          .from("order_status_history")
          .select("note")
          .eq("order_id", over.order.orderId)
          .eq("status", "confirmed"),
      );
      check(
        "the timeline says how much was overpaid",
        note.some((n) => /overpaid/i.test(n.note ?? "")),
        note.map((n) => n.note).join(" | "),
      );
    }
  }

  {
    const foreign = await razorpayOrder(variants[1].id);
    if (!serverUp || !WEBHOOK_SECRET) {
      skip("currency substitution", "no reachable server or no webhook secret");
    } else {
      const paymentId = `pay_fx${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const body = paymentEvent({
        event: "payment.captured",
        paymentId,
        providerOrderId: foreign.providerOrderId,
        amountPaise: foreign.order.grandTotal,
        currency: "USD",
      });
      madeEventIds.push(`payment.captured:${paymentId}`);
      const reply = await postWebhook(body, sign(body));
      check(
        "a non-INR payment.captured is dropped with 400",
        reply.status === 400,
        `${reply.status}`,
      );
      const row = await orderRow(foreign.order.orderId);
      check(
        "and the order does not move",
        row?.status === "pending",
        `${row?.status}`,
      );

      // The precedence question: the guard reads payment.currency, the amount
      // for order.paid comes from the *order* entity. A USD order carrying an
      // INR payment entity is the shape that slips between the two.
      const paidBody = orderPaidEvent({
        providerOrderId: foreign.providerOrderId,
        amountPaise: foreign.order.grandTotal,
        amountPaidPaise: foreign.order.grandTotal,
        orderCurrency: "USD",
        paymentEntity: {
          id: `${paymentId}b`,
          amountPaise: foreign.order.grandTotal,
          currency: "INR",
        },
      });
      madeEventIds.push(`order.paid:${foreign.providerOrderId}`);
      const paidReply = await postWebhook(paidBody, sign(paidBody));
      const after = await orderRow(foreign.order.orderId);
      check(
        "order.paid naming a USD order is dropped too, not settled at INR parity",
        paidReply.status === 400 && after?.status === "pending",
        `status ${paidReply.status}, order ${after?.status} — a 200 here means the currency guard ` +
          "reads the payment entity while the amount comes from the order entity",
      );
    }
  }

  /* ═══ 13 · cancelling an order while its capture is in flight ═════════════ */
  section("13 · Cancel racing capture");

  {
    if (!serverUp || !WEBHOOK_SECRET) {
      skip("cancel racing capture", "no reachable server or no webhook secret");
    } else {
      // Fresh variants: by now the earlier sections have eaten into the ones
      // picked at the top, and a race test that dies on OSTCK proves nothing.
      const spare = await rows<{ id: string }>(
        "variants for the race",
        anon
          .from("product_variants")
          .select("id, product:products!inner(is_active, deleted_at)")
          .eq("is_active", true)
          .gte("stock_quantity", 4)
          .limit(8)
          .overrideTypes<{ id: string }[]>(),
      );
      let inconsistent = 0;
      let observed = "";
      const attempts = Math.min(3, spare.length);
      for (let i = 0; i < attempts; i++) {
        const target = await razorpayOrder(spare[i].id);
        const paymentId = `pay_tc${i}${randomUUID().replace(/-/g, "").slice(0, 10)}`;
        const body = paymentEvent({
          event: "payment.captured",
          paymentId,
          providerOrderId: target.providerOrderId,
          amountPaise: target.order.grandTotal,
        });
        madeEventIds.push(`payment.captured:${paymentId}`);

        // What the customer's "I closed the modal" action does, fired at the
        // same instant the capture lands.
        await Promise.all([
          postWebhook(body, sign(body)),
          cancelOrder(target.order.orderId, "audit: abandoned"),
        ]);

        const row = await orderRow(target.order.orderId);
        // The one state that must never exist: a live order whose units have
        // already been given back to the catalog.
        if (
          row &&
          row.status !== "cancelled" &&
          row.stock_restored_at !== null
        ) {
          inconsistent++;
          observed = `${row.status}/${row.payment_status} with stock_restored_at set`;
        }
        if (
          row &&
          row.status === "cancelled" &&
          row.payment_status === "paid" &&
          !observed
        ) {
          observed = "cancelled/paid — charged and restocked, refund owed";
        }
      }
      check(
        `${attempts} cancel-vs-capture races never leave a live order with its stock given back`,
        inconsistent === 0,
        inconsistent > 0
          ? `${inconsistent}/${attempts} produced ${observed}`
          : observed ||
              "every race resolved to cancelled or confirmed consistently",
      );
    }
  }

  {
    /**
     * The same race, aimed rather than thrown.
     *
     * `applyPaymentOutcome` reads the order, then updates it, with a round trip
     * to `payments` in between and no `where status = ...` on the update. Firing
     * the cancellation simultaneously mostly loses that window; firing it a
     * measured delay later is what an attacker with a stopwatch would do. The
     * state being hunted is an order that is *not* cancelled and whose
     * `stock_restored_at` is set — a live, paid order whose units are back on
     * the shelf for somebody else to buy.
     */
    if (!serverUp || !WEBHOOK_SECRET) {
      skip(
        "aimed cancel-vs-capture race",
        "no reachable server or no webhook secret",
      );
    } else {
      const spare = await rows<{ id: string }>(
        "variants for the aimed race",
        anon
          .from("product_variants")
          .select("id, product:products!inner(is_active, deleted_at)")
          .eq("is_active", true)
          .gte("stock_quantity", 4)
          .limit(10)
          .overrideTypes<{ id: string }[]>(),
      );
      // The window is one Supabase round trip wide — between the SELECT on
      // `orders` and the UPDATE on it, with the `payments` UPDATE in between —
      // so the sweep is fine-grained around where that lands.
      const delays = [40, 80, 120, 150, 175, 200, 225, 250, 275, 320];
      const outcomes: string[] = [];
      let bad = 0;
      let evidence = "";

      for (let i = 0; i < delays.length && i < spare.length; i++) {
        const target = await razorpayOrder(spare[i].id);
        const paymentId = `pay_tw${i}${randomUUID().replace(/-/g, "").slice(0, 10)}`;
        const body = paymentEvent({
          event: "payment.captured",
          paymentId,
          providerOrderId: target.providerOrderId,
          amountPaise: target.order.grandTotal,
        });
        madeEventIds.push(`payment.captured:${paymentId}`);

        const capture = postWebhook(body, sign(body));
        await new Promise((resolve) => setTimeout(resolve, delays[i]));
        await Promise.all([
          capture,
          cancelOrder(target.order.orderId, "audit: aimed abandon"),
        ]);

        const row = await orderRow(target.order.orderId);
        const state = `${delays[i]}ms:${row?.status}/${row?.payment_status}${row?.stock_restored_at ? "+restocked" : ""}`;
        outcomes.push(state);
        if (
          row &&
          row.status !== "cancelled" &&
          row.stock_restored_at !== null
        ) {
          bad++;
          if (!evidence) {
            const timeline = await rows<{
              status: string;
              note: string | null;
            }>(
              "timeline of the lost update",
              admin
                .from("order_status_history")
                .select("status, note, created_at")
                .eq("order_id", target.order.orderId)
                .order("created_at", { ascending: true }),
            );
            evidence = ` [${target.order.orderNumber} timeline: ${timeline.map((t) => t.status).join(" -> ")}]`;
          }
        }
      }

      check(
        "no delay produces a live order whose stock has already been given back",
        bad === 0,
        `${outcomes.join(" ")}${evidence}`,
      );
    }
  }

  /* ═══ 14 · the guest order that signing in used to lose ═══════════════════ */
  section(
    "14 · A guest order, after the customer accepts the offer to sign in",
  );

  {
    /**
     * This section asserted the bug, and kept asserting it after it was fixed.
     *
     * It was written against pre-E-3 behaviour and it checked exactly two of
     * the three things `/auth/callback` does: merge the bag, then drop the
     * cookie. It never called `adopt_guest_orders()`, so it never saw the step
     * that moves the orders — and it then asserted the *consequence* of that
     * omission, "the guest order is NOT attached to the account", as though it
     * were the correct outcome. Meanwhile `audit:checkout` §9 asserted the
     * opposite, correctly. Two suites disagreeing about one behaviour is worse
     * than one suite, because it means at least one of them is lying and
     * neither says which.
     *
     * Rewritten to run the callback's real sequence, in the callback's real
     * order — merge, adopt, and only then drop the cookie — and to assert what
     * that sequence is supposed to produce. The one assertion kept from the old
     * version is the last: a stranger with no cookie still gets a 404. That was
     * never the bug, and it must not become one.
     */
    const bag = await guestBag(variants[2].id, 1);
    const placed = await placeOrder(admin, bag.cartId, bag.token, null, "cod");
    if (!placed.ok)
      throw new Error(`could not place the guest order: ${placed.code}`);
    madeOrders.push(placed.order.orderId);

    const beforeSignIn = await rows<{ id: string }>(
      "guest reads their order before signing in",
      guestClient(bag.token)
        .from("orders")
        .select("id")
        .eq("id", placed.order.orderId),
    );
    check(
      "the guest can read their order while they hold the cookie",
      beforeSignIn.length === 1,
    );

    const email = `fv-sec-g.${Date.now().toString(36)}@example.com`;
    const signUp = await anon.auth.signUp({ email, password: PASSWORD });
    if (signUp.error || !signUp.data.session) {
      skip(
        "the sign-in half of the orphaned-order chain",
        "sign-up did not return a session",
      );
    } else {
      madeUsers.push(signUp.data.session.user.id);
      const callbackClient = createClient<Database>(URL_, ANON, {
        auth: { persistSession: false },
        global: {
          headers: {
            Authorization: `Bearer ${signUp.data.session.access_token}`,
            "x-guest-token": bag.token,
          },
        },
      });
      /* Step 1, as /auth/callback does it: fold the bag in. */
      const { data, error } = await callbackClient.rpc("merge_guest_cart", {
        p_guest_token: bag.token,
        p_max_line_quantity: 5,
      });
      check(
        "merge_guest_cart succeeds for a token whose only cart is converted",
        !error,
        error?.message ?? "",
      );
      check(
        "and reports guest_cart_consumed — the first of the two conditions for dropping the cookie",
        data?.[0]?.guest_cart_consumed === true,
        JSON.stringify(data?.[0] ?? null),
      );

      /* Step 2, the one this section used to skip. Same client, because the
         function reads the user from auth.uid() and the token from the
         x-guest-token header and takes no arguments at all. */
      const { data: adopted, error: adoptError } =
        await callbackClient.rpc("adopt_guest_orders");
      check(
        "adopt_guest_orders succeeds",
        !adoptError,
        adoptError?.message ?? "",
      );
      check(
        "and reports moving exactly the one guest order",
        adopted === 1,
        `returned ${JSON.stringify(adopted)}`,
      );

      const attached = await rows<{ id: string }>(
        "the new account's orders",
        createClient<Database>(URL_, ANON, {
          auth: { persistSession: false },
          global: {
            headers: {
              Authorization: `Bearer ${signUp.data.session.access_token}`,
            },
          },
        })
          .from("orders")
          .select("id")
          .eq("user_id", signUp.data.session.user.id),
      );
      check(
        "the guest order is now readable through the customer policy, by the account that just signed in",
        attached.length === 1 && attached[0]?.id === placed.order.orderId,
        `${attached.length} orders on the new account`,
      );

      const row = await maybeRow<{
        user_id: string | null;
        guest_token: string | null;
      }>(
        "the order row itself",
        admin
          .from("orders")
          .select("user_id, guest_token")
          .eq("id", placed.order.orderId)
          .maybeSingle(),
      );
      check(
        "the row carries the account and no longer carries the token — so dropping the cookie is now safe",
        row?.user_id === signUp.data.session.user.id &&
          row?.guest_token === null,
        JSON.stringify(row),
      );

      if (!serverUp) {
        skip(
          "page — /order/<number> for a stranger",
          `${BASE} is not answering`,
        );
      } else {
        // Unchanged from the original, and deliberately so. Adoption moved the
        // order onto an account; it must not have made the order public. No
        // cookie, no session — this is a stranger with a guessed order number.
        const stranger = await fetch(
          `${BASE}/order/${placed.order.orderNumber}`,
          {
            redirect: "manual",
          },
        );
        check(
          "page — a stranger with no cookie and no session still gets 404",
          stranger.status === 404,
          `${stranger.status}`,
        );
      }
    }
  }

  /* ═══ 15 · stock held forever by an order nobody will ever pay ════════════ */
  section("15 · An abandoned online order releases its stock eventually");

  {
    /**
     * Stock is claimed when the order row is written, and `payment.failed`
     * deliberately does not cancel. So an anonymous visitor can take the last
     * unit of anything out of the shop by starting a Razorpay checkout and
     * closing the tab — for free, repeatedly, with a fresh guest token each
     * time. Nothing in the schema or the codebase gives those units back.
     *
     * This check fails until something does. It calls a release function by an
     * agreed name; whoever implements it may rename it freely and change this
     * one line, but the assertion — an order left unpaid past a cutoff gives
     * its units back — is the contract.
     */
    const v = variants[5];
    const before = await stockOf(v.id);
    const target = await razorpayOrder(v.id);
    const held = await stockOf(v.id);
    check(
      "an unpaid, unconfirmed online order does hold its unit (so the next check matters)",
      held === before - 1,
      `${before} -> ${held}`,
    );

    // Backdate it well past any plausible cutoff, so the only reason the units
    // could still be held is that nothing sweeps.
    const backdated = (
      await admin
        .from("orders")
        .update({
          placed_at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
        })
        .eq("id", target.order.orderId)
    ).error;
    if (backdated) console.error(`  could not backdate: ${backdated.message}`);

    // Called over raw PostgREST rather than through the typed client: the
    // function does not exist yet, so `Database` has no name for it and the
    // typed call would need an `any` the lint gate forbids.
    const release = await fetch(
      `${URL_}/rest/v1/rpc/release_abandoned_orders`,
      {
        method: "POST",
        headers: {
          apikey: SERVICE,
          Authorization: `Bearer ${SERVICE}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ p_older_than_minutes: 60 }),
      },
    );
    const after = await stockOf(v.id);
    check(
      "a six-hour-old unpaid order gives its unit back to the catalog",
      release.ok && after === before,
      release.ok
        ? `${before} -> ${after}`
        : `no release mechanism exists (HTTP ${release.status} from ` +
            `rpc/release_abandoned_orders) — the unit is still held, ${before} -> ${after}`,
    );
  }

  /* ═══ 16 · writing straight to the money tables ═══════════════════════════ */
  section("16 · Writing to the money tables over PostgREST");

  {
    // Every table below is granted to `anon`/`authenticated` at the SQL level;
    // RLS is the only thing between a customer and the price of a shoe. That is
    // the correct design, and it is exactly why it has to be exercised rather
    // than assumed — a missing policy here is a free pair of shoes.
    const email = `fv-sec-w.${Date.now().toString(36)}@example.com`;
    const signUp = await anon.auth.signUp({ email, password: PASSWORD });
    if (signUp.error || !signUp.data.session) {
      skip(
        "direct writes to the money tables",
        "sign-up did not return a session",
      );
    } else {
      madeUsers.push(signUp.data.session.user.id);
      const customer = bearerClient(signUp.data.session.access_token);
      const victimVariant = variants[3];

      const variantRow = await maybeRow<{
        product: { id: string; base_price: number };
      }>(
        "a product to reprice",
        admin
          .from("product_variants")
          .select("product:products!inner(id, base_price)")
          .eq("id", victimVariant.id)
          .maybeSingle()
          .overrideTypes<{ product: { id: string; base_price: number } }>(),
      );
      if (!variantRow)
        throw new Error("could not find the product behind the variant");
      const product = variantRow.product;

      // The victim order is COD, so it already carries one legitimate
      // `confirmed` row. The assertion is "unchanged", not "zero".
      const historyBefore = await historyCount(victimOrder.order.orderId);

      const attacks: [
        string,
        () => Promise<{ error: { code?: string } | null }>,
        () => Promise<boolean>,
      ][] = [
        [
          "set a product's base_price to 1 paisa",
          async () =>
            customer
              .from("products")
              .update({ base_price: 1 })
              .eq("id", product.id),
          async () => {
            const now = await maybeRow<{ base_price: number }>(
              "price after",
              admin
                .from("products")
                .select("base_price")
                .eq("id", product.id)
                .maybeSingle(),
            );
            return now?.base_price === product.base_price;
          },
        ],
        [
          "set a variant's price_override to 1 paisa",
          async () =>
            customer
              .from("product_variants")
              .update({ price_override: 1 })
              .eq("id", victimVariant.id),
          async () => {
            const now = await maybeRow<{ price_override: number | null }>(
              "override after",
              admin
                .from("product_variants")
                .select("price_override")
                .eq("id", victimVariant.id)
                .maybeSingle(),
            );
            return now?.price_override === null;
          },
        ],
        [
          "give themselves 999 units of stock",
          async () =>
            customer
              .from("product_variants")
              .update({ stock_quantity: 999 })
              .eq("id", victimVariant.id),
          async () => (await stockOf(victimVariant.id)) !== 999,
        ],
        [
          "insert an order row of their own",
          async () =>
            customer.from("orders").insert({
              user_id: signUp.data.session!.user.id,
              status: "confirmed",
              payment_status: "paid",
              subtotal: 0,
              grand_total: 0,
              shipping_address: ADDRESS,
            }),
          async () =>
            (
              await rows<{ id: string }>(
                "self-issued orders",
                admin
                  .from("orders")
                  .select("id")
                  .eq("user_id", signUp.data.session!.user.id),
              )
            ).length === 0,
        ],
        [
          "insert a 'confirmed' row into somebody's order history",
          async () =>
            customer.from("order_status_history").insert({
              order_id: victimOrder.order.orderId,
              status: "confirmed",
              note: "forged",
            }),
          async () =>
            (await historyCount(victimOrder.order.orderId)) === historyBefore,
        ],
        [
          "insert a captured payment against an order",
          async () =>
            customer.from("payments").insert({
              order_id: victimOrder.order.orderId,
              provider: "razorpay",
              provider_order_id: `order_forged_${randomUUID().slice(0, 8)}`,
              amount: 0,
              status: "captured",
            }),
          async () =>
            (
              await rows<{ id: string }>(
                "payments on the victim order",
                admin
                  .from("payments")
                  .select("id")
                  .eq("order_id", victimOrder.order.orderId),
              )
            ).length === 0,
        ],
        [
          "insert a processed payment_events row to swallow a real webhook",
          async () =>
            customer.from("payment_events").insert({
              provider: "razorpay",
              event_id: "payment.captured:pay_forged",
              event_type: "payment.captured",
              processed_at: new Date().toISOString(),
            }),
          async () =>
            (
              await rows<{ id: string }>(
                "forged ledger rows",
                admin
                  .from("payment_events")
                  .select("id")
                  .eq("event_id", "payment.captured:pay_forged"),
              )
            ).length === 0,
        ],
        [
          "make themselves an admin",
          async () =>
            customer
              .from("profiles")
              .update({ role: "admin" })
              .eq("id", signUp.data.session!.user.id),
          async () => {
            const { data, error } = await customer.rpc("is_admin");
            return !error && data === false;
          },
        ],
      ];

      for (const [label, attempt, verify] of attacks) {
        const { error } = await attempt();
        const held = await verify();
        check(
          `refused, and nothing changed: ${label}`,
          held,
          error
            ? `refused with ${error.code}`
            : "no error returned — RLS matched zero rows",
        );
      }
    }
  }

  /* ═══ 17 · the signature primitive, against independent vectors ══════════ */
  section("17 · verifyHexSignature, against HMACs this file computed itself");

  {
    const { verifyHexSignature } =
      await import("../../src/lib/payments/signature");
    const secret = "a-test-secret";
    const message = '{"event":"payment.captured"}';
    const expected = createHmac("sha256", secret)
      .update(message, "utf8")
      .digest("hex");

    check(
      "the correct hex signature verifies",
      verifyHexSignature(secret, message, expected),
    );
    check(
      "a different secret does not",
      !verifyHexSignature("other", message, expected),
    );
    check(
      "a different message does not",
      !verifyHexSignature(secret, `${message} `, expected),
    );
    check(
      "upper case does not",
      !verifyHexSignature(secret, message, expected.toUpperCase()),
    );
    check(
      "a truncated signature does not",
      !verifyHexSignature(secret, message, expected.slice(0, 63)),
    );
    check(
      "a padded signature does not",
      !verifyHexSignature(secret, message, `${expected}0`),
    );
    check("null does not", !verifyHexSignature(secret, message, null));
    check("an empty string does not", !verifyHexSignature(secret, message, ""));
    check(
      "a non-hex string of the right length does not decode into a match",
      !verifyHexSignature(secret, message, "z".repeat(64)),
    );
    check(
      "flipping one character of a correct signature does not",
      !verifyHexSignature(
        secret,
        message,
        `${expected[0] === "a" ? "b" : "a"}${expected.slice(1)}`,
      ),
    );
  }
}

/* ═══ cleanup ═══════════════════════════════════════════════════════════════ */

async function sweep() {
  section("Cleanup");

  let cleanupProblems = 0;
  for (const orderId of madeOrders) {
    const cancelled = (
      await admin.rpc("cancel_order_with_restock", {
        p_order_id: orderId,
        p_reason: "security audit cleanup",
        p_release_cart: false,
      })
    ).error;
    if (cancelled) {
      cleanupProblems++;
      console.error(`  could not cancel ${orderId}: ${cancelled.message}`);
    }
    const deleted = (await admin.from("orders").delete().eq("id", orderId))
      .error;
    if (deleted) {
      cleanupProblems++;
      console.error(`  could not delete ${orderId}: ${deleted.message}`);
    }
  }
  if (madeCarts.length) {
    const carts = (await admin.from("carts").delete().in("id", madeCarts))
      .error;
    if (carts) {
      cleanupProblems++;
      console.error(`  could not delete carts: ${carts.message}`);
    }
  }
  if (madeEventIds.length) {
    const events = (
      await admin.from("payment_events").delete().in("event_id", madeEventIds)
    ).error;
    if (events) {
      cleanupProblems++;
      console.error(`  could not delete payment events: ${events.message}`);
    }
  }
  for (const [variantId, stock] of stockToRestore) {
    const restored = (
      await admin
        .from("product_variants")
        .update({ stock_quantity: stock })
        .eq("id", variantId)
    ).error;
    if (restored) {
      cleanupProblems++;
      console.error(`  could not restore stock for ${variantId}`);
    }
  }
  for (const flag of flagsToRestore) {
    const restored = (
      await admin
        .from("product_variants")
        .update({ is_active: flag.is_active })
        .eq("id", flag.id)
    ).error;
    if (restored) {
      cleanupProblems++;
      console.error(`  could not restore is_active for ${flag.id}`);
    }
  }
  let usersDeleted = 0;
  for (const userId of madeUsers) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error)
      console.error(`  could not delete user ${userId}: ${error.message}`);
    else usersDeleted++;
  }

  // Prove the sweep rather than assert it.
  const leftOrders = await rows<{ id: string }>(
    "orders left behind",
    admin
      .from("orders")
      .select("id")
      .in("id", madeOrders.length ? madeOrders : [randomUUID()]),
  );
  const leftCarts = await rows<{ id: string }>(
    "carts left behind",
    admin
      .from("carts")
      .select("id")
      .in("id", madeCarts.length ? madeCarts : [randomUUID()]),
  );
  const leftEvents = await rows<{ id: string }>(
    "events left behind",
    admin
      .from("payment_events")
      .select("id")
      .in("event_id", madeEventIds.length ? madeEventIds : ["none"]),
  );

  console.log(
    `  orders created ${madeOrders.length}, left behind ${leftOrders.length}\n` +
      `  carts created ${madeCarts.length}, left behind ${leftCarts.length}\n` +
      `  payment_events created ${madeEventIds.length}, left behind ${leftEvents.length}\n` +
      `  accounts created ${madeUsers.length}, deleted ${usersDeleted}\n` +
      `  cleanup errors ${cleanupProblems}`,
  );
  check(
    "every row this run created has been swept",
    leftOrders.length === 0 &&
      leftCarts.length === 0 &&
      leftEvents.length === 0,
  );
  check(
    "every throwaway account has been deleted",
    usersDeleted === madeUsers.length,
  );
}

async function run() {
  try {
    await main();
  } catch (error) {
    failures++;
    console.error("\n  THREW mid-run — the sweep below still runs.\n", error);
  }
  await sweep().catch((error) => {
    failures++;
    console.error("  the sweep itself failed:", error);
  });

  console.log(
    `\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED${skipped ? ` (${skipped} of them SKIPPED)` : ""}.`}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void run();
