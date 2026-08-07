import "server-only";

/**
 * Collect the params to pre-render, or none if the database is unreachable.
 *
 * `generateStaticParams` is an optimisation: returning an empty list means the
 * route renders on demand instead of at build time, which is a slower first
 * request and nothing worse. A build that *fails* because the catalog could not
 * be read is worse — it means CI cannot verify a pull request without live
 * credentials, and a Supabase blip cannot be deployed around.
 *
 * This is deliberately not a general-purpose error swallow. Request-time reads
 * still throw: a customer opening a product page that cannot load its product
 * should see the error page, not a blank one. The distinction is that at build
 * time there is no customer waiting, and no page to get wrong.
 */
export async function staticParamsOr<T>(
  label: string,
  collect: () => Promise<T[]>,
): Promise<T[]> {
  try {
    return await collect();
  } catch (error) {
    console.warn(
      `[static-params] ${label}: ${error instanceof Error ? error.message : error}. ` +
        "Falling back to on-demand rendering for this route.",
    );
    return [];
  }
}
