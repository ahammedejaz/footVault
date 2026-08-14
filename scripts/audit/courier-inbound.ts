/**
 * `npm run audit:courier-inbound` — the courier tells us something, and the
 * shop hears it exactly once, understands what it can, and raises the rest.
 *
 *   npm run dev:stage             # a server on :3210, for the route half
 *   npm run audit:courier-inbound
 *
 * ## What this is protecting
 *
 * FV-2026-00668 was cancelled in the Shiprocket portal on 14 August 2026. It is
 * still `packed` here, the admin page still offers to book its pickup, and the
 * customer's ₹13.50 is still captured. Nothing was broken. There was simply no
 * inbound path: the only one that existed was a 30-minute poller that looked at
 * orders already `shipped` — a status no order in this shop's history has ever
 * reached — and understood two words.
 *
 * So the properties below are not "does the endpoint work". They are the
 * specific ways a webhook receiver silently loses money, each one asserted
 * against the real code:
 *
 *   1 · the timezone. Shiprocket sends IST with no offset. Parsed as UTC every
 *       delivery lands 5½ hours early, and the 24-hour damage window — the only
 *       remedy this shop offers — is measured from it. The check is built
 *       backwards from a known instant so it fails if the offset moves in
 *       either direction, and it fails **differently** for "no offset applied"
 *       and "offset applied twice".
 *   2 · the AWB arrives as a JSON number. Matching a number against a text
 *       column matches nothing, quietly, forever.
 *   3 · matching precedence, and what happens when nothing matches. An
 *       unmatched event must be recorded and raised, never dropped.
 *   4 · unknown statuses. The sample payload carries one status. Everything
 *       else must be raised rather than guessed at — and "Canceled", the exact
 *       word that started this, is asserted by name.
 *   5 · idempotency and ordering. Webhooks retry and arrive out of order.
 *   6 · security. Constant-time token, identical refusal for a wrong token and
 *       a malformed body, and — the one that matters — a forged payload cannot
 *       move an order even when the token is right.
 *
 * The payload throughout is Shiprocket's own documented sample, pasted from
 * their dashboard, with only the identifiers changed to point at fixtures.
 */
// clients first: repoints this process at staging, refuses production.
import "./clients";
import { adminClient, assertNotProduction, assertServerNotProduction } from "./clients";

assertNotProduction("run courier-inbound");

import { courierInstant } from "../../src/lib/shipping/courier-time";
import {
  applyCourierSignal,
  eventKey,
  interpret,
  normaliseAwb,
  rawAwbDigits,
  readWebhookSignal,
} from "../../src/lib/shipping/inbound";
import { BASE_URL } from "./routes";
import { scanned } from "./scanned";

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail = ""): void {
  checks++;
  if (!condition) failures++;
  console.log(
    `  ${condition ? "\x1b[32mok  \x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${label}` +
      `${condition || !detail ? (detail ? ` — ${detail}` : "") : `\n          ${detail}`}`,
  );
}

/**
 * Shiprocket's documented sample, verbatim from their dashboard.
 *
 * Kept as a template rather than rewritten into our own shape, because the
 * whole risk this gate covers is the gap between what they send and what we
 * think they send. `awb` is an unquoted number here for the same reason: that
 * is how it arrives, and it is the trap in point 2.
 */
