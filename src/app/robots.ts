import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/env";
import { isIndexable } from "@/lib/indexing";

/**
 * Two layers, and they are not redundant.
 *
 * `X-Robots-Tag: noindex` (set site-wide in `next.config.ts`) is an
 * *instruction on a page a crawler has already fetched*. This file stops the
 * fetch happening at all. A crawler that respects only one of the two is still
 * handled, and the sitemap is withheld rather than advertising every URL we are
 * asking not to be indexed.
 *
 * Both read the same `SITE_INDEXABLE` gate, so they cannot disagree.
 */
export default function robots(): MetadataRoute.Robots {
  if (!isIndexable()) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Per-visitor or infinite. Nothing here is worth a crawl budget, and the
      // matching pages carry `robots: noindex` in their metadata too.
      disallow: [
        "/cart",
        "/wishlist",
        "/search",
        "/account",
        "/admin",
        "/checkout",
        "/order",
      ],
    },
    sitemap: new URL("/sitemap.xml", SITE_URL).toString(),
  };
}
