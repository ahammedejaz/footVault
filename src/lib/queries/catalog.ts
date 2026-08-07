import "server-only";

import { compareSizes } from "@/lib/sizes";
import { createClient } from "@/lib/supabase/server";
import { createStaticClient } from "@/lib/supabase/static";
import type {
  FootwearType,
  Gender,
  ProductColor,
  ProductDetail,
  ProductSummary,
} from "@/lib/catalog-types";

/**
 * Throw on a PostgREST error instead of treating it as "no rows".
 *
 * Destructuring only `{ data }` makes a failed query indistinguishable from an
 * empty one — which is how a malformed embed hint in getCategory() turned every
 * category page into a 404 rather than an error anyone would notice. Anything
 * that can 404 a page has to be able to tell the two apart.
 */
function unwrap<T>(result: { data: T; error: { message: string } | null }, what: string): T {
  if (result.error) {
    throw new Error(`${what}: ${result.error.message}`);
  }
  return result.data;
}

export type {
  FootwearType,
  Gender,
  ProductColor,
  ProductDetail,
  ProductSummary,
  SizeAvailability,
} from "@/lib/catalog-types";

/**
 * One shape for every product read.
 *
 * The variants come back in full even when a size filter is active: the size
 * run has to show the whole run with the missing sizes struck through, so a
 * query that returned only matching sizes would quietly turn the signature
 * element into a lie. Filtering by size therefore narrows *which products* come
 * back, never which sizes are shown on them.
 */
const PRODUCT_FIELDS = `
  id, slug, name, description, material, gender, footwear_type,
  base_price, sale_price, effective_price, meta_title, meta_description, created_at,
  brand:brands ( name, slug ),
  category:categories ( name, slug ),
  images:product_images ( url, alt_text, sort_order, is_primary ),
  variants:product_variants ( id, size, color, color_hex, sku, stock_quantity, is_active )
` as const;

type RawProduct = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  material: string | null;
  gender: Gender;
  footwear_type: FootwearType;
  base_price: number;
  sale_price: number | null;
  effective_price: number;
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
  }>;
  variants: Array<{
    id: string;
    size: string;
    color: string;
    color_hex: string | null;
    sku: string;
    stock_quantity: number;
    is_active: boolean;
  }>;
};

function toSummary(row: RawProduct): ProductSummary {
  const images = [...row.images].sort(
    (a, b) => Number(b.is_primary) - Number(a.is_primary) || a.sort_order - b.sort_order,
  );

  // Stock is summed across colourways: a customer scanning a grid wants to know
  // whether the shop has their size at all, not whether it has it in the colour
  // that happens to be photographed.
  const stockBySize = new Map<string, number>();
  for (const variant of row.variants) {
    if (!variant.is_active) continue;
    stockBySize.set(
      variant.size,
      (stockBySize.get(variant.size) ?? 0) + variant.stock_quantity,
    );
  }

  const sizes = [...stockBySize.entries()]
    .sort((a, b) => compareSizes(a[0], b[0]))
    .map(([size, stock]) => ({ size, stock, available: stock > 0 }));

  const colors: ProductColor[] = [];
  for (const variant of row.variants) {
    if (colors.some((c) => c.name === variant.color)) continue;
    colors.push({ name: variant.color, hex: variant.color_hex });
  }

  const image = (index: number) =>
    images[index]
      ? { url: images[index]!.url, alt: images[index]!.alt_text ?? row.name }
      : null;

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
    heroImage: image(0),
    soleImage: image(1),
    sizes,
    colors,
    inStock: sizes.some((s) => s.available),
  };
}

