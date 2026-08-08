import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Breadcrumbs } from "@/components/storefront/breadcrumbs";
import { ProductListing } from "@/components/storefront/product-listing";
import { getCategory, getCategoryTree } from "@/lib/queries/catalog";
import { staticParamsOr } from "@/lib/static-params";
import type { RawSearchParams } from "@/lib/queries/search-params";

/**
 * Pre-rendered params, but a dynamic render: the filters live in the query
 * string, and a page that reads the query string cannot be static. What
 * generateStaticParams still buys is a warm route on the first request.
 */
export async function generateStaticParams() {
  return staticParamsOr("categories", async () => {
    const tree = await getCategoryTree();
    return tree.flatMap((node) => [
      { category: node.slug },
      ...node.children.map((child) => ({ category: child.slug })),
    ]);
  });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ category: string }>;
}): Promise<Metadata> {
  const { category: slug } = await params;
  const category = await getCategory(slug);
  if (!category) return {};
  const title = category.parent
    ? `${category.parent.name} · ${category.name}`
    : category.name;
  return {
    title,
    description:
      category.description ??
      `${title} at Foot Vault. Every size we hold, shown on every shoe.`,
    // Canonical without the query string: a filtered listing is the same page
    // with a narrower view, not a page of its own to be indexed.
    alternates: { canonical: `/shop/${category.slug}` },
    openGraph: { title, description: category.description ?? undefined },
  };
}

export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ category: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const [{ category: slug }, search] = await Promise.all([
    params,
    searchParams,
  ]);
  const category = await getCategory(slug);
  if (!category) notFound();

  const { parent } = category;

  return (
    <>
      <div className="mx-auto max-w-7xl px-4 pt-6 sm:px-6">
        <Breadcrumbs
          crumbs={[
            { label: "Home", href: "/" },
            { label: "Shop", href: "/shop" },
            ...(parent
              ? [{ label: parent.name, href: `/shop/${parent.slug}` }]
              : []),
            { label: category.name },
          ]}
        />
      </div>

      <ProductListing
        params={search}
        pathname={`/shop/${category.slug}`}
        overrides={{ categorySlug: category.slug }}
        eyebrow={parent?.name}
        heading={category.name}
        description={category.description}
        escape={
          parent
            ? {
                href: `/shop/${parent.slug}`,
                label: `Browse all of ${parent.name}`,
              }
            : { href: "/shop", label: "Browse all footwear" }
        }
      />
    </>
  );
}
