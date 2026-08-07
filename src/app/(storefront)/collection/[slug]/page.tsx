import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/storefront/empty-state";
import { ProductGrid } from "@/components/storefront/product-card";
import { getCollection } from "@/lib/queries/catalog";

export const revalidate = 600;

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
  };
}

/**
 * A curated rail, given its own page.
 *
 * Collections are ordered by the owner, so this page keeps `sort_order` rather
 * than offering a sort — the sequence is the curation.
 */
export default async function CollectionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const collection = await getCollection(slug);
  if (!collection) notFound();

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:py-14">
      <header className="max-w-2xl">
        <p className="text-muted-foreground font-mono text-xs tracking-[0.14em] uppercase">
          Collection
        </p>
        <h1 className="font-display mt-2 text-4xl font-extrabold tracking-[-0.03em] uppercase">
          {collection.name}
        </h1>
        {collection.description ? (
          <p className="text-muted-foreground mt-3 text-base text-pretty">
            {collection.description}
          </p>
        ) : null}
      </header>

      <div className="mt-10">
        {collection.products.length === 0 ? (
          <EmptyState
            title="This rail is empty"
            body="Nothing has been added to this collection yet. The rest of the shop is one tap away."
            action={{ href: "/shop", label: "Shop all footwear" }}
          />
        ) : (
          <ProductGrid products={collection.products} />
        )}
      </div>
    </div>
  );
}
