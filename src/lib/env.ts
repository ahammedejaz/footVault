/**
 * Environment access, read once and checked at the boundary.
 *
 * Reading `process.env.X!` at each call site means a missing variable surfaces
 * as `undefined` deep inside a Supabase call, where the error is "Invalid URL"
 * rather than "you forgot to set NEXT_PUBLIC_SUPABASE_URL". These throw with
 * the name of the thing that is missing.
 *
 * NEXT_PUBLIC_ values are inlined by the bundler and are safe in the browser.
 * The service role key deliberately has no accessor here — it is read in
 * src/lib/supabase/admin.ts, which is marked server-only, so it cannot be
 * pulled into a client bundle by an accidental import.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

export const SUPABASE_URL = () =>
  required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);

export const SUPABASE_ANON_KEY = () =>
  required(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );

/** Absolute origin. Used for metadataBase, OG images, sitemap and auth redirects. */
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

/**
 * Which of the two public Supabase variables are missing. Empty means configured.
 *
 * Returning the names rather than a boolean is the point: the value of noticing
 * this at all is being able to say *which* variable, and a boolean throws that
 * away at the only moment it is worth having.
 */
export function missingSupabaseEnv(): string[] {
  const missing: string[] = [];
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL)
    missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
    missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  return missing;
}

/**
 * True when both public Supabase variables are present.
 *
 * **Read what this does and does not guarantee**, because for three phases it
 * claimed more than it delivered. Until Phase 6 its comment said the storefront
 * "degrades to a styled empty state rather than a stack trace", and the only
 * caller was `src/lib/supabase/proxy.ts` — nothing on the render path checked
 * it, so every page went on to call `SUPABASE_URL()` and throw.
 *
 * It is now true, and it is true because of two callers rather than one:
 *
 *   - the proxy returns early, so middleware does not throw on every request
 *     (there is no error boundary around middleware; a throw there is a bare
 *     500 with no markup at all)
 *   - the root layout renders `<NotConfigured />` instead of the tree, which is
 *     the styled state the comment was promising
 *
 * Anything below the layout may still assume configuration and call
 * `SUPABASE_URL()` freely. That is the deal: one check, high up, rather than a
 * null branch in every query.
 */
export const isSupabaseConfigured = () => missingSupabaseEnv().length === 0;
