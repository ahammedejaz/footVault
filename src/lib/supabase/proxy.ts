import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import type { Database } from "@/lib/database.types";
import { AUTH_COOKIE_OPTIONS } from "@/lib/supabase/cookie-options";
import {
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  isSupabaseConfigured,
} from "@/lib/env";

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

export async function updateSession(
  request: NextRequest,
): Promise<NextResponse> {
  // A clone with no Supabase credentials still has to serve the storefront's
  // styled empty state rather than throwing out of the proxy on every route.
  if (!isSupabaseConfigured()) return NextResponse.next({ request });

  let supabaseResponse = NextResponse.next({ request });

  // Per request, never hoisted: on a warm serverless instance a client held in
  // module scope can be reused across requests and hand one customer another
  // customer's session.
  const supabase = createServerClient<Database>(
    SUPABASE_URL(),
    SUPABASE_ANON_KEY(),
    {
      // The refresh path writes the session cookie, so this is one of the two
      // places `Secure` has to be stated. See cookie-options.ts for what the
      // library sets on its own, and for why `httpOnly` deliberately does not
      // follow.
      cookieOptions: AUTH_COOKIE_OPTIONS,
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet)
            request.cookies.set(name, value);
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
    },
  );

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
 * ## Three attempts, and why the first two were wrong
 *
 * Carried unfixed through two security reviews as "`/admin` answers 200", and
 * the cause was never the document response — that has always been 404. It is
 * the **flight** response. A `<Link href="/admin">` or a router prefetch asks
 * for the RSC payload rather than the document, and that answered 200 while a
 * genuinely missing path answered 404. Identical bodies, different status:
 * exactly the one bit the guard exists to withhold.
 *
 * **Attempt one** branched on `RSC: 1` and `Next-Router-Prefetch: 1`. It
 * measured *worse than useless*: the response still carried
 * `x-middleware-rewrite: /_not-found` and still answered 200, because Next
 * strips those headers before the proxy sees them — precisely so middleware
 * cannot branch on them. A guard written against a header that never arrives is
 * a guard that does not run, and it looks exactly like one that does.
 *
 * **Attempt two** branched on `Accept: text/html`, which does arrive. The third
 * adversarial review broke it in one line:
 *
 * ```
 * curl /admin -H 'RSC: 1' -H 'Accept: text/html'   -> 200
 * curl /definitely-not-a-route  (same headers)     -> 404
 * ```
 *
 * Next's own client never sends that pair, so the fix looked correct against
 * every real navigation. An attacker sets headers for free. **Any
 * classification of a request built from client-supplied headers is forgeable**,
 * and the lesson is that the guard must not classify the request at all.
 *
 * ## What actually works
 *
 * Rewrite to a path that has **no route** — not to `/_not-found`.
 *
 * `/_not-found` is a route Next *knows about*, so a rewrite to it is answered
 * with that route's own status handling, and on the flight path that is 200.
 * `NOWHERE` matches nothing, so the request falls through to the same unmatched
 * handling a genuinely missing URL takes. Same code path, same body, same
 * status, for every shape — which is the property "indistinguishable from a
 * route that was never there" actually requires, and it needs no branch and so
 * has nothing to forge.
 *
 * Measured on a production build after the change:
 *
 * ```
 * shape                        /admin  /definitely-not-a-route
 * default                      404     404
 * Accept: text/html            404     404
 * RSC: 1                       404     404
 * RSC: 1 + Accept: text/html   404     404
 * + Next-Router-Prefetch: 1    404     404
 * ```
 *
 * and the styled not-found page is still what a browser renders, because that
 * is what Next renders for any unmatched path.
 */
function notFound(request: NextRequest, carrying: NextResponse): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = NOWHERE;
  const response = NextResponse.rewrite(url, { request });
  // The session cookies still have to travel: a non-admin who is signed in is
  // still signed in, and dropping a refreshed token here logs them out of the
  // storefront for having typed the wrong URL.
  for (const cookie of carrying.cookies.getAll()) response.cookies.set(cookie);
  return response;
}

/**
 * A path with no route, and there must never be one.
 *
 * Deliberately unguessable-looking rather than pretty: if somebody ever adds a
 * route that matches this, the admin guard silently starts rewriting to a real
 * page instead of to nothing, and the disclosure comes back for a fourth time.
 * `npm run audit:auth` asserts the pair of status codes rather than the body,
 * so that would fail the gate rather than pass quietly.
 */
const NOWHERE = "/__fv_no_such_route__";
