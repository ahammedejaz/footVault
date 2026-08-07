import type { Metadata } from "next";
import Link from "next/link";
import { Search } from "lucide-react";

import { ProductListing } from "@/components/storefront/product-listing";
import type { RawSearchParams } from "@/lib/queries/search-params";

export const metadata: Metadata = {
  title: "Search",
  // A search results page is not something a search engine should index.
  robots: { index: false, follow: true },
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  const query = (Array.isArray(params.q) ? params.q[0] : params.q)?.trim() ?? "";

  if (!query) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
        <h1 className="font-display text-4xl font-extrabold tracking-[-0.03em] uppercase">
          Search
        </h1>
        <form action="/search" className="mt-8 flex gap-2">
          <label htmlFor="q" className="sr-only">
            Search for a shoe
          </label>
          <input
            id="q"
            name="q"
            type="search"
            autoFocus
            placeholder="Try a brand, or a model name"
            className="border-input bg-background h-12 flex-1 rounded-lg border px-4 text-base outline-none"
          />
          <button
            type="submit"
            className="bg-primary text-primary-foreground inline-flex h-12 items-center gap-2 rounded-lg px-5 font-medium"
          >
            <Search className="size-4" aria-hidden />
            Search
          </button>
        </form>
        <p className="text-muted-foreground mt-4 text-sm">
          Or browse{" "}
          <Link href="/shop" className="text-orange-ink underline underline-offset-4">
            everything we hold
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <ProductListing
      params={params}
      pathname="/search"
      title={`“${query}”`}
      description="Matching the product name. Filters narrow the results further."
      emptyBody={`Nothing in the shop is called “${query}”. Try a brand on its own — Nike, Bata, Crocs — or browse the full catalog.`}
    />
  );
}
