import "server-only";

import {
  CLIENT_CALLBACK_EVENT_TYPE,
  judgeWebhookLiveness,
  razorpayModeHealth,
  type ModeCheck,
  type WebhookHealth,
} from "@/lib/payments/health";
import { createClient } from "@/lib/supabase/server";
import { maybeRow, pagedRows, rows } from "@/lib/queries/run";

/**
 * The dashboard's numbers.
 *
 * Read through the caller's own client, so `admins read every order` and the
 * rest of the `is_admin()` policies are what allow it. A service-role read here
 * would work identically for an admin and would also work for a bug, which is
 * the difference that matters.
 *
 * **Nothing here is cached.** Every other read-heavy surface in this codebase
 * goes through `unstable_cache`, and this one deliberately does not: the owner
 * opens the dashboard to find out what is true *now*, and a sixty-second-old
 * count of unfulfilled orders is worse than no count, because they will act on
 * it. It is also a single-user page, so there is no cache-hit-rate argument.
 *
 * "Today" is the shop's day, not UTC. Bengaluru is UTC+5:30, so a UTC boundary
 * would roll the counter over at half past five in the morning and split the
 * evening's trade across two days.
 */

const SHOP_TIMEZONE_OFFSET_MINUTES = 330; // Asia/Kolkata, UTC+5:30. No DST.

/** Low is per-variant and deliberately small — this is a single shop, not a warehouse. */
export const LOW_STOCK_THRESHOLD = 3;

export type DashboardSnapshot = {
  todayOrders: number;
  todayRevenuePaise: number;
  pendingOrders: number;
  unfulfilled: number;
  lowStock: number;
  outOfStock: number;
  recent: RecentOrder[];
  lowStockRows: LowStockRow[];
  /** Is Razorpay still talking to us server-to-server? See payments/health.ts. */
  webhook: WebhookHealth;
  /** Are we holding live keys on a preview, or test keys on production? */
  keyMode: ModeCheck;
  /** Orders we cancelled and did not give the money back for. */
  refundsOwed: RefundQueue;
};

/**
 * An order that is cancelled and paid — the state that means *we kept a
 * customer's money*.
 *
 * Stage 1 measured this at zero and the whole point of putting it on the
 * dashboard is that it must never silently become one. Everything the owner
 * needs to act is on the row, including `payment_reference`, because the refund
 * is issued in the Razorpay dashboard against that `pay_...` id and nowhere
 * else.
 */
export type RefundOwed = {
  id: string;
  orderNumber: string;
  grandTotalPaise: number;
  /** What was actually taken online. On a Pay-on-Delivery order this is the advance. */
  advancePaise: number;
  paymentReference: string | null;
  cancelledAt: string;
};

export type RefundQueue =
  | { state: "ok"; count: number; rows: RefundOwed[] }
  | { state: "unknown"; message: string };

type Supabase = Awaited<ReturnType<typeof createClient>>;

export type RecentOrder = {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  grandTotal: number;
  placedAt: string;
  contactName: string;
};

export type LowStockRow = {
  variantId: string;
  productId: string;
  productName: string;
  size: string;
  color: string;
  sku: string;
  stock: number;
};

export function shopDayStart(now = new Date()): string {
  const shifted = new Date(
    now.getTime() + SHOP_TIMEZONE_OFFSET_MINUTES * 60_000,
  );
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(
    shifted.getTime() - SHOP_TIMEZONE_OFFSET_MINUTES * 60_000,
  ).toISOString();
}

