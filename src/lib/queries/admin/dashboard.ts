import "server-only";

import { createClient } from "@/lib/supabase/server";
import { rows } from "@/lib/queries/run";

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
};

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

  const [today, live, lowStockRows] = await Promise.all([
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
  };
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
