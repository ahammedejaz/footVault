import type { Metadata } from "next";
import Link from "next/link";
import { Search } from "lucide-react";

import { Breadcrumbs } from "@/components/storefront/breadcrumbs";
import { ProductListing } from "@/components/storefront/product-listing";
import { getCategoryTree, getPopularBrands } from "@/lib/queries/catalog";
import { first, type RawSearchParams } from "@/lib/queries/search-params";

export const metadata: Metadata = {
  title: "Search",
  // A results page is per-visitor and effectively infinite; nothing here is
  // worth a crawl budget, and robots.ts disallows it too.
  robots: { index: false, follow: true },
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  const query = first(params.q)?.trim() ?? "";

  if (!query) return <SearchLanding />;

  return (
    <>
      <div className="mx-auto max-w-7xl px-4 pt-6 sm:px-6">
        <Breadcrumbs
          crumbs={[{ label: "Home", href: "/" }, { label: `Search: ${query}` }]}
        />
      </div>
      <ProductListing
        params={params}
        pathname="/search"
        eyebrow="Search"
        heading={`“${query}”`}
        description="Spelling is forgiven, and a brand on its own works. Filters narrow it further."
        escape={{ href: "/shop", label: "Browse all footwear" }}
      />
    </>
  );
}

/**
 * The empty search page.
 *
 * A bare input on an empty page is a dead end for anybody who does not already
 * know what they want. The departments and the brands the shop actually stocks
 * are the way out, and they come from the database rather than a list here, so
 * they cannot go stale.
 */
async function SearchLanding() {
  const [tree, brands] = await Promise.all([
    getCategoryTree(),
    getPopularBrands(8),
  ]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
      <h1 className="font-display text-4xl font-extrabold tracking-[-0.03em] uppercase">
        Search
      </h1>

      <form action="/search" role="search" className="mt-8 flex gap-2">
        <label htmlFor="q" className="sr-only">
          Search for a brand, a model or a category
        </label>
        <input
          id="q"
          name="q"
          type="search"
          autoFocus
          placeholder="Try a brand, a model, or “running”"
          className="border-input bg-background h-12 min-w-0 flex-1 rounded-lg border px-4 text-base"
        />
        <button
          type="submit"
          className="bg-primary text-primary-foreground inline-flex h-12 shrink-0 items-center gap-2 rounded-lg px-5 font-semibold"
        >
          <Search className="size-4" aria-hidden />
          Search
        </button>
      </form>

      <section className="mt-12" aria-labelledby="departments">
        <h2
          id="departments"
          className="text-muted-foreground font-mono text-xs tracking-[0.06em] uppercase"
        >
          Departments
        </h2>
        <ul className="mt-3 flex flex-wrap gap-2">
          {tree.map((node) => (
            <li key={node.slug}>
              <Link
                href={`/shop/${node.slug}`}
                className="border-border hover:border-foreground inline-flex min-h-11 items-center rounded-lg border px-4 text-sm transition-colors"
              >
                {node.name}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8" aria-labelledby="brands">
        <h2
          id="brands"
          className="text-muted-foreground font-mono text-xs tracking-[0.06em] uppercase"
        >
          Brands we stock
        </h2>
        <ul className="mt-3 flex flex-wrap gap-2">
          {brands.map((brand) => (
            <li key={brand.value}>
              <Link
                href={`/shop?brand=${brand.value}`}
                className="border-border hover:border-foreground inline-flex min-h-11 items-center gap-2 rounded-lg border px-4 text-sm transition-colors"
              >
                {brand.label}
                <span className="text-dim font-mono text-xs">
                  {brand.count}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <p className="text-muted-foreground mt-10 text-sm">
        Or{" "}
        <Link
          href="/shop"
          className="text-orange-ink underline underline-offset-4"
        >
          browse everything we hold
        </Link>
        .
      </p>
    </div>
  );
}