function toDetail(row: RawProduct): ProductDetail {
  return {
    ...toSummary(row),
    description: row.description,
    material: row.material,
    metaTitle: row.meta_title,
    metaDescription: row.meta_description,
    images: [...row.images]
      .sort(
        (a, b) =>
          Number(b.is_primary) - Number(a.is_primary) || a.sort_order - b.sort_order,
      )
      .map((i) => ({ url: i.url, alt: i.alt_text ?? row.name })),
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

export type SortKey = "newest" | "price-asc" | "price-desc";

export type ProductFilters = {
  categorySlug?: string;
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
};

/**
 * Size, colour and in-stock are properties of a *variant*, not of a product, so
 * they are resolved in a first pass that reduces them to a set of product ids.
 *
 * Doing it this way rather than with an inner-joined embed keeps the count
 * honest: PostgREST's exact count on a joined query counts joined rows, so a
 * shoe available in four sizes would count four times and the pagination would
 * promise pages that do not exist.
 */
async function productIdsMatchingVariants(
  supabase: Awaited<ReturnType<typeof createClient>>,
  filters: ProductFilters,
): Promise<string[] | null> {
  const { sizes, colors, inStockOnly } = filters;
  if (!sizes?.length && !colors?.length && !inStockOnly) return null;

  let query = supabase.from("product_variants").select("product_id").eq("is_active", true);
  if (sizes?.length) query = query.in("size", sizes);
  if (colors?.length) query = query.in("color", colors);
  if (inStockOnly || sizes?.length) query = query.gt("stock_quantity", 0);

  const { data, error } = await query;
  if (error) throw error;
  return [...new Set((data ?? []).map((row) => row.product_id))];
}

export async function listProducts(filters: ProductFilters = {}): Promise<ProductPage> {
  const supabase = await createClient();
  const perPage = filters.perPage ?? PRODUCTS_PER_PAGE;
  const page = Math.max(1, filters.page ?? 1);

  const variantIds = await productIdsMatchingVariants(supabase, filters);
  // An empty array means the variant filters matched nothing. Short-circuit:
  // `.in("id", [])` is a valid query but the intent is clearer stated here.
  if (variantIds?.length === 0) {
    return { products: [], total: 0, page, perPage, pageCount: 0 };
  }

  let query = supabase
    .from("products")
    .select(PRODUCT_FIELDS, { count: "exact" })
    .eq("is_active", true)
    .is("deleted_at", null);

  if (variantIds) query = query.in("id", variantIds);
  if (filters.gender) query = query.eq("gender", filters.gender);
  if (filters.footwearType) query = query.eq("footwear_type", filters.footwearType);
  if (filters.minPrice !== undefined) query = query.gte("effective_price", filters.minPrice);
  if (filters.maxPrice !== undefined) query = query.lte("effective_price", filters.maxPrice);
  if (filters.onSale) query = query.not("sale_price", "is", null);
  // Trigram index on products.name makes the leading wildcard an index scan.
  if (filters.search) query = query.ilike("name", `%${filters.search}%`);

  if (filters.categorySlug) {
    const ids = await descendantCategoryIds(supabase, filters.categorySlug);
    if (ids.length === 0) {
      return { products: [], total: 0, page, perPage, pageCount: 0 };
    }
    query = query.in("category_id", ids);
  }

  if (filters.brandSlugs?.length) {
    const brands = unwrap(
      await supabase.from("brands").select("id").in("slug", filters.brandSlugs),
      "listProducts brand lookup",
    );
    const ids = (brands ?? []).map((b) => b.id);
    if (ids.length === 0) {
      return { products: [], total: 0, page, perPage, pageCount: 0 };
    }
    query = query.in("brand_id", ids);
  }

  switch (filters.sort) {
    case "price-asc":
      query = query.order("effective_price", { ascending: true });
      break;
    case "price-desc":
      query = query.order("effective_price", { ascending: false });
      break;
    default:
      query = query.order("created_at", { ascending: false });
  }
  // A stable tiebreak, so a product does not swap pages between requests when
  // several share a price.
  query = query.order("id", { ascending: true });

  const from = (page - 1) * perPage;
  const { data, error, count } = await query.range(from, from + perPage - 1);
  if (error) throw error;

  const total = count ?? 0;
  return {
    products: (data as unknown as RawProduct[]).map(toSummary),
    total,
    page,
    perPage,
    pageCount: Math.max(1, Math.ceil(total / perPage)),
  };
}

/**
 * A category page shows the category's own products plus everything in its
 * children — /shop/men lists men's sneakers, formal and sandals together, which
 * is what a customer clicking "Men" expects.
 */
async function descendantCategoryIds(
  supabase: Awaited<ReturnType<typeof createClient>>,
  slug: string,
): Promise<string[]> {
  const root = unwrap(
    await supabase.from("categories").select("id").eq("slug", slug).maybeSingle(),
    `descendantCategoryIds(${slug})`,
  );
  if (!root) return [];

  const children = unwrap(
    await supabase.from("categories").select("id").eq("parent_id", root.id),
    "descendantCategoryIds children",
  );

  return [root.id, ...(children ?? []).map((c) => c.id)];
}

export async function getProduct(slug: string): Promise<ProductDetail | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("products")
    .select(PRODUCT_FIELDS)
    .eq("slug", slug)
    .eq("is_active", true)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) throw error;
  return data ? toDetail(data as unknown as RawProduct) : null;
}

export async function listProductSlugs(): Promise<string[]> {
  const supabase = createStaticClient();
  const data = unwrap(
    await supabase
      .from("products")
      .select("slug")
      .eq("is_active", true)
      .is("deleted_at", null),
    "listProductSlugs",
  );
  return (data ?? []).map((row) => row.slug);
}

export type CategoryNode = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  children: CategoryNode[];
};

