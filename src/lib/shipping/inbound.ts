import "server-only";

import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/database.types";
import { isRtoTrackingStatus } from "@/lib/orders/rto";
import { promoteDeliveredOrder } from "@/lib/orders/delivery";
import { courierInstant } from "@/lib/shipping/courier-time";
import { applyTrackingSnapshot, getShipment } from "@/lib/shipping/fulfilment";
import { maybeRow, rows } from "@/lib/queries/run";

/**
 * Everything the courier tells us, and the one seam that decides what to do
 * about it.
 *
 * ## Why there is exactly one of these
 *
 * Three things now hear from Shiprocket: the push webhook at
 * `/api/parcel/inbound`, the reconciliation sweep on
 * `/api/cron/poll-deliveries`, and the admin's own "Refresh tracking" button.
 * Before this module they would have been three interpretations of the same
 * courier vocabulary, and the brief that asked for the webhook put it exactly
 * right: *two inbound paths that disagree are worse than one*. So all three
 * parse into `CourierSignal`, all three call `applyCourierSignal`, and all
 * three dedupe against each other through the same `event_key` — a sweep that
 * rediscovers an hour later what the webhook already told us is absorbed as a
 * duplicate rather than raising a second alert about one parcel.
 *
 * ## The rule that matters more than any of the others
 *
 * **An unrecognised status is recorded and raised, never dropped.**
 *
 * We confidently understand two things a courier can say. "Delivered" starts
 * the 24-hour damage window and promotes the order. "RTO" means the parcel is
 * coming back. That is the whole vocabulary, and it is deliberately not
 * extended from memory: Shiprocket's documented sample payload carries exactly
 * one status — `Delivered`, id 7 — and a status map built by recalling what the
 * other numbers probably mean is a map of guesses that will be trusted like
 * facts. `status_id` is recorded on every row and dispatched on by nothing.
 *
 * Everything else — "Canceled", "Lost", "NDR raised", a word no courier has
 * used yet — is written to `courier_events` with `needs_attention`, appears on
 * the admin dashboard, and waits for a person. That is not a shortcut around
 * writing the map. It is the only behaviour under which the next thing we have
 * never seen gets noticed, and it is the behaviour whose absence cost
 * FV-2026-00668: a portal cancellation reached nothing, changed nothing, and
 * said nothing, while the customer's ₹13.50 sat captured.
 */

type Db = SupabaseClient<Database>;

/** Where a signal came from. Recorded, never used to decide anything. */
export type CourierSource = "webhook" | "sweep" | "admin";

export type CourierScan = {
  at: string | null;
  activity: string;
  location: string | null;
};

export type CourierSignal = {
  source: CourierSource;
  /** Always a string here — see `normaliseAwb`. */
  awb: string | null;
  /** The id we chose and sent at creation, if the courier echoes it back. */
  channelOrderId: string | null;
  /** Shiprocket's `order_id`, which is theirs *or* ours. See `matchOrder`. */
  courierOrderId: string | null;
  statusText: string | null;
  statusId: number | null;
  /** The courier's own moment, resolved through IST. Null if they gave none. */
  statusAt: string | null;
  scans: CourierScan[];
  payload: unknown;
};

export type CourierInterpretation =
  | "delivered"
  | "rto"
  | "unknown"
  | "unmatched"
  | "stalled";

export type CourierOutcome = "applied" | "no_change" | "stale" | "raised";

export type CourierResult = {
  status: "recorded" | "duplicate" | "failed";
  interpretation?: CourierInterpretation;
  outcome?: CourierOutcome;
  orderNumber?: string | null;
  needsAttention?: boolean;
  message?: string;
  /** True only when a 5xx would help. See the route. */
  retryable?: boolean;
};

