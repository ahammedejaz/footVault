import "server-only";

import { z } from "zod";

import { compareSizes } from "@/lib/sizes";
import { createStaticClient } from "@/lib/supabase/static";
import { maybeRow, rows, run } from "@/lib/queries/run";
import type {
  CatalogFacets,
  Facet,
  FootwearType,
  Gender,
  ProductColor,
  ProductDetail,
  ProductImage,
  ProductSummary,
  SizeAvailability,
} from "@/lib/catalog-types";

export type {
  CatalogFacets,
  Facet,
  FootwearType,
  Gender,
  ProductColor,
  ProductDetail,
  ProductImage,
  ProductSummary,
  SizeAvailability,
} from "@/lib/catalog-types";

/**
 * The catalog reads through the cookieless anon client, not the session one.
 *
 * Everything here is public: RLS exposes exactly the live catalog to `anon`,
 * and no row differs by who is asking. Reading it through `cookies()` was
 * costing far more than it looked — a page that touches cookies is dynamic, so
 * `/` and `/product/[slug]` were rendered on every request despite their
 * `revalidate`, and the LCP image could not be discovered until the server had
 * finished the round trip. Anything that genuinely varies per customer (the
 * bag, the account) uses supabase/server.ts, where the session applies.
 */
const db = () => createStaticClient();

/* -------------------------------------------------------------------------- */
/* row -> view model                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One shape for every product read.
 *
 * Variants come back in full even when a size filter is active: the size run
 * has to show the whole run with the missing sizes struck through, so a query
 * that returned only matching sizes would quietly turn the signature element
 * into a lie. Filtering by size narrows *which products* come back, never which
 * sizes are shown on them.
 */
export const PRODUCT_FIELDS = `
  id, slug, name, description, material, gender, footwear_type,
  base_price, sale_price, effective_price, meta_title, meta_description, created_at,
  brand:brands ( name, slug ),
  category:categories ( name, slug ),
  images:product_images ( url, alt_text, sort_order, is_primary, color ),
  variants:product_variants ( id, size, color, color_hex, color_family, sku, stock_quantity, is_active )
` as const;

export type RawProduct = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  material: string | null;
  gender: Gender;
  footwear_type: FootwearType;
  base_price: number;
  sale_price: number | null;
  effective_price: number | null;
  meta_title: string | null;
  meta_description: string | null;
  created_at: string;
  brand: { name: string; slug: string } | null;
  category: { name: string; slug: string } | null;
  images: Array<{
    url: string;
    alt_text: string | null;
    sort_order: number;
    is_primary: boolean;
    color: string | null;
  }>;
  variants: Array<{
    id: string;
    size: string;
    color: string;
    color_hex: string | null;
    color_family: string | null;
    sku: string;
    stock_quantity: number;
    is_active: boolean;
  }>;
};

/** Primary first, then the owner's order. Used for the gallery and the card. */
function orderImages(images: RawProduct["images"]) {
  return [...images].sort(
    (a, b) => Number(b.is_primary) - Number(a.is_primary) || a.sort_order - b.sort_order,
  );
}

function toSizes(
  variants: RawProduct["variants"],
  colourway?: string,
): SizeAvailability[] {
  const stockBySize = new Map<string, number>();
  // Only populated when scoped to a colourway: (product, size, colour) is
  // unique, so there is exactly one variant per size. Across colourways a size
  // is several variants and naming one of them would be a guess.
  const variantBySize = new Map<string, string>();

  for (const variant of variants) {
    if (!variant.is_active) continue;
    if (colourway && variant.color !== colourway) continue;
    stockBySize.set(
      variant.size,
      (stockBySize.get(variant.size) ?? 0) + variant.stock_quantity,
    );
    if (colourway) variantBySize.set(variant.size, variant.id);
  }

  return [...stockBySize.entries()]
    .sort((a, b) => compareSizes(a[0], b[0]))
    .map(([size, stock]) => ({
      size,
      stock,
      available: stock > 0,
      variantId: variantBySize.get(size) ?? null,
    }));
}

