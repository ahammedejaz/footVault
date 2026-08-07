import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/env";
import {
  getCategoryTree,
  listCollectionSlugs,
  listProductSlugs,
} from "@/lib/queries/catalog";
import { listPageSlugs } from "@/lib/queries/content";
import { staticParamsOr } from "@/lib/static-params";

/**
 * The sitemap is generated from the database, so a product the owner adds is
 * discoverable without anyone touching this file.
 *
 * /cart, /wishlist and /search are deliberately absent: they are per-visitor or
 * effectively infinite, and each already carries `robots: noindex`.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const url = (path: string) => new URL(path, SITE_URL).toString();

  // Same reasoning as generateStaticParams: an unreachable catalog degrades the
  // sitemap to its static routes rather than failing the build.
  const [productSlugs, pageSlugs, collectionSlugs, tree] = await Promise.all([
    staticParamsOr("sitemap products", listProductSlugs),
    staticParamsOr("sitemap pages", listPageSlugs),
    staticParamsOr("sitemap collections", listCollectionSlugs),
    staticParamsOr("sitemap categories", getCategoryTree),
  ]);

  const categories = tree.flatMap((node) => [
    node.slug,
    ...node.children.map((child) => child.slug),
  ]);

  return [
    { url: url("/"), changeFrequency: "daily", priority: 1 },
    { url: url("/shop"), changeFrequency: "daily", priority: 0.9 },
    ...categories.map((slug) => ({
      url: url(`/shop/${slug}`),
      changeFrequency: "daily" as const,
      priority: 0.8,
    })),
    ...collectionSlugs.map((slug) => ({
      url: url(`/collection/${slug}`),
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
    ...productSlugs.map((slug) => ({
      url: url(`/product/${slug}`),
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
    ...pageSlugs.map((slug) => ({
      url: url(`/page/${slug}`),
      changeFrequency: "monthly" as const,
      priority: 0.4,
    })),
  ];
}
