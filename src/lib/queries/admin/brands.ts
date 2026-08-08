import "server-only";

import {
  likePattern,
  rangeFor,
  type ListParams,
} from "@/lib/admin/list-params";
import { pagedRows, rows } from "@/lib/queries/run";
import { createClient } from "@/lib/supabase/server";

/** Columns the brands table may be ordered by. Allow-listed; see list-params. */
export const BRAND_SORTS = ["name", "slug", "created_at"] as const;
export type BrandSort = (typeof BRAND_SORTS)[number];

export type AdminBrandRow = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  isActive: boolean;
  createdAt: string;
  /** Live products carrying this brand. */
  productCount: number;
  /**
   * Including soft-deleted ones. `products.brand_id` is `on delete set null`,
   * so a deleted brand quietly unbrands a product that is only *hidden* — and
   * restoring that product later would give it no maker at all. The delete
   * guard counts these; the row shows the owner the live number.
   */
  productCountIncludingDeleted: number;
};

export type BrandFilter = "" | "active" | "inactive";

export async function listBrands(
  params: ListParams<BrandSort>,
  filter: BrandFilter,
): Promise<{ rows: AdminBrandRow[]; total: number }> {
  const supabase = await createClient();
  const [from, to] = rangeFor(params);

  let query = supabase
    .from("brands")
    .select(`id, name, slug, logo_url, is_active, created_at`, {
      count: "exact",
    });

  if (filter === "active") query = query.eq("is_active", true);
  if (filter === "inactive") query = query.eq("is_active", false);

  if (params.q) {
    const pattern = likePattern(params.q);
    query = query.or(`name.ilike.${pattern},slug.ilike.${pattern}`);
  }

  const result = await pagedRows<{
    id: string;
    name: string;
    slug: string;
    logo_url: string | null;
    is_active: boolean;
    created_at: string;
  }>(
    "admin.brands.list",
    query
      .order(params.sort, { ascending: params.dir === "asc" })
      .order("name", { ascending: true })
      .range(from, to),
  );

  /**
   * Product counts as one follow-up query scoped to the page's ids, the same
   * shape `listOrders` uses for its line counts: one extra round trip whatever
   * the page size, rather than a count per row.
   */
  const ids = result.rows.map((row) => row.id);
  const products = ids.length
    ? await rows<{ brand_id: string | null; deleted_at: string | null }>(
        "admin.brands.productCounts",
        supabase
          .from("products")
          .select("brand_id, deleted_at")
          .in("brand_id", ids),
      )
    : [];

  const live = new Map<string, number>();
  const any = new Map<string, number>();
  for (const product of products) {
    const key = product.brand_id;
    if (!key) continue;
    any.set(key, (any.get(key) ?? 0) + 1);
    if (product.deleted_at === null) live.set(key, (live.get(key) ?? 0) + 1);
  }

  return {
    total: result.total,
    rows: result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      logoUrl: row.logo_url,
      isActive: row.is_active,
      createdAt: row.created_at,
      productCount: live.get(row.id) ?? 0,
      productCountIncludingDeleted: any.get(row.id) ?? 0,
    })),
  };
}
