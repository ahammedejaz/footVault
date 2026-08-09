/**
 * Order transitions and the inventory ledger, held to their promises.
 *
 *   npm run audit:transitions
 *
 * `transitionOrder` is the fourth writer to `orders.status` and the one a
 * human drives; the promise it makes is that the compare-and-swap cannot be
 * bypassed and cancellation is delegated, never reimplemented. Those are
 * claims about behaviour under interference, so the interference is real
 * here: two transitions fired at one order simultaneously, against staging.
 *
 * The inventory half closes the same loop from the other side: every path
 * that moves stock writes a movement row naming why, and after the churn this
 * gate causes, `reconcile_inventory()` must report zero drift on every
 * variant it touched. A ledger that only balances when nothing happened is
 * not a ledger.
 *
 * Run as: NODE_OPTIONS=--conditions=react-server tsx scripts/audit/transitions.ts
 */
// clients first, before any src import: it repoints this process at staging
// and refuses to run against production. Order matters.
import "./clients";

import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../../src/lib/database.types";
import { createAccount } from "./fixtures";
import {
  canTransition,
  ORDER_TRANSITIONS,
  TERMINAL_ORDER_STATUSES,
  type OrderStatus,
} from "../../src/lib/orders/types";
import {
  transitionOrder,
  type TransitionResult,
} from "../../src/lib/orders/transition";

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

let failures = 0;
function check(name: string, passed: boolean, detail = "") {
  if (!passed) failures++;
  console.log(
    `${passed ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`,
  );
}

function service(): SupabaseClient<Database> {
  return createClient<Database>(URL_, SERVICE, {
    auth: { persistSession: false },
  });
}

/**
 * `transitionOrder`'s cancel branch ends in `stockChanged()`, which requires a
 * Server Action context and throws under tsx. The cancellation itself has
 * already committed inside `cancel_order_with_restock` by then, so the gate
 * treats that specific throw as "completed; verify the database" — any other
 * throw is a real failure and re-raised.
 */
type CancelOutcome =
  | { completed: true; result: TransitionResult }
  | { completed: true; threwAfterCommit: true };

async function cancelVia(
  admin: SupabaseClient<Database>,
  orderId: string,
  actorId: string,
): Promise<CancelOutcome> {
  try {
    const result = await transitionOrder({
      supabase: admin,
      elevated: () => admin,
      orderId,
      to: "cancelled",
      note: "audit: cancel via transitionOrder",
      actorId,
    });
    return { completed: true, result };
  } catch (error) {
    if (error instanceof Error && error.message.includes("updateTag")) {
      return { completed: true, threwAfterCommit: true };
    }
    throw error;
  }
}

/** Committed either way — as a verdict, or as the known post-commit throw. */
function cancelCommitted(outcome: CancelOutcome): boolean {
  return "threwAfterCommit" in outcome ? true : outcome.result.ok;
}

