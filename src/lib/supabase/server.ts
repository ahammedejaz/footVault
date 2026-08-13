import "server-only";

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import type { Database } from "@/lib/database.types";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/env";
import { AUTH_COOKIE_OPTIONS } from "@/lib/supabase/cookie-options";
import { GUEST_TOKEN_COOKIE, GUEST_TOKEN_HEADER } from "@/lib/guest-token";

/**
 * The server client: anon key plus the caller's session cookie, so every query
 * runs as that user and RLS applies. This is what Server Components and Server
 * Actions read through.
 *
 * The guest token travels as a request header. `public.current_guest_token()`
 * reads it out of `request.headers` inside the cart policies, which is how an
 * anonymous bag is scoped to one browser without a JWT. Forwarding it from an
 * httpOnly cookie means the token is never exposed to client JavaScript.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const guestToken = cookieStore.get(GUEST_TOKEN_COOKIE)?.value;

  return createServerClient<Database>(SUPABASE_URL(), SUPABASE_ANON_KEY(), {
    // Stated here as well as in proxy.ts because a Route Handler writes the
    // session too — /auth/callback exchanges the OAuth code and sets the
    // cookie from this client, so a `Secure` set only in the proxy would leave
    // the *first* cookie of every session without it. See cookie-options.ts.
    cookieOptions: AUTH_COOKIE_OPTIONS,
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot set cookies. The refreshed session is
          // written by the middleware instead, which runs on every request —
          // so swallowing this is correct rather than lossy.
        }
      },
    },
    global: guestToken
      ? { headers: { [GUEST_TOKEN_HEADER]: guestToken } }
      : undefined,
  });
}
