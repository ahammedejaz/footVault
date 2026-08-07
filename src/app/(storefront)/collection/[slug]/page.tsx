import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Breadcrumbs } from "@/components/storefront/breadcrumbs";
import { ProductListing } from "@/components/storefront/product-listing";
import { getCollection, listCollectionSlugs } from "@/lib/queries/catalog";
import { staticParamsOr } from "@/lib/static-params";
import type { RawSearchParams } from "@/lib/queries/search-params";

export async function generateStaticParams() {
  return staticParamsOr("collections", async () =>
    (await listCollectionSlugs()).map((slug) => ({ slug })),
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const collection = await getCollection(slug);
  if (!collection) return {};
  return {
    title: collection.name,
    description: collection.description ?? undefined,
    alternates: { canonical: `/collection/${collection.slug}` },
    openGraph: {
      title: collection.name,
      description: collection.description ?? undefined,
    },
  };
}

/**
 * A curated rail, given its own page.
 *
 * It carries the same filters as any other listing — a customer who lands on
 * "Monsoon ready" from the homepage still needs to narrow it to their size,
 * and having the panel here but not there would be an arbitrary difference.
 * The default order is the owner's `sort_order`, because the sequence is the
 * curation.
 */
export default async function CollectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const [{ slug }, search] = await Promise.all([params, searchParams]);
  const collection = await getCollection(slug);
  if (!collection) notFound();

  return (
    <>
      <div className="mx-auto max-w-7xl px-4 pt-6 sm:px-6">
        <Breadcrumbs
          crumbs={[
            { label: "Home", href: "/" },
            { label: "Shop", href: "/shop" },
            { label: collection.name },
          ]}
        />
      </div>
      <ProductListing
        params={search}
        pathname={`/collection/${collection.slug}`}
        overrides={{ collectionSlug: collection.slug }}
        eyebrow="Collection"
        heading={collection.name}
        description={collection.description}
        escape={{ href: "/shop", label: "Browse all footwear" }}
      />
    </>
  );
}
