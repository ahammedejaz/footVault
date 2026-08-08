import "server-only";

import { cache } from "react";

import { createClient } from "@/lib/supabase/server";

/**
 * Who is asking, for the parts of the UI that need to know.
 *
 * `getClaims()` rather than `getSession()`: the project signs its JWTs with
 * ES256, so the signature is verified against the published JWKS instead of
 * being trusted from a cookie a browser could have edited. `getSession()` reads
 * the cookie and believes it — fine for deciding whether to draw a menu, not
 * fine for anything else, and the difference is invisible at the call site. So
 * the unsafe one is simply not used anywhere in this codebase.
 *
 * Wrapped in React's `cache` so the header, the page and the badges share one
 * verification per request instead of four.
 *
 * This is for *rendering*, not for authorisation. Every row this user can read
 * or write is decided by an RLS policy in the database. If this function were
 * wrong, the worst it could do is draw the wrong menu.
 */
export type CurrentUser = {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
};

export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) return null;

  const claims = data.claims;
  const meta = (claims.user_metadata ?? {}) as Record<string, unknown>;
  const str = (key: string) =>
    typeof meta[key] === "string" ? (meta[key] as string) : null;

  return {
    id: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    // Google sends `name`; `full_name` is what the profiles trigger stores.
    name: str("full_name") ?? str("name"),
    avatarUrl: str("avatar_url") ?? str("picture"),
  };
});
