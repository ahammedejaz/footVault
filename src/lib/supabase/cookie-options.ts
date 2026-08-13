/**
 * The cookie attributes the session travels with, in one place.
 *
 * Shared by `proxy.ts` and `server.ts` — the only two `createServerClient`
 * call sites — for the same reason `guest-token.ts` exists: two copies of a
 * security attribute drift, and the one that drifts is the one nobody reads.
 *
 * ## What @supabase/ssr sets on its own, and what it does not
 *
 * Measured rather than assumed. A real session was minted, its stored expiry
 * backdated so the proxy's `getClaims()` had to refresh, and the `Set-Cookie`
 * the app emitted was read off the wire:
 *
 * ```
 * sb-<ref>-auth-token; Path=/; Max-Age=34560000; SameSite=lax
 * ```
 *
 * No `Secure`. No `HttpOnly`. Those come from the library's
 * `DEFAULT_COOKIE_OPTIONS`, which is `{ path, sameSite: "lax",
 * httpOnly: false, maxAge: 400 days }` — and the string `secure` does not
 * appear **anywhere** in the published `@supabase/ssr` bundle, so there is no
 * environment in which it turns itself on. Next does not add cookie attributes
 * of its own and neither does Vercel. What the library defaults to is what the
 * browser gets.
 *
 * That is unlike `fv_guest`, whose `secure` is gated on `NODE_ENV` in
 * `cart/token.ts` and which measures correctly in production
 * (`Secure; HttpOnly; SameSite=lax`). The session cookie had no such gate to
 * get right or wrong; it simply had no flag.
 *
 * ## Why `secure` is set here and `httpOnly` is not
 *
 * `secure` is free. Nothing about this application needs the session to travel
 * over plaintext, and until now the only thing preventing it was HSTS — which
 * does not protect a browser's first-ever visit, before the policy is pinned.
 *
 * **`httpOnly` cannot follow, and this is the part worth reading.**
 * `@supabase/ssr` defaults it to `false` deliberately: `createBrowserClient`
 * recovers the session by reading `document.cookie`. Setting it here would not
 * harden anything — it would sign those clients out. Four admin upload panels
 * talk to Supabase Storage directly with the caller's session and would begin
 * authenticating as `anon`, which the storage policies correctly refuse:
 *
 *   - `components/admin/products/image-upload-panel.tsx`
 *   - `components/admin/products/recrop-dialog.tsx`
 *   - `components/admin/appearance/hero-video-uploader.tsx`
 *   - `components/admin/media/media-uploader.tsx`
 *
 * (`app/(storefront)/product/[slug]/not-found.tsx` uses the browser client
 * too, for auth state.)
 *
 * ## The consequence, stated plainly
 *
 * **The session cookie is reachable from JavaScript by design.** An XSS bug on
 * this site takes the session, and with it whatever remains of a 400-day
 * cookie. The usual sentence — "XSS is contained, the session is httpOnly" —
 * is not available to this architecture, because Supabase's SSR design trades
 * that defence for the browser client.
 *
 * So a Content-Security-Policy here is **the first layer, not the second**.
 * Everywhere else a CSP is defence in depth behind an httpOnly cookie; here
 * there is nothing behind it. Anyone tempted to defer the CSP work on the
 * grounds that the session is already protected should stop at this paragraph:
 * it is not.
 *
 * Note the asymmetry with the anonymous bag. `guest-token.ts` really is
 * httpOnly — verified on production — so an XSS cannot walk off with somebody's
 * cart. It can walk off with their account.
 *
 * ## What this object cannot change
 *
 * The library merges it as `{ ...DEFAULT_COOKIE_OPTIONS, ...cookieOptions }`,
 * so `path` and `sameSite` survive untouched — but it then **re-forces**
 * `maxAge` back to its own 400-day default on the write path. Shortening the
 * session's lifetime is therefore not something this object can do; it would
 * need GoTrue's own refresh-token expiry setting on the project.
 */
export const AUTH_COOKIE_OPTIONS = {
  /**
   * Only over TLS. Set unconditionally rather than gated on `NODE_ENV`: the
   * `fv_guest` cookie gates its own `secure` because a developer on
   * `http://localhost` needs that cookie to be set at all for the bag to work
   * locally, and a browser drops a `Secure` cookie on a plaintext origin.
   *
   * The session does not have that constraint — `localhost` is treated as a
   * secure context by every browser that implements the cookie `Secure`
   * attribute, so a `Secure` session cookie is stored and sent on
   * `http://localhost` exactly as it is on `https://www.footvault.in`. An
   * unconditional `true` is therefore one fewer environment-dependent security
   * attribute, which is one fewer thing that can be right in dev and wrong in
   * production.
   */
  secure: true,
} as const;