/* -------------------------------------------------------------------------- */
/* normalising what arrived                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The AWB, as a string, and which side of the comparison was normalised.
 *
 * **Shiprocket sends `"awb": 59629792084` — a JSON number.** We store
 * `shipments.awb_code` as text, written verbatim from the same courier's own
 * AWB-assign response. The inbound side is the one normalised, for two reasons:
 * our stored value is the authoritative record of what the courier gave us and
 * rewriting it would be a migration over live rows for a formatting concern;
 * and text is the only representation that survives an AWB with a leading zero
 * or one longer than 15 digits, both of which a JSON number destroys.
 *
 * That destruction is the trap worth naming. `59629792084` is well inside
 * `Number.MAX_SAFE_INTEGER` and round-trips exactly; a 20-digit AWB does not,
 * and by the time `JSON.parse` has run the damage is already done and
 * invisible. So the receiver prefers the **digits as they appear in the raw
 * body** over the parsed number — see `rawAwbDigits` — and only falls back to
 * the parsed value when the body could not be scanned.
 */
export function normaliseAwb(value: unknown): string | null {
  if (typeof value === "string") {
    const text = value.trim();
    return text.length > 0 ? text : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

/**
 * The AWB exactly as it was typed in the JSON body, before `JSON.parse` turned
 * it into a float.
 *
 * Cheap, and it is the only defence against silent precision loss on a long
 * AWB. Matches an unquoted number only — a quoted AWB is already a string and
 * `normaliseAwb` handles it without help.
 */
export function rawAwbDigits(rawBody: string): string | null {
  const found = /"awb"\s*:\s*(\d{6,})/.exec(rawBody);
  return found?.[1] ?? null;
}

function text(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim()))
    return Number(value.trim());
  return null;
}

/**
 * Shiprocket's status-update body, read defensively.
 *
 * Returns null when the payload is not an object at all. Every field beyond
 * that is optional, because a webhook body is hostile input and a receiver that
 * throws on a missing key answers 500 and asks the courier to send it again
 * forever.
 *
 * **The scans array is sorted here, not trusted.** The documented sample
 * arrives newest-first; nothing promises that, and "the last scan" is what
 * decides the delivery moment when the summary timestamp is missing. Sorting by
 * date is one line and removes an assumption that would fail silently and in
 * the customer's disfavour.
 */
export function readWebhookSignal(
  body: unknown,
  rawBody: string,
): CourierSignal | null {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return null;
  const row = body as Record<string, unknown>;

  const scans: CourierScan[] = Array.isArray(row.scans)
    ? row.scans
        .flatMap((entry) => {
          if (typeof entry !== "object" || entry === null) return [];
          const scan = entry as Record<string, unknown>;
          const activity = text(scan.activity);
          if (!activity) return [];
          return [
            {
              at: courierInstant(scan.date),
              activity,
              location: text(scan.location),
            },
          ];
        })
        // Oldest first. `at` may be null for an unparseable date; those sort to
        // the front rather than being dropped, because a scan we cannot time is
        // still a scan somebody may need to read.
        .sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""))
    : [];

  /**
   * The summary timestamp if there is one, otherwise the newest scan.
   *
   * Not `now()`. A webhook can be retried a day later and stamping arrival time
   * would restart a customer's 24-hour window from whenever our function
   * happened to run.
   */
  const statusAt =
    courierInstant(row.current_timestamp) ??
    scans[scans.length - 1]?.at ??
    null;

  return {
    source: "webhook",
    awb: rawAwbDigits(rawBody) ?? normaliseAwb(row.awb),
    channelOrderId: text(row.channel_order_id),
    courierOrderId: text(row.order_id),
    statusText: text(row.current_status) ?? text(row.shipment_status),
    statusId: integer(row.current_status_id) ?? integer(row.shipment_status_id),
    statusAt,
    scans,
    payload: body,
  };
}

/* -------------------------------------------------------------------------- */
/* matching                                                                   */
/* -------------------------------------------------------------------------- */

