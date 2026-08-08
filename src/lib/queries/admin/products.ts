import "server-only";

import {
  likePattern,
  rangeFor,
  type ListParams,
} from "@/lib/admin/list-params";
import { compareSizes } from "@/lib/sizes";
import { maybeRow, pagedRows, rows } from "@/lib/queries/run";
import { createClient } from "@/lib/supabase/server";
import type {
  AdminImage,
  AdminProductDetail,
  AdminVariant,
  CatalogOption,
  FootwearType,
  Gender,
  ParcelDefaults,
  ProductListRow,
} from "@/components/admin/products/types";

/**
 * Everything /admin/products reads.
 *
 * All of it goes through the caller's own client, so the `admins manage
 * products` RLS policies are re-checked by Postgres on every row. Nothing here
 * needs the service role, and using it would mean the panel's reads were
 * trusting this file to be right.
 */

/** Columns the table may be ordered by. Allow-listed; see list-params.ts. */
export const PRODUCT_SORTS = [
  "name",
  "base_price",
  "created_at",
  "updated_at",
] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

/**
 * `""` is everything the shop still has. `removed` is the soft-deleted pile,
 * which is deliberately reachable: `admin_delete_product` hides a product that
 * has been ordered rather than dropping it, and a hidden thing with no screen
 * that lists it is a thing the owner cannot get back.
 */
export type ProductStatus = "" | "live" | "hidden" | "removed";

export const PRODUCT_STATUSES: readonly ProductStatus[] = [
  "",
  "live",
  "hidden",
  "removed",
];

/** How many SKU matches a search will look through before it stops. */
const SKU_MATCH_LIMIT = 200;

export async function listAdminProducts(
  params: ListParams<ProductSort>,
  status: ProductStatus,
): Promise<{ rows: ProductListRow[]; total: number }> {
  const supabase = await createClient();
  const [from, to] = rangeFor(params);

  let query = supabase.from("products").select(
    // A template literal, not a concatenation — supabase-js parses this select
    // at the type level, and `string` makes it give up and hand back
    // GenericStringError a long way from here.
    `id, name, slug, base_price, sale_price, is_active, deleted_at,
       created_at, updated_at, brands ( name ), categories ( name )`,
    { count: "exact" },
  );

  if (status === "removed") {
    query = query.not("deleted_at", "is", null);
  } else {
    query = query.is("deleted_at", null);
    if (status === "live") query = query.eq("is_active", true);
    if (status === "hidden") query = query.eq("is_active", false);
  }

  /**
   * Name and slug are on the product; SKU is on its variants.
   *
   * PostgREST cannot `or` across an embed, so the SKU half is resolved first
   * into a bounded list of product ids and folded back in as `id.in.(…)`. That
   * is one extra round trip, and only when the owner is actually searching —
   * the alternative, an `!inner` join on variants, would multiply the product
   * rows by their sizes and break both the count and the pagination.
   */
  if (params.q) {
    const pattern = likePattern(params.q);
    const skuMatches = await rows<{ product_id: string }>(
      "admin.products.skuSearch",
      supabase
        .from("product_variants")
        .select("product_id")
        .ilike("sku", pattern)
        .limit(SKU_MATCH_LIMIT),
    );
    const matchedIds = [...new Set(skuMatches.map((row) => row.product_id))];
    const clauses = [`name.ilike.${pattern}`, `slug.ilike.${pattern}`];
    if (matchedIds.length > 0) clauses.push(`id.in.(${matchedIds.join(",")})`);
    query = query.or(clauses.join(","));
  }

  const result = await pagedRows<{
    id: string;
    name: string;
    slug: string;
    base_price: number;
    sale_price: number | null;
    is_active: boolean;
    deleted_at: string | null;
    created_at: string;
    updated_at: string;
    brands: { name: string } | null;
    categories: { name: string } | null;
  }>(
    "admin.products.list",
    query
      .order(params.sort, { ascending: params.dir === "asc" })
      // A stable tie-break. Without it two products with the same name swap
      // places between pages and one of them is never shown.
      .order("id", { ascending: true })
      .range(from, to),
  );

  const ids = result.rows.map((row) => row.id);
  const [variants, images, orderedLines] = await Promise.all([
    ids.length
      ? rows<{ product_id: string; stock_quantity: number }>(
          "admin.products.variantTotals",
          supabase
            .from("product_variants")
            .select("product_id, stock_quantity")
            .in("product_id", ids),
        )
      : Promise.resolve([]),
    ids.length
      ? rows<{
          product_id: string;
          url: string;
          alt_text: string | null;
          sort_order: number;
          is_primary: boolean;
        }>(
          "admin.products.thumbnails",
          supabase
            .from("product_images")
            .select("product_id, url, alt_text, sort_order, is_primary")
            .in("product_id", ids),
        )
      : Promise.resolve([]),
    ids.length
      ? rows<{ product_id: string | null }>(
          "admin.products.orderedIds",
          supabase
            .from("order_items")
            .select("product_id")
            .in("product_id", ids),
        )
      : Promise.resolve([]),
  ]);

  const counts = new Map<string, { variants: number; stock: number }>();
  for (const variant of variants) {
    const current = counts.get(variant.product_id) ?? { variants: 0, stock: 0 };
    current.variants += 1;
    current.stock += variant.stock_quantity;
    counts.set(variant.product_id, current);
  }

  // Primary first, then the owner's order — the same rule the storefront
  // gallery uses, so the thumbnail here is the photograph a customer sees.
  const thumbnails = new Map<string, { url: string; alt: string | null }>();
  for (const image of [...images].sort(
    (a, b) =>
      Number(b.is_primary) - Number(a.is_primary) ||
      a.sort_order - b.sort_order,
  )) {
    if (!thumbnails.has(image.product_id)) {
      thumbnails.set(image.product_id, {
        url: image.url,
        alt: image.alt_text,
      });
    }
  }

  const ordered = new Set(
    orderedLines
      .map((line) => line.product_id)
      .filter((id): id is string => id !== null),
  );

  return {
    total: result.total,
    rows: result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      brandName: row.brands?.name ?? null,
      categoryName: row.categories?.name ?? null,
      basePrice: row.base_price,
      salePrice: row.sale_price,
      isActive: row.is_active,
      deletedAt: row.deleted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      variantCount: counts.get(row.id)?.variants ?? 0,
      totalStock: counts.get(row.id)?.stock ?? 0,
      imageUrl: thumbnails.get(row.id)?.url ?? null,
      imageAlt: thumbnails.get(row.id)?.alt ?? null,
      hasOrders: ordered.has(row.id),
    })),
  };
}

