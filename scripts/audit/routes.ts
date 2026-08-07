/**
 * The routes every audit walks.
 *
 * One list, so the screenshot pass, the overflow pass and the axe pass cannot
 * drift apart and quietly stop covering the same screens.
 */
export const AUDIT_ROUTES = [
  { path: "/", name: "home" },
  { path: "/shop", name: "shop" },
  { path: "/shop/mens-sneakers", name: "category" },
  { path: "/shop/mens-sneakers?size=9&color=Black", name: "category-filtered" },
  { path: "/collection/new-arrivals", name: "collection" },
  { path: "/product/nike-air-max-90-mens", name: "product" },
  // The awkward ones, from the seed: sold out in every size, one size only,
  // and a sixty-six character name.
  { path: "/product/adidas-gazelle-indoor-womens", name: "product-sold-out" },
  { path: "/product/woodland-nubuck-trek-mens", name: "product-one-size" },
  { path: "/product/asics-gel-kayano-31-wide-womens", name: "product-long-name" },
  { path: "/search?q=nkie+pegasis", name: "search-typo" },
  { path: "/search?q=zzzzz", name: "search-empty" },
  { path: "/search", name: "search-landing" },
  { path: "/page/about", name: "page" },
  { path: "/cart", name: "cart" },
  { path: "/wishlist", name: "wishlist" },
  { path: "/this-route-does-not-exist", name: "not-found" },
] as const;

/** The widths in the quality gate. */
export const AUDIT_WIDTHS = [360, 390, 768, 1024, 1440, 1920] as const;

export const BASE_URL = process.env.AUDIT_BASE_URL ?? "http://localhost:3210";
