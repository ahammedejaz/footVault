import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import type { Database } from "@/lib/database.types";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/env";

/**
 * Session refresh, and the admin guard.
 *
 * Runs on every request that is not a static asset. Two jobs:
 *
 * 1. **Keep the session alive.** An access token expires in an hour; the
 *    refresh happens here so a Server Component always sees a valid session
 *    rather than a customer being silently signed out mid-browse. The rewritten
 *    cookies have to travel on the response, which is why the response object
 *    is rebuilt inside `setAll` rather than created once at the top.
 *
 * 2. **Hide /admin from everyone who is not an admin.** Not a redirect — a
 *    redirect to /login tells an attacker that /admin exists and is worth
 *    coming back to. A 404 tells them nothing the rest of the internet does not
 *    already know.
 *
 * The database is still the authority. This guard is defence in depth and a
 * courtesy to the URL bar; every admin table is protected by an RLS policy that
 * calls `is_admin()`, so a bypass here reaches nothing.
 */

/** Paths whose existence should not be discoverable by a non-admin. */
const ADMIN_PREFIX = "/admin";

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  // A clone with no Supabase credentials still has to serve the storefront's
  // styled empty state rather than throwing out of the proxy on every route.
  if (!isSupabaseConfigured()) return NextResponse.next({ request });

  let supabaseResponse = NextResponse.next({ request });

  // Per request, never hoisted: on a warm serverless instance a client held in
  // module scope can be reused across requests and hand one customer another
  // customer's session.
  const supabase = createServerClient<Database>(SUPABASE_URL(), SUPABASE_ANON_KEY(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        supabaseResponse = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options);
        }
        // @supabase/ssr hands us the cache headers that must ride along with a
        // refreshed token. Without them a CDN can cache a response carrying
        // somebody's Set-Cookie and serve it to the next visitor, who is then
        // signed in as them.
        for (const [key, value] of Object.entries(headers ?? {})) {
          supabaseResponse.headers.set(key, value);
        }
      },
    },
  });

  // Nothing between the client and this call. Anything that throws in between
  // leaves the session half-refreshed and logs people out at random.
  // getClaims() rather than getSession(): the project signs with ES256, so the
  // signature is verified locally against the published JWKS instead of trusted
  // from a cookie a browser could have edited.
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (request.nextUrl.pathname.startsWith(ADMIN_PREFIX)) {
    const admin = claims ? await isAdmin(supabase) : false;
    if (!admin) return notFound(request, supabaseResponse);
  }

  // Returned as-is. Building a fresh response here and forgetting to carry the
  // cookies over is how a browser and a server drift apart and a session dies
  // early.
  return supabaseResponse;
}

/**
 * `is_admin()` is SECURITY DEFINER and reads `profiles.role` for `auth.uid()`,
 * so the answer cannot be influenced by anything the client sends — which is
 * the whole point. A role claim from a JWT would be user-editable.
 */
async function isAdmin(
  supabase: ReturnType<typeof createServerClient<Database>>,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_admin");
  if (error) {
    // Fail closed. An unreachable database must not open the admin panel.
    console.error("[proxy] is_admin() failed, denying:", error.message);
    return false;
  }
  return data === true;
}

/**
 * A 404 that is indistinguishable from a route that was never there.
 *
 * Rewriting rather than redirecting keeps the URL in the bar, and rewriting to
 * a path that cannot exist makes Next render its own not-found page with a real
 * 404 status — so the customer gets the styled page and an attacker gets
 * nothing.
 */
function notFound(request: NextRequest, carrying: NextResponse): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = "/_not-found";
  const response = NextResponse.rewrite(url, { request });
  for (const cookie of carrying.cookies.getAll()) response.cookies.set(cookie);
  return response;
}
