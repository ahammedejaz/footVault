import "server-only";

import type { MovementRow } from "@/lib/inventory-types";

import {
  likePattern,
  rangeFor,
  type ListParams,
} from "@/lib/admin/list-params";
import { pagedRows, rows } from "@/lib/queries/run";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const INVENTORY_SORTS = ["stock_quantity", "sku", "size"] as const;
export type InventorySort = (typeof INVENTORY_SORTS)[number];

/** Matches the dashboard's definition, imported rather than repeated. */
export { LOW_STOCK_THRESHOLD } from "@/lib/queries/admin/dashboard";
export type { MovementRow } from "@/lib/inventory-types";

export type InventoryRow = {
  variantId: string;
  productId: string;
  productName: string;
  productSlug: string;
  size: string;
  color: string;
  sku: string;
  stock: number;
  isActive: boolean;
};

export type StockFilter = "" | "low" | "out" | "in";

export async function listInventory(
  params: ListParams<InventorySort>,
  stock: StockFilter,
  threshold: number,
): Promise<{ rows: InventoryRow[]; total: number }> {
  const supabase = await createClient();
  const [from, to] = rangeFor(params);

  let query = supabase
    .from("product_variants")
    .select(
      `id, size, color, sku, stock_quantity, is_active, product_id,
       products!inner(name, slug, deleted_at)`,
      { count: "exact" },
    )
    // A deleted product's sizes are not stock anybody can sell, and showing
    // them makes every count on this page disagree with the shop.
    .is("products.deleted_at", null);

  if (stock === "out") query = query.eq("stock_quantity", 0);
  if (stock === "low")
    query = query.gt("stock_quantity", 0).lte("stock_quantity", threshold);
  if (stock === "in") query = query.gt("stock_quantity", threshold);

  // SKU and colour are on the variant; the product name is on the joined row and
  // PostgREST cannot `or` across an embed, so searching by product name is done
  // with a filter on the embedded column instead of folded into this.
  if (params.q) {
    const pattern = likePattern(params.q);
    query = query.or(
      `sku.ilike.${pattern},color.ilike.${pattern},size.ilike.${pattern}`,
    );
  }

  const result = await pagedRows<{
    id: string;
    size: string;
    color: string;
    sku: string;
    stock_quantity: number;
    is_active: boolean;
    product_id: string;
    products: { name: string; slug: string; deleted_at: string | null } | null;
  }>(
    "admin.inventory.list",
    query
      .order(params.sort, { ascending: params.dir === "asc" })
      .order("sku", { ascending: true })
      .range(from, to),
  );

  return {
    total: result.total,
    rows: result.rows.map((row) => ({
      variantId: row.id,
      productId: row.product_id,
      productName: row.products?.name ?? "—",
      productSlug: row.products?.slug ?? "",
      size: row.size,
      color: row.color,
      sku: row.sku,
      stock: row.stock_quantity,
      isActive: row.is_active,
    })),
  };
}

/**
 * One variant's ledger, newest first.
 *
 * This is the answer to "why does this say four when I counted six", and it is
 * the reason the ledger was built before the editor that needs it. Every row
 * carries who and why, including the ones nobody typed: an order, the sweep, a
 * cancellation.
 */
export async function getVariantMovements(
  variantId: string,
  limit = 50,
): Promise<MovementRow[]> {
  const supabase = await createClient();

  const movements = await rows<{
    id: string;
    delta: number;
    balance_after: number;
    reason: string;
    note: string | null;
    created_at: string;
    actor: string | null;
  }>(
    "admin.inventory.movements",
    supabase
      .from("inventory_movements")
      .select(`id, delta, balance_after, reason, note, created_at, actor`)
      .eq("variant_id", variantId)
      .order("created_at", { ascending: false })
      .limit(limit),
  );

  const actorIds = [
    ...new Set(
      movements.map((m) => m.actor).filter((id): id is string => !!id),
    ),
  ];
  const names = new Map<string, string>();
  if (actorIds.length) {
    const profiles = await rows<{ id: string; full_name: string | null }>(
      "admin.inventory.actors",
      supabase.from("profiles").select("id, full_name").in("id", actorIds),
    );
    for (const profile of profiles)
      names.set(profile.id, profile.full_name ?? "an admin");
  }

  return movements.map((movement) => ({
    id: movement.id,
    delta: movement.delta,
    balanceAfter: movement.balance_after,
    reason: movement.reason,
    note: movement.note,
    createdAt: movement.created_at,
    // Null actor is honest rather than missing: the sweep and the opening
    // balance genuinely were not done by a person.
    actorName: movement.actor
      ? (names.get(movement.actor) ?? "an admin")
      : null,
  }));
}

/**
 * Variants whose ledger and whose count disagree.
 *
 * `reconcile_inventory()` has existed since Phase 5 and was reachable only from
 * an audit script — which means the one screen that could act on the answer
 * never asked the question. The brief is direct about it: *"If
 * `sum(inventory_movements) ≠ stock_quantity` for any variant, show it in the
 * admin rather than leaving it to a script."*
 *
 * Drift is not a cosmetic problem. The ledger is the only account of *why* a
 * number is what it is, so a variant that has drifted is a size nobody can be
 * asked about — and the shop finds out when a customer buys something that is
 * not on the shelf.
 *
 * Read through the **service role** rather than the caller's client. The
 * function is `SECURITY DEFINER` and granted to admins, but it aggregates over
 * `inventory_movements`, and an admin whose RLS view of that table were ever
 * narrowed would silently see less drift rather than an error. The page is
 * already behind `adminActorOrNull()`; this read is not what authorises it.
 */
export async function inventoryDrift(): Promise<
  { variantId: string; sku: string; stock: number; ledgerTotal: number; drift: number }[]
> {
  const { data, error } = await createAdminClient().rpc("reconcile_inventory");
  if (error) {
    // Surfaced as "we could not check" by the caller rendering nothing, rather
    // than as "everything is fine". An unreadable reconciliation is not a clean
    // one, and the distinction is the whole reason this is not a boolean.
    console.error("[admin] reconcile_inventory failed:", error.message);
    throw new Error(`inventoryDrift: ${error.message}`);
  }
  return (data ?? []).map((row) => ({
    variantId: row.variant_id,
    sku: row.sku,
    stock: row.stock_quantity,
    ledgerTotal: Number(row.ledger_total),
    drift: Number(row.drift),
  }));
}
