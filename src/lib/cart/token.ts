import "server-only";

import { cookies } from "next/headers";

import {
  GUEST_TOKEN_COOKIE,
  GUEST_TOKEN_MAX_AGE,
  createGuestToken,
} from "@/lib/guest-token";

/**
 * The anonymous cart identifier, minted on demand.
 *
 * Deliberately lazy. Minting in the proxy would put a `Set-Cookie` on every
 * response the site serves, including to crawlers, and hand a bag identifier to
 * people who are only reading. A token is created the first time somebody
 * actually puts something in a bag, and not before — so an anonymous visitor
 * who browses and leaves carries no state at all.
 *
 * Only callable from a Server Action or a Route Handler: a Server Component
 * cannot set a cookie, so `read` and `getOrCreate` are separate functions and
 * the render path only ever gets the first one.
 */

/** The token this browser already has, if any. Safe anywhere. */
export async function readGuestToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(GUEST_TOKEN_COOKIE)?.value ?? null;
}

/**
 * The token this browser has, creating one if it does not.
 *
 * httpOnly: the token is a bearer credential for one bag, with the same
 * security properties as a session cookie. Client JavaScript never sees it, so
 * an XSS bug cannot walk off with somebody's cart.
 */
export async function getOrCreateGuestToken(): Promise<string> {
  const store = await cookies();
  const existing = store.get(GUEST_TOKEN_COOKIE)?.value;
  if (existing) return existing;

  const token = createGuestToken();
  store.set(GUEST_TOKEN_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: GUEST_TOKEN_MAX_AGE,
  });
  return token;
}

/** Forget the anonymous bag. Used after it has been merged into an account. */
export async function clearGuestToken(): Promise<void> {
  const store = await cookies();
  store.delete(GUEST_TOKEN_COOKIE);
}
