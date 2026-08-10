import "server-only";

/**
 * Collect the params to pre-render, or fail the build trying.
 *
 * This function used to swallow collection errors and return an empty list, on
 * the theory that "returning an empty list means the route renders on demand
 * instead of at build time, which is a slower first request and nothing worse."
 * On 2026-08-10 production proved that theory wrong. A route with
 * `generateStaticParams` is classified SSG *by the manifest*, not by what the
 * list contained: with zero paths collected, zero pages render at build time,
 * so the build never discovers that these pages read `cookies()` (the
 * per-customer wishlist hearts) and never reclassifies the route as dynamic
 * the way every healthy build does. Every request then attempts a *static*
 * generation at runtime, hits `cookies()`, and dies with
 * DYNAMIC_SERVER_USAGE — every product page a 500, from a build that passed.
 * One Supabase 522 during the deploy of fa2e60a took the catalog down; the
 * innocent-looking merge it built got the blame.
 *
 * So the contract is now: retry, then throw. A build that cannot read the
 * catalog must fail loudly and keep the previous deployment serving, because
 * the artifact it would produce is not "slower on first request" — it is
 * poisoned for its whole lifetime, and nothing at request time can un-bake a
 * manifest (`connection()` can rescue a page body, see prerender.ts, but
 * `generateStaticParams` has no equivalent).
 *
 * The one deliberate exception: CI builds with placeholder Supabase
 * credentials on purpose, so a pull request can be verified without live
 * database access — and CI's artifact never serves a request. That build, and
 * only that build, declares itself with STATIC_PARAMS_ALLOW_EMPTY=1 and gets
 * the old fallback. Vercel builds must never set it.
 */

const ATTEMPTS = 3;
const RETRY_PAUSE_MS = [2_000, 5_000];

/** Cloudflare hands back a whole HTML error page as the message; one line of
 *  it identifies the failure, four hundred lines of it bury the build log. */
function brief(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 300);
}

export async function staticParamsOr<T>(
  label: string,
  collect: () => Promise<T[]>,
): Promise<T[]> {
  let lastError: unknown;

  // A build that has declared its artifact unserved is usually a CI build
  // whose placeholder credentials can never succeed — retrying them is a
  // minute of pauses purchasing nothing.
  const attempts =
    process.env.STATIC_PARAMS_ALLOW_EMPTY === "1" ? 1 : ATTEMPTS;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // The 2026-08-10 incident, on demand: a build-time database outage is a
      // network event, so no code change can reproduce it. This hook lets the
      // build-smoke gate inject one for a named route ("products") or every
      // route ("all") and assert that the resulting build fails.
      const outage = process.env.STATIC_PARAMS_SIMULATE_OUTAGE;
      if (outage === "all" || outage?.split(",").includes(label)) {
        throw new Error(
          `simulated build-time outage for "${label}" (STATIC_PARAMS_SIMULATE_OUTAGE=${outage})`,
        );
      }
      return await collect();
    } catch (error) {
      lastError = error;
      console.warn(
        `[static-params] ${label}: attempt ${attempt}/${attempts} failed: ${brief(error)}`,
      );
      if (attempt < attempts) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_PAUSE_MS[attempt - 1]),
        );
      }
    }
  }

  if (process.env.STATIC_PARAMS_ALLOW_EMPTY === "1") {
    console.warn(
      `[static-params] ${label}: falling back to on-demand rendering because ` +
        "STATIC_PARAMS_ALLOW_EMPTY=1. This artifact must never serve traffic.",
    );
    return [];
  }

  throw new Error(
    `[static-params] ${label}: could not collect params after ${attempts} attempts. ` +
      "Failing the build rather than shipping a route that 500s on every request " +
      `(see src/lib/static-params.ts). Last error: ${brief(lastError)}`,
    { cause: lastError },
  );
}