export async function getDashboard(): Promise<DashboardSnapshot> {
  const supabase = await createClient();
  const dayStart = shopDayStart();

  const [today, live, lowStockRows, webhook, refundsOwed] = await Promise.all([
    rows<{ grand_total: number; status: string }>(
      "admin.dashboard.today",
      supabase
        .from("orders")
        .select("grand_total, status")
        .gte("placed_at", dayStart),
    ),
    rows<{
      id: string;
      order_number: string;
      status: string;
      payment_status: string;
      grand_total: number;
      placed_at: string;
      shipping_address: unknown;
    }>(
      "admin.dashboard.recent",
      supabase
        .from("orders")
        .select(
          `id, order_number, status, payment_status, grand_total, placed_at, shipping_address`,
        )
        .order("placed_at", { ascending: false })
        .limit(120),
    ),
    rows<{
      id: string;
      size: string;
      color: string;
      sku: string;
      stock_quantity: number;
      product_id: string;
      products: { name: string; deleted_at: string | null } | null;
    }>(
      "admin.dashboard.lowStock",
      supabase
        .from("product_variants")
        .select(
          `id, size, color, sku, stock_quantity, product_id, products!inner(name, deleted_at)`,
        )
        .lte("stock_quantity", LOW_STOCK_THRESHOLD)
        .eq("is_active", true)
        .is("products.deleted_at", null)
        .order("stock_quantity", { ascending: true })
        .limit(50),
    ),
    // Both of these degrade rather than throw. A health tile that takes the
    // whole dashboard down with it has cost the owner more than the fault it
    // was watching for.
    readWebhookLiveness(supabase),
    readRefundsOwed(supabase),
  ]);

  /**
   * Revenue counts orders that are not cancelled, rather than orders that are
   * paid. A COD order is real money the shop is going to take, and excluding it
   * would show a zero on a day the shop was busy. Cancelled is excluded because
   * its stock has gone back on the shelf and its money never arrives.
   */
  const todayRevenuePaise = today
    .filter((order) => order.status !== "cancelled")
    .reduce((sum, order) => sum + order.grand_total, 0);

  return {
    todayOrders: today.length,
    todayRevenuePaise,
    pendingOrders: live.filter((order) => order.status === "pending").length,
    // What the owner has to *do*: paid or COD, confirmed, and not yet out the
    // door. `packed` is included — a packed parcel still needs a courier.
    unfulfilled: live.filter(
      (order) => order.status === "confirmed" || order.status === "packed",
    ).length,
    lowStock: lowStockRows.filter((row) => row.stock_quantity > 0).length,
    outOfStock: lowStockRows.filter((row) => row.stock_quantity === 0).length,
    recent: live.slice(0, 8).map((order) => ({
      id: order.id,
      orderNumber: order.order_number,
      status: order.status,
      paymentStatus: order.payment_status,
      grandTotal: order.grand_total,
      placedAt: order.placed_at,
      contactName: recipientName(order.shipping_address),
    })),
    lowStockRows: lowStockRows.slice(0, 12).map((row) => ({
      variantId: row.id,
      productId: row.product_id,
      productName: row.products?.name ?? "—",
      size: row.size,
      color: row.color,
      sku: row.sku,
      stock: row.stock_quantity,
    })),
    webhook,
    keyMode: razorpayModeHealth(),
    refundsOwed,
  };
}

/**
 * When did Razorpay last talk to us server-to-server?
 *
 * `event_type <> 'client.callback'` is the entire value of this query and it is
 * not an optimisation. `payment_events` carries a `client.callback` row for
 * every paid order, written by the customer's own browser. Include those and a
 * webhook chain that has never once fired reads back as healthy, because the
 * browser kept reporting in — which is exactly the state this shop was in when
 * Phase 8 opened, and exactly what nobody noticed.
 *
 * The verdict is judged against the last *paid order*, never the clock: see
 * `judgeWebhookLiveness`.
 */
