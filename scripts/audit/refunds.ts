/**
 * The refund promises, held to.
 *
 * Three of these are quality gates written into the Batch 3 brief verbatim:
 * *a refund cannot exceed the captured amount; a replayed refund webhook
 * produces one refund; a double-clicked button cannot issue two refunds.*
 * All three are promises about what the **database** does under concurrent
 * or repeated writes, so the second half of this suite runs against staging
 * for real — synthetic order, synthetic captured payment, real trigger, real
 * unique indexes, real webhook application code. No Razorpay API call is
 * made anywhere in it; the provider is simulated at exactly the seam the
 * webhook route uses, `recordAndApplyRefund`.
 *
 * The first half is pure: the policy matrix's edges, and the webhook parser
 * fed signed and tampered bodies. The parser tests sign with whatever secret
 * the environment carries (or a test one when none is set) — what is being
 * proved is that verification and parsing agree, not what the secret is.
 */
// clients first, before any src import: it repoints this process at staging
// and refuses to run against production. Order matters.
import { adminClient } from "./clients";

import { createHmac } from "node:crypto";

import { refundFor } from "../../src/lib/orders/refund-policy";
import { recordAndApplyRefund } from "../../src/lib/orders/refunds";
import { razorpayAdapter } from "../../src/lib/payments/razorpay";

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail = ""): void {
  checks++;
  if (!condition) failures++;
  console.log(
    `  ${condition ? "ok  " : "FAIL"}  ${label}${condition || !detail ? "" : `\n          ${detail}`}`,
  );
}

/* ════════════════════════════════════════════════ the matrix, pure ════════ */

console.log("\nThe policy matrix\n");

const base = {
  capturedPaise: 34900,
  actualForwardPaise: 14000,
  actualRtoPaise: 14000,
  rtoPolicy: "actual_freight" as const,
  rtoFlatDeductionPaise: 0,
};

{
  const verdict = refundFor({ ...base, stage: "before_shipment", cause: "normal" });
  ok(
    "before shipment: the full advance, no deductions",
    verdict.refundPaise === 34900 && verdict.deductions.length === 0,
  );
}
{
  const verdict = refundFor({ ...base, stage: "refused_rto", cause: "normal" });
  ok(
    "refused at the door: advance minus both legs — ₹69 of a ₹349 advance",
    verdict.refundPaise === 34900 - 28000,
  );
}
{
  // The round-trip advance spent on the round trip. The arithmetic must reach
  // zero, not a special case.
  const verdict = refundFor({
    ...base,
    capturedPaise: 28000,
    stage: "refused_rto",
    cause: "normal",
  });
  ok("POD refused: advance == freight → nothing back", verdict.refundPaise === 0);
}
{
  const verdict = refundFor({ ...base, stage: "refused_rto", cause: "shop_error" });
  ok(
    "our mistake overrides every stage: full, no deductions",
    verdict.refundPaise === 34900 && verdict.deductions.length === 0,
  );
}
{
  const verdict = refundFor({ ...base, stage: "delivered", cause: "normal" });
  ok(
    "delivered: replacement only, zero money",
    verdict.refundPaise === 0 && verdict.replacementOnly,
  );
}
{
  // The clamp. Freight larger than the capture must floor at zero, never a
  // negative refund; a capture smaller than the computed refund must cap it.
  const verdict = refundFor({
    ...base,
    capturedPaise: 10000,
    actualForwardPaise: 40000,
    stage: "in_transit_rto",
    cause: "normal",
  });
  ok("deductions past the capture floor at zero", verdict.refundPaise === 0);
}

/* ═══════════════════════════════════════════ the parser, signed bodies ════ */

console.log("\nThe webhook parser\n");

process.env.RAZORPAY_WEBHOOK_SECRET ||= "audit-refunds-test-secret";
const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

function signed(payload: unknown): { body: string; signature: string } {
  const body = JSON.stringify(payload);
  return {
    body,
    signature: createHmac("sha256", secret).update(body, "utf8").digest("hex"),
  };
}

function refundEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    event: "refund.processed",
    payload: {
      refund: {
        entity: {
          id: "rfnd_PARSE1",
          payment_id: "pay_PARSE1",
          amount: 34900,
          currency: "INR",
          status: "processed",
          notes: { refund_row_id: "11111111-2222-3333-4444-555555555555" },
          ...overrides,
        },
      },
    },
  };
}