export type CourierMatch =
  | { orderId: string; orderNumber: string; matchedBy: string }
  /**
   * Two shipments carry the same identifier, so acting would be a coin toss.
   *
   * `shipments.awb_code` has no unique constraint — nothing has ever needed one
   * — so this is reachable, and the failure it replaces is the bad one:
   * `maybeSingle()` **throws** on multiple rows, which inside the receiver is a
   * 500, which is Shiprocket retrying forever until the subscription is
   * disabled. Found by `audit:courier-inbound` on its first run, from a fixture
   * that accidentally minted three shipments with one AWB. The fixture was
   * wrong; the receiver's answer to it was worse.
   */
  | { ambiguous: string }
  | null;

/**
 * Which order this is about, in a precedence that is a decision rather than an
 * ordering of convenience.
 *
 * 1. **AWB.** The event is about a *parcel*. The AWB is the courier's own
 *    identifier for exactly one parcel, we hold it verbatim from their assign
 *    response, and it stays correct on the day a Shiprocket order is split into
 *    two shipments — at which point the order-level ids identify the order and
 *    say nothing about which half moved.
 * 2. **`channel_order_id` → `orders.order_number`.** The id *we* chose and sent
 *    at creation (`order_id: order.orderNumber` in `createShipment`). Unique in
 *    our system by construction. Second because it is order-level.
 * 3. **`order_id`, against both sides.** This field is genuinely ambiguous and
 *    the ambiguity is ours: we send our order number under that key when we
 *    create the order, and Shiprocket returns *their* id under the same key in
 *    the response we store as `shiprocket_order_id`. So both are tried —
 *    theirs first, because on an inbound message the sender's own identifier is
 *    the likelier meaning — and whichever hits is recorded in `matched_by` so
 *    the next person does not have to re-derive this paragraph from the code.
 *
 * A miss returns null and is **not** an error to swallow: the caller records the
 * event with `interpretation: 'unmatched'` and raises it. An inbound message
 * about a parcel we cannot find is either a Shiprocket account mix-up or our own
 * data being wrong, and both are things a person needs to see.
 */
