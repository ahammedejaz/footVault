import "server-only";

import { formatPaise } from "@/lib/format";
import { stockChanged } from "@/lib/stock-freshness";
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
    /**
     * Four columns beyond the two the swap needs, and they are here for one
     * branch: the refusal to cancel a paid order has to name the amount and the
     * payment it belongs to. Read on every pass rather than fetched inside that
     * branch because the row is already being read and a second round trip to
     * build an error message is a round trip spent on the unhappy path.
     */
    const order = await maybeRow<{
      id: string;
      status: OrderStatus;
      payment_method: string | null;
      advance_amount: number | null;
      grand_total: number | null;
      payment_reference: string | null;
    }>(
      "transitionOrder.read",
      supabase
        .from("orders")
        .select(
          "id, status, payment_method, advance_amount, grand_total, payment_reference",
        )
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
          message: refundInstruction(order),
        };
      }
      // Whatever the verdict below, the units may have gone back on the shelf.
      // Said unconditionally rather than only on the happy path: `already_cancelled`
      // means somebody else restocked, and the cache is no fresher for that.
      stockChanged();

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

/**
 * What to refund, and against which payment, in a sentence the owner can act on.
 *
 * Until refunds are built the shop's answer to "cancel this paid order" is a
 * manual transfer in the Razorpay dashboard, and the old wording — "refund in
 * Razorpay first" — named neither a figure nor a payment. The owner had to open
 * the order, work out which of three amounts on it was actually taken, and find
 * the payment by hand.
 *
 * **The amount is `advance_amount`, never `grand_total`, and that distinction is
 * the entire reason this function exists.** On a Pay-on-Delivery order those two
 * are wildly different: the advance is what Razorpay captured, the total
 * includes a balance the courier never collected because the parcel is being
 * cancelled. Refunding the total would send money the shop never received. On a
 * prepaid order they are equal — `orders_advance_balance_sums` guarantees
 * `advance_amount + balance_due_on_delivery = grand_total` — so reading the
 * advance is correct for both and there is no branch on payment method.
 *
 * Exported for the test. It is pure, and it is the only part of `transitionOrder`
 * worth asserting on without a database behind it.
 */
export function refundInstruction(order: {
  payment_method: string | null;
  advance_amount: number | null;
  grand_total: number | null;
  payment_reference: string | null;
}): string {
  const captured = order.advance_amount;
  const isCod = order.payment_method === "cod";

  // Null rather than zero: `advance_amount` is non-null on every order this
  // codebase writes, so a null here means something read a shape we do not
  // know. Saying "look it up" is honest; printing "₹0" would be a lie the owner
  // would act on.
  const amount =
    typeof captured === "number"
      ? formatPaise(captured)
      : "the amount captured at checkout";

  // A paid order should always carry its `pay_…` id. When it does not, do not
  // invent one — send them to the order number, which Razorpay's dashboard can
  // search on via the notes we attach at creation.
  const against = order.payment_reference
    ? `payment ${order.payment_reference}`
    : "the payment on this order (no payment reference was recorded — search Razorpay by order number)";

  // Only said for Pay on Delivery, because only there can the two numbers be
  // confused, and an unnecessary "not the total" on a prepaid order invites the
  // owner to wonder which figure is right.
  const notTheTotal =
    isCod &&
    typeof captured === "number" &&
    typeof order.grand_total === "number"
      ? ` That is the advance taken at checkout, not the ${formatPaise(order.grand_total)} order total — the balance was never collected.`
      : "";

  return (
    "This order has been paid, so cancelling it would mean refunding it. " +
    `Refund ${amount} against ${against} in Razorpay, then cancel.${notTheTotal}`
  );
}
