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
 * True when Supabase is configured. The storefront degrades to a styled empty
 * state rather than a stack trace when it is not — a fresh clone with no
 * .env.local should still boot and tell you what to do.
 */
export const isSupabaseConfigured = () =>
  Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