async function main() {
  console.log("\nOrder transitions and the inventory ledger\n");

  const admin = service();
  const placedOrders: string[] = [];
  const madeCarts: string[] = [];
  const stockToRestore = new Map<string, number>();

  /* ── 1 · the matrix itself, as written ───────────────────────────────── */
  console.log("1 · the transition matrix holds its two structural promises");

  for (const terminal of TERMINAL_ORDER_STATUSES) {
    check(
      `${terminal} is terminal — no way out`,
      ORDER_TRANSITIONS[terminal].length === 0,
      ORDER_TRANSITIONS[terminal].join(", "),
    );
  }
  check(
    "the fulfilment chain is walkable: pending → confirmed → packed → shipped → delivered",
    canTransition("pending", "confirmed") &&
      canTransition("confirmed", "packed") &&
      canTransition("packed", "shipped") &&
      canTransition("shipped", "delivered"),
  );
  check(
    "a parcel on its way back cannot be delivered or cancelled",
    !canTransition("returning", "delivered") &&
      !canTransition("returning", "cancelled"),
  );
  check(
    "delivery cannot be skipped: pending/confirmed never reach delivered directly",
    !canTransition("pending", "delivered") &&
      !canTransition("confirmed", "delivered"),
  );
  check(
    "every pre-shipment state can still be cancelled",
    canTransition("pending", "cancelled") &&
      canTransition("confirmed", "cancelled") &&
      canTransition("packed", "cancelled"),
  );

  /* ── fixtures ─────────────────────────────────────────────────────────── */

  const { data: variants, error: variantsError } = await admin
    .from("product_variants")
    .select("id, stock_quantity, product:products!inner(is_active, deleted_at)")
    .eq("is_active", true)
    .gte("stock_quantity", 6)
    .limit(3);
  if (variantsError || !variants || variants.length < 3)
    throw new Error(variantsError?.message ?? "need three variants with stock");
  for (const variant of variants)
    stockToRestore.set(variant.id, variant.stock_quantity);
  const [vChain, vRace, vCancel] = variants;

  async function placeOrder(variantId: string): Promise<{
    orderId: string;
    orderNumber: string;
  }> {
    const token = randomUUID();
    const guest = createClient<Database>(URL_, ANON, {
      auth: { persistSession: false },
      global: { headers: { "x-guest-token": token } },
    });
    const { data: cart, error: cartError } = await guest
      .from("carts")
      .insert({ guest_token: token })
      .select("id")
      .single();
    if (cartError || !cart) throw new Error(`cart: ${cartError?.message}`);
    madeCarts.push(cart.id);
    const { error: lineError } = await guest
      .from("cart_items")
      .insert({ cart_id: cart.id, variant_id: variantId, quantity: 1 });
    if (lineError) throw new Error(`line: ${lineError.message}`);

    const { data, error } = await admin.rpc("create_order_with_stock", {
      p_cart_id: cart.id,
      p_shipping_address: ADDRESS,
      p_payment_method: "razorpay",
      p_initial_status: "confirmed",
      p_payment_status: "unpaid",
      p_shipping_flat_fee: 9900,
      p_guest_token: token,
      p_contact_email: null as unknown as undefined,
      p_contact_phone: "9876543210",
    });
    if (error) throw new Error(`place: ${error.message}`);
    const row = data?.[0];
    if (!row) throw new Error("place: no row");
    placedOrders.push(row.order_id);
    return { orderId: row.order_id, orderNumber: row.order_number };
  }

  /**
   * A real profile, because `order_status_history.changed_by` and the
   * movement trigger's actor column are both foreign keys — an invented uuid
   * makes every history insert fail quietly and the gate read as coverage.
   */
  const account = await createAccount("transitions-actor");
  const actor = account.userId;

  const historyRows = async (orderId: string, status: OrderStatus) => {
    const { data, error } = await admin
      .from("order_status_history")
      .select("id")
      .eq("order_id", orderId)
      .eq("status", status);
    if (error) throw new Error(`history: ${error.message}`);
    return (data ?? []).length;
  };

  const stockOf = async (variantId: string) => {
    const { data, error } = await admin
      .from("product_variants")
      .select("stock_quantity")
      .eq("id", variantId)
      .single();
    if (error) throw new Error(`stockOf: ${error.message}`);
    return data.stock_quantity;
  };

  const statusOf = async (orderId: string) => {
    const { data, error } = await admin
      .from("orders")
      .select("status")
      .eq("id", orderId)
      .single();
    if (error) throw new Error(`status: ${error.message}`);
    return data.status;
  };

  try {
    /* ── 2 · the happy chain, one history row per step ───────────────────── */
    console.log("\n2 · the fulfilment chain, one audit row per step");

    const chain = await placeOrder(vChain.id);
    for (const to of ["packed", "shipped", "delivered"] as OrderStatus[]) {
      const result = await transitionOrder({
        supabase: admin,
        elevated: () => admin,
        orderId: chain.orderId,
        to,
        note: `audit: ${to}`,
        actorId: actor,
      });
      check(
        `confirmed order reaches ${to}`,
        result.ok && result.status === to,
        result.ok ? "" : result.message,
      );
    }
    check(
      "the order ends delivered",
      (await statusOf(chain.orderId)) === "delivered",
    );
    for (const status of ["packed", "shipped", "delivered"] as OrderStatus[]) {
      check(
        `exactly one history row for ${status}`,
        (await historyRows(chain.orderId, status)) === 1,
      );
    }

    /* ── 3 · refusals ─────────────────────────────────────────────────────── */
    console.log("\n3 · the refusals a human meets");

    const backward = await transitionOrder({
      supabase: admin,
      elevated: () => admin,
      orderId: chain.orderId,
      to: "packed",
      note: null,
      actorId: actor,
    });
    check(
      "delivered cannot go back to packed",
      !backward.ok && backward.reason === "illegal",
      backward.ok ? "moved!" : backward.reason,
    );

    const samePress = await transitionOrder({
      supabase: admin,
      elevated: () => admin,
      orderId: chain.orderId,
      to: "delivered",
      note: null,
      actorId: actor,
    });
    check(
      "a second press of the same status is a calm no-op",
      samePress.ok && (await historyRows(chain.orderId, "delivered")) === 1,
    );

    const ghost = await transitionOrder({
      supabase: admin,
      elevated: () => admin,
      orderId: randomUUID(),
      to: "packed",
      note: null,
      actorId: actor,
    });
    check(
      "a missing order is not_found",
      !ghost.ok && ghost.reason === "not_found",
    );

    /* ── 4 · the race the CAS exists for ─────────────────────────────────── */
    console.log("\n4 · two admins press at once — the CAS decides");

    const raced = await placeOrder(vRace.id);
    const [first, second] = await Promise.all([
      transitionOrder({
        supabase: admin,
        elevated: () => admin,
        orderId: raced.orderId,
        to: "packed",
        note: "audit: press A",
        actorId: actor,
      }),
      transitionOrder({
        supabase: admin,
        elevated: () => admin,
        orderId: raced.orderId,
        to: "packed",
        note: "audit: press B",
        actorId: actor,
      }),
    ]);
    check(
      "both presses report success — neither human sees an error",
      first.ok && second.ok,
      `${first.ok} / ${second.ok}`,
    );
    check(
      "but the order moved exactly once: one packed history row",
      (await historyRows(raced.orderId, "packed")) === 1,
      String(await historyRows(raced.orderId, "packed")),
    );
    check("and it is packed", (await statusOf(raced.orderId)) === "packed");

    /* ── 5 · cancellation is delegated, and the shelf agrees ─────────────── */
    console.log("\n5 · cancel through the same door, stock through the ledger");

    const cancel = await placeOrder(vCancel.id);
    const stockAfterPlace = await stockOf(vCancel.id);
    check(
      "placing claimed one unit",
      stockAfterPlace === vCancel.stock_quantity - 1,
      `${vCancel.stock_quantity} → ${stockAfterPlace}`,
    );

    const cancelled = await cancelVia(admin, cancel.orderId, actor);
    check(
      "the cancel commits (verdict or the known post-commit throw)",
      cancelCommitted(cancelled),
    );
    check(
      "the order is cancelled",
      (await statusOf(cancel.orderId)) === "cancelled",
    );

    const stockAfterCancel = await stockOf(vCancel.id);
    check(
      "the unit is back on the shelf",
      stockAfterCancel === vCancel.stock_quantity,
      `${stockAfterPlace} → ${stockAfterCancel}`,
    );

    const again = await cancelVia(admin, cancel.orderId, actor);
    const stockAfterSecond = await stockOf(vCancel.id);
    check(
      "a second cancel restocks nothing",
      stockAfterSecond === vCancel.stock_quantity && cancelCommitted(again),
      String(stockAfterSecond),
    );

    /* ── 6 · the ledger names every movement ─────────────────────────────── */
    console.log("\n6 · the inventory ledger, written and balanced");

    const { data: movements, error: movementsError } = await admin
      .from("inventory_movements")
      .select("reason, delta")
      .eq("reference_id", cancel.orderId);
    if (movementsError) throw new Error(movementsError.message);

    check(
      "the order's life is two movements: the claim and the return",
      (movements ?? []).length === 2,
      (movements ?? []).map((m) => `${m.reason}:${m.delta}`).join(", "),
    );
    check(
      "named 'order' out and 'cancellation' back, summing to zero",
      (movements ?? []).some((m) => m.reason === "order" && m.delta === -1) &&
        (movements ?? []).some(
          (m) => m.reason === "cancellation" && m.delta === 1,
        ),
    );

    const { data: reconcile, error: reconcileError } = await admin.rpc(
      "reconcile_inventory",
    );
    if (reconcileError) throw new Error(reconcileError.message);
    const touched = new Set([vChain.id, vRace.id, vCancel.id]);
    const drifted = (reconcile ?? []).filter(
      (row) => touched.has(row.variant_id) && row.drift !== 0,
    );
    check(
      "reconcile_inventory reports zero drift on every variant this run touched",
      drifted.length === 0,
      drifted.map((row) => `${row.sku}: ${row.drift}`).join(", "),
    );
  } finally {
    console.log("\ncleanup");
    // The actor account goes last — movements still reference it until they
    // are deleted below.
    for (const orderId of placedOrders) {
      const { data: order, error: readError } = await admin
        .from("orders")
        .select("status")
        .eq("id", orderId)
        .single();
      if (readError) {
        console.error(`  cleanup read: ${readError.message}`);
        continue;
      }
      // Delivered orders cannot be cancelled; delete restores nothing, so put
      // the unit back through the ledger-writing RPC only where legal.
      if (order && !["cancelled", "delivered"].includes(order.status)) {
        const { error } = await admin.rpc("cancel_order_with_restock", {
          p_order_id: orderId,
          p_reason: "audit: cleanup",
          p_require_unpaid: true,
        });
        if (error) console.error(`  cleanup cancel: ${error.message}`);
      }
    }
    // The delivered chain order held its unit to the end; hand adjustment with
    // the movement trigger attributing it, then delete rows.
    const { error: deleteError } = await admin
      .from("orders")
      .delete()
      .in("id", placedOrders);
    if (deleteError) console.error(`  cleanup orders: ${deleteError.message}`);
    if (madeCarts.length) {
      const { error } = await admin.from("carts").delete().in("id", madeCarts);
      if (error) console.error(`  cleanup carts: ${error.message}`);
    }
    const { error: movementCleanup } = await admin
      .from("inventory_movements")
      .delete()
      .in("reference_id", placedOrders);
    if (movementCleanup)
      console.error(`  cleanup movements: ${movementCleanup.message}`);
    for (const [variantId, expected] of stockToRestore) {
      const { data, error } = await admin
        .from("product_variants")
        .select("stock_quantity")
        .eq("id", variantId)
        .single();
      if (error) {
        console.error(`  cleanup stock read: ${error.message}`);
        continue;
      }
      if (data.stock_quantity !== expected) {
        const { error: repair } = await admin
          .from("product_variants")
          .update({ stock_quantity: expected })
          .eq("id", variantId);
        if (repair) console.error(`  cleanup stock: ${repair.message}`);
        else
          console.log(
            `  restored ${variantId}: ${data.stock_quantity} → ${expected}`,
          );
      }
    }
  }

  {
    const { error } = await admin.auth.admin.deleteUser(actor);
    if (error) console.error(`  cleanup actor: ${error.message}`);
  }

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — transitions  (${failures} failing)\n`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
