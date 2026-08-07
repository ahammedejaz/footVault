import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { SUPABASE_URL } from "@/lib/env";

/**
 * The service role client. Bypasses Row Level Security entirely.
 *
 * `import "server-only"` above makes importing this file from a Client
 * Component a build error, not a runtime surprise — which is the guarantee that
 * matters, because the key it reads would otherwise be inlined into a browser
 * bundle.
 *
 * Reach for it only where RLS cannot express the rule and the server has
 * already done the authorisation itself:
 *
 *   - checkout, which must decrement stock and write an order the customer has
 *     no INSERT policy for
 *   - coupon validation, since coupons are unreadable from the client by design
 *   - admin mutations that need to touch soft-deleted or inactive rows
 *
 * Anything a customer is allowed to do on their own behalf goes through
 * src/lib/supabase/server.ts, where the policies still apply.
 */
export function createAdminClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error(
      "Missing SUPABASE_SERVICE_ROLE_KEY. It is server-only — set it in .env.local " +
        "and in the Vercel project, never with a NEXT_PUBLIC_ prefix.",
    );
  }

  return createSupabaseClient<Database>(SUPABASE_URL(), serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
