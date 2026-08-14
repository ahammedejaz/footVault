import { NextResponse } from "next/server";

import { callerIp, consumeRateLimit } from "@/lib/rate-limit";
import {
  applyCourierSignal,
  readWebhookSignal,
} from "@/lib/shipping/inbound";
import { createAdminClient } from "@/lib/supabase/admin";
import { timingSafeEqual } from "node:crypto";

/**
 * Shiprocket's status-update webhook. The first inbound courier path this shop
 * has ever had.
 *
 * ## Why the path says nothing about who calls it
 *
 * Shiprocket's own configuration page refuses a URL containing "shiprocket",
 * "kartrocket", "sr" or "kr" — an anti-abuse rule of theirs, and "sr" as a bare
 * substring rules out a great many obvious names ("courier-status" is fine;
 * "shipping-response" is not). `/api/parcel/inbound` is clean of all four in
 * both the host and the path, which is the check that matters: the full URL is
 * `https://www.footvault.in/api/parcel/inbound`.
 *
 * ## The security model, stated plainly because it is weak
 *
 * **There is no HMAC.** Shiprocket authenticates with a static token in a
 * header of your choosing, and that is the entire authentication. Anyone who
 * learns the URL and the token can post arbitrary courier state at this shop —
 * mark a parcel delivered, start a 24-hour damage window, promote an order.
 * That is not a risk this code can design away; it can only be contained:
 *
 *   - the token is compared in **constant time**, so the endpoint is not itself
 *     an oracle for guessing it one byte at a time;
 *   - an **absent** `COURIER_WEBHOOK_TOKEN` refuses everything rather than
 *     opening the door, the same choice `authorisedCronRequest` makes and for
 *     the same reason: "unset means open" is how a route becomes public the
 *     first time an environment variable fails to copy across;
 *   - the **response is identical** for a wrong token and for a body we cannot
 *     read. "Bad token" and "bad JSON" are two different facts and an attacker
 *     who can tell them apart learns which half to keep changing. The real
 *     reason goes to our logs;
 *   - and every payload is treated as hostile: size-capped before it is read,
 *     rate-limited per caller, parsed field by field with no field required,
 *     and — this is the important one — **acted upon only for the two statuses
 *     this shop understands**. A forged "Canceled" cannot cancel anything,
 *     because a real one cannot either.
 *
 * The token should be long and random, it should exist nowhere in this
 * repository, and rotating it is a one-line change in two places (the Vercel
 * environment and the Shiprocket portal). See docs/shipping-webhook.md.
 *
 * ## Why almost everything answers 200
 *
 * A webhook's status code is a control signal, not a report card. Shiprocket
 * retries non-2xx and eventually disables a subscription that keeps failing —
 * and a disabled subscription is this whole feature silently gone, which is the
 * state the shop is in today and the reason FV-2026-00668 sat cancelled and
 * unnoticed. So the endpoint answers 200 the moment the event is **durably
 * recorded**, whatever we made of it. An unmatched parcel is a 200. A status we
 * do not understand is a 200. Both are on the dashboard before the response is
 * written; neither is dropped.
 *
 * 500 is reserved for the one case where another delivery would genuinely help:
 * we could not write the row. 401 is reserved for "we do not believe you".
 */

/** `node:crypto` for the constant-time compare. */
export const runtime = "nodejs";

/** A courier event is never cacheable and never prerendered. */
export const dynamic = "force-dynamic";

/**
 * A status-update body is a few kilobytes; the documented sample is under one.
 * Anything approaching a quarter of a megabyte is not a webhook, and reading it
 * into memory before finding that out is doing an attacker's allocation for
 * them.
 */
const MAX_BODY_BYTES = 262_144;

