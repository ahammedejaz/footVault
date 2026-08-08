import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { canTransition, type OrderStatus } from "@/lib/orders/types";
import { maybeRow } from "@/lib/queries/run";

/**
 * Moving an order's status because a human said so.
 *
 * This is the fourth writer to `orders.status`, and the brief for this phase was
 * explicit that a fourth writer is only acceptable if it does not bypass the
 * compare-and-swap the third one introduced. So it does not. The other three:
 *
 *   1. `create_order_with_stock` — writes the row, so there is nothing to swap
 *   2. `cancel_order_with_restock` — takes `for update` on the row first
 *   3. `applyPaymentOutcome` — reads, decides, and swaps on `.eq("status", …)`
 *
 * The race this closes is not exotic. The owner opens an order, reads
 * `confirmed`, and reaches for "mark as packed". While the page was open the
 * Razorpay webhook confirmed a different transition, or the abandoned-order
 * sweep cancelled it, or they have the same order open on the shop tablet and
 * the counter laptop. Without the swap, the second write silently wins and an
 * order that is `cancelled` — stock already back on the shelf — becomes
 * `packed`, and somebody goes looking for a parcel that must not be sent.
 *
 * **Cancellation is delegated, never reimplemented.** Entering `cancelled` has
 * to restock, exactly once, guarded by `orders.stock_restored_at`, and write a
 * movement row. All of that already exists inside `cancel_order_with_restock`.
 * A second copy of it here is how the two drift, so the cancel branch calls the
 * function and this module never touches stock at all.
 */

export type TransitionResult =
  | { ok: true; status: OrderStatus; restocked: boolean }
  | {
      ok: false;
      reason: "not_found" | "illegal" | "conflict" | "paid" | "error";
      message: string;
    };

/**
 * How many times to re-read and re-decide. Three, matching
 * `applyPaymentOutcome` — a fourth consecutive loss is not contention, it is
 * something rewriting the order in a loop, and spinning is the wrong answer.
 */
const CAS_ATTEMPTS = 3;

export async function transitionOrder(args: {
  /** The caller's RLS client. `admins update orders` is what lets this through. */
  supabase: SupabaseClient<Database>;
  /** Service role, for `cancel_order_with_restock`, which no other role may run. */
  elevated: () => SupabaseClient<Database>;
  orderId: string;
  to: OrderStatus;
  note: string | null;
  actorId: string;
}): Promise<TransitionResult> {
  const { supabase, elevated, orderId, to, note, actorId } = args;

  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const order = await maybeRow<{ id: string; status: OrderStatus }>(
      "transitionOrder.read",
      supabase
        .from("orders")
        .select("id, status")
        .eq("id", orderId)
        .maybeSingle(),
    );

    // Indistinguishable from "not yours", and deliberately so: this reads
    // through RLS, so a non-admin gets the same answer as a bad id.
    if (!order) {
      return {
        ok: false,
        reason: "not_found",
        message: "That order no longer exists.",
      };
    }

    if (order.status === to) {
      // Not an error. Two clicks, or two tabs, and the second one is a no-op
      // that must not read as a failure to the person who pressed it.
      return { ok: true, status: to, restocked: false };
    }

    if (!canTransition(order.status, to)) {
      return {
        ok: false,
        reason: "illegal",
        message: `An order that is ${order.status} cannot become ${to}.`,
      };
    }

    if (to === "cancelled") {
      const { data, error } = await elevated().rpc(
        "cancel_order_with_restock",
        {
          p_order_id: orderId,
          p_reason: note?.trim() || "Cancelled by an admin",
          p_changed_by: actorId,
          // A cancellation that would need a refund is refused rather than
          // performed. Moving money back is Phase 8, and quietly restocking a
          // paid order would leave the customer charged for units we have just
          // put back on the shelf.
          p_require_unpaid: true,
          p_release_cart: false,
          p_movement_reason: "cancellation",
        },
      );
      if (error) {
        throw new Error(
          `transitionOrder.cancel: ${error.message} [${error.code ?? "?"}]`,
        );
      }
      if (data === "already_paid") {
        return {
          ok: false,
          reason: "paid",
          message:
            "This order has been paid, so cancelling it would mean refunding it. " +
            "Refunds are not built yet — refund in Razorpay first, then cancel.",
        };
      }
      if (data === "not_found") {
        return {
          ok: false,
          reason: "not_found",
          message: "That order no longer exists.",
        };
      }
      if (data === "illegal_transition") {
        return {
          ok: false,
          reason: "illegal",
          message: "A delivered or returned order cannot be cancelled.",
        };
      }
      return { ok: true, status: "cancelled", restocked: data === "cancelled" };
    }

    /**
     * Compare and swap. `.eq("status", order.status)` is the whole of it: the
     * row has to still be the one this decision was made against, or the update
     * matches zero rows and we go round again against whatever actually won.
     */
    const { data: swapped, error: swapError } = await supabase
      .from("orders")
      .update({ status: to })
      .eq("id", orderId)
      .eq("status", order.status)
      .select("id");

    if (swapError) {
      throw new Error(
        `transitionOrder.swap: ${swapError.message} [${swapError.code ?? "?"}]`,
      );
    }
    if ((swapped?.length ?? 0) !== 1) continue;

    const { error: historyError } = await supabase
      .from("order_status_history")
      .insert({
        order_id: orderId,
        status: to,
        note: note?.trim() || null,
        changed_by: actorId,
      });
    if (historyError) {
      // The status moved and the audit row did not. Loud, because a timeline
      // with a gap is worse than one that is merely incomplete — and not fatal
      // to the caller, whose order did move.
      console.error(
        "[admin] order moved but its history row failed:",
        historyError.message,
      );
    }

    return { ok: true, status: to, restocked: false };
  }

  return {
    ok: false,
    reason: "conflict",
    message:
      "This order changed while you were looking at it. Reload the page and try again.",
  };
}