export async function getCategoryTree(): Promise<CategoryNode[]> {
  const supabase = createStaticClient();
  const rows = unwrap(
    await supabase
      .from("categories")
      .select("id, name, slug, description, parent_id, sort_order")
      .eq("is_active", true)
      .order("sort_order"),
    "getCategoryTree",
  ) ?? [];
  const byId = new Map(
    rows.map((row) => [
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
  for (const row of rows) {
    const node = byId.get(row.id)!;
    const parent = row.parent_id ? byId.get(row.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export async function getCategory(slug: string) {
  const supabase = await createClient();
  // PostgREST disambiguates a self-referencing embed by the column, not by the
  // constraint name: `parent:categories!categories_parent_id_fkey` is rejected
  // with PGRST200, and `parent:parent_id` is what resolves.
  return unwrap(
    await supabase
      .from("categories")
      .select("id, name, slug, description, parent:parent_id ( name, slug )")
      .eq("slug", slug)
      .eq("is_active", true)
      .maybeSingle(),
    `getCategory(${slug})`,
  );
}

/**
 * The facets for the filter panel.
 *
 * Scoped to the listing being filtered, not to the whole catalog. On
 * /shop/men the global facet list offered kids' sizes 10C–13C, and picking one
 * returned an empty grid — a filter that can only produce no results is worse
 * than no filter. Passing the category narrows sizes, colours and brands to
 * what that listing actually contains.
 */
export async function getFilterFacets(scope: { categorySlug?: string } = {}) {
  const supabase = await createClient();

  let productIds: string[] | null = null;
  if (scope.categorySlug) {
    const categoryIds = await descendantCategoryIds(supabase, scope.categorySlug);
    const rows = unwrap(
      await supabase
        .from("products")
        .select("id")
        .in("category_id", categoryIds)
        .eq("is_active", true)
        .is("deleted_at", null),
      "getFilterFacets products",
    );
    productIds = (rows ?? []).map((row) => row.id);
    if (productIds.length === 0) return { sizes: [], colors: [], brands: [] };
  }

  let variantQuery = supabase
    .from("product_variants")
    .select("size, color, color_hex")
    .eq("is_active", true);
  if (productIds) variantQuery = variantQuery.in("product_id", productIds);

  const brandQuery = supabase
    .from("brands")
    .select("name, slug, id")
    .eq("is_active", true)
    .order("name");

  const [variantResult, brandResult, scopedBrandIds] = await Promise.all([
    variantQuery,
    brandQuery,
    productIds
      ? supabase
          .from("products")
          .select("brand_id")
          .in("id", productIds)
          .then((r) => new Set((r.data ?? []).map((row) => row.brand_id)))
      : Promise.resolve(null),
  ]);

  const variants = unwrap(variantResult, "getFilterFacets variants");
  const allBrands = unwrap(brandResult, "getFilterFacets brands");
  const brands = (allBrands ?? [])
    .filter((brand) => !scopedBrandIds || scopedBrandIds.has(brand.id))
    .map(({ name, slug }) => ({ name, slug }));

  const sizes = [...new Set((variants ?? []).map((v) => v.size))].sort(compareSizes);
  const colorMap = new Map<string, string | null>();
  for (const v of variants ?? []) {
    if (!colorMap.has(v.color)) colorMap.set(v.color, v.color_hex);
  }

  return {
    sizes,
    colors: [...colorMap.entries()]
      .map(([name, hex]) => ({ name, hex }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    brands,
  };
}

export async function getCollection(slug: string) {
  const supabase = await createClient();
  const collection = unwrap(
    await supabase
      .from("collections")
      .select("id, name, slug, description")
      .eq("slug", slug)
      .eq("is_active", true)
      .maybeSingle(),
    `getCollection(${slug})`,
  );
  if (!collection) return null;

  const members = unwrap(
    await supabase
      .from("collection_products")
      .select(`sort_order, product:products ( ${PRODUCT_FIELDS} )`)
      .eq("collection_id", collection.id)
      .order("sort_order"),
    "getCollection members",
  );

  const products = (members ?? [])
    .map((row) => row.product as unknown as RawProduct | null)
    .filter((row): row is RawProduct => Boolean(row))
    .map(toSummary);

  return { ...collection, products };
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
  /** The primary image of the newest product in the category. */
  imageUrl: string | null;
};

/**
 * Tiles for the homepage's category grid.
 *
 * categories.image_url is empty until the owner uploads one from
 * /admin/categories, so the tile borrows the newest product's hero shot in the
 * meantime. The grid therefore looks like a shop from the first seed rather
 * than like three grey rectangles waiting for an upload.
 */
export async function getCategoryTiles(slugs: string[]): Promise<CategoryTile[]> {
  const supabase = await createClient();
  const categories = unwrap(
    await supabase
      .from("categories")
      .select("id, name, slug, description, image_url")
      .in("slug", slugs)
      .eq("is_active", true),
    "getCategoryTiles",
  );

  const bySlug = new Map((categories ?? []).map((c) => [c.slug, c]));

  return Promise.all(
    // Ordered by the payload the owner saved, not by the database's order.
    slugs
      .map((slug) => bySlug.get(slug))
      .filter((c): c is NonNullable<typeof c> => Boolean(c))
      .map(async (category) => {
        const { products, total } = await listProducts({
          categorySlug: category.slug,
          perPage: 1,
        });
        return {
          name: category.name,
          slug: category.slug,
          description: category.description,
          productCount: total,
          imageUrl: category.image_url ?? products[0]?.heroImage?.url ?? null,
        };
      }),
  );
}

/** The featured products the hero collages. */
export async function getFeaturedProducts(limit = 3): Promise<ProductSummary[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("products")
    .select(PRODUCT_FIELDS)
    .eq("is_active", true)
    .eq("is_featured", true)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data as unknown as RawProduct[]).map(toSummary);
}