export function toSummary(row: RawProduct): ProductSummary {
  const images = orderImages(row.images);
  const toImage = (image: (typeof images)[number]): ProductImage => ({
    url: image.url,
    alt: image.alt_text ?? row.name,
    color: image.color,
  });

  // Stock on the card is summed across colourways: a customer scanning a grid
  // wants to know whether the shop has their size at all, not whether it has it
  // in the colour that happens to be photographed.
  const sizes = toSizes(row.variants);

  const colors: ProductColor[] = [];
  for (const variant of row.variants) {
    if (!variant.is_active) continue;
    if (colors.some((c) => c.name === variant.color)) continue;
    const own = images.filter((image) => image.color === variant.color);
    colors.push({
      name: variant.color,
      hex: variant.color_hex,
      family: variant.color_family,
      sizes: toSizes(row.variants, variant.color),
      // A colourway with no photography of its own falls back to the shared
      // set, so a half-uploaded product still renders a gallery.
      images: (own.length > 0 ? own : images.filter((i) => i.color === null)).map(toImage),
    });
  }

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    brandName: row.brand?.name ?? null,
    categoryName: row.category?.name ?? null,
    categorySlug: row.category?.slug ?? null,
    gender: row.gender,
    footwearType: row.footwear_type,
    basePrice: row.base_price,
    salePrice: row.sale_price,
    heroImage: images[0] ? toImage(images[0]) : null,
    soleImage: images[1] ? toImage(images[1]) : null,
    sizes,
    colors,
    inStock: sizes.some((s) => s.available),
  };
}

function toDetail(row: RawProduct): ProductDetail {
  const images = orderImages(row.images);
  return {
    ...toSummary(row),
    description: row.description,
    material: row.material,
    metaTitle: row.meta_title,
    metaDescription: row.meta_description,
    images: images.map((i) => ({
      url: i.url,
      alt: i.alt_text ?? row.name,
      color: i.color,
    })),
    variants: row.variants
      .filter((v) => v.is_active)
      .sort((a, b) => compareSizes(a.size, b.size) || a.color.localeCompare(b.color))
      .map((v) => ({
        id: v.id,
        size: v.size,
        color: v.color,
        colorHex: v.color_hex,
        sku: v.sku,
        stock: v.stock_quantity,
      })),
  };
}

/* -------------------------------------------------------------------------- */
/* listing                                                                    */
/* -------------------------------------------------------------------------- */

export type SortKey = "newest" | "price-asc" | "price-desc" | "relevance";

export type ProductFilters = {
  categorySlug?: string;
  collectionSlug?: string;
  gender?: Gender;
  footwearType?: FootwearType;
  brandSlugs?: string[];
  sizes?: string[];
  colors?: string[];
  minPrice?: number;
  maxPrice?: number;
  inStockOnly?: boolean;
  onSale?: boolean;
  search?: string;
  sort?: SortKey;
  page?: number;
  perPage?: number;
};

export const PRODUCTS_PER_PAGE = 12;

export type ProductPage = {
  products: ProductSummary[];
  total: number;
  page: number;
  perPage: number;
  pageCount: number;
  facets: CatalogFacets;
};

/**
 * catalog_query() returns jsonb, which arrives as `Json` — a type that says
 * nothing. Parsing it here means a change to the function's shape fails at the
 * boundary with a readable message instead of surfacing as `undefined.map` two
 * components deep.
 */
const facetSchema = z.object({ value: z.string(), count: z.number() });
const brandFacetSchema = facetSchema.extend({ label: z.string() });

const catalogResultSchema = z.object({
  total: z.number(),
  ids: z.array(z.string()),
  facets: z.object({
    sizes: z.array(facetSchema),
    colors: z.array(facetSchema),
    brands: z.array(brandFacetSchema),
    genders: z.array(facetSchema),
    in_stock: z.number(),
    on_sale: z.number(),
    price: z.object({ min: z.number().nullable(), max: z.number().nullable() }),
  }),
});

const GENDER_LABEL: Record<string, string> = {
  men: "Men",
  women: "Women",
  unisex: "Unisex",
  kids: "Kids",
};

