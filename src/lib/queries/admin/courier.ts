import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { refundPanelState } from "@/lib/orders/refunds";
import { rows } from "@/lib/queries/run";

/**
 * The courier queue: everything a courier has said that this shop decided not
 * to act on by itself, with the money it is holding computed beside it.
 *
 * ## What this is for
 *
 * FV-2026-00668 was cancelled in the Shiprocket portal on 14 August. Nothing
 * here knew. The order still reads `packed`, the admin page still offers to
 * book a pickup, and ₹13.50 of the customer's money is captured against a
 * parcel that is never going to move. There was no code path by which that
 * fact could arrive, and — the part that matters more — no *surface* on which
 * it would have been visible if it had.
 *
 * This is the surface. Its predicate is exactly the partial index on
 * `courier_events`: raised, and not yet resolved by a person.
 *
 * ## Why the money is computed and not stored
 *
 * The figure is `refundPanelState(orderId).refundablePaise` — captured, less
 * what has already been refunded, less what is in flight. It is the same number
 * the refund panel offers and the same number `cancel_order_with_restock`
 * refuses on, and it is read live rather than stamped onto the event row so
 * that a refund issued in the Razorpay dashboard between the alert appearing
 * and somebody reading it makes the figure go down rather than making the shop
 * pay twice. The FV-2026-00623 double-refund is what that sentence is about.
 *
 * ## What it deliberately cannot do
 *
 * Nothing here issues a refund and nothing here changes an order. The queue
 * computes and points; a person decides. Whether a shipment is actually dead is
 * a fact that lives in the Shiprocket portal, not in this database, and a
 * founder does not move a customer's money on an inference.
 */

type Db = SupabaseClient<Database>;

export type CourierAttentionRow = {
  id: string;
  orderId: string | null;
  orderNumber: string | null;
  awb: string | null;
  statusText: string | null;
  interpretation: string;
  reason: string;
  receivedAt: string;
  source: string;
  /**
   * What the shop could give back right now, in paise. Null when the event
   * matched no order, or when the refund state could not be read — which is
   * not the same as zero and must not be rendered as "₹0.00".
   */
  refundablePaise: number | null;
  orderStatus: string | null;
  paymentStatus: string | null;
};

export type CourierQueue =
  | { state: "ok"; count: number; rows: CourierAttentionRow[] }
  | { state: "unknown"; message: string };

type EventRow = {
  id: string;
  order_id: string | null;
  awb: string | null;
  status_text: string | null;
  interpretation: string;
  attention_reason: string | null;
  received_at: string;
  source: string;
  orders: {
    order_number: string;
    status: string;
    payment_status: string;
  } | null;
};

/**
 * Twenty is a ceiling on the render, not on the count.
 *
 * `count` comes from the query's own exact count, so a queue of two hundred
 * says two hundred and shows twenty. A truncated list that reports its own
 * length as the total is how a backlog looks handled.
 */
const RENDER_LIMIT = 20;

export async function courierAttentionQueue(
  supabase: Db,
): Promise<CourierQueue> {
  try {
    const query = supabase
      .from("courier_events")
      .select(
        "id, order_id, awb, status_text, interpretation, attention_reason, received_at, source, orders(order_number, status, payment_status)",
        { count: "exact" },
      )
      .eq("needs_attention", true)
      .is("resolved_at", null)
      .order("received_at", { ascending: false })
      .limit(RENDER_LIMIT);

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);

    const events = (data ?? []) as unknown as EventRow[];
    if (events.length === 0)
      return { state: "ok", count: count ?? 0, rows: [] };

    /**
     * One refund read per queued order, and no more: two events about the same
     * parcel are one question about one sum of money.
     *
     * Sequential rather than `Promise.all`, because this runs on the dashboard
     * — the page the owner opens first — and a queue of twenty would otherwise
     * be twenty concurrent multi-query reads in front of the first paint. On a
     * healthy shop the loop body never runs at all.
     */
    const refundable = new Map<string, number | null>();
    for (const event of events) {
      if (!event.order_id || refundable.has(event.order_id)) continue;
      try {
        const state = await refundPanelState(event.order_id);
        refundable.set(event.order_id, state?.refundablePaise ?? null);
      } catch {
        // Null, not zero. "We could not work out what is owed" and "nothing is
        // owed" are opposite instructions to whoever reads this row.
        refundable.set(event.order_id, null);
      }
    }

    return {
      state: "ok",
      count: count ?? events.length,
      rows: events.map((event) => ({
        id: event.id,
        orderId: event.order_id,
        orderNumber: event.orders?.order_number ?? null,
        awb: event.awb,
        statusText: event.status_text,
        interpretation: event.interpretation,
        reason:
          event.attention_reason ??
          "A courier update this shop did not interpret. The payload is on the event row.",
        receivedAt: event.received_at,
        source: event.source,
        refundablePaise: event.order_id
          ? (refundable.get(event.order_id) ?? null)
          : null,
        orderStatus: event.orders?.status ?? null,
        paymentStatus: event.orders?.payment_status ?? null,
      })),
    };
  } catch (error) {
    // Degrades rather than throwing, like the refund queue beside it: an alert
    // strip that takes the dashboard down with it has cost the owner more than
    // the fault it was watching for.
    return {
      state: "unknown",
      message: error instanceof Error ? error.message : "unknown",
    };
  }
}

/** The unresolved events for one order, for the strip on its own page. */
export async function courierEventsForOrder(
  supabase: Db,
  orderId: string,
): Promise<
  {
    id: string;
    statusText: string | null;
    interpretation: string;
    reason: string;
    receivedAt: string;
    source: string;
  }[]
> {
  const events = await rows<Omit<EventRow, "orders">>(
    "admin.courier.forOrder",
    supabase
      .from("courier_events")
      .select(
        "id, order_id, awb, status_text, interpretation, attention_reason, received_at, source",
      )
      .eq("order_id", orderId)
      .eq("needs_attention", true)
      .is("resolved_at", null)
      .order("received_at", { ascending: false })
      .limit(10),
  );
  return events.map((event) => ({
    id: event.id,
    statusText: event.status_text,
    interpretation: event.interpretation,
    reason:
      event.attention_reason ??
      "A courier update this shop did not interpret.",
    receivedAt: event.received_at,
    source: event.source,
  }));
}
