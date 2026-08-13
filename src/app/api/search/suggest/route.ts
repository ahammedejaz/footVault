import { NextResponse } from "next/server";

import { listProducts } from "@/lib/queries/catalog";
import { callerIp, consumeRateLimit } from "@/lib/rate-limit";

/**
 * Type-ahead for the search overlay.
 *
 * A route handler rather than a Server Action: this is a read, it is called on
 * a keystroke cadence, and it wants to be cancellable — things an action is
 * not. It runs the same trigram query the /search page runs, so what the
 * overlay promises is what the results page delivers.
 *
 * ## The ceiling, and the `revalidate` that was not one
 *
 * This file carried `export const revalidate = 60`, and it was read — in a
 * security audit — as meaning repeated queries were served from a cache and
 * only a varying `q` reached the database. It cached nothing. The route is
 * dynamic and appears in no prerender entry, so every request was already a
 * trigram query, including identical ones a second apart. Removed rather than
 * left in place, because a line that looks like protection and is not is worse
 * than no line at all.
 *
 * So this is the first ceiling the endpoint has had: the one public GET that
 * reaches the database on a keystroke cadence, previously unbounded. See
 * `searchSuggest` in `src/lib/rate-limit.ts` for the numbers and the keying.
 */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (query.length < 2) {
    return NextResponse.json({ query, results: [] });
  }

  /*
    After the length check and before the query, so the cheap rejection of a
    one-character term does not spend anybody's allowance, and so nothing
    reaches `catalog_query` without passing here first.
  */
  const throttle = await consumeRateLimit("searchSuggest", await callerIp());
  if (!throttle.allowed) {
    return NextResponse.json(
      { query, results: [], total: 0 },
      {
        status: 429,
        headers: { "retry-after": String(throttle.retryAfterSeconds) },
      },
    );
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
