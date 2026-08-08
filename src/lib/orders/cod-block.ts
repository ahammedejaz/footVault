import "server-only";

import { cache } from "react";

import { getCurrentUser } from "@/lib/auth";
import { maybeRow } from "@/lib/queries/run";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Has Pay on Delivery been withdrawn from *this* customer?
 *
 * ## Why this file exists at all
 *
 * `profiles.cod_blocked_at` shipped in Phase 7 as a column read by nothing. The
 * third adversarial review found both halves of that: `computeOrderTotals`
 * declared a `codBlocked` parameter and **no caller passed it**, and the column
 * was **customer-self-writable** — a blocked customer cleared their own block
 * with one PostgREST PATCH. A control the person it constrains can switch off
 * is not a control, and a control nothing reads is a column.
 *
 * The write side is closed by widening `guard_profile_role()` so the trigger
 * that has always frozen `role` now freezes these two columns as well
 * (`20260808140700_guard_cod_block_columns.sql`). This is the read side.
 *
 * ## Why the service role
 *
 * A customer *may* read their own `profiles` row, so the caller's own client
 * would work — and it would be the wrong choice. The answer decides which
 * payment methods are offered, so a policy change that narrowed what a customer
 * can see of their own row would silently turn every block off rather than
 * fail. Read through the service role, the answer is the row, and RLS has no
 * opportunity to make a withdrawal look like an absence.
 *
 * **A failed read blocks.** The alternative is that a database hiccup hands
 * Pay on Delivery back to the exact customers it was taken from, which is the
 * expensive direction — the tail is where the losses concentrate. It is one
 * customer inconvenienced against a repeat refuser being handed another parcel.
 *
 * ## Guests
 *
 * A guest has no profile, so a guest is never blocked. That is a real gap and
 * it is stated rather than papered over: the block is keyed to an account, and
 * somebody determined to get round it can check out signed out. Blocking by
 * phone number would follow the person rather than the login, and it needs a
 * verified phone number, which this shop does not collect. Noted for the phase
 * that does.
 */

/**
 * Wrapped in React's `cache` so the payment step, the quote action and
 * `placeOrder` share one read per request rather than three.
 */
export const codBlockedForCaller = cache(async (): Promise<boolean> => {
  const user = await getCurrentUser();
  if (!user) return false;

  try {
    const row = await maybeRow<{ cod_blocked_at: string | null }>(
      "orders.codBlocked",
      createAdminClient()
        .from("profiles")
        .select("cod_blocked_at")
        .eq("id", user.id)
        .maybeSingle(),
    );
    return row?.cod_blocked_at !== null && row?.cod_blocked_at !== undefined;
  } catch (error) {
    // Blocks on failure. See the header: handing Pay on Delivery back to a
    // repeat refuser because a read failed is the expensive direction.
    console.error(
      "[orders] could not read the Pay-on-Delivery block, withholding it:",
      error instanceof Error ? error.message : "unknown",
    );
    return true;
  }
});
