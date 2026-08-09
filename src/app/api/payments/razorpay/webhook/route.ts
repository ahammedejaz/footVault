import { NextResponse } from "next/server";

import { recordAndApplyRefund } from "@/lib/orders/refunds";
import { recordAndApply } from "@/lib/payments/apply";
import { getPaymentAdapter } from "@/lib/payments";
import { callerIp, consumeRateLimit } from "@/lib/rate-limit";

/**
 * Razorpay's webhook. The authoritative word on whether money moved.
 *
 * The browser's success callback is a hint — it can be closed, lost to a dead
 * phone battery, or fabricated. This endpoint is the one Razorpay calls
 * server-to-server, and it is what decides payment state. Everything about the
 * handler below is arranged around two facts:
 *
 *   **It is public.** Anyone can POST here. The signature is the entire
 *   authentication, it is checked before anything else, and until
 *   `RAZORPAY_WEBHOOK_SECRET` exists the adapter rejects every request — which
 *   is the correct failure direction for an endpoint that can confirm orders.
 *
 *   **It is retried.** Razorpay redelivers anything that is slow or not 2xx,
 *   so the same event arrives repeatedly and the handler must be idempotent.
 *   It also means the status code is a control signal, not decoration: a 500
 *   asks for redelivery and a 200 says "done, stop". Answering 500 to something
 *   we will never be able to process makes Razorpay hammer the endpoint until
 *   it disables it, and every later event is lost with it.
 *
 * Nothing here touches `orders`. Verified events go to `recordAndApply`, which
 * claims the event id and calls the order code's seam.
 */

/** `node:crypto` for the HMAC. Not available on the edge runtime. */
export const runtime = "nodejs";

/** A payment event is never cacheable and never prerendered. */
export const dynamic = "force-dynamic";

/**
 * Razorpay's payloads are a few kilobytes. Anything approaching a megabyte is
 * not a webhook, and HMACing it before finding that out would be doing an
 * attacker's memory allocation for them.
 */
const MAX_BODY_BYTES = 1_000_000;

const PROVIDER = "razorpay" as const;