/**
 * One product, with its sizes and its photographs.
 *
 * Soft-deleted products are returned rather than treated as missing: the owner
 * reaches this page from the "Removed" filter to put one back, and a 404 there
 * would make a recoverable product look destroyed.
 */
export async function getAdminProduct(
  productId: string,
): Promise<AdminProductDetail | null> {
  const supabase = await createClient();

  const product = await maybeRow<{
    id: string;
    name: string;
    slug: string;
    description: string | null;
    brand_id: string | null;
    category_id: string | null;
    gender: Gender;
    footwear_type: FootwearType;
    material: string | null;
    base_price: number;
    sale_price: number | null;
    is_active: boolean;
    is_featured: boolean;
    meta_title: string | null;
    meta_description: string | null;
    weight_grams: number | null;
    length_cm: number | null;
    breadth_cm: number | null;
    height_cm: number | null;
    search_keywords: string[] | null;
    deleted_at: string | null;
  }>(
    "admin.products.detail",
    supabase
      .from("products")
      .select(
        `id, name, slug, description, brand_id, category_id, gender, footwear_type,
         material, base_price, sale_price, is_active, is_featured, meta_title,
         meta_description, weight_grams, length_cm, breadth_cm, height_cm,
         search_keywords, deleted_at`,
      )
      .eq("id", productId)
      .maybeSingle(),
  );

  // Null is "no such product" or "not readable by this caller", and the two are
  // indistinguishable on purpose.
  if (!product) return null;

  const [variantRows, imageRows] = await Promise.all([
    rows<{
      id: string;
      size: string;
      color: string;
      color_hex: string | null;
      sku: string;
      price_override: number | null;
      stock_quantity: number;
      is_active: boolean;
    }>(
      "admin.products.variants",
      supabase
        .from("product_variants")
        .select(
          `id, size, color, color_hex, sku, price_override, stock_quantity, is_active`,
        )
        .eq("product_id", productId),
    ),
    rows<{
      id: string;
      url: string;
      alt_text: string | null;
      sort_order: number;
      is_primary: boolean;
      color: string | null;
    }>(
      "admin.products.images",
      supabase
        .from("product_images")
        .select("id, url, alt_text, sort_order, is_primary, color")
        .eq("product_id", productId),
    ),
  ]);

  /**
   * How many order lines point at each size.
   *
   * The variant editor needs it to decide whether "Delete" is honest: an
   * ordered variant hard-deleted takes `order_items.variant_id` to null and
   * cascades away any live cart line, so that size is turned off instead. Same
   * argument `admin_delete_product` makes one level up.
   */
  const variantIds = variantRows.map((row) => row.id);
  const orderLines = variantIds.length
    ? await rows<{ variant_id: string | null }>(
        "admin.products.variantOrders",
        supabase
          .from("order_items")
          .select("variant_id")
          .in("variant_id", variantIds),
      )
    : [];

  const orderCount = new Map<string, number>();
  for (const line of orderLines) {
    if (!line.variant_id) continue;
    orderCount.set(line.variant_id, (orderCount.get(line.variant_id) ?? 0) + 1);
  }

  const variants: AdminVariant[] = variantRows
    .map((row) => ({
      id: row.id,
      size: row.size,
      color: row.color,
      colorHex: row.color_hex,
      sku: row.sku,
      priceOverride: row.price_override,
      stock: row.stock_quantity,
      isActive: row.is_active,
      orderCount: orderCount.get(row.id) ?? 0,
    }))
    // compareSizes knows a junior 1 comes after a 13C. Sorting here rather than
    // in SQL keeps that rule in one place.
    .sort(
      (a, b) => a.color.localeCompare(b.color) || compareSizes(a.size, b.size),
    );

  /**
   * Primary first, then the owner's order — the same comparator the storefront
   * gallery and `resequence()` in the actions both use.
   *
   * Sorted here rather than in SQL because it is a *rule* rather than a column
   * order, and the admin list has to be the order the shop will render. The
   * seeded catalog predates the "first photograph is the primary" invariant and
   * can carry a primary that is not at position zero; this makes the screen
   * agree with the gallery before the first reorder rewrites both.
   */
  const images: AdminImage[] = [...imageRows]
    .sort(
      (a, b) =>
        Number(b.is_primary) - Number(a.is_primary) ||
        a.sort_order - b.sort_order,
    )
    .map((row) => ({
      id: row.id,
      url: row.url,
      altText: row.alt_text,
      sortOrder: row.sort_order,
      isPrimary: row.is_primary,
      color: row.color,
    }));

  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    description: product.description,
    brandId: product.brand_id,
    categoryId: product.category_id,
    gender: product.gender,
    footwearType: product.footwear_type,
    material: product.material,
    basePrice: product.base_price,
    salePrice: product.sale_price,
    isActive: product.is_active,
    isFeatured: product.is_featured,
    metaTitle: product.meta_title,
    metaDescription: product.meta_description,
    weightGrams: product.weight_grams,
    lengthCm: product.length_cm,
    breadthCm: product.breadth_cm,
    heightCm: product.height_cm,
    searchKeywords: product.search_keywords ?? [],
    deletedAt: product.deleted_at,
    variants,
    images,
  };
}

