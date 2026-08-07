"use client";

import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/lib/database.types";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/env";

/**
 * The browser client. Holds the anon key, which is public by design: every
 * request it makes is filtered by the RLS policies in
 * supabase/migrations/*_rls_*.sql.
 *
 * Used for auth state and realtime only. Reads that shape a page happen in
 * Server Components through src/lib/supabase/server.ts, so the data arrives in
 * the HTML rather than after a client round trip.
 */
export function createClient() {
  return createBrowserClient<Database>(SUPABASE_URL(), SUPABASE_ANON_KEY());
}