export async function listProducts(filters: ProductFilters = {}): Promise<ProductPage> {
  const supabase = db();
  const perPage = filters.perPage ?? PRODUCTS_PER_PAGE;
  const page = Math.max(1, filters.page ?? 1);

  const raw = await run(
    "catalog_query",
    supabase.rpc("catalog_query", {
      p_category_slug: filters.categorySlug,
      p_collection_slug: filters.collectionSlug,
      p_gender: filters.gender,
      p_type: filters.footwearType,
      p_brands: filters.brandSlugs?.length ? filters.brandSlugs : undefined,
      p_sizes: filters.sizes?.length ? filters.sizes : undefined,
      p_colors: filters.colors?.length ? filters.colors : undefined,
      p_min_price: filters.minPrice,
      p_max_price: filters.maxPrice,
      p_in_stock: filters.inStockOnly ?? false,
      p_on_sale: filters.onSale ?? false,
      p_search: filters.search,
      p_sort: filters.sort ?? "newest",
      p_limit: perPage,
      p_offset: (page - 1) * perPage,
    }),
  );

  const result = catalogResultSchema.parse(raw);

  const facets: CatalogFacets = {
    // Sorted here rather than in SQL: compareSizes() already knows that a
    // junior 1 comes after a 13C, and that rule should live in one place.
    sizes: result.facets.sizes
      .map((f) => ({ value: f.value, label: f.value, count: f.count }))
      .sort((a, b) => compareSizes(a.value, b.value)),
    colors: result.facets.colors.map((f) => ({
      value: f.value,
      label: f.value,
      count: f.count,
    })),
    brands: result.facets.brands.map((f) => ({
      value: f.value,
      label: f.label,
      count: f.count,
    })),
    genders: result.facets.genders.map((f) => ({
      value: f.value,
      label: GENDER_LABEL[f.value] ?? f.value,
      count: f.count,
    })),
    inStock: result.facets.in_stock,
    onSale: result.facets.on_sale,
    price:
      result.facets.price.min !== null && result.facets.price.max !== null
        ? { min: result.facets.price.min, max: result.facets.price.max }
        : null,
  };

  if (result.ids.length === 0) {
    return { products: [], total: result.total, page, perPage, pageCount: 0, facets };
  }

  const products = await rows<RawProduct>(
    "listProducts rows",
    supabase.from("products").select(PRODUCT_FIELDS).in("id", result.ids) as never,
  );

  // PostgREST returns `in` results in its own order; the sort the customer
  // asked for lives in `ids`.
  const byId = new Map(products.map((row) => [row.id, row]));
  return {
    products: result.ids
      .map((id) => byId.get(id))
      .filter((row): row is RawProduct => Boolean(row))
      .map(toSummary),
    total: result.total,
    page,
    perPage,
    pageCount: Math.max(1, Math.ceil(result.total / perPage)),
    facets,
  };
}

/* -------------------------------------------------------------------------- */
/* single reads                                                               */
/* -------------------------------------------------------------------------- */

export async function getProduct(slug: string): Promise<ProductDetail | null> {
  const row = await maybeRow<RawProduct>(
    `getProduct(${slug})`,
    db()
      .from("products")
      .select(PRODUCT_FIELDS)
      .eq("slug", slug)
      .eq("is_active", true)
      .is("deleted_at", null)
      .maybeSingle() as never,
  );
  return row ? toDetail(row) : null;
}

export async function listProductSlugs(): Promise<string[]> {
  const data = await rows<{ slug: string }>(
    "listProductSlugs",
    db().from("products").select("slug").eq("is_active", true).is("deleted_at", null),
  );
  return data.map((row) => row.slug);
}

export type CategoryNode = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  children: CategoryNode[];
};

