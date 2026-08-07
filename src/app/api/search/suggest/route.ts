import { NextResponse } from "next/server";

import { listProducts } from "@/lib/queries/catalog";

/**
 * Type-ahead for the search overlay.
 *
 * A route handler rather than a Server Action: this is a read, it is called on
 * a keystroke cadence, and it wants to be cacheable and cancellable — three
 * things an action is not. It runs the same trigram query the /search page
 * runs, so what the overlay promises is what the results page delivers.
 */
export const revalidate = 60;

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (query.length < 2) {
    return NextResponse.json({ query, results: [] });
  }

  const { products, total } = await listProducts({
    search: query,
    sort: "relevance",
    perPage: 6,
  });

  return NextResponse.json({
    query,
    total,
    results: products.map((product) => ({
      slug: product.slug,
      name: product.name,
      brand: product.brandName,
      price: product.salePrice ?? product.basePrice,
      image: product.heroImage?.url ?? null,
      inStock: product.inStock,
    })),
  });
}
