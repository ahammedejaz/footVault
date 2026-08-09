import "server-only";

import { formatPaise } from "@/lib/format";
import { stockChanged } from "@/lib/stock-freshness";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { sendDelivered, sendShipped } from "@/lib/email";
import { canTransition, type OrderStatus } from "@/lib/orders/types";
import { maybeRow, rows } from "@/lib/queries/run";

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

/**
 * Tell the customer their parcel moved.
 *
 * **Never allowed to matter.** The order has already changed status by the time
 * this runs; a missing shipment row, a customer who checked out with no email,
 * or a dead mail provider all end here as a log line at worst. The owner has
 * booked a real courier pickup — failing their action because of an email would
 * be the tail wagging the dog.
 *
 * Tracking is read from `shipments` and every field of it is optional. An AWB is
 * assigned by a separate Shiprocket call from the one that books the pickup, so
 * a parcel can legitimately be `shipped` with no tracking number yet; the
 * template renders that case as "a tracking number usually appears within a
 * day" rather than printing a null.
 */
async function notifyStatusChange(
  supabase: SupabaseClient<Database>,
  orderId: string,
  to: "shipped" | "delivered",
): Promise<void> {
  try {
    const order = await maybeRow<{
      order_number: string;
      contact_email: string | null;
      balance_due_on_delivery: number | null;
      shipping_address: { recipientName?: string } | null;
    }>(
      "notifyStatusChange.order",
      supabase
        .from("orders")
        .select(
          "order_number, contact_email, balance_due_on_delivery, shipping_address",
        )
        .eq("id", orderId)
        .maybeSingle(),
    );
    if (!order?.contact_email) return;

    const customerName = order.shipping_address?.recipientName ?? "there";

    if (to === "delivered") {
      await sendDelivered({
        orderNumber: order.order_number,
        to: order.contact_email,
        customerName,
      });
      return;
    }

    const shipment = await maybeRow<{
      awb_code: string | null;
      courier_name: string | null;
    }>(
      "notifyStatusChange.shipment",
      supabase
        .from("shipments")
        .select("awb_code, courier_name")
        .eq("order_id", orderId)
        .maybeSingle(),
    );

    await sendShipped({
      orderNumber: order.order_number,
      to: order.contact_email,
      customerName,
      courierName: shipment?.courier_name ?? null,
      trackingNumber: shipment?.awb_code ?? null,
      /*
        Shiprocket's public tracker takes the AWB, so the link is derived rather
        than stored. No AWB means no link — never a URL ending in "null", which
        is the shape of a tracking link that makes a customer think the shop has
        lost their parcel.
      */
      trackingUrl: shipment?.awb_code
        ? `https://shiprocket.co/tracking/${encodeURIComponent(shipment.awb_code)}`
        : null,
      balanceDueOnDelivery: order.balance_due_on_delivery ?? 0,
    });
  } catch (error) {
    console.error(
      `[email] ${to} notice failed for order ${orderId}: ` +
        (error instanceof Error ? error.message : "unknown"),
    );
  }
}

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
          /*
            Null, and that is the decision rather than an omission. `p_reason` is
            the admin's own text and belongs in the audit column; what the
            customer needs to know about a cancellation — whether money is coming
            back — is *derived* from the order's payment status by
            `whatHappensNext`, in one place, rather than frozen into a history
            row that cannot know whether a refund settles afterwards.
          */
          p_customer_note: undefined,
        },
      );
      if (error) {
        throw new Error(
          `transitionOrder.cancel: ${error.message} [${error.code ?? "?"}]`,
        );
      }
      if (data === "already_paid") {
        /**
         * Only now, and only on the unhappy path. The guard has just told us
         * money is outstanding, so one extra round trip to say *how much* is
         * cheap — and without it the sentence names the whole advance on an
         * order that has already been partly refunded, which is the shop
         * sending the same money twice.
         *
         * Read with the elevated client because `refunds` is admin-only by
         * policy and this runs behind the admin guard already.
         */
        const settled = await rows<{ amount_paise: number }>(
          "transitionOrder.refunded",
          elevated()
            .from("refunds")
            .select("amount_paise")
            .eq("order_id", orderId)
            .eq("status", "processed"),
        );
        return {
          ok: false,
          reason: "paid",
          message: refundInstruction({
            ...order,
            refunded_paise: settled.reduce(
              (total, refund) => total + refund.amount_paise,
              0,
            ),
          }),
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
        /*
          The admin's own words stay internal. `note` here is whatever the owner
          typed into "Add a note" — "rang the customer, no answer" is the
          placeholder — and it was going straight onto the customer's order page.
          What the customer sees for a status change is the status label, which
          `ORDER_STATUS_COPY` already writes properly for all eight of them.
        */
        customer_note: null,
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

    /*
      The two status changes a customer is told about.

      Hooked here rather than in the admin actions because this is the only
      function that moves an order between statuses — `schedulePickupForOrder`
      reaches `shipped` through it, `setOrderStatus` reaches `delivered` through
      it, and anything added later gets the email without having to remember to.
      Wiring the two call sites instead would be two places to forget, and the
      one that gets forgotten is the one nobody notices for a month.

      Inside the CAS, after the swap that won, so a losing attempt cannot send.
      Never allowed to matter — see `notifyStatusChange`.
    */
    if (to === "shipped" || to === "delivered") {
      await notifyStatusChange(supabase, orderId, to);
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
  /**
   * What has **already** come back, in paise.
   *
   * Added because this sentence had the cancel guard's blind spot from the other
   * side: it told the owner to refund `advance_amount` without ever asking
   * whether that had already happened. On FV-2026-00623 — ₹135 captured, ₹135
   * refunded, webhook-confirmed — it instructed a second refund of money that
   * was already back with the customer. Obeyed, that is the shop paying twice.
   *
   * Optional so that callers with no refund data behave exactly as before.
   */
  refunded_paise?: number | null;
}): string {
  const isCod = order.payment_method === "cod";

  /**
   * What is still outstanding — the same arithmetic the SQL guard now uses, and
   * it has to be the same or the owner is shown a figure the database would not
   * refuse on. Never below zero: an over-refund is somebody else's problem and
   * printing a negative amount to refund would be nonsense.
   */
  const alreadyBack = Math.max(0, order.refunded_paise ?? 0);
  const captured =
    typeof order.advance_amount === "number"
      ? Math.max(0, order.advance_amount - alreadyBack)
      : order.advance_amount;

  /**
   * Nothing left to send back. Reached when a refund settled but the order was
   * never closed — exactly FV-2026-00623's state before this phase — and the
   * honest instruction is "press cancel again", not "refund ₹0".
   */
  if (alreadyBack > 0 && captured === 0) {
    return (
      "This order has already been refunded in full, so there is nothing left " +
      "to send back. Cancelling it now will put the pairs back on the shelf."
    );
  }

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

  /**
   * A partial refund already sent. Said out loud, because the figure above is
   * now smaller than the advance on the order and an owner cross-checking the
   * two would otherwise conclude the message was wrong.
   */
  const partly =
    alreadyBack > 0
      ? ` ${formatPaise(alreadyBack)} has already gone back, so this is what is left.`
      : "";

  /**
   * Since Batch 3 the panel on the order page moves the money itself, so the
   * sentence sends the owner there rather than to the Razorpay dashboard. The
   * amount and payment id stay in it on purpose — they are what the owner
   * cross-checks the panel against, and `scripts/audit/refund-message.ts`
   * holds this sentence to naming both and never the grand total.
   */
  return (
    "This order has been paid, so cancelling it would mean refunding it. " +
    `Use "The money back" panel on this page to send ${amount} back against ` +
    `${against}, then cancel.${notTheTotal}${partly}`
  );
}
