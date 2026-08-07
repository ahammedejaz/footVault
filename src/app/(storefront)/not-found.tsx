import { NotFoundBody } from "@/components/storefront/not-found-body";

/**
 * The 404 for anything inside the storefront group.
 *
 * Bare, because the group's layout has already rendered the header, the
 * navigation and the footer. Without this file Next falls back to
 * `src/app/not-found.tsx`, which supplies its own `StorefrontChrome` — and a
 * `notFound()` raised by `/order/[orderNumber]` or `/account/orders/[id]` then
 * renders the entire storefront a second time, nested inside the first.
 *
 * `product/[slug]/not-found.tsx` already worked this way, which is why the
 * defect showed up on the Phase 5 routes and not on a dead product URL.
 */
export default function StorefrontNotFound() {
  return <NotFoundBody />;
}