function samplePayload(overrides: {
  awb: number | string;
  channelOrderId?: string;
  orderId?: string;
  status?: string;
  statusId?: number;
  timestamp?: string;
  scans?: { date: string; activity: string; location: string }[];
}): string {
  const body = {
    awb: overrides.awb,
    current_status: overrides.status ?? "Delivered",
    order_id: overrides.orderId ?? "13905312",
    current_timestamp: overrides.timestamp ?? "2026-08-14 16:41:59",
    etd: "2026-08-14 16:41:59",
    current_status_id: overrides.statusId ?? 7,
    shipment_status: overrides.status ?? "Delivered",
    shipment_status_id: overrides.statusId ?? 7,
    channel_order_id: overrides.channelOrderId ?? "enter your channel order id",
    channel: "enter your channel name",
    courier_name: "enter courier_name",
    scans: overrides.scans ?? [
      {
        date: "2026-08-14 12:08:00",
        activity: "SHIPMENT DELIVERED",
        location: "PATIALA",
      },
      {
        date: "2026-08-14 10:18:00",
        activity: "SHIPMENT OUT FOR DELIVERY",
        location: "PATIALA",
      },
      {
        date: "2026-08-13 18:56:00",
        activity: "SHIPMENT PICKED UP",
        location: "COD PROCESSING CENTRE I",
      },
    ],
  };
  return JSON.stringify(body);
}

/**
 * One row, or a throw.
 *
 * Every read in this file is an *assertion input*, and a dropped `error`
 * renders as "no rows" — which would make "the order did not move" pass for a
 * database that could not be read at all. The repository's own eslint rule
 * says so; this is the shape that satisfies it once rather than nine times.
 */
async function one<T>(
  label: string,
  query: PromiseLike<{ data: T | null; error: { message: string } | null }>,
): Promise<T | null> {
  const { data, error } = await query;
  if (error) throw new Error(`${label} failed: ${error.message}`);
  return data;
}

/** 'a' -> 01, 'b' -> 02 … so a suffix survives a digits-only AWB. */
function suffixDigits(suffix: string): string {
  return String(suffix.charCodeAt(0) - 96).padStart(2, "0");
}

