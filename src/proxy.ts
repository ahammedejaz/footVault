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
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)",
  ],
};
