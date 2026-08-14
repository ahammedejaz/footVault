import { NextResponse } from "next/server";

import { authorisedCronRequest } from "@/lib/cron/auth";
import { readTracking } from "@/lib/shipping/fulfilment";
import {
  applyCourierSignal,
  reconciliationCandidates,
  recordStalledShipment,
  signalFromTracking,
  stalledShipments,
  STALLED_HOURS,
} from "@/lib/shipping/inbound";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The reconciliation sweep. Formerly the delivery poller, and the change of
 * name is the change of job.
 *
 * ## What it was, and why it never once ran
 *
 * From 11 August it took orders that were `shipped`, with an AWB, and asked
 * Shiprocket whether they had arrived. **No order in this shop's history has
 * ever reached `shipped`**, so in the six days it ran — forty-eight ticks a day
 * — it examined nothing, every time. Its own gate said as much in its header:
 * "the first real delivery is the real test". FV-2026-00668 was `packed` with a
 * courier assigned and a cancellation sitting in the Shiprocket portal, and the
 * `shipped` filter excluded it by construction.
 *
 * The filter was wrong for a reason worth keeping in mind: it took *our*
 * workflow status as a precondition for asking *the courier* a question. An
 * AWB is the real precondition. Our status is what the answer might change.
 *
 * ## Keep it, narrow it, or delete it — and why it stays
 *
 * The webhook this deploy adds is push, and push is the fast path. The brief
 * that asked for it was right that two inbound paths which disagree are worse
 * than one — so they are not two interpretations any more. Both parse into
 * `CourierSignal`, both call `applyCourierSignal`, and both dedupe against each
 * other on the same `event_key`: a sweep that rediscovers half an hour later
 * what the webhook already told us writes nothing and raises nothing.
 *
 * Given that, the sweep earns its place as the **backstop**, because everything
 * about the push path can fail silently and none of it is ours: the
 * subscription lives in Shiprocket's portal where it can be deleted or disabled
 * by their retry policy, there is no HMAC and therefore no delivery receipt,
 * and a token rotated in one place and not the other turns every event into a
 * 401 that nobody is watching for. A pull that runs every thirty minutes
 * notices all of that within thirty minutes.
 *
 * It also reaches what the webhook structurally cannot: a shipment with **no
 * AWB**, which produces no courier events at all because no courier has been
 * involved. That is FV-2026-00571 — created 8 August, ₹349 taken, never
 * assigned — and it is why `stalledShipments` exists beside the tracking sweep.
 *
 * ## What it may and may not do
 *
 * Never act on an unknown, inherited verbatim from the reconciler route. A
 * timeout, a 500, an unreadable payload leaves the parcel exactly as it was for
 * the next tick. And **this route moves no money and cancels nothing**: a
 * cancelled or lost parcel becomes a row on the dashboard with the amount
 * computed and a human's name on the decision. See `applyCourierSignal`.
 *
 * Scheduled by pg_cron → pg_net every 30 minutes
 * (supabase/migrations/20260811090100_schedule_delivery_poll.sql).
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

/** The stalled sweep costs no courier calls, so its cap only bounds our own writes. */
const MAX_STALLED_PER_TICK = 50;

export async function POST(request: Request): Promise<NextResponse> {
  if (!authorisedCronRequest(request, "cron/poll-deliveries")) {
    console.warn("[cron/reconcile] rejected: bad or missing token");
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const admin = createAdminClient();

  let candidates;
  try {
    candidates = await reconciliationCandidates(admin, MAX_SHIPMENTS_PER_TICK);
  } catch (error) {
    console.error("[cron/reconcile] could not read candidates", {
      message: error instanceof Error ? error.message : "unknown",
    });
    // 500 so a monitored failure is visible as one. Nothing has been changed.
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  const tally = {
    examined: 0,
    applied: 0,
    raised: 0,
    duplicate: 0,
    noChange: 0,
    unreachable: 0,
    stalled: 0,
  };

  for (const order of candidates) {
    tally.examined++;

    const tracked = await readTracking(admin, order.id);
    if (!tracked.ok) {
      // The unknown: courier unreachable, or payload unreadable. The parcel is
      // exactly as it was, and next tick asks again.
      console.warn("[cron/reconcile] tracking unavailable", {
        orderNumber: order.order_number,
        message: tracked.message,
      });
      tally.unreachable++;
      continue;
    }

    const signal = signalFromTracking(
      "sweep",
      { awb: tracked.awb, orderNumber: order.order_number },
      tracked.tracking,
      tracked.raw,
    );
    const result = await applyCourierSignal(
      admin,
      signal,
      JSON.stringify(tracked.raw ?? {}),
    );

    if (result.status === "duplicate") {
      // The webhook got here first. This is the steady state once the portal is
      // configured, and it is the evidence that the two paths agree.
      tally.duplicate++;
      continue;
    }
    if (result.status === "failed") {
      console.error("[cron/reconcile] could not record", {
        orderNumber: order.order_number,
        detail: result.message,
      });
      tally.unreachable++;
      continue;
    }
    if (result.outcome === "applied") {
      console.info("[cron/reconcile] applied", {
        orderNumber: order.order_number,
        interpretation: result.interpretation,
      });
      tally.applied++;
    } else if (result.needsAttention) {
      console.error("[cron/reconcile] NEEDS ATTENTION", {
        orderNumber: order.order_number,
        status: signal.statusText,
        interpretation: result.interpretation,
      });
      tally.raised++;
    } else {
      tally.noChange++;
    }
  }

  /**
   * The half no webhook can reach. A shipment with no AWB has no courier and
   * therefore no courier events, however well the push path is configured.
   */
  try {
    for (const stalled of await stalledShipments(admin, MAX_STALLED_PER_TICK)) {
      const result = await recordStalledShipment(admin, stalled);
      if (result.status === "recorded") {
        console.error("[cron/reconcile] NEEDS ATTENTION — stalled shipment", {
          orderNumber: stalled.orderNumber,
          hours: STALLED_HOURS,
          moneyTakenPaise: stalled.moneyTakenPaise,
        });
        tally.stalled++;
      }
    }
  } catch (error) {
    // Reported and survived: the tracking sweep above has already done its
    // work, and failing the whole tick because a second query hiccuped would
    // throw away results that are already durable.
    console.error("[cron/reconcile] stalled sweep failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
  }

  console.info("[cron/reconcile] tick complete", tally);
  return NextResponse.json({ ok: true, ...tally });
}
