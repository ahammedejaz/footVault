import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

/**
 * Moving a guest's orders onto the account they have just created.
 *
 * The confirmation page for a guest order offers "create an account". Before
 * this existed, accepting cost the customer the order: the cart merge reports a
 * checked-out cart as spent, /auth/callback drops the guest cookie on the
 * strength of that, and the order was left holding a token no browser had any
 * more — invisible to the guest policy, invisible to the customer policy, gone.
 *
 * The wrapper is thin on purpose. Everything that decides *which* orders move
 * lives in `public.adopt_guest_orders()`, which takes no arguments at all: the
 * user comes from `auth.uid()` and the token from the `x-guest-token` header.
 * There is nothing for this function to pass and therefore nothing for a caller
 * to get wrong. `guestToken` is here only so the common case — a customer
 * signing in on a browser that never shopped as a guest — costs no round trip.
 *
 * It throws rather than returning a verdict, because the caller's decision is
 * binary and consequential: if this did not succeed, the guest cookie must not
 * be deleted, or the orders become unreachable. A silent zero would look
 * exactly like "there was nothing to adopt".
 */
export async function adoptGuestOrders(
  supabase: SupabaseClient<Database>,
  guestToken: string | null,
): Promise<number> {
  if (!guestToken) return 0;

  const { data, error } = await supabase.rpc("adopt_guest_orders");
  if (error) {
    throw new Error(`adoptGuestOrders: ${error.message} [${error.code ?? "unknown"}]`);
  }
  return data ?? 0;
}
