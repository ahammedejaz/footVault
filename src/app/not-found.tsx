import { StorefrontChrome } from "@/components/storefront/chrome";
import { NotFoundBody } from "@/components/storefront/not-found-body";

/**
 * The catch-all 404, for URLs outside every route group.
 *
 * Wearing the full storefront chrome on purpose: a customer who mistypes a URL
 * or follows a stale link should land somewhere that still has the navigation,
 * the search and the footer on it. A bare error card is a dead end, and it is
 * also a document with no `main` landmark.
 *
 * Anything *inside* `(storefront)` is served by
 * `src/app/(storefront)/not-found.tsx` instead, which renders the same body
 * without the chrome the group layout has already drawn.
 */
export default function NotFound() {
  return (
    <StorefrontChrome>
      <NotFoundBody />
    </StorefrontChrome>
  );
}