export async function POST(request: Request): Promise<NextResponse> {
  /**
   * The token first, before the body is touched.
   *
   * Ordering, not decoration: an unauthenticated caller must not be able to
   * make this function parse anything, and checking auth first is what makes
   * "identical response for a bad token and a bad body" cost nothing — the only
   * way to reach the malformed-body branch is to already hold the token.
   */
  if (!authorised(request)) {
    console.warn("[parcel-inbound] refused: bad or missing token");
    return refuse();
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    console.warn("[parcel-inbound] refused: body too large", { declaredLength });
    return refuse();
  }

  /**
   * A ceiling on the database work one source can ask for. It does not stop the
   * request — the function is already invoked and billed — it bounds the writes
   * a flood can cause. 429 rather than 400 because a throttled event is delayed
   * by Shiprocket's own retry and never dropped.
   */
  const throttle = await consumeRateLimit("webhook", await callerIp());
  if (!throttle.allowed) {
    console.warn("[parcel-inbound] throttled", {
      retryAfterSeconds: throttle.retryAfterSeconds,
    });
    return NextResponse.json(
      { ok: false },
      {
        status: 429,
        headers: {
          "Cache-Control": "no-store",
          "retry-after": String(throttle.retryAfterSeconds),
        },
      },
    );
  }

  /**
   * The raw text is kept, and it is not only for logging: `rawAwbDigits` reads
   * the AWB out of it as the digits Shiprocket actually typed, because
   * `JSON.parse` has already turned a long one into a float by the time the
   * parsed object exists.
   */
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    console.warn("[parcel-inbound] refused: body could not be read");
    return refuse();
  }

  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    console.warn("[parcel-inbound] refused: body too large");
    return refuse();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    console.warn("[parcel-inbound] refused: body is not JSON");
    return refuse();
  }

  const signal = readWebhookSignal(parsed, rawBody);
  if (!signal) {
    console.warn("[parcel-inbound] refused: body is not a status object");
    return refuse();
  }

  const result = await applyCourierSignal(
    createAdminClient(),
    signal,
    rawBody,
  );

  if (result.status === "failed") {
    console.error("[parcel-inbound] could not record", {
      awb: signal.awb,
      status: signal.statusText,
      detail: result.message,
    });
    // The one 500: another delivery is the only thing that brings this back.
    return NextResponse.json(
      { ok: false },
      { status: result.retryable ? 500 : 200, headers: noStore },
    );
  }

  if (result.status === "duplicate") {
    // The steady state under retry, and the reason this endpoint is safe to
    // call ten times. Info, not warn: it is expected traffic.
    console.info("[parcel-inbound] already handled", {
      awb: signal.awb,
      status: signal.statusText,
      orderNumber: result.orderNumber,
    });
    return NextResponse.json({ ok: true, duplicate: true }, { headers: noStore });
  }

  const line = "[parcel-inbound] recorded";
  const fields = {
    awb: signal.awb,
    status: signal.statusText,
    statusId: signal.statusId,
    statusAt: signal.statusAt,
    orderNumber: result.orderNumber,
    interpretation: result.interpretation,
    outcome: result.outcome,
  };
  // `error` for anything a person has to look at, so it is visible in Vercel's
  // log filter without knowing what to search for. This is the level at which
  // the 2026-08-14 cancellation would have announced itself.
  if (result.needsAttention) console.error(`${line} — NEEDS ATTENTION`, fields);
  else console.info(line, fields);

  return NextResponse.json({ ok: true }, { headers: noStore });
}

const noStore = { "Cache-Control": "no-store" } as const;

/**
 * One refusal shape for every request we will not process.
 *
 * Says nothing. "No token", "wrong token", "not JSON" and "not an object" are
 * four different pieces of information and an attacker who can tell them apart
 * knows what to change next.
 */
function refuse(): NextResponse {
  return NextResponse.json({ ok: false }, { status: 401, headers: noStore });
}

/**
 * The static token, compared in constant time.
 *
 * Shiprocket's portal has an "Auth Token Type" dropdown that names the
 * **header**, defaulting to `Authorization`, and a box for the token itself. It
 * sends the token as the bare header value. `Bearer <token>` is accepted too,
 * because that is what a person pastes when the header is called
 * `Authorization` and they have seen an API before — and refusing it would fail
 * at 2am in a portal with no error detail.
 *
 * Length is compared before `timingSafeEqual`, which throws on a length
 * mismatch: the throw would be both a 500 and a length oracle.
 */
function authorised(request: Request): boolean {
  const expected = process.env.COURIER_WEBHOOK_TOKEN?.trim();
  if (!expected) {
    console.error(
      "[parcel-inbound] COURIER_WEBHOOK_TOKEN is not set, so every request is " +
        "refused. Set it in the Vercel project and paste the same value into " +
        "the Shiprocket portal's webhook configuration.",
    );
    return false;
  }

  const header = request.headers.get("authorization") ?? "";
  const offered = header.trim();
  if (offered.length === 0) return false;

  const candidates = offered.toLowerCase().startsWith("bearer ")
    ? [offered, offered.slice(7).trim()]
    : [offered];

  // Both candidates are always compared — no early return — so the number of
  // comparisons does not depend on whether the first one matched.
  let matched = false;
  for (const candidate of candidates) {
    const a = Buffer.from(candidate, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length === b.length && timingSafeEqual(a, b)) matched = true;
  }
  return matched;
}
