import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ProductListing } from "@/components/storefront/product-listing";
import { getCategory, getCategoryTree } from "@/lib/queries/catalog";
import { staticParamsOr } from "@/lib/static-params";
import type { RawSearchParams } from "@/lib/queries/search-params";

export const revalidate = 600;

/**
 * Pre-rendered at build time. There are fifteen categories and they change
 * rarely, so the listing is static until an admin edit revalidates it.
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
  return {
    title: category.name,
    description: category.description ?? undefined,
    alternates: { canonical: `/shop/${category.slug}` },
  };
}

export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ category: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const [{ category: slug }, search] = await Promise.all([params, searchParams]);
  const category = await getCategory(slug);
  if (!category) notFound();

  const { parent } = category;

  return (
    <>
      <nav
        aria-label="Breadcrumb"
        className="mx-auto max-w-7xl px-4 pt-8 sm:px-6"
      >
        <ol className="text-muted-foreground flex flex-wrap items-center gap-1.5 font-mono text-xs tracking-[0.06em]">
          <li>
            <Link href="/shop" className="hover:text-foreground">
              Shop
            </Link>
          </li>
          {parent ? (
            <>
              <li aria-hidden>/</li>
              <li>
                <Link href={`/shop/${parent.slug}`} className="hover:text-foreground">
                  {parent.name}
                </Link>
              </li>
            </>
          ) : null}
          <li aria-hidden>/</li>
          <li className="text-foreground">{category.name}</li>
        </ol>
      </nav>

      <ProductListing
        params={search}
        pathname={`/shop/${category.slug}`}
        overrides={{ categorySlug: category.slug }}
        title={parent ? `${parent.name} · ${category.name}` : category.name}
        description={category.description}
      />
    </>
  );
}
