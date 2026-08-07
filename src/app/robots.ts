import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/env";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Per-visitor or infinite. Nothing here is worth a crawl budget, and the
      // matching pages carry `robots: noindex` in their metadata too.
      disallow: ["/cart", "/wishlist", "/search", "/account", "/admin"],
    },
    sitemap: new URL("/sitemap.xml", SITE_URL).toString(),
  };
}