export async function matchOrder(
  supabase: Db,
  signal: CourierSignal,
): Promise<CourierMatch> {
  if (signal.awb) {
    /**
     * Two rows are fetched, not one, precisely so that "more than one" is an
     * answer rather than an exception. See `CourierMatch`.
     */
    const hits = await rows<{
      order_id: string;
      orders: { order_number: string } | null;
    }>(
      "courier.match.awb",
      supabase
        .from("shipments")
        .select("order_id, orders(order_number)")
        .eq("awb_code", signal.awb)
        .limit(2),
    );
    if (hits.length > 1)
      return {
        ambiguous: `AWB ${signal.awb} is on ${hits.length} shipments in this database, so there is no way to tell which parcel this update is about.`,
      };
    const hit = hits[0];
    if (hit?.order_id)
      return {
        orderId: hit.order_id,
        orderNumber: hit.orders?.order_number ?? "",
        matchedBy: "awb",
      };
  }

  for (const [field, value] of [
    ["channel_order_id", signal.channelOrderId],
    ["courier_order_id", signal.courierOrderId],
  ] as const) {
    if (!value) continue;

    if (field === "courier_order_id") {
      const byShiprocket = await maybeRow<{
        order_id: string;
        orders: { order_number: string } | null;
      }>(
        "courier.match.shiprocketOrderId",
        supabase
          .from("shipments")
          .select("order_id, orders(order_number)")
          .eq("shiprocket_order_id", value)
          .maybeSingle(),
      );
      if (byShiprocket?.order_id)
        return {
          orderId: byShiprocket.order_id,
          orderNumber: byShiprocket.orders?.order_number ?? "",
          matchedBy: "courier_order_id",
        };
    }

    const byNumber = await maybeRow<{ id: string; order_number: string }>(
      "courier.match.orderNumber",
      supabase
        .from("orders")
        .select("id, order_number")
        .eq("order_number", value)
        .maybeSingle(),
    );
    if (byNumber)
      return {
        orderId: byNumber.id,
        orderNumber: byNumber.order_number,
        matchedBy: field,
      };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* interpreting                                                               */
/* -------------------------------------------------------------------------- */

/** Shiprocket's own words for "it arrived". Loose; it varies by courier. */
export function isDeliveredStatus(status: string | null): boolean {
  return (
    status !== null && /delivered/i.test(status) && !/undelivered/i.test(status)
  );
}

/**
 * What we make of a status string. Two answers and a shrug, on purpose.
 *
 * The shrug is the feature. See the module header: the only status ids in
 * evidence are one, and a map assembled from recollection would be believed.
 */
export function interpret(signal: CourierSignal): CourierInterpretation {
  if (isDeliveredStatus(signal.statusText)) return "delivered";
  if (isRtoTrackingStatus(signal.statusText)) return "rto";
  return "unknown";
}

/* -------------------------------------------------------------------------- */
/* the ledger                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The idempotency key, derived from the transition rather than from the body.
 *
 * Three properties are wanted and this is the cheapest thing that has all
 * three. A webhook **retry** carries an identical body and produces the same
 * key. A **reconciliation sweep** that discovers the same transition through a
 * completely different API shape produces the same key, so the two paths cannot
 * raise two alerts about one parcel — which is the entire reason the sweep is
 * allowed to keep existing. And a **genuinely new** transition on the same
 * parcel differs in status or in timestamp and gets its own row.
 *
 * The source is deliberately *not* in the key. Neither is the raw body: two
 * Shiprocket retries that differ only in a `retry_count` field are the same
 * event, and hashing the body would file them as two.
 *
 * When the courier gives no timestamp at all the key falls back to a hash of
 * the body, which still dedupes an identical retry and is the honest answer —
 * without a timestamp there is nothing that distinguishes "sent twice" from
 * "happened twice".
 */
export function eventKey(signal: CourierSignal, rawBody: string): string {
  const parcel =
    signal.awb ?? signal.channelOrderId ?? signal.courierOrderId ?? "unknown";
  const moment =
    signal.statusAt ?? `body:${createHash("sha256").update(rawBody).digest("hex").slice(0, 32)}`;
  return createHash("sha256")
    .update(`${parcel}|${(signal.statusText ?? "").toLowerCase()}|${moment}`)
    .digest("hex");
}

/** A `courier_events` row, as this module writes one. */
type EventDraft = {
  source: CourierSource;
  event_key: string;
  awb: string | null;
  channel_order_id: string | null;
  courier_order_id: string | null;
  status_text: string | null;
  status_id: number | null;
  status_at: string | null;
  order_id: string | null;
  matched_by: string | null;
  interpretation: CourierInterpretation;
  outcome: CourierOutcome;
  needs_attention: boolean;
  attention_reason: string | null;
  payload: Json | null;
};

/* -------------------------------------------------------------------------- */
/* applying                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Record what the courier said, then do the one thing it might mean.
 *
 * ## Order of operations, and why the claim is written first
 *
 * The row goes in before the work, with `on conflict do nothing`. A conflict
 * means some other delivery of this same transition already has it, and this
 * one returns `duplicate` having touched nothing — the shape `recordAndApply`
 * uses for Razorpay, and the reason a webhook that Shiprocket retries eight
 * times moves an order once.
 *
 * The alternative — apply, then record — is idempotent in practice, because
 * `delivered_at` is written only when null and `transitionOrder` is a
 * compare-and-swap. It was rejected anyway: "idempotent in practice" is a
 * property of today's callees, and the claim-first order does not depend on
 * them staying that way.
 *
 * ## Never backwards
 *
 * Two guards, because there are two ways to go backwards.
 *
 * **Out of order.** An event whose `status_at` is older than the newest one
 * already applied to this order is recorded as `stale` and applied to nothing.
 * Webhooks arrive out of order; "Out for delivery" landing after "Delivered"
 * must not un-deliver a parcel.
 *
 * **Past a terminal state.** Once an order carries `delivered_at` or `rto_at`,
 * a non-terminal signal changes nothing. It is still *recorded*, and if it is a
 * status we do not understand it is still *raised* — "Canceled" arriving after
 * "Delivered" is one of the more alarming things this endpoint could be told,
 * and the answer to it is a human, not a state change.
 */
export async function applyCourierSignal(
  supabase: Db,
  signal: CourierSignal,
  rawBody: string,
): Promise<CourierResult> {
  const key = eventKey(signal, rawBody);
  const found = await matchOrder(supabase, signal);
  const ambiguous = found !== null && "ambiguous" in found;
  const match = ambiguous ? null : (found as Exclude<CourierMatch, { ambiguous: string } | null>);

  const interpretation: CourierInterpretation = match
    ? interpret(signal)
    : "unmatched";

  const draft: EventDraft = {
    source: signal.source,
    event_key: key,
    awb: signal.awb,
    channel_order_id: signal.channelOrderId,
    courier_order_id: signal.courierOrderId,
    status_text: signal.statusText,
    status_id: signal.statusId,
    status_at: signal.statusAt,
    order_id: match?.orderId ?? null,
    matched_by: match?.matchedBy ?? null,
    interpretation,
    outcome: "raised",
    needs_attention: true,
    attention_reason: null,
    payload: (signal.payload ?? null) as Json,
  };

  if (!match) {
    draft.attention_reason = ambiguous
      ? `${(found as { ambiguous: string }).ambiguous} Status "${signal.statusText ?? "(none)"}". ` +
        `Nothing has been changed — fix the duplicate first.`
      : `A courier update arrived for a parcel this shop cannot find. ` +
      `AWB ${signal.awb ?? "(none)"}, order ${signal.courierOrderId ?? signal.channelOrderId ?? "(none)"}, ` +
      `status "${signal.statusText ?? "(none)"}". Either it belongs to another ` +
      `account or our own record of the parcel is wrong.`;
    return claim(supabase, draft, null);
  }

  /* ── stale? ────────────────────────────────────────────────────────────── */
  const newest = await maybeRow<{ status_at: string | null }>(
    "courier.newestApplied",
    supabase
      .from("courier_events")
      .select("status_at")
      .eq("order_id", match.orderId)
      .eq("outcome", "applied")
      .not("status_at", "is", null)
      .order("status_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  );

  if (
    signal.statusAt &&
    newest?.status_at &&
    signal.statusAt < newest.status_at
  ) {
    draft.outcome = "stale";
    draft.needs_attention = false;
    draft.attention_reason = null;
    return claim(supabase, draft, match.orderNumber);
  }

  /* ── what do we make of it? ────────────────────────────────────────────── */
  if (interpretation === "unknown") {
    draft.outcome = "raised";
    draft.needs_attention = true;
    draft.attention_reason =
      `Shiprocket says "${signal.statusText ?? "(no status)"}" about ${match.orderNumber}. ` +
      `This shop only acts automatically on "delivered" and "RTO"; everything ` +
      `else waits for a person, on purpose. Check the Shiprocket panel and ` +
      `decide what this order should do.`;
    return claim(supabase, draft, match.orderNumber);
  }

  const order = await maybeRow<{
    status: string;
    delivered_at: string | null;
    rto_at: string | null;
  }>(
    "courier.order",
    supabase
      .from("orders")
      .select("status, delivered_at, rto_at")
      .eq("id", match.orderId)
      .maybeSingle(),
  );

  if (order?.delivered_at || order?.rto_at) {
    // Terminal already. Re-applying "Delivered" is a no-op by design — the
    // window must not restart — so say so rather than pretending work happened.
    draft.outcome = "no_change";
    draft.needs_attention = false;
    return claim(supabase, draft, match.orderNumber);
  }

  /**
   * The write itself goes through the path that already existed.
   *
   * `applyTrackingSnapshot` caches the courier's status on the shipment, writes
   * `delivered_at` exactly once from the courier's own timestamp, mirrors it
   * onto the order with `delivered_source: 'courier'`, and runs RTO detection.
   * Every one of those behaviours is proven by `audit:delivery-poll` and
   * `audit:rto`, and reimplementing them here for the webhook is how the two
   * paths would start to disagree.
   */
  const shipment = await getShipment(supabase, match.orderId);
  if (!shipment) {
    draft.outcome = "raised";
    draft.needs_attention = true;
    draft.attention_reason =
      `Shiprocket says "${signal.statusText}" about ${match.orderNumber}, ` +
      `but this shop has no shipment row for it to write against.`;
    return claim(supabase, draft, match.orderNumber);
  }

  const applied = await applyTrackingSnapshot(
    supabase,
    match.orderId,
    {
      status: signal.statusText,
      activities: signal.scans.map((scan) => ({
        // `applyTracking` re-parses this string, so it is handed back in the
        // shape it arrived in rather than as an ISO instant — one parser, and
        // it is the one `courier-time.ts` owns.
        date: scan.at ?? "",
        activity: scan.activity,
        location: scan.location,
      })),
    },
    signal.payload,
  );

  if (!applied.ok) {
    draft.outcome = "raised";
    draft.needs_attention = true;
    draft.attention_reason =
      `Could not apply "${signal.statusText}" to ${match.orderNumber}: ${applied.message ?? "unknown"}.`;
    const recorded = await claim(supabase, draft, match.orderNumber);
    return { ...recorded, retryable: true };
  }

  if (interpretation === "delivered") {
    const promotion = await promoteDeliveredOrder(supabase, match.orderId);
    if ("result" in promotion && promotion.promoted) {
      draft.outcome = "applied";
      draft.needs_attention = false;
    } else {
      /**
       * Evidence landed and the transition did not. `not_shipped` is the
       * common case in this shop and it is worth a person: a parcel the
       * courier says it delivered against an order nobody ever marked shipped
       * means our own workflow and the courier's disagree about what happened.
       */
      draft.outcome = "raised";
      draft.needs_attention = true;
      draft.attention_reason =
        `${match.orderNumber} has courier delivery evidence but did not move to ` +
        `delivered (${"why" in promotion ? promotion.why : promotion.result}). ` +
        `The delivery timestamp is recorded; the order's status is not.`;
    }
    return claim(supabase, draft, match.orderNumber);
  }

  // RTO: `applyTrackingSnapshot` has already run detection, which owns the
  // transition and its own compare-and-swap.
  draft.outcome = "applied";
  draft.needs_attention = false;
  return claim(supabase, draft, match.orderNumber);
}

/**
 * Write the row, and read a unique violation as "somebody else got here first".
 *
 * 23505 is the only error code treated as success, and it is the one the whole
 * design rests on: `event_key` is unique, so a retry, a re-delivery and a sweep
 * rediscovering the same transition all land here and all leave exactly one
 * row.
 */
async function claim(
  supabase: Db,
  draft: EventDraft,
  orderNumber: string | null,
): Promise<CourierResult> {
  const { error } = await supabase.from("courier_events").insert(draft);

  if (error) {
    if (error.code === "23505")
      return { status: "duplicate", orderNumber, interpretation: draft.interpretation };
    console.error("[courier-inbound] could not record the event", {
      code: error.code,
      message: error.message,
      eventKey: draft.event_key,
    });
    return {
      status: "failed",
      message: error.message,
      // A write we could not make is worth another delivery; the courier's
      // retry is the only thing that will bring this event back.
      retryable: true,
    };
  }

  return {
    status: "recorded",
    interpretation: draft.interpretation,
    outcome: draft.outcome,
    orderNumber,
    needsAttention: draft.needs_attention,
  };
}

/* -------------------------------------------------------------------------- */
/* the pull side: reconciliation                                              */
/* -------------------------------------------------------------------------- */

/**
 * A tracking snapshot, in the same shape a webhook body arrives in.
 *
 * The point of converting rather than special-casing: a pulled signal goes
 * through `matchOrder` like any other, matching on the AWB we just used to ask
 * about it. That looks like a wasted round trip and is the opposite — it means
 * the matcher is exercised on every sweep tick rather than only when a webhook
 * happens to arrive, and it means a pull and a push about the same transition
 * produce the same `event_key` and collapse into one row.
 */
export function signalFromTracking(
  source: CourierSource,
  parcel: { awb: string; orderNumber: string | null },
  tracking: { status: string | null; activities: CourierScan[] | { date: string; activity: string; location: string | null }[] },
  raw: unknown,
): CourierSignal {
  const scans: CourierScan[] = (tracking.activities as { date?: string; at?: string | null; activity: string; location: string | null }[])
    .map((entry) => ({
      at: courierInstant(entry.at ?? entry.date),
      activity: entry.activity,
      location: entry.location,
    }))
    .sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));

  return {
    source,
    awb: parcel.awb,
    channelOrderId: parcel.orderNumber,
    courierOrderId: null,
    statusText: tracking.status,
    statusId: null,
    statusAt: scans[scans.length - 1]?.at ?? null,
    scans,
    payload: raw,
  };
}

/**
 * A parcel that was handed to Shiprocket and never moved, with the customer's
 * money already taken.
 *
 * ## Why this is here and not a status
 *
 * The tracking API needs an AWB. FV-2026-00571 has none: a shipment created on
 * 8 August that never got a courier assigned, ₹349 of a Pay-on-Delivery advance
 * sitting captured, and seven days of nothing. There is no courier status to
 * interpret because there is no courier. The only signal available is the
 * clock, and the clock is a legitimate signal here — three days without even
 * assigning a courier is not a slow day, it is an abandoned parcel.
 *
 * ## Why seventy-two hours
 *
 * It has to be a threshold that cannot fire on a healthy order, because a queue
 * with false positives is a queue nobody reads. A normal parcel gets its AWB in
 * the same sitting as its shipment — the admin panel's five steps are pressed
 * one after another. Three days is far outside that and inside no plausible
 * working pattern, including a weekend. It is deliberately *not* tuned to catch
 * things sooner: a parcel with an AWB has tracking, and tracking is evidence,
 * and evidence beats a clock every time.
 *
 * Recorded once per shipment, not once per sweep: the `event_key` names the
 * order and the finding, so forty-eight ticks a day produce one row and one
 * alert until a person resolves it.
 */
export const STALLED_HOURS = 72;

export type StalledShipment = {
  orderId: string;
  orderNumber: string;
  shipmentCreatedAt: string;
  moneyTakenPaise: number;
};

export async function recordStalledShipment(
  supabase: Db,
  stalled: StalledShipment,
): Promise<CourierResult> {
  const draft: EventDraft = {
    source: "sweep",
    event_key: createHash("sha256")
      .update(`stalled|${stalled.orderId}|${stalled.shipmentCreatedAt}`)
      .digest("hex"),
    awb: null,
    channel_order_id: stalled.orderNumber,
    courier_order_id: null,
    status_text: null,
    status_id: null,
    status_at: stalled.shipmentCreatedAt,
    order_id: stalled.orderId,
    matched_by: "stalled_sweep",
    interpretation: "stalled",
    outcome: "raised",
    needs_attention: true,
    attention_reason:
      `${stalled.orderNumber} was handed to Shiprocket on ` +
      `${stalled.shipmentCreatedAt.slice(0, 10)} and still has no courier assigned, ` +
      `${STALLED_HOURS} hours later. The shop is holding ` +
      `₹${(stalled.moneyTakenPaise / 100).toFixed(2)} against a parcel that has not ` +
      `started moving. Check the Shiprocket panel: if the shipment is dead there, ` +
      `this order needs cancelling here and that money needs returning.`,
    payload: null,
  };
  return claim(supabase, draft, stalled.orderNumber);
}

/**
 * The parcels the reconciliation sweep should ask about.
 *
 * **Widened, and that widening is the fix.** The old candidate set was
 * `status = 'shipped'`, which no order in this shop's history has ever reached
 * — so the poller has run forty-eight times a day since 11 August with zero
 * candidates, every time, and its own gate said so. FV-2026-00668 is `packed`
 * with an AWB assigned and a cancellation sitting in the Shiprocket portal, and
 * the old filter excluded it by construction.
 *
 * An AWB is the real precondition: it means a courier has been committed and
 * there is something to ask about. Our own workflow status is not, and treating
 * it as one is what made the poller a no-op for its entire life.
 *
 * The other filters keep their reasons. A stamped `delivered_at` or `rto_at`
 * means the question is answered; the 45-day cap means a parcel lost in 2026 is
 * not still being polled in 2027; and the per-tick limit bounds the backlog
 * after an outage, because an unbounded catch-up is a self-inflicted rate-limit
 * incident against a quota that also moves this shop's real parcels.
 */
export async function reconciliationCandidates(
  supabase: Db,
  limit: number,
): Promise<{ id: string; order_number: string }[]> {
  const cutoff = new Date(Date.now() - 45 * 24 * 60 * 60_000).toISOString();
  const { data, error } = await supabase
    .from("orders")
    .select("id, order_number, shipments!inner(awb_code)")
    .in("status", ["confirmed", "packed", "shipped"])
    .is("delivered_at", null)
    .is("rto_at", null)
    .gt("placed_at", cutoff)
    .not("shipments.awb_code", "is", null)
    .order("placed_at", { ascending: true })
    .limit(limit);
  if (error)
    throw new Error(`could not read reconciliation candidates: ${error.message}`);
  return (data ?? []) as unknown as { id: string; order_number: string }[];
}

/**
 * Shipments with money on them that never got a courier.
 *
 * The money figure is the one the refund queue and the dashboard both use:
 * `advance_amount` when there is one (a Pay-on-Delivery deposit) and the order
 * total otherwise (a fully prepaid order). Same expression
 * `applyPaymentOutcome` uses to decide what it expected to be paid, so three
 * places cannot disagree about what "we took" means.
 */
export async function stalledShipments(
  supabase: Db,
  limit: number,
): Promise<StalledShipment[]> {
  const cutoff = new Date(Date.now() - STALLED_HOURS * 60 * 60_000).toISOString();
  const { data, error } = await supabase
    .from("orders")
    .select(
      "id, order_number, grand_total, advance_amount, payment_status, shipments!inner(awb_code, created_at)",
    )
    .in("status", ["confirmed", "packed"])
    .eq("payment_status", "paid")
    .is("delivered_at", null)
    .is("rto_at", null)
    .limit(limit);
  if (error)
    throw new Error(`could not read stalled shipments: ${error.message}`);

  const rows = (data ?? []) as unknown as {
    id: string;
    order_number: string;
    grand_total: number;
    advance_amount: number;
    shipments: { awb_code: string | null; created_at: string }[];
  }[];

  return rows.flatMap((row) => {
    // `shipments!inner` returns an array through PostgREST even for a 1:1.
    const shipment = Array.isArray(row.shipments)
      ? row.shipments[0]
      : (row.shipments as unknown as { awb_code: string | null; created_at: string });
    if (!shipment || shipment.awb_code) return [];
    if (shipment.created_at > cutoff) return [];
    return [
      {
        orderId: row.id,
        orderNumber: row.order_number,
        shipmentCreatedAt: shipment.created_at,
        moneyTakenPaise:
          row.advance_amount > 0 ? row.advance_amount : row.grand_total,
      },
    ];
  });
}
