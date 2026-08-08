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
 *
 * **And a deploy does not clear it.** This was got wrong once, in writing, on
 * the way to production: `unstable_cache` on Vercel is backed by the **Data
 * Cache**, which is a *runtime* store shared across deployments — not the
 * `.next/cache` directory in the build output. So shipping new code does not
 * flush it, and neither does forcing a build with the build cache disabled
 * (`vercel --prod --force`); both were tried against the live project and the
 * stale entry survived. The only three things that clear a tagged entry are the
 * two functions above, the TTL lapsing, and an owner purging the Data Cache
 * from the Vercel dashboard.
 *
 * The practical consequence is worth stating because it is the *good* half:
 * content edited by SQL is stale for up to an hour, but a **policy number**
 * never is. Thresholds are not stored in cached content any more — the cached
 * payload holds `{{free_shipping_threshold}}` and the value is resolved on
 * every render from `site_settings`, uncached. So the owner changing a
 * threshold is correct immediately, everywhere, cache or no cache. See
 * `src/lib/content-tokens.ts`.
 */
export function stockChanged(): void {
  updateTag(CATALOG_CACHE_TAG);
}

/** The same statement, from a Route Handler — the webhook is the only one. */
export function stockChangedFromRoute(): void {
  revalidateTag(CATALOG_CACHE_TAG, { expire: 0 });
}
