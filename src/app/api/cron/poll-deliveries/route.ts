import { NextResponse } from "next/server";

import { authorisedCronRequest } from "@/lib/cron/auth";
import { promoteDeliveredOrder } from "@/lib/orders/delivery";
import { fetchTracking, inFlightDeliveryCandidates } from "@/lib/shipping/fulfilment";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The poller that makes "delivered" real.
 *
 * Until Phase 11, `orders.delivered_at` was written only when an admin opened
 * an order and pressed "Refresh tracking" — which, measured against the
 * shop's entire history, was never (audit 11B: zero non-null values). The
 * 24-hour damage window had no clock behind it, and the two features this
 * phase adds — review eligibility and coin credit — would have hung off an
 * event that does not fire.
 *
 * Every tick: take the in-flight shipments (AWB assigned, still `shipped`,
 * no delivery or RTO stamp, under 45 days old, capped per tick), ask
 * Shiprocket about each through `fetchTracking` — the same single
 * implementation the admin button uses, RTO detection included — and where
 * that leaves courier-stamped `delivered_at` evidence on the order, promote
 * its status through `transitionOrder`, which writes the history row and
 * sends the delivered email exactly as the button would.
 *
 * **Never act on an unknown** — inherited verbatim from the reconciler
 * route's rule, and it matters more here because from Batch B this event
 * mints money. A timeout, a 500, an unparseable payload leaves the shipment
 * exactly as it was for the next tick; only the courier's own parsed
 * timestamp (`deliveredTimestamp`) ever counts as evidence, never a status
 * string the parser does not recognise.
 *
 * Scheduled by pg_cron → pg_net every 30 minutes
 * (supabase/migrations/20260811090100_schedule_delivery_poll.sql). The
 * reconciler runs at 10 because a charged customer is being cancelled; a
 * delivery discovered 30 minutes late costs nothing.
 */

/** `node:crypto` for the constant-time compare in the shared auth. */
export const runtime = "nodejs";

/** Never cached, never prerendered. It transitions orders. */
export const dynamic = "force-dynamic";

/**
 * Shiprocket calls one tick may spend. 48 ticks a day × this cap bounds the
 * quota; the remainder is next tick's work, not lost.
 */
const MAX_SHIPMENTS_PER_TICK = 40;

export async function POST(request: Request): Promise<NextResponse> {
  if (!authorisedCronRequest(request, "cron/poll-deliveries")) {
    console.warn("[cron/poll-deliveries] rejected: bad or missing token");
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const admin = createAdminClient();

  let candidates;
  try {
    candidates = await inFlightDeliveryCandidates(admin, MAX_SHIPMENTS_PER_TICK);
  } catch (error) {
    console.error("[cron/poll-deliveries] could not read candidates", {
      message: error instanceof Error ? error.message : "unknown",
    });
    // 500 so a monitored failure is visible as one. Nothing has been changed.
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  const tally = {
    examined: 0,
    delivered: 0,
    stillInFlight: 0,
    unreachable: 0,
  };

  for (const order of candidates) {
    tally.examined++;

    const tracked = await fetchTracking(admin, order.id);
    if (!tracked.ok) {
      // The unknown: courier unreachable, or payload unreadable. The shipment
      // is exactly as it was, and next tick asks again.
      console.warn("[cron/poll-deliveries] tracking unavailable", {
        orderNumber: order.order_number,
        message: tracked.message,
      });
      tally.unreachable++;
      continue;
    }

    const outcome = await promoteDeliveredOrder(admin, order.id);
    if ("result" in outcome && outcome.promoted) {
      console.info("[cron/poll-deliveries] order delivered", {
        orderNumber: order.order_number,
      });
      tally.delivered++;
    } else if ("result" in outcome && !outcome.promoted) {
      // Evidence exists but the transition lost — a concurrent writer, or a
      // state the transition table refuses. Worth seeing; next tick retries.
      console.warn("[cron/poll-deliveries] promotion did not apply", {
        orderNumber: order.order_number,
        result: outcome.result,
      });
      tally.stillInFlight++;
    } else {
      // No delivery evidence yet (or RTO detection just rerouted the order).
      tally.stillInFlight++;
    }
  }

  console.info("[cron/poll-deliveries] tick complete", tally);
  return NextResponse.json({ ok: true, ...tally });
}