export async function getCategoryTree(): Promise<CategoryNode[]> {
  const data = await rows<{
    id: string;
    name: string;
    slug: string;
    description: string | null;
    parent_id: string | null;
    sort_order: number;
  }>(
    "getCategoryTree",
    db()
      .from("categories")
      .select("id, name, slug, description, parent_id, sort_order")
      .eq("is_active", true)
      .order("sort_order"),
  );

  const byId = new Map(
    data.map((row) => [
      row.id,
      {
        id: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description,
        children: [] as CategoryNode[],
      },
    ]),
  );

  const roots: CategoryNode[] = [];
  for (const row of data) {
    const node = byId.get(row.id)!;
    const parent = row.parent_id ? byId.get(row.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export type Category = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  parent: { name: string; slug: string } | null;
};

export async function getCategory(slug: string): Promise<Category | null> {
  // PostgREST disambiguates a self-referencing embed by the column, not by the
  // constraint name: `parent:categories!categories_parent_id_fkey` is rejected
  // with PGRST200, and `parent:parent_id` is what resolves.
  return maybeRow<Category>(
    `getCategory(${slug})`,
    db()
      .from("categories")
      .select("id, name, slug, description, parent:parent_id ( name, slug )")
      .eq("slug", slug)
      .eq("is_active", true)
      .maybeSingle() as never,
  );
}

export type Collection = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
};

export async function getCollection(slug: string): Promise<Collection | null> {
  return maybeRow<Collection>(
    `getCollection(${slug})`,
    db()
      .from("collections")
      .select("id, name, slug, description")
      .eq("slug", slug)
      .eq("is_active", true)
      .maybeSingle(),
  );
}

export async function listCollectionSlugs(): Promise<string[]> {
  const data = await rows<{ slug: string }>(
    "listCollectionSlugs",
    db().from("collections").select("slug").eq("is_active", true),
  );
  return data.map((row) => row.slug);
}

/** The "You may also like" rail: same category, never the product you are on. */
export async function getRelatedProducts(
  product: ProductDetail,
  limit = 4,
): Promise<ProductSummary[]> {
  if (!product.categorySlug) return [];
  const { products } = await listProducts({
    categorySlug: product.categorySlug,
    perPage: limit + 1,
  });
  return products.filter((p) => p.id !== product.id).slice(0, limit);
}

export type CategoryTile = {
  name: string;
  slug: string;
  description: string | null;
  productCount: number;
  imageUrl: string | null;
  imageAlt: string;
};

/**
 * Tiles for the homepage's category grid.
 *
 * Two round trips whatever the tile count: the categories, and one column of
 * live products to count against. The previous shape ran a full listing query
 * per tile — three tiles, three paginated catalog queries, on the busiest page
 * on the site.
 */
export async function getCategoryTiles(slugs: string[]): Promise<CategoryTile[]> {
  const supabase = db();

  const [categories, live] = await Promise.all([
    rows<{
      id: string;
      name: string;
      slug: string;
      description: string | null;
      image_url: string | null;
      parent_id: string | null;
    }>(
      "getCategoryTiles categories",
      supabase
        .from("categories")
        .select("id, name, slug, description, image_url, parent_id")
        .eq("is_active", true),
    ),
    rows<{ category_id: string | null }>(
      "getCategoryTiles counts",
      supabase
        .from("products")
        .select("category_id")
        .eq("is_active", true)
        .is("deleted_at", null),
    ),
  ]);

  const directCount = new Map<string, number>();
  for (const row of live) {
    if (!row.category_id) continue;
    directCount.set(row.category_id, (directCount.get(row.category_id) ?? 0) + 1);
  }

  const bySlug = new Map(categories.map((c) => [c.slug, c]));

  return slugs
    .map((slug) => bySlug.get(slug))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .map((category) => {
      // A top-level category holds nothing directly; its products sit in its
      // children, and "Men (20)" is the number a customer expects to see.
      const children = categories.filter((c) => c.parent_id === category.id);
      const productCount =
        (directCount.get(category.id) ?? 0) +
        children.reduce((sum, child) => sum + (directCount.get(child.id) ?? 0), 0);

      return {
        name: category.name,
        slug: category.slug,
        description: category.description,
        productCount,
        imageUrl: category.image_url,
        imageAlt: `${category.name} footwear at Foot Vault`,
      };
    });
}

/** The featured products the hero collages. */
export async function getFeaturedProducts(limit = 3): Promise<ProductSummary[]> {
  const data = await rows<RawProduct>(
    "getFeaturedProducts",
    db()
      .from("products")
      .select(PRODUCT_FIELDS)
      .eq("is_active", true)
      .eq("is_featured", true)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(limit) as never,
  );
  return data.map(toSummary);
}

/** Brands with something live in them, for the search page's escape hatches. */
export async function getPopularBrands(limit = 8): Promise<Facet[]> {
  const { facets } = await listProducts({ perPage: 1 });
  return [...facets.brands].sort((a, b) => b.count - a.count).slice(0, limit);
}
