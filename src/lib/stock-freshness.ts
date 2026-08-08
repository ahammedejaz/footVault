import "server-only";

import { revalidateTag, updateTag } from "next/cache";

import { CATALOG_CACHE_TAG } from "@/lib/queries/cached";

/**
 * "A unit moved" — said once, to the cache, from wherever it happened.
 *
 * Before Phase 7 the catalog cache was expired by five admin actions and by
 * nothing else. Not by checkout, which decrements. Not by a cancellation, which
 * restores. Not by the stock editor the owner actually uses, which called
 * `revalidatePath("/", "layout")` — a route-cache expiry that leaves every
 * `unstable_cache` entry precisely where it was. So a size the owner had zeroed
 * went on being offered for the rest of the hour. See
 * `src/lib/queries/availability.ts` for the full diagnosis.
 *
 * **Two functions rather than one, because Next 16 has two.** `updateTag` is
 * Server-Actions-only and expires immediately, which is what a customer who has
 * just bought the last pair needs. `revalidateTag` is what a Route Handler may
 * call, and its second argument is now mandatory — the single-argument form is
 * deprecated and does not typecheck here. `{ expire: 0 }` asks for the same
 * immediate expiry rather than `"max"`'s stale-while-revalidate, because
 * serving one more request from a stale stock figure is the exact failure being
 * fixed.
 *
 * **What neither of them can reach**, stated plainly because it is a real
 * residue: `release_abandoned_orders()` runs inside Postgres under `pg_cron`
 * and has no way to call into Next, and an owner editing a row in the Supabase
 * dashboard is not calling anything either. Both of those only ever *restore*
 * stock, so the stale direction is "we still say sold out for up to an hour" —
 * a lost sale rather than an oversold pair. The product page does not have even
 * that window, because its availability is read live.
 */
export function stockChanged(): void {
  updateTag(CATALOG_CACHE_TAG);
}

/** The same statement, from a Route Handler — the webhook is the only one. */
export function stockChangedFromRoute(): void {
  revalidateTag(CATALOG_CACHE_TAG, { expire: 0 });
}