{
  const { body, signature } = signed(refundEnvelope());
  const parsed = razorpayAdapter.parseWebhook(body, signature);
  ok(
    "refund.processed parses to a refund event, not a payment outcome",
    parsed.ok && Boolean(parsed.refund) && !parsed.event,
  );
  if (parsed.ok && parsed.refund) {
    ok(
      "carries id, payment, paise and the row note",
      parsed.refund.providerRefundId === "rfnd_PARSE1" &&
        parsed.refund.providerPaymentId === "pay_PARSE1" &&
        parsed.refund.amountPaise === 34900 &&
        parsed.refund.refundRowId === "11111111-2222-3333-4444-555555555555",
    );
    ok(
      "the idempotency key is derived: event:entity",
      parsed.refund.eventId === "refund.processed:rfnd_PARSE1",
    );
  }
}
{
  const envelope = refundEnvelope({ notes: [] });
  const { body, signature } = signed({ ...envelope, event: "refund.failed" });
  const parsed = razorpayAdapter.parseWebhook(body, signature);
  ok(
    "refund.failed with Razorpay's empty-notes-as-array: parses, row id null",
    parsed.ok && parsed.refund?.eventType === "refund.failed" &&
      parsed.refund.refundRowId === null,
  );
}
{
  const { body } = signed(refundEnvelope());
  const parsed = razorpayAdapter.parseWebhook(body, "0".repeat(64));
  ok("a tampered signature is refused", !parsed.ok && !("refund" in parsed));
}
{
  const { body, signature } = signed(refundEnvelope({ currency: "USD" }));
  const parsed = razorpayAdapter.parseWebhook(body, signature);
  ok(
    "a non-INR refund is refused, not converted",
    !parsed.ok && parsed.reason === "malformed",
  );
}

/* ═══════════════════════════════════ the database promises, on staging ════ */