/** Brands and categories, for the two selects on the form. */
export async function getCatalogOptions(): Promise<{
  brands: CatalogOption[];
  categories: CatalogOption[];
}> {
  const supabase = await createClient();

  const [brands, categories] = await Promise.all([
    rows<{ id: string; name: string; is_active: boolean }>(
      "admin.products.brands",
      supabase
        .from("brands")
        .select("id, name, is_active")
        .order("name", { ascending: true }),
    ),
    rows<{ id: string; name: string; is_active: boolean }>(
      "admin.products.categories",
      supabase
        .from("categories")
        .select("id, name, is_active")
        .order("name", { ascending: true }),
    ),
  ]);

  const toOption = (row: {
    id: string;
    name: string;
    is_active: boolean;
  }): CatalogOption => ({
    id: row.id,
    name: row.name,
    isActive: row.is_active,
  });

  return { brands: brands.map(toOption), categories: categories.map(toOption) };
}

/**
 * The parcel Shiprocket is told about when a product carries no dimensions.
 *
 * Read here, and shown on the form, so "leave it blank" is a statement with
 * numbers behind it rather than a shrug. Falls back to the same figures
 * `src/lib/shipping/quote.ts` uses, because a settings row that has gone
 * missing must not make this screen claim the default is nothing.
 */
const PARCEL_FALLBACK: ParcelDefaults = {
  weightGrams: 900,
  lengthCm: 33,
  breadthCm: 22,
  heightCm: 13,
};

export async function getParcelDefaults(): Promise<ParcelDefaults> {
  const supabase = await createClient();
  const row = await maybeRow<{ value: unknown }>(
    "admin.products.parcelDefaults",
    supabase
      .from("site_settings")
      .select("value")
      .eq("key", "shipping_defaults")
      .maybeSingle(),
  );

  const value = row?.value;
  if (!value || typeof value !== "object") return PARCEL_FALLBACK;
  const partial = value as Record<string, unknown>;

  return {
    weightGrams: positiveOr(partial.weight_grams, PARCEL_FALLBACK.weightGrams),
    lengthCm: positiveOr(partial.length_cm, PARCEL_FALLBACK.lengthCm),
    breadthCm: positiveOr(partial.breadth_cm, PARCEL_FALLBACK.breadthCm),
    heightCm: positiveOr(partial.height_cm, PARCEL_FALLBACK.heightCm),
  };
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
