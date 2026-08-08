/**
 * The routes every audit walks.
 *
 * One list, so the screenshot pass, the overflow pass and the axe pass cannot
 * drift apart and quietly stop covering the same screens.
 *
 * Everything here is reachable by **typing a URL with no history behind you**,
 * which is the limit of what a flat list can say. `/cart` below is the empty
 * bag; `/checkout` is the "nothing to check out" panel. The populated halves of
 * those same routes — and everything that needs a session or a real order —
 * live in ./states.ts, because a bag with three lines in it is not a path.
 */
export type AuditRoute = {
  path: string;
  name: string;
  /** Expected HTTP status. 200 unless the route exists to be missing. */
  status?: number;
};

export const AUDIT_ROUTES: readonly AuditRoute[] = [
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
  {
    path: "/product/asics-gel-kayano-31-wide-womens",
    name: "product-long-name",
  },
  { path: "/search?q=nkie+pegasis", name: "search-typo" },
  { path: "/search?q=zzzzz", name: "search-empty" },
  { path: "/search", name: "search-landing" },
  { path: "/page/about", name: "page" },
  { path: "/cart", name: "cart" },
  { path: "/wishlist", name: "wishlist" },

  // Phase 5. Signed out, so these are the sign-in pitches and the empty states
  // — the versions a search engine or a stranger with a link would see.
  { path: "/checkout", name: "checkout-empty" },
  { path: "/account", name: "account" },
  { path: "/account/orders", name: "account-orders-signed-out" },
  { path: "/account/addresses", name: "account-addresses-signed-out" },

  // Both 404 on purpose. An order number that does not exist and an order id
  // that belongs to somebody else have to render the *same* page, or the 404
  // becomes an oracle for walking the sequential order-number space.
  { path: "/order/FV-2026-99999", name: "order-not-found", status: 404 },
  {
    path: "/account/orders/33333333-3333-4333-8333-333333333333",
    name: "account-order-not-found",
    status: 404,
  },

  { path: "/this-route-does-not-exist", name: "not-found", status: 404 },
];

/** The widths in the quality gate. */
export const AUDIT_WIDTHS = [360, 390, 768, 1024, 1440, 1920] as const;

export const BASE_URL = process.env.AUDIT_BASE_URL ?? "http://localhost:3210";
