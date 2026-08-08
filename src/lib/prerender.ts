import "server-only";

import { connection } from "next/server";

/**
 * A route that cannot read its data at build time renders on demand instead.
 *
 * Phase 3 made `/`, every product page and the CMS pages static, which is worth
 * a lot — no database round trip in front of the LCP image. It also means those
 * pages are now *rendered during `next build`*, and CI builds with placeholder
 * Supabase credentials on purpose, so that a pull request can be verified
 * without live database access. The first build after the change failed on
 * `getaddrinfo ENOTFOUND placeholder.supabase.co`.
 *
 * The rule is the one `staticParamsOr` already established: at build time there
 * is no customer waiting and no page to get wrong, so degrade; at request time
 * a failure must surface. `connection()` is the primitive that expresses it —
 * it aborts the prerender and marks the route dynamic, so the build succeeds
 * and the page is rendered per request instead of being baked with whatever
 * fallback happened to be lying around.
 *
 * This is deliberately not a general-purpose swallow. Outside a production
 * build it rethrows, so a customer opening a page whose data will not load sees
 * error.tsx rather than a page pretending the shop is empty.
 */
function isPrerendering(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

export async function prerenderOrDefer<T>(
  label: string,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!isPrerendering()) throw error;
    console.warn(
      `[prerender] ${label}: ${error instanceof Error ? error.message : error}. ` +
        "Rendering this route on demand instead.",
    );
    // Throws Next's dynamic-usage signal, which the build catches; nothing
    // after this line runs during a prerender.
    await connection();
    return read();
  }
}

/**
 * The same decision, for a caller that has a *usable* fallback.
 *
 * The header falls back to a static nav when the category tree is unreachable,
 * which is right at request time — a bare header is worse than a slightly wrong
 * one. Baking that fallback into a prerendered page is not: it would ship a
 * navigation that never recovers. Call this in the catch, before falling back.
 */
export async function deferIfPrerendering(
  label: string,
  error: unknown,
): Promise<void> {
  if (!isPrerendering()) return;
  console.warn(
    `[prerender] ${label}: ${error instanceof Error ? error.message : error}. ` +
      "Rendering this route on demand rather than baking the fallback.",
  );
  await connection();
}
