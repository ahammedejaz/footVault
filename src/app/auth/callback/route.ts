import { NextResponse, type NextRequest } from "next/server";

import { safeNext } from "@/lib/safe-redirect";
import { createClient } from "@/lib/supabase/server";

/**
 * Where Google sends the customer back to.
 *
 * Supabase's SSR client uses PKCE, so what arrives here is a single-use code,
 * not a token. Exchanging it server-side is what writes the session cookies —
 * which is the whole reason this is a route handler and not a page: a Server
 * Component cannot set a cookie, so a page here would authenticate the customer
 * and then lose the session on the redirect.
 *
 * Everything that must happen exactly once at the moment of signing in belongs
 * here, in this order:
 *
 *   1. exchange the code for a session
 *   2. merge the guest bag into the account's bag        (src/lib/cart/merge.ts)
 *   3. finish whatever the customer was trying to do     (src/lib/pending-intent.ts)
 *
 * 2 and 3 run *after* the session exists, so both act as the signed-in user and
 * both are covered by the same RLS policies as any other request.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNext(url.searchParams.get("next"));

  // The customer pressed "cancel" on Google's consent screen, or the provider
  // returned an error. Neither is a fault worth a stack trace; send them back
  // to where they were.
  const providerError = url.searchParams.get("error");
  if (providerError) {
    console.warn(
      `[auth] provider returned ${providerError}: ${url.searchParams.get("error_description") ?? ""}`,
    );
    return NextResponse.redirect(new URL(`${next}${joiner(next)}signin=cancelled`, url.origin));
  }

  if (!code) {
    return NextResponse.redirect(new URL(`${next}${joiner(next)}signin=failed`, url.origin));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    // A code is single-use and short-lived, so the usual cause is a reload of
    // this URL rather than an attack.
    console.error("[auth] exchangeCodeForSession failed:", error.message);
    return NextResponse.redirect(new URL(`${next}${joiner(next)}signin=failed`, url.origin));
  }

  return NextResponse.redirect(new URL(next, url.origin));
}

/** `?` or `&`, depending on whether the destination already carries a query. */
function joiner(path: string): string {
  return path.includes("?") ? "&" : "?";
}
