/**
 * The anonymous cart identifier.
 *
 * A guest has no `auth.uid()`, so there is nothing for an RLS policy to key
 * their cart on. The server mints an opaque random token, stores it in an
 * httpOnly cookie, and forwards it to PostgREST as a request header;
 * `public.current_guest_token()` reads it back out inside the cart policies.
 *
 * httpOnly matters: the token is a bearer credential for one cart. Client
 * JavaScript never sees it, so an XSS bug cannot walk off with somebody's bag.
 *
 * This used to read "with the same security properties as a session cookie",
 * which is false and false in the flattering direction. The Supabase session
 * cookie is **not** httpOnly and cannot be — `@supabase/ssr`'s browser client
 * reads it from `document.cookie`, and four admin upload panels depend on that.
 * The bag is the better-protected of the two. See
 * `src/lib/supabase/cookie-options.ts`.
 *
 * This module is shared by the middleware, the server client and the cart
 * actions, so the cookie name and the header name are defined once.
 */

export const GUEST_TOKEN_COOKIE = "fv_guest";
export const GUEST_TOKEN_HEADER = "x-guest-token";

/** A year: long enough that a bag survives being left over a holiday. */
export const GUEST_TOKEN_MAX_AGE = 60 * 60 * 24 * 365;

/** 128 bits from the platform CSPRNG. Unguessable, and available in both runtimes. */
export function createGuestToken(): string {
  return crypto.randomUUID();
}