async function main() {
  await assertServerNotProduction(BASE_URL, "run audit:courier-inbound");
  const db = adminClient();
  const run = Date.now().toString(36);

  const orderIds: string[] = [];
  const eventKeys: string[] = [];

  /** A packed, paid order with an AWB — the shape FV-2026-00668 is in. */
  async function fixtureOrder(suffix: string): Promise<{
    id: string;
    orderNumber: string;
    awb: string;
  }> {
    const { data: order, error } = await db
      .from("orders")
      .insert({
        status: "shipped",
        payment_status: "paid",
        payment_method: "razorpay",
        subtotal: 129_900,
        grand_total: 129_900,
        advance_amount: 129_900,
        balance_due_on_delivery: 0,
        shipping_address: {
          recipientName: "QA Courier",
          phone: "9800000002",
          line1: "2 Audit Street",
          line2: null,
          city: "Coimbatore",
          state: "Tamil Nadu",
          postalCode: "641001",
          country: "IN",
        },
        contact_phone: "9800000002",
        contact_email: null,
      })
      .select("id, order_number")
      .single();
    if (error || !order)
      throw new Error(`fixture order failed: ${error?.message}`);
    orderIds.push(order.id);

    /**
     * Digits, and genuinely distinct per fixture.
     *
     * The first version built this from a base-36 run id and then stripped
     * non-digits — which threw away the suffix along with the letters, so every
     * fixture in a run shared one AWB. Three shipments on one AWB is what found
     * the `maybeSingle()` throw in `matchOrder`, so the bug was worth having;
     * it is not worth keeping.
     */
    const awb = `9${Date.now()}${suffixDigits(suffix)}`.slice(0, 14);
    const { error: shipmentError } = await db.from("shipments").insert({
      order_id: order.id,
      status: "awb_assigned",
      awb_code: awb,
      shiprocket_order_id: `SR${run}${suffix}`,
    });
    if (shipmentError)
      throw new Error(`fixture shipment failed: ${shipmentError.message}`);
    return { id: order.id, orderNumber: order.order_number, awb };
  }

  async function eventsFor(orderId: string) {
    const { data, error } = await db
      .from("courier_events")
      .select("*")
      .eq("order_id", orderId)
      .order("received_at");
    if (error) throw new Error(`reading courier_events failed: ${error.message}`);
    for (const row of data ?? []) eventKeys.push(row.event_key);
    return data ?? [];
  }

  try {
    /* ═══ 1 · the timezone ═══════════════════════════════════════════════ */
    console.log("\n\x1b[1m1 · IST, stated in code and provable from outside\x1b[0m");

    /**
     * 16:41:59 IST on 2026-08-14 is 11:11:59 UTC. Built backwards from the
     * answer: the assertion names the instant, so a missing offset (16:41:59Z)
     * and a doubled one (05:41:59Z) are two distinct failures rather than one
     * vague "not equal".
     */
    const IST_INPUT = "2026-08-14 16:41:59";
    const AS_UTC_INSTANT = "2026-08-14T11:11:59.000Z";
    const NAIVE_WRONG = "2026-08-14T16:41:59.000Z";

    const parsed = courierInstant(IST_INPUT);
    ok(
      "a bare Shiprocket timestamp resolves through +05:30",
      parsed === AS_UTC_INSTANT,
      `${IST_INPUT} → ${parsed} (expected ${AS_UTC_INSTANT})`,
    );
    ok(
      "and is NOT read as UTC, which is the 5½-hour bug",
      parsed !== NAIVE_WRONG,
      parsed === NAIVE_WRONG
        ? "read as UTC — every delivery lands 5½ hours early and every damage window is short by that much"
        : "the offset is applied",
    );
    ok(
      "a timestamp that already carries a zone is not shifted twice",
      courierInstant("2026-08-14T11:11:59Z") === AS_UTC_INSTANT,
      String(courierInstant("2026-08-14T11:11:59Z")),
    );
    ok(
      "and rubbish is null rather than Invalid Date",
      courierInstant("not a date") === null && courierInstant(42) === null,
    );

    /* ═══ 2 · the AWB is a number ════════════════════════════════════════ */
    console.log("\n\x1b[1m2 · awb arrives as a JSON number\x1b[0m");

    const numeric = samplePayload({ awb: 59629792084 });
    ok(
      "the sample really does carry it unquoted",
      /"awb"\s*:\s*59629792084(?!")/.test(numeric),
      "if this fails the fixture has drifted and points 2 and 3 prove nothing",
    );

    const fromNumber = readWebhookSignal(JSON.parse(numeric), numeric);
    ok(
      "it is normalised to the string our column holds",
      fromNumber?.awb === "59629792084",
      `got ${JSON.stringify(fromNumber?.awb)}`,
    );
    ok(
      "normaliseAwb agrees on both spellings",
      normaliseAwb(59629792084) === "59629792084" &&
        normaliseAwb("59629792084") === "59629792084",
    );

    /**
     * The trap behind the trap. A 20-digit AWB is past
     * `Number.MAX_SAFE_INTEGER`, so `JSON.parse` has already destroyed it
     * before any of our code runs — silently, and in a way that would match no
     * shipment forever. The digits are read from the raw body for that reason.
     */
    /**
     * Spliced into the JSON **text**, not passed as a number.
     *
     * The first version wrote `awb: 12345678901234567890` as a TypeScript
     * literal, which V8 had already rounded to 12345678901234567000 before
     * `JSON.stringify` ever saw it — so the fixture and the code under test
     * were both looking at the same damaged value and the check compared it to
     * itself. A body arriving over the wire has the real digits in it; this one
     * does now too.
     */
    const LONG_AWB = "12345678901234567890";
    const long = samplePayload({ awb: 0 }).replace(
      /"awb":0/,
      `"awb":${LONG_AWB}`,
    );
    ok(
      "the fixture really carries twenty digits over the wire",
      long.includes(`"awb":${LONG_AWB}`),
      "if this fails the splice broke and the two checks below prove nothing",
    );
    ok(
      "a long AWB is taken from the raw body, not from the parsed float",
      rawAwbDigits(long) === LONG_AWB,
      `raw digits ${rawAwbDigits(long)}`,
    );
    ok(
      "and the parsed float really would have been wrong",
      String((JSON.parse(long) as { awb: number }).awb) !== LONG_AWB,
      `JSON.parse gives ${String((JSON.parse(long) as { awb: number }).awb)} — this is why the raw body is kept`,
    );

    /* ═══ 3 · matching ═══════════════════════════════════════════════════ */
    console.log("\n\x1b[1m3 · matching, and the miss that must not be silent\x1b[0m");

    const byAwb = await fixtureOrder("a");
    const awbBody = samplePayload({ awb: Number(byAwb.awb) });
    const awbResult = await applyCourierSignal(
      db,
      readWebhookSignal(JSON.parse(awbBody), awbBody)!,
      awbBody,
    );
    ok(
      "an AWB match wins and is recorded as such",
      awbResult.status === "recorded" && awbResult.orderNumber === byAwb.orderNumber,
      `${awbResult.status}, order ${awbResult.orderNumber}`,
    );
    {
      const events = await eventsFor(byAwb.id);
      scanned("events written for the AWB-matched order", events.length);
      ok("matched_by names the AWB", events[0]?.matched_by === "awb", String(events[0]?.matched_by));
    }

    const byChannel = await fixtureOrder("b");
    const channelBody = samplePayload({
      awb: 999999999999,
      channelOrderId: byChannel.orderNumber,
    });
    const channelResult = await applyCourierSignal(
      db,
      readWebhookSignal(JSON.parse(channelBody), channelBody)!,
      channelBody,
    );
    ok(
      "an unknown AWB falls through to channel_order_id",
      channelResult.orderNumber === byChannel.orderNumber,
      `matched ${channelResult.orderNumber}`,
    );

    const orphanBody = samplePayload({
      awb: 111111111111,
      channelOrderId: "FV-2026-00000",
      orderId: "0000000000",
      status: "Delivered",
    });
    const orphan = await applyCourierSignal(
      db,
      readWebhookSignal(JSON.parse(orphanBody), orphanBody)!,
      orphanBody,
    );
    ok(
      "an event matching no order is RECORDED, not dropped",
      orphan.status === "recorded",
      orphan.status,
    );
    ok(
      "and it is raised for a human",
      orphan.interpretation === "unmatched" && orphan.needsAttention === true,
      `${orphan.interpretation}, needsAttention=${orphan.needsAttention}`,
    );
    {
      const data = await one<{ event_key: string; attention_reason: string | null }>(
        "orphan event read",
        db
          .from("courier_events")
          .select("event_key, attention_reason")
          .eq("awb", "111111111111")
          .maybeSingle(),
      );
      if (data) eventKeys.push(data.event_key);
      ok(
        "with a sentence naming what could not be found",
        typeof data?.attention_reason === "string" &&
          data.attention_reason.includes("111111111111"),
        data?.attention_reason?.slice(0, 90) ?? "(none)",
      );
    }

    /* ═══ 4 · unknown statuses ═══════════════════════════════════════════ */
    console.log("\n\x1b[1m4 · a status we do not understand is raised, never dropped\x1b[0m");

    const cancelled = await fixtureOrder("c");
    const cancelBody = samplePayload({
      awb: Number(cancelled.awb),
      status: "Canceled",
      statusId: 8,
    });
    const cancelSignal = readWebhookSignal(JSON.parse(cancelBody), cancelBody)!;
    ok(
      "interpret() shrugs at it rather than inventing a meaning",
      interpret(cancelSignal) === "unknown",
      interpret(cancelSignal),
    );

    const cancelResult = await applyCourierSignal(db, cancelSignal, cancelBody);
    ok(
      '"Canceled" — the exact word that started this — is raised',
      cancelResult.needsAttention === true && cancelResult.outcome === "raised",
      `${cancelResult.interpretation}/${cancelResult.outcome}`,
    );

    const cancelledOrder = await one<{
      status: string;
      delivered_at: string | null;
      rto_at: string | null;
    }>(
      "cancelled order read",
      db
        .from("orders")
        .select("status, delivered_at, rto_at")
        .eq("id", cancelled.id)
        .single(),
    );
    ok(
      "and it changes nothing about the order",
      cancelledOrder?.status === "shipped" &&
        cancelledOrder?.delivered_at === null &&
        cancelledOrder?.rto_at === null,
      `status ${cancelledOrder?.status}`,
    );

    /**
     * The status id is recorded and dispatched on by nothing. Asserted because
     * the temptation to build a map from `current_status_id` is exactly the
     * temptation this design refuses, and a future edit that yields to it
     * should have to delete a check that says so.
     */
    {
      const data = await one<{
        status_id: number | null;
        status_text: string | null;
        interpretation: string;
      }>(
        "cancelled event read",
        db
          .from("courier_events")
          .select("status_id, status_text, interpretation")
          .eq("order_id", cancelled.id)
          .maybeSingle(),
      );
      ok(
        "the id is recorded beside the text, and decided nothing",
        data?.status_id === 8 && data?.interpretation === "unknown",
        `id ${data?.status_id}, text "${data?.status_text}", made of it: ${data?.interpretation}`,
      );
    }

    /* ═══ 5 · idempotency and ordering ═══════════════════════════════════ */
    console.log("\n\x1b[1m5 · retries, and events that arrive backwards\x1b[0m");

    const delivered = await fixtureOrder("d");
    const deliverBody = samplePayload({ awb: Number(delivered.awb) });
    const deliverSignal = readWebhookSignal(JSON.parse(deliverBody), deliverBody)!;

    ok(
      "the same body twice produces the same idempotency key",
      eventKey(deliverSignal, deliverBody) ===
        eventKey(
          readWebhookSignal(JSON.parse(deliverBody), deliverBody)!,
          deliverBody,
        ),
    );

    const first = await applyCourierSignal(db, deliverSignal, deliverBody);
    ok("a Delivered payload applies", first.outcome === "applied", `${first.interpretation}/${first.outcome}`);

    const replays = [];
    for (let i = 0; i < 5; i += 1) {
      replays.push(await applyCourierSignal(db, deliverSignal, deliverBody));
    }
    scanned("replays of the identical payload", replays.length, 5);
    ok(
      "every replay is a duplicate, not a second application",
      replays.every((r) => r.status === "duplicate"),
      replays.map((r) => r.status).join(", "),
    );

    const afterReplay = await eventsFor(delivered.id);
    ok(
      "and exactly one row exists for it",
      afterReplay.length === 1,
      `${afterReplay.length} rows`,
    );

    const deliveredOrder = await one<{
      status: string;
      delivered_at: string | null;
      delivered_source: string | null;
    }>(
      "delivered order read",
      db
        .from("orders")
        .select("status, delivered_at, delivered_source")
        .eq("id", delivered.id)
        .single(),
    );
    /**
     * The scans are handed in newest-first by the sample and sorted here, so
     * the delivery moment is the *latest* scan, 12:08 IST — not the first one
     * in the array, which is the trap in trusting the courier's ordering.
     */
    ok(
      "the delivery timestamp is the courier's own, resolved through IST",
      deliveredOrder?.delivered_at === "2026-08-14T06:38:00+00:00" ||
        deliveredOrder?.delivered_at === "2026-08-14T06:38:00.000Z",
      `${deliveredOrder?.delivered_at} (12:08:00 IST = 06:38:00Z)`,
    );
    ok(
      "and the order moved to delivered, by the courier's word",
      deliveredOrder?.status === "delivered" &&
        deliveredOrder?.delivered_source === "courier",
      `${deliveredOrder?.status} / ${deliveredOrder?.delivered_source}`,
    );

    const stampedAt = deliveredOrder?.delivered_at;
    const backwardsBody = samplePayload({
      awb: Number(delivered.awb),
      status: "Out for delivery",
      statusId: 6,
      timestamp: "2026-08-14 10:18:00",
      scans: [
        {
          date: "2026-08-14 10:18:00",
          activity: "SHIPMENT OUT FOR DELIVERY",
          location: "PATIALA",
        },
      ],
    });
    const backwards = await applyCourierSignal(
      db,
      readWebhookSignal(JSON.parse(backwardsBody), backwardsBody)!,
      backwardsBody,
    );
    ok(
      "an older event arriving late is recorded as stale",
      backwards.outcome === "stale" || backwards.outcome === "no_change",
      String(backwards.outcome),
    );

    const afterBackwards = await one<{ status: string; delivered_at: string | null }>(
      "post-stale order read",
      db
        .from("orders")
        .select("status, delivered_at")
        .eq("id", delivered.id)
        .single(),
    );
    ok(
      "and the order does not move backwards",
      afterBackwards?.status === "delivered" &&
        afterBackwards?.delivered_at === stampedAt,
      `${afterBackwards?.status}, stamp ${afterBackwards?.delivered_at === stampedAt ? "unmoved" : "MOVED"}`,
    );

    /* ═══ 6 · security, at the real route ════════════════════════════════ */
    console.log("\n\x1b[1m6 · the endpoint, as a stranger finds it\x1b[0m");

    const url = `${BASE_URL}/api/parcel/inbound`;
    const probe = await fixtureOrder("e");
    const probeBody = samplePayload({ awb: Number(probe.awb) });

    const noToken = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: probeBody,
    });
    const noTokenText = await noToken.text();
    ok(
      "no token is refused",
      noToken.status === 401,
      `HTTP ${noToken.status}`,
    );

    const wrongToken = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "definitely-not-the-token",
      },
      body: probeBody,
    });
    const wrongTokenText = await wrongToken.text();
    ok(
      "a wrong token is refused",
      wrongToken.status === 401,
      `HTTP ${wrongToken.status}`,
    );
    ok(
      "and the refusal is identical to the one for no token",
      noToken.status === wrongToken.status && noTokenText === wrongTokenText,
      `${noToken.status}:${noTokenText} vs ${wrongToken.status}:${wrongTokenText}`,
    );

    const garbage = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "definitely-not-the-token",
      },
      body: "}{ not json at all",
    });
    ok(
      "a malformed body answers exactly what a wrong token answers",
      garbage.status === wrongToken.status &&
        (await garbage.text()) === wrongTokenText,
      `HTTP ${garbage.status}`,
    );

    const probeOrder = await one<{ status: string; delivered_at: string | null }>(
      "probe order read",
      db
        .from("orders")
        .select("status, delivered_at")
        .eq("id", probe.id)
        .single(),
    );
    ok(
      "and none of it touched the order",
      probeOrder?.status === "shipped" &&
        probeOrder?.delivered_at === null,
      `${probeOrder?.status}, delivered_at ${probeOrder?.delivered_at}`,
    );
    {
      const events = await eventsFor(probe.id);
      ok(
        "nor wrote a courier event",
        events.length === 0,
        `${events.length} events — an unauthenticated caller must not be able to make us write`,
      );
    }

    /* ═══ 7 · the whole path, with a token that works ═══════════════════ */
    console.log("\n\x1b[1m7 · a real POST, end to end\x1b[0m");

    /**
     * The half section 6 cannot prove.
     *
     * Every check above either calls `applyCourierSignal` directly or asserts a
     * refusal, and a receiver can pass all of them while being unreachable —
     * wrong path, wrong method, a proxy that eats the body, a route that never
     * deployed. This is the one that fails if the URL the owner pastes into the
     * Shiprocket portal does not work, which is the failure mode with no other
     * symptom: the portal accepts the address, the Test Webhook button says it
     * sent something, and nothing is ever heard from again.
     */
    const token = process.env.COURIER_WEBHOOK_TOKEN?.trim() ?? "";
    if (!token) {
      ok(
        "COURIER_WEBHOOK_TOKEN is set so the endpoint can be exercised",
        false,
        "add it to .env.local — without it this section proves nothing and the " +
          "route refuses every request by design",
      );
    } else {
      const live = await fixtureOrder("f");
      const liveBody = samplePayload({
        awb: Number(live.awb),
        status: "Canceled",
        statusId: 8,
      });

      const accepted = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: token,
        },
        body: liveBody,
      });
      ok(
        "a correct token in a bare Authorization header is accepted",
        accepted.status === 200,
        `HTTP ${accepted.status} — this is the exact shape Shiprocket sends`,
      );

      const bearer = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: liveBody,
      });
      ok(
        "and so is the same token written as a Bearer",
        bearer.status === 200,
        `HTTP ${bearer.status} — what a person pastes when the header is called Authorization`,
      );

      const liveEvents = await eventsFor(live.id);
      scanned("events written by the real endpoint", liveEvents.length);
      ok(
        "the POST left exactly one row, not two",
        liveEvents.length === 1,
        `${liveEvents.length} — the second POST is the same transition and must dedupe`,
      );
      ok(
        "it is raised, because nobody taught this shop what Canceled means",
        liveEvents[0]?.needs_attention === true &&
          liveEvents[0]?.interpretation === "unknown",
        `${liveEvents[0]?.interpretation}, needs_attention=${liveEvents[0]?.needs_attention}`,
      );
      ok(
        "and it carries the raw payload, which is the only way the status map ever gets written",
        liveEvents[0]?.payload !== null,
        liveEvents[0]?.payload ? "payload stored" : "PAYLOAD LOST",
      );

      const untouched = await one<{ status: string }>(
        "live order read",
        db.from("orders").select("status").eq("id", live.id).single(),
      );
      ok(
        "the order it names did not move",
        untouched?.status === "shipped",
        String(untouched?.status),
      );
    }

    /**
     * The URL itself. Shiprocket's portal refuses a webhook address containing
     * any of four substrings, and "sr" as a bare substring rules out a great
     * many obvious names. Asserted here rather than remembered, because the
     * failure mode is a portal that will not accept the address at all — at
     * which point the whole feature is configured and inert.
     */
    const publicUrl = "https://www.footvault.in/api/parcel/inbound";
    const forbidden = ["shiprocket", "kartrocket", "sr", "kr"];
    scanned("forbidden substrings checked against the webhook URL", forbidden.length, 4);
    for (const needle of forbidden) {
      ok(
        `the URL is clean of "${needle}"`,
        !publicUrl.toLowerCase().includes(needle),
        publicUrl,
      );
    }
  } finally {
    if (eventKeys.length > 0) {
      const { error } = await db
        .from("courier_events")
        .delete()
        .in("event_key", [...new Set(eventKeys)]);
      if (error) console.error(`  ! courier_events cleanup: ${error.message}`);
    }
    for (const id of orderIds) {
      // Children first, then the order. Each failure is reported rather than
      // swallowed: a fixture order left on staging is one the next run counts.
      for (const table of [
        "courier_events",
        "shipments",
        "order_status_history",
      ] as const) {
        const { error } = await db.from(table).delete().eq("order_id", id);
        if (error) console.error(`  ! ${table} cleanup ${id}: ${error.message}`);
      }
      const { error } = await db.from("orders").delete().eq("id", id);
      if (error) console.error(`  ! order cleanup ${id}: ${error.message}`);
    }
  }

  console.log(
    failures === 0
      ? `\n\x1b[1m\x1b[32mcourier-inbound: ${checks} checks, all green.\x1b[0m\n`
      : `\n\x1b[1m\x1b[31mcourier-inbound: ${failures} of ${checks} checks failed.\x1b[0m\n`,
  );
  if (failures > 0) process.exit(1);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
