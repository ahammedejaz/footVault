import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/env";

/**
 * A cookieless anonymous client.
 *
 * `generateStaticParams`, `sitemap.ts` and `robots.ts` run at build time with
 * no HTTP request, so `cookies()` — and therefore the session-aware client in
 * server.ts — is unavailable there. This one carries the anon key and nothing
 * else.
 *
 * That is not a downgrade: everything these callers read is public catalog data
 * that the `anon` RLS policies already expose. Anything scoped to a signed-in
 * customer must use server.ts, because this client has no idea who is asking.
 */
export function createStaticClient() {
  return createSupabaseClient<Database>(SUPABASE_URL(), SUPABASE_ANON_KEY(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
