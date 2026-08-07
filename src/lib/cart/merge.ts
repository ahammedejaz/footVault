import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { MAX_LINE_QUANTITY } from "@/lib/validations/cart";

/**
 * Folding the guest bag into the account bag, at the moment of signing in.
 *
 * Three shoes go in as a guest, Google happens, and all three are still there —
 * combined with whatever was already in the account from another device,
 * quantities summed, each line capped at what the shop actually holds.
 *
 * **This is now one statement, not eight.** Phase 4 did the merge line by line
 * over PostgREST: idempotent, because each guest line was retired as soon as it
 * landed, but not atomic. A failure at line five left the bag split across two
 * carts, and the next sign-in stitched it back together. That was survivable
 * while a cart was only a display. Checkout converts a cart and decrements
 * stock from it, so a half-merged bag is now a half-placed order — the merge
 * lives in `public.merge_guest_cart()` and either all of it happens or none of
 * it does.
 *
 * **No elevated privilege.** The function is SECURITY INVOKER and executable by
 * `authenticated` only. RLS still governs both bags: the client this runs on
 * was built inside /auth/callback while the guest cookie was still set, so it
 * carries the `x-guest-token` header the anonymous cart policy matches, and
 * after the code exchange it also carries the session the account cart policy
 * matches. That is the whole reason DEFINER is not needed here, and Phase 1's
 * guard_profile_role() is why not needing it matters.
 *
 * Failure must never cost the customer their sign-in. If this throws, the
 * caller leaves the guest token alone, so the bag is still reachable and the
 * next sign-in tries again; a lost session with an intact cart is a worse trade
 * than a delayed merge. Re-running is therefore the normal case, and it is a
 * no-op: the guest cart is deleted inside the same transaction that empties it,
 * so the second call finds nothing to move.
 *
 * The token stays a parameter and cookies stay the caller's problem — partly
 * layering, and partly so scripts/audit/cart-merge.ts can call straight into
 * this without a browser. The *database* reads the token from the request
 * header regardless and refuses if the two disagree; a client that thinks it is
 * merging one bag while carrying the header of another is a bug, not a merge.
 */

export type MergeOutcome = {
  /** Lines that moved across or were added into an existing line. */
  merged: number;
  /** Lines that could not come: sold out or withdrawn while they were away. */
  dropped: number;
  /** True once the guest bag is gone, which is when its cookie may be dropped. */
  guestCartConsumed: boolean;
};

export async function mergeGuestCartIntoAccount(
  supabase: SupabaseClient<Database>,
  userId: string,
  guestToken: string | null,
): Promise<MergeOutcome> {
  const empty: MergeOutcome = { merged: 0, dropped: 0, guestCartConsumed: false };

  if (!guestToken) return empty;

  // MAX_LINE_QUANTITY is a policy number that lives in
  // src/lib/validations/cart.ts and is enforced by the add-to-bag schema. It is
  // passed rather than copied into the function body, because a second copy in
  // SQL is a copy that drifts the first time somebody changes the ceiling.
  const { data, error } = await supabase.rpc("merge_guest_cart", {
    p_guest_token: guestToken,
    p_max_line_quantity: MAX_LINE_QUANTITY,
  });

  if (error) {
    // userId is not what the function trusts — it derives the user from
    // auth.uid() inside — but it is what the caller *believed*, which is the
    // useful half of a log line when a merge fails.
    throw new Error(
      `mergeGuestCartIntoAccount(${userId}): ${error.message} [${error.code ?? "unknown"}]`,
    );
  }

  const row = data?.[0];
  if (!row) return empty;

  return {
    merged: row.merged,
    dropped: row.dropped,
    guestCartConsumed: row.guest_cart_consumed,
  };
}