async function main(): Promise<void> {
  console.log("\nThe database promises (staging)\n");

  const db = adminClient();
  const run = Date.now().toString(36);
  const payId = `pay_AUDIT${run}`;

  /** One synthetic prepaid order with one captured payment of ₹1,698. */
  async function fixtureOrder(): Promise<{ orderId: string; paymentId: string }> {
    const { data: order, error: orderError } = await db
      .from("orders")
      .insert({
        subtotal: 169800,
        grand_total: 169800,
        // The money identity the schema enforces: advance + balance = total.
        // Prepaid shape — everything captured up front, nothing at the door.
        advance_amount: 169800,
        balance_due_on_delivery: 0,
        shipping_address: { audit: "refunds", run },
        contact_email: `fv-qa.refunds-${run}@example.com`,
      })
      .select("id")
      .single();
    if (orderError || !order) {
      throw new Error(`fixture order failed: ${orderError?.message}`);
    }
    const { data: payment, error: paymentError } = await db
      .from("payments")
      .insert({
        order_id: order.id,
        provider: "razorpay",
        provider_order_id: `order_AUDIT${run}${Math.random().toString(36).slice(2, 6)}`,
        provider_payment_id: `${payId}${Math.random().toString(36).slice(2, 6)}`,
        amount: 169800,
        status: "captured",
      })
      .select("id, provider_payment_id")
      .single();
    if (paymentError || !payment) {
      throw new Error(`fixture payment failed: ${paymentError?.message}`);
    }
    return { orderId: order.id, paymentId: payment.provider_payment_id ?? "" };
  }

  const cleanup: string[] = [];

  try {
    const f1 = await fixtureOrder();
    cleanup.push(f1.orderId);

    /* ── gate: a refund cannot exceed the captured amount ────────────────── */
    {
      const { error } = await db.from("refunds").insert({
        order_id: f1.orderId,
        amount_paise: 169900,
        reason: "other",
        status: "created",
      });
      ok(
        "the trigger refuses one paise more than was captured",
        Boolean(error?.message.includes("refund_exceeds_captured")),
        error?.message ?? "insert unexpectedly succeeded",
      );
    }

    /* ── gate: a double click cannot issue two refunds ───────────────────── */
    const { data: first, error: firstError } = await db
      .from("refunds")
      .insert({
        order_id: f1.orderId,
        amount_paise: 10000,
        reason: "other",
        status: "created",
      })
      .select("id")
      .single();
    ok("the first press inserts its in-flight row", !firstError && Boolean(first));

    {
      const { error } = await db.from("refunds").insert({
        order_id: f1.orderId,
        amount_paise: 10000,
        reason: "other",
        status: "created",
      });
      ok(
        "the second press loses to the one-in-flight index",
        error?.code === "23505",
        error?.message ?? "second insert unexpectedly succeeded",
      );
    }

    if (!first) throw new Error("no in-flight row to continue with");

    const rfnd1 = `rfnd_AUDIT${run}a`;
    {
      const { error } = await db
        .from("refunds")
        .update({ status: "pending", razorpay_refund_id: rfnd1 })
        .eq("id", first.id);
      if (error) throw new Error(`marking pending failed: ${error.message}`);
    }

    /* ── gate: a replayed refund webhook produces one refund ─────────────── */
    const processedEvent = {
      eventId: `refund.processed:${rfnd1}`,
      eventType: "refund.processed" as const,
      providerRefundId: rfnd1,
      providerPaymentId: f1.paymentId,
      amountPaise: 10000,
      rawStatus: "processed",
      refundRowId: null,
    };

    const firstDelivery = await recordAndApplyRefund(processedEvent);
    ok("the first delivery applies", firstDelivery.status === "applied");

    const secondDelivery = await recordAndApplyRefund(processedEvent);
    ok(
      "the replay short-circuits as a duplicate",
      secondDelivery.status === "duplicate",
    );

    {
      const { data, error } = await db
        .from("refunds")
        .select("id, status, processed_at")
        .eq("razorpay_refund_id", rfnd1);
      ok(
        "exactly one refund row, processed, with a settled timestamp",
        !error &&
          data?.length === 1 &&
          data[0].status === "processed" &&
          data[0].processed_at !== null,
        error?.message ?? `rows: ${data?.length}`,
      );
    }

    /* ── the ceiling counts settled money ────────────────────────────────── */
    {
      const { error } = await db.from("refunds").insert({
        order_id: f1.orderId,
        amount_paise: 169800,
        reason: "other",
        status: "created",
      });
      ok(
        "a full-amount refund after a partial one is refused",
        Boolean(error?.message.includes("refund_exceeds_captured")),
        error?.message ?? "insert unexpectedly succeeded",
      );
    }

    /* ── a dashboard refund becomes a row on arrival ─────────────────────── */
    const rfnd2 = `rfnd_AUDIT${run}b`;
    const dashboardDelivery = await recordAndApplyRefund({
      eventId: `refund.processed:${rfnd2}`,
      eventType: "refund.processed",
      providerRefundId: rfnd2,
      providerPaymentId: f1.paymentId,
      amountPaise: 159800,
      rawStatus: "processed",
      refundRowId: null,
    });
    ok(
      "a refund the database has never heard of is recorded, not refused",
      dashboardDelivery.status === "applied",
    );
    {
      const { data, error } = await db
        .from("refunds")
        .select("status, reason, note")
        .eq("razorpay_refund_id", rfnd2)
        .maybeSingle();
      ok(
        "it lands as its own processed row, marked as issued outside the admin",
        !error &&
          data?.status === "processed" &&
          Boolean(data.note?.includes("outside the admin")),
        error?.message ?? JSON.stringify(data),
      );
    }

    /* ── every captured paise back → the order says refunded ─────────────── */
    {
      const { data, error } = await db
        .from("orders")
        .select("payment_status")
        .eq("id", f1.orderId)
        .maybeSingle();
      ok(
        "10000 + 159800 = the full capture, so payment_status is refunded",
        !error && data?.payment_status === "refunded",
        error?.message ?? `payment_status: ${data?.payment_status}`,
      );
    }

    /* ── the timeout scare: adopt by note, then settle ───────────────────── */
    const f2 = await fixtureOrder();
    cleanup.push(f2.orderId);

    const { data: orphan, error: orphanError } = await db
      .from("refunds")
      .insert({
        order_id: f2.orderId,
        amount_paise: 50000,
        reason: "other",
        status: "failed",
        failure_reason: "No answer from Razorpay — simulated timeout.",
      })
      .select("id")
      .single();
    if (orphanError || !orphan) {
      throw new Error(`orphan fixture failed: ${orphanError?.message}`);
    }

    const rfnd3 = `rfnd_AUDIT${run}c`;
    const adoption = await recordAndApplyRefund({
      eventId: `refund.processed:${rfnd3}`,
      eventType: "refund.processed",
      providerRefundId: rfnd3,
      providerPaymentId: f2.paymentId,
      amountPaise: 50000,
      rawStatus: "processed",
      refundRowId: orphan.id,
    });
    {
      const { data, error } = await db
        .from("refunds")
        .select("id, status, razorpay_refund_id")
        .eq("order_id", f2.orderId);
      ok(
        "the timed-out attempt is adopted by its note — one row, processed, no duplicate",
        adoption.status === "applied" &&
          !error &&
          data?.length === 1 &&
          data[0].id === orphan.id &&
          data[0].status === "processed" &&
          data[0].razorpay_refund_id === rfnd3,
        error?.message ?? JSON.stringify(data),
      );
    }
  } finally {
    /* ── leave staging as found ──────────────────────────────────────────── */
    for (const orderId of cleanup) {
      await db.from("refunds").delete().eq("order_id", orderId);
      await db.from("payment_events").delete().eq("order_id", orderId);
      await db.from("order_status_history").delete().eq("order_id", orderId);
      await db.from("payments").delete().eq("order_id", orderId);
      await db.from("orders").delete().eq("id", orderId);
    }
  }

  console.log(
    failures === 0
      ? `\nPASS — ${checks}/${checks} checks`
      : `\nFAIL — ${failures} of ${checks} checks failed`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