async function readWebhookLiveness(supabase: Supabase): Promise<WebhookHealth> {
  try {
    const [lastEvent, lastPaid] = await Promise.all([
      maybeRow<{ received_at: string }>(
        "admin.dashboard.lastWebhook",
        supabase
          .from("payment_events")
          .select("received_at")
          .neq("event_type", CLIENT_CALLBACK_EVENT_TYPE)
          .order("received_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
      /**
       * `payment_status` means *the online portion* everywhere in this codebase
       * — `markCashCollected` deliberately does not touch it — so a `paid` order
       * is always one Razorpay took money for, including the advance on a
       * Pay-on-Delivery order. That is what makes it the right thing to measure
       * the webhook against: every row in this set should have produced one.
       *
       * `placed_at` rather than `updated_at`, because `updated_at` moves every
       * time the owner packs or ships the order, which would keep pushing the
       * bar forward and eventually paint a healthy chain red.
       */
      maybeRow<{ placed_at: string }>(
        "admin.dashboard.lastPaidOrder",
        supabase
          .from("orders")
          .select("placed_at")
          .eq("payment_status", "paid")
          .order("placed_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
    ]);

    return judgeWebhookLiveness({
      lastServerEventAt: lastEvent?.received_at ?? null,
      lastPaidOrderAt: lastPaid?.placed_at ?? null,
    });
  } catch (error) {
    console.error("[dashboard] webhook liveness could not be read", error);
    return { state: "unknown", message: describe(error) };
  }
}

/**
 * The orders we cancelled without giving the money back.
 *
 * `status = 'cancelled' and payment_status = 'paid'` is the code path that
 * means the shop kept a customer's money — the `illegal_transition` case in
 * `applyPaymentOutcome`, and the one the abandoned-order sweep can create by
 * cancelling an order Razorpay had already captured. It is zero today. A count
 * that goes to one without anybody seeing it is the failure this exists to
 * prevent, so it is read on every dashboard load and never cached.
 *
 * Counted exactly and listed to twenty. If it is ever over twenty the count is
 * the emergency; the list is only there so the owner can start.
 */
async function readRefundsOwed(supabase: Supabase): Promise<RefundQueue> {
  try {
    const owed = await pagedRows<{
      id: string;
      order_number: string;
      grand_total: number;
      advance_amount: number;
      payment_reference: string | null;
      updated_at: string;
    }>(
      "admin.dashboard.refundsOwed",
      supabase
        .from("orders")
        .select(
          `id, order_number, grand_total, advance_amount, payment_reference, updated_at`,
          { count: "exact" },
        )
        .eq("status", "cancelled")
        .eq("payment_status", "paid")
        .order("updated_at", { ascending: false })
        .limit(20),
    );

    if (owed.rows.length === 0)
      return { state: "ok", count: owed.total, rows: [] };

    /**
     * There is no `cancelled_at` column, and `updated_at` is whenever the row
     * was last touched by anything. The history table has the real moment, so
     * it is read — but only when there is something in the queue, which is
     * almost never, so the normal dashboard load still costs nothing.
     */
    const history = await rows<{ order_id: string; created_at: string }>(
      "admin.dashboard.refundsOwed.cancelledAt",
      supabase
        .from("order_status_history")
        .select("order_id, created_at")
        .in(
          "order_id",
          owed.rows.map((order) => order.id),
        )
        .eq("status", "cancelled")
        .order("created_at", { ascending: false }),
    );

    const cancelledAt = new Map<string, string>();
    for (const entry of history) {
      if (!cancelledAt.has(entry.order_id))
        cancelledAt.set(entry.order_id, entry.created_at);
    }

    return {
      state: "ok",
      count: owed.total,
      rows: owed.rows.map((order) => ({
        id: order.id,
        orderNumber: order.order_number,
        grandTotalPaise: order.grand_total,
        advancePaise: order.advance_amount,
        paymentReference: order.payment_reference,
        // Falls back to `updated_at` rather than showing nothing: an order with
        // no history row was still cancelled at some point, and an approximate
        // time beats a dash on a screen the owner is acting from.
        cancelledAt: cancelledAt.get(order.id) ?? order.updated_at,
      })),
    };
  } catch (error) {
    console.error("[dashboard] the refund queue could not be read", error);
    // Deliberately not `count: 0`. "We could not check" and "there is nothing
    // to refund" are the two answers this screen must never confuse.
    return { state: "unknown", message: describe(error) };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The name off an order's address snapshot.
 *
 * `shipping_address` is jsonb written by checkout, so it is ours rather than
 * arbitrary — but it is still a `Json` at the type level and a row written by
 * an older version of checkout may not have the field. Narrowed rather than
 * cast, because a cast here would be a runtime crash on the dashboard.
 */
function recipientName(address: unknown): string {
  if (address && typeof address === "object" && "recipientName" in address) {
    const value = (address as { recipientName: unknown }).recipientName;
    if (typeof value === "string" && value.trim()) return value;
  }
  return "—";
}
