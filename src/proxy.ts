import type { NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/proxy";

/**
 * Next 16 calls this file `proxy.ts`; it is what earlier versions called
 * `middleware.ts`. Both names still resolve, and picking the wrong one fails
 * silently — the file is simply never invoked — so this is verified in the
 * quality gate rather than assumed.
 */
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and image files. The session has to be
     * refreshed on page requests; refreshing it on a request for a font is
     * a round trip nobody is waiting for.
     *
     * `api/csp-report` is excluded for a sharper version of the same reason.
     * Browsers fire it automatically, unauthenticated, at a rate that scales
     * with page views rather than with anything a person did — and every one
     * that reached the proxy would cost a `getClaims()` round trip to verify a
     * session the handler never looks at. Under the one condition the endpoint
     * exists to detect, a policy blocking something on every page, that is a
     * Supabase call per violation per visitor. The exclusion is narrow and
     * names one route: nothing else under `/api` is safe to skip, because
     * `/api/cart` and the payment routes all read the caller's session.
     */
    "/((?!_next/static|_next/image|favicon.ico|api/csp-report|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)",
  ],
};
