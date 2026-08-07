import "server-only";

import { unstable_cache } from "next/cache";

import {
  getCategoryTiles,
  getCategoryTree,
  getCollection,
  getPopularBrands,
  getProduct,
  listProducts,
  type ProductDetail,
  type ProductSummary,
} from "@/lib/queries/catalog";
import {
  getBanner,
  getHomepageSections,
  getPage,
  getSiteSettings,
  listPages,
} from "@/lib/queries/content";

/**
 * The chrome's data, cached across requests.
 *
 * The header, the footer and the announcement bar are the same for every
 * visitor, but they sit in the layout — so before Phase 4 they were rendered
 * once per ISR window and after it they are rendered once per *request*, because
 * the announcement bar now reads a cookie and a cookie read makes the route
 * dynamic (see src/lib/announcement.ts for why that trade was taken).
 *
 * Dynamic rendering is cheap. Four database round trips in front of the LCP
 * element on every route of the site is not, and that is what this would have
 * cost: the category tree twice, the popular brands, the settings and the page
 * list. Caching the *data* separates the two — the render is per-request, the
 * queries are not, and nothing on the LCP path waits for Postgres.
 *
 * Every read below is public catalog or site content fetched through the
 * cookieless client, so there is nothing per-visitor to leak into a shared
 * cache entry. Anything scoped to a signed-in customer must not be added here.
 *
 * `revalidate` matches the hour the pages already used. The tag is the seam
 * Phase 7 revalidates when the owner edits settings or reorders the navigation,
 * so a change is live without waiting out the window.
 */
export const CHROME_CACHE_TAG = "chrome";

const ONE_HOUR = 3600;
const options = { revalidate: ONE_HOUR, tags: [CHROME_CACHE_TAG] };

export const cachedCategoryTree = unstable_cache(
  getCategoryTree,
  ["chrome:category-tree"],
  options,
);

export const cachedPopularBrands = unstable_cache(
  (limit: number) => getPopularBrands(limit),
  ["chrome:popular-brands"],
  options,
);

export const cachedSiteSettings = unstable_cache(
  getSiteSettings,
  ["chrome:site-settings"],
  options,
);

export const cachedPages = unstable_cache(listPages, ["chrome:pages"], options);

/* -------------------------------------------------------------------------- */
/* the LCP path                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The reads behind the three routes that used to be statically rendered.
 *
 * `/`, `/product/[slug]` and `/page/[slug]` were prerendered at build time with
 * an hourly revalidate, which is why nothing on them waited for Postgres. They
 * are dynamic now — the layout reads a cookie — so without this every one of
 * those queries would run again on every request, in front of the hero image.
 *
 * Caching the data restores the property that mattered. The hourly window is
 * the same one `export const revalidate = 3600` gave them; the tag is what
 * Phase 6 and 7 revalidate when the owner edits a product or republishes the
 * homepage, so a change is live immediately rather than within the hour.
 *
 * Deliberately *not* cached: `/shop` and `/search`. Their filters come from the
 * query string, so a cache keyed on them has an unbounded number of keys, and
 * both routes were already dynamic before this change — there is nothing to
 * restore and a real cost to caching. `listProducts` is exposed here only
 * through the two bounded shapes below.
 */
export const CATALOG_CACHE_TAG = "catalog";

const catalog = { revalidate: ONE_HOUR, tags: [CATALOG_CACHE_TAG] };

export const cachedHomepageSections = unstable_cache(
  getHomepageSections,
  ["catalog:homepage-sections"],
  catalog,
);

export const cachedBanner = unstable_cache(
  (placement: string) => getBanner(placement),
  ["catalog:banner"],
  catalog,
);

export const cachedCategoryTiles = unstable_cache(
  (slugs: string[]) => getCategoryTiles(slugs),
  ["catalog:category-tiles"],
  catalog,
);

export const cachedCollection = unstable_cache(
  (slug: string) => getCollection(slug),
  ["catalog:collection"],
  catalog,
);

export const cachedProduct = unstable_cache(
  (slug: string) => getProduct(slug),
  ["catalog:product"],
  catalog,
);

export const cachedPage = unstable_cache(
  (slug: string) => getPage(slug),
  ["catalog:page"],
  catalog,
);

/** One collection's rail. Bounded: one key per collection. */
export const cachedCollectionProducts = unstable_cache(
  (collectionSlug: string, perPage: number) => listProducts({ collectionSlug, perPage }),
  ["catalog:collection-products"],
  catalog,
);

/** One category's first page. Bounded: one key per category. */
const cachedCategoryProducts = unstable_cache(
  (categorySlug: string, perPage: number) => listProducts({ categorySlug, perPage }),
  ["catalog:category-products"],
  catalog,
);

/**
 * "You may also like".
 *
 * The exclusion of the product being viewed happens *outside* the cache, so the
 * key stays `(categorySlug, limit)` rather than gaining a per-product entry for
 * what is the same query underneath.
 */
export async function cachedRelatedProducts(
  product: ProductDetail,
  limit = 4,
): Promise<ProductSummary[]> {
  if (!product.categorySlug) return [];
  const { products } = await cachedCategoryProducts(product.categorySlug, limit + 1);
  return products.filter((p) => p.id !== product.id).slice(0, limit);
}