export async function POST(request: Request): Promise<NextResponse> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    console.warn("[razorpay-webhook] rejected: body too large", {
      declaredLength,
    });
    return reject();
  }

  /**
   * The raw bytes, as text, before anything parses them.
   *
   * `request.json()` would be the shorter thing and would break the signature
   * check completely: the HMAC is over the exact body Razorpay sent, and
   * re-serialising a parsed object changes key order and whitespace. Every
   * signature would fail and it would look like a configuration problem.
   */
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    console.warn("[razorpay-webhook] rejected: body could not be read");
    return reject();
  }

  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    console.warn("[razorpay-webhook] rejected: body too large");
    return reject();
  }

  /**
   * A ceiling on how much work one source can ask this endpoint to do.
   *
   * Be precise about what this does and does not buy, because an
   * application-level limiter on a public endpoint is easy to oversell. It does
   * **not** stop the request: the function has already been invoked and billed
   * by the time this line runs, and volumetric defence is Vercel's WAF, not
   * ours. What it does is bound the *database* work a flood can cause —
   * `recordAndApply` writes to `payment_events` on every verified event, and a
   * replay flood of one genuinely signed payload would otherwise be a few
   * thousand round trips a second.
   *
   * 429 rather than 400 on purpose. Razorpay redelivers anything non-2xx with
   * backoff for about a day, so a throttled event is delayed, never dropped —
   * whereas a 400 is us telling Razorpay this event is permanently unacceptable.
   *
   * The bucket is the caller's IP, which off Vercel is a client-controlled
   * header. That is survivable here precisely because the worst case is delay:
   * an attacker who spoofs Razorpay's IP to exhaust its bucket buys a retry, not
   * a lost payment.
   */
  const throttle = await consumeRateLimit("webhook", await callerIp());
  if (!throttle.allowed) {
    console.warn("[razorpay-webhook] throttled", {
      providerEventId: request.headers.get("x-razorpay-event-id"),
      retryAfterSeconds: throttle.retryAfterSeconds,
    });
    const throttled = noStore(429);
    throttled.headers["retry-after"] = String(throttle.retryAfterSeconds);
    return NextResponse.json({ ok: false }, throttled);
  }

  /**
   * Razorpay's own event id, for cross-referencing a dashboard row in support.
   * It is logged and not used as the idempotency key — see `webhookEventId` in
   * `src/lib/payments/razorpay.ts` for why a derived key dedupes strictly more,
   * including a manual resend from the dashboard.
   */
  const providerEventId = request.headers.get("x-razorpay-event-id");

  const parsed = getPaymentAdapter(PROVIDER).parseWebhook(
    rawBody,
    request.headers.get("x-razorpay-signature"),
  );

  if (!parsed.ok) {
    if (parsed.reason === "unhandled") {
      // An event type we do not handle is not a failure. Razorpay sends
      // whatever the dashboard subscription is set to, and 400ing on
      // `payment.downtime.started` would put the endpoint into retry and then
      // into disabled.
      console.info("[razorpay-webhook] ignored", {
        providerEventId,
        detail: parsed.message,
      });
      return NextResponse.json({ ok: true, ignored: true }, noStore(200));
    }

    /**
     * `bad_signature` and `malformed` both land here as a 400. The adapter has
     * already logged the reason; the payload itself is never logged, by either
     * of us.
     *
     * `malformed` means the signature checked out and we still could not read
     * it — a Razorpay schema change, or the currency guard firing. 400 is the
     * deliberate answer there too, even though nothing we do will make the
     * retry parse: Razorpay redelivers with backoff for around a day, and that
     * window is the only chance a deploy has to catch the events that arrived
     * during the outage. Answering 200 would drop them silently, which for a
     * captured payment is the worst outcome available.
     */
    console.warn("[razorpay-webhook] rejected", {
      providerEventId,
      reason: parsed.reason,
    });
    return reject();
  }

  /**
   * Refund events settle `refunds` rows, not order payment state, so they
   * take their own path with the same shape of discipline: claim the event id
   * first, 500 only when redelivery could help, 200 otherwise. A refund the
   * database has never heard of is recorded rather than refused — that is a
   * dashboard refund becoming visible, which is the reconciliation the brief
   * asks for arriving by push instead of pull.
   */
  if (parsed.refund) {
    const application = await recordAndApplyRefund(parsed.refund);
    switch (application.status) {
      case "duplicate":
        console.info("[razorpay-webhook] refund already handled", {
          providerEventId,
          eventId: parsed.refund.eventId,
        });
        return NextResponse.json({ ok: true, duplicate: true }, noStore(200));
      case "not_found":
        // A refund along a payment this deployment has never seen — the
        // shared test account again. Logged loud enough to investigate,
        // answered 200 so Razorpay stops resending it.
        console.error("[razorpay-webhook] refund for unknown payment", {
          providerEventId,
          eventId: parsed.refund.eventId,
        });
        return NextResponse.json({ ok: true, applied: false }, noStore(200));
      case "failed":
        console.error("[razorpay-webhook] refund could not be applied", {
          providerEventId,
          eventId: parsed.refund.eventId,
          retryable: application.retryable,
          detail: application.message,
        });
        return NextResponse.json(
          { ok: false },
          noStore(application.retryable ? 500 : 200),
        );
      case "applied":
        console.info("[razorpay-webhook] refund applied", {
          providerEventId,
          eventId: parsed.refund.eventId,
          eventType: parsed.refund.eventType,
        });
        return NextResponse.json({ ok: true }, noStore(200));
    }
  }

  const { eventId, eventType, providerOrderId, outcome } = parsed.event;

  if (!providerOrderId || !outcome) {
    // Verified, understood, and about nothing we can act on — a payment with no
    // order attached, which our checkout never creates. Recorded in the log and
    // deliberately *not* claimed in the ledger, so that if this ever turns out
    // to be a real case a resend can still be processed.
    console.warn("[razorpay-webhook] verified but not actionable", {
      providerEventId,
      eventId,
      eventType,
    });
    return NextResponse.json({ ok: true, ignored: true }, noStore(200));
  }

  const application = await recordAndApply({
    eventId,
    provider: PROVIDER,
    providerOrderId,
    eventType,
    outcome,
  });

  if (application.status === "duplicate") {
    // The steady state under retry, and the reason this endpoint is safe to
    // call ten times. Info, not warn: it is expected traffic.
    console.info("[razorpay-webhook] already handled", {
      providerEventId,
      eventId,
    });
    return NextResponse.json({ ok: true, duplicate: true }, noStore(200));
  }

  if (application.status === "failed") {
    console.error("[razorpay-webhook] could not apply", {
      providerEventId,
      eventId,
      eventType,
      retryable: application.retryable,
      detail: application.message,
    });
    // 500 is a request for redelivery, and it is only correct when redelivery
    // could help. `recordAndApply` has already given the event claim back, so
    // the retry will be processed rather than short-circuited as a duplicate.
    return NextResponse.json(
      { ok: false },
      noStore(application.retryable ? 500 : 200),
    );
  }

  const { result } = application;

  if (result.applied) {
    console.info("[razorpay-webhook] applied", {
      providerEventId,
      eventId,
      eventType,
      status: result.status,
      paymentStatus: result.paymentStatus,
    });
    return NextResponse.json({ ok: true }, noStore(200));
  }

  /**
   * The seam declined, and every reason it can give is a 200.
   *
   * **`illegal_transition` was logged at info here, and that was wrong.** The
   * comment this replaces justified the low severity by saying it is "the
   * normal outcome when the browser callback got here first". It is not, and
   * it cannot be: when the callback has already confirmed the order,
   * `applyPaymentOutcome` finds a `confirmed` order, which is not terminal and
   * not `pending`, so neither branch that sets `illegal` fires and the result
   * is `applied: true` with the status left alone. Traced through
   * `payment-state.ts` rather than assumed.
   *
   * There are exactly two ways to reach `illegal_transition`, and both are
   * somebody's money:
   *
   *   - a capture short of what was owed, which leaves the order `pending` and
   *     `unpaid` for a human — a customer charged for an order that will not
   *     ship;
   *   - a capture against an order that is already `cancelled` or `returned` —
   *     the shop has taken money for goods it has put back on the shelf, and
   *     owes a refund.
   *
   * Neither should ever be filtered out of a log at info level, and the
   * cancelled case now also appears on the admin dashboard as a refund queue.
   * `duplicate` genuinely is routine — the seam's idempotency agreeing with
   * ours. `not_found` is an event for an order this deployment does not have.
   */
  const line = "[razorpay-webhook] not applied";
  const fields = {
    providerEventId,
    eventId,
    eventType,
    reason: result.reason,
    detail: result.message,
  };
  if (result.reason === "not_found" || result.reason === "illegal_transition")
    console.error(line, fields);
  else console.info(line, fields);

  return NextResponse.json({ ok: true, applied: false }, noStore(200));
}

/**
 * One rejection shape for every unverified request.
 *
 * Deliberately says nothing: "no signature", "wrong signature" and "not JSON"
 * are three different pieces of information, and an attacker who can tell them
 * apart can work out what to change. The reasons are in our logs instead.
 */
function reject(): NextResponse {
  return NextResponse.json({ ok: false }, noStore(400));
}

function noStore(status: number): {
  status: number;
  headers: Record<string, string>;
} {
  return { status, headers: { "Cache-Control": "no-store" } };
}
