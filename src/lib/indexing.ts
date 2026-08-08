/**
 * Whether search engines are allowed in.
 *
 * `foot-vault.vercel.app` is publicly reachable throughout the build, and a
 * store indexed with placeholder illustrations and a half-finished checkout is
 * a reputation problem that outlives the deploy that caused it — Google will
 * hold a cached copy long after the page is fixed.
 *
 * So the default is **noindex**, and it is the default in the strong sense:
 * an unset variable, a typo'd variable and a misconfigured environment all
 * resolve to "keep them out". Only the exact string "true" opens the door,
 * which means no plausible accident opens it.
 *
 * **To go live:** set `SITE_INDEXABLE=true` in the Vercel project (Production
 * only, so previews stay hidden) and redeploy. That is the whole change.
 *
 * Deliberately dependency-free: this is imported by `next.config.ts`, which is
 * evaluated by the Next build outside the app's module graph and cannot resolve
 * the `@/` path alias.
 */
export function isIndexable(): boolean {
  return process.env.SITE_INDEXABLE === "true";
}

/**
 * The header value when indexing is off.
 *
 * `noindex` alone still lets a crawler follow links out of the page and
 * discover more of the store to queue up for later; `nofollow` closes that.
 * `noarchive` stops a cached copy being served from the search results even
 * before the page is dropped from the index.
 */
export const NOINDEX_HEADER = "noindex, nofollow, noarchive";
