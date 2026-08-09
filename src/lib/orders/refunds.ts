import "server-only";

import type { Database } from "@/lib/database.types";
import { formatPaise } from "@/lib/format";
import { REFUND_ARRIVAL_WINDOW } from "@/lib/orders/customer-copy";
import {
  refundFor,
  stageFor,
  type RefundCause,
  type RefundStage,
  type RefundVerdict,
} from "@/lib/orders/refund-policy";
import {
  createRazorpayRefund,
  fetchPaymentRefunds,
  type ProviderRefund,
} from "@/lib/payments/razorpay";
import type { VerifiedRefundEvent } from "@/lib/payments/types";
import { maybeRow, rows } from "@/lib/queries/run";
import { shippingSettings } from "@/lib/shipping/settings";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The shop giving money back — the last thing it could not do.
 *
 * Three writers meet at the `refunds` table and this module is all three:
 * the admin pressing the button (`initiateRefund`), the webhook settling the
 * result (`recordAndApplyRefund`), and the import that pulls in refunds issued
 * straight from the Razorpay dashboard (`importRefundsForOrder`). They share
 * one vocabulary on purpose — a refund row is *created* here, *pending* once
 * Razorpay has accepted it, and *processed* only when the webhook says so.
 * The API answering 200 settles nothing; the brief is explicit about that,
 * and so is `refunds.status`.
 *
 * ## The ordering that makes a double click one refund
 *
 * `initiateRefund` writes the row **before** calling Razorpay, in `created`,
 * and `refunds_one_in_flight_per_order` (a partial unique index) lets exactly
 * one such row exist per order. Two simultaneous presses race on an insert and
 * the database picks the winner — the same pre-insert serialisation the
 * shipments table uses, chosen for the same reason: no constraint can undo a
 * second API call that already happened, so the constraint must fire before
 * the first one.
 *
 * The row also rides along to Razorpay as `notes.refund_row_id`. If the create
 * call times out — answered by neither success nor refusal — the row is marked
 * `failed` with instructions to run the import, and the import (or the
 * webhook, whichever arrives first) matches the orphaned provider refund back
 * to its row by that note. Every ordering of "timed out but actually
 * happened" converges on one settled refund and an audit trail of the scare.
 *
 * ## What the ceiling is
 *
 * `refunds_guard` (a trigger) enforces the invariant — non-failed refunds can
 * never sum past the order's captured payments — with a row lock, so it holds
 * under concurrency and for every writer including the import. The checks in
 * this module exist to produce polite messages; the trigger exists so that the
 * messages being wrong can never move money.
 */

/* ------------------------------------------------------------------ types -- */

export type RefundRowSummary = {
  id: string;
  amountPaise: number;
  reason: string;
  status: "created" | "pending" | "processed" | "failed";
  note: string | null;
  deductions: { label: string; amountPaise: number }[];
  razorpayRefundId: string | null;
  failureReason: string | null;
  createdAt: string;
  processedAt: string | null;
};

export type RefundPanelState = {
  /** Sum of captured payment rows. What there ever was to give back. */
  capturedPaise: number;
  /** Settled refunds — the webhook has confirmed these. */
  processedPaise: number;
  /** Created or pending rows. Counted against the ceiling until they fail. */
  inFlightPaise: number;
  /** What a new refund may take: captured − processed − in flight. */
  refundablePaise: number;
  /** The `pay_...` a refund would move along, or null when nothing was captured. */
  providerPaymentId: string | null;
  stage: RefundStage;
  /** The matrix's answer for each cause the admin can pick, against `refundablePaise`. */
  verdicts: { normal: RefundVerdict; shopError: RefundVerdict };
  rows: RefundRowSummary[];
};

export type InitiateRefundResult =
  | { ok: true; amountPaise: number; razorpayRefundId: string }
  | {
      ok: false;
      reason: "invalid" | "conflict" | "provider" | "error";
      message: string;
    };

/* ---------------------------------------------------------------- context -- */

type OrderStatus = Database["public"]["Enums"]["order_status"];

type OrderForRefund = {
  id: string;
  order_number: string;
  status: OrderStatus;
  payment_status: string;
  advance_amount: number | null;
  grand_total: number | null;
  quoted_forward_paise: number | null;
  quoted_rto_paise: number | null;
  rto_at: string | null;
  rto_actual_charge_paise: number | null;
  delivered_at: string | null;
};

type PaymentForRefund = {
  id: string;
  provider: string;
  status: string;
  amount: number;
  provider_payment_id: string | null;
};

type RefundRow = {
  id: string;
  payment_id: string | null;
  amount_paise: number;
  reason: string;
  status: "created" | "pending" | "processed" | "failed";
  note: string | null;
  deduction_breakdown: unknown;
  razorpay_refund_id: string | null;
  failure_reason: string | null;
  created_at: string;
  processed_at: string | null;
};

type RefundContext = {
  order: OrderForRefund;
  payments: PaymentForRefund[];
  refunds: RefundRow[];
  stage: RefundStage;
  capturedPaise: number;
  processedPaise: number;
  inFlightPaise: number;
  refundablePaise: number;
};

async function loadContext(orderId: string): Promise<RefundContext | null> {
  const admin = createAdminClient();

  const order = await maybeRow<OrderForRefund>(
    "refunds.order",
    admin
      .from("orders")
      .select(
        `id, order_number, status, payment_status, advance_amount, grand_total,
         quoted_forward_paise, quoted_rto_paise, rto_at,
         rto_actual_charge_paise, delivered_at`,
      )
      .eq("id", orderId)
      .maybeSingle(),
  );
  if (!order) return null;

  const [payments, refunds, shipment] = await Promise.all([
    rows<PaymentForRefund>(
      "refunds.payments",
      admin
        .from("payments")
        .select("id, provider, status, amount, provider_payment_id")
        .eq("order_id", orderId)
        .order("created_at", { ascending: true }),
    ),
    rows<RefundRow>(
      "refunds.rows",
      admin
        .from("refunds")
        .select(
          `id, payment_id, amount_paise, reason, status, note,
           deduction_breakdown, razorpay_refund_id, failure_reason,
           created_at, processed_at`,
        )
        .eq("order_id", orderId)
        .order("created_at", { ascending: true }),
    ),
    maybeRow<{ awb_code: string | null; status: string }>(
      "refunds.shipment",
      admin
        .from("shipments")
        .select("awb_code, status")
        .eq("order_id", orderId)
        .maybeSingle(),
    ),
  ]);

  const capturedPaise = payments
    .filter((payment) => payment.status === "captured")
    .reduce((sum, payment) => sum + payment.amount, 0);
  const processedPaise = refunds
    .filter((refund) => refund.status === "processed")
    .reduce((sum, refund) => sum + refund.amount_paise, 0);
  const inFlightPaise = refunds
    .filter((refund) => refund.status === "created" || refund.status === "pending")
    .reduce((sum, refund) => sum + refund.amount_paise, 0);

  /**
   * `pickedUp` from the order's own lifecycle rather than courier vocabulary:
   * an order goes `shipped` when the parcel is collected, and the only thing
   * the flag decides is which RTO row of the matrix explains the deduction.
   */
  const stage = stageFor({
    status: order.status,
    hasShipment: shipment !== null,
    hasAwb: Boolean(shipment?.awb_code),
    pickedUp: ["shipped", "delivered", "returning", "returned"].includes(
      order.status,
    ),
    rtoAt: order.rto_at,
    deliveredAt: order.delivered_at,
  });

  return {
    order,
    payments,
    refunds,
    stage,
    capturedPaise,
    processedPaise,
    inFlightPaise,
    refundablePaise: Math.max(0, capturedPaise - processedPaise - inFlightPaise),
  };
}

/**
 * The freight actually incurred, best number available for each leg.
 *
 * The forward leg has no "actual" column yet — Shiprocket bills it on the
 * monthly invoice — so the frozen quote is used and labelled honestly in the
 * breakdown. The return leg prefers the actual charge recorded at RTO receipt
 * (Batch 3.3) and falls back to the frozen quote. Missing numbers are zero,
 * which deducts nothing: the shop absorbs what it cannot substantiate, never
 * the customer.
 */
function freightFor(order: OrderForRefund): {
  actualForwardPaise: number;
  actualRtoPaise: number;
} {
  return {
    actualForwardPaise: order.quoted_forward_paise ?? 0,
    actualRtoPaise:
      order.rto_actual_charge_paise ?? order.quoted_rto_paise ?? 0,
  };
}

async function verdictFor(
  context: RefundContext,
  cause: RefundCause,
): Promise<RefundVerdict> {
  const settings = await shippingSettings();
  const freight = freightFor(context.order);
  return refundFor({
    stage: context.stage,
    cause,
    /**
     * The ceiling is what is *left*, not what was ever captured: a second
     * partial refund computes against the remainder, and the clamp inside
     * `refundFor` then cannot promise money a previous refund already took.
     */
    capturedPaise: context.refundablePaise,
    actualForwardPaise: freight.actualForwardPaise,
    actualRtoPaise: freight.actualRtoPaise,
    rtoPolicy: settings.rtoDeductionPolicy,
    rtoFlatDeductionPaise: settings.rtoDeductionFlatPaise,
  });
}

/* ------------------------------------------------------------ panel state -- */

export async function refundPanelState(
  orderId: string,
): Promise<RefundPanelState | null> {
  const context = await loadContext(orderId);
  if (!context) return null;

  const [normal, shopError] = await Promise.all([
    verdictFor(context, "normal"),
    verdictFor(context, "shop_error"),
  ]);

  const capturedRazorpay = context.payments.find(
    (payment) =>
      payment.provider === "razorpay" &&
      payment.status === "captured" &&
      payment.provider_payment_id,
  );

  return {
    capturedPaise: context.capturedPaise,
    processedPaise: context.processedPaise,
    inFlightPaise: context.inFlightPaise,
    refundablePaise: context.refundablePaise,
    providerPaymentId: capturedRazorpay?.provider_payment_id ?? null,
    stage: context.stage,
    verdicts: { normal, shopError },
    rows: context.refunds.map(summarise),
  };
}

function summarise(row: RefundRow): RefundRowSummary {
  const breakdown = Array.isArray(row.deduction_breakdown)
    ? (row.deduction_breakdown as { label?: unknown; amountPaise?: unknown }[])
    : [];
  return {
    id: row.id,
    amountPaise: row.amount_paise,
    reason: row.reason,
    status: row.status,
    note: row.note,
    deductions: breakdown
      .filter(
        (line) =>
          typeof line.label === "string" &&
          typeof line.amountPaise === "number",
      )
      .map((line) => ({
        label: line.label as string,
        amountPaise: line.amountPaise as number,
      })),
    razorpayRefundId: row.razorpay_refund_id,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    processedAt: row.processed_at,
  };
}

/* --------------------------------------------------------------- initiate -- */

const UNIQUE_VIOLATION = "23505";

export async function initiateRefund(input: {
  orderId: string;
  cause: RefundCause;
  note: string | null;
  /**
   * The number the admin was shown when they pressed confirm. Recomputed here
   * and refused on any difference — the amount is never taken from the
   * browser, but the browser's understanding of it is held to account.
   */
  expectedPaise: number;
  actorId: string;
}): Promise<InitiateRefundResult> {
  const admin = createAdminClient();

  const context = await loadContext(input.orderId);
  if (!context) {
    return { ok: false, reason: "invalid", message: "No such order." };
  }

  const verdict = await verdictFor(context, input.cause);

  if (verdict.replacementOnly) {
    return {
      ok: false,
      reason: "invalid",
      message:
        "This order was delivered — the policy is a replacement, not a refund. " +
        "If it is our mistake, choose 'our mistake'.",
    };
  }
  if (verdict.refundPaise <= 0) {
    return {
      ok: false,
      reason: "invalid",
      message:
        context.refundablePaise === 0
          ? "Everything captured for this order has already been refunded or is in flight."
          : "The matrix computes nothing to refund for this order and reason.",
    };
  }
  if (verdict.refundPaise !== input.expectedPaise) {
    return {
      ok: false,
      reason: "conflict",
      message:
        `The refund recomputes to ${formatPaise(verdict.refundPaise)}, not the ` +
        `${formatPaise(input.expectedPaise)} on your screen — something changed. ` +
        `Review the new figure and confirm again.`,
    };
  }

  /**
   * The refund needs one captured Razorpay payment with enough headroom —
   * the API refunds along a payment, not an order. Headroom is per payment so
   * a hypothetical second capture cannot be double-counted.
   */
  const refundedByPayment = new Map<string, number>();
  for (const refund of context.refunds) {
    if (refund.status === "failed" || !refund.payment_id) continue;
    refundedByPayment.set(
      refund.payment_id,
      (refundedByPayment.get(refund.payment_id) ?? 0) + refund.amount_paise,
    );
  }
  const source = context.payments.find(
    (payment) =>
      payment.provider === "razorpay" &&
      payment.status === "captured" &&
      payment.provider_payment_id &&
      payment.amount - (refundedByPayment.get(payment.id) ?? 0) >=
        verdict.refundPaise,
  );
  if (!source?.provider_payment_id) {
    return {
      ok: false,
      reason: "invalid",
      message:
        "No captured online payment on this order can cover that amount. " +
        "If it was refunded in the Razorpay dashboard, press 'Check Razorpay' to import it.",
    };
  }

  /**
   * The row first, the API second. The insert is the double-click guard —
   * see the module header — and the trigger behind it is the ceiling.
   */
  const { data: created, error: insertError } = await admin
    .from("refunds")
    .insert({
      order_id: context.order.id,
      payment_id: source.id,
      amount_paise: verdict.refundPaise,
      reason: verdict.reason,
      deduction_breakdown: verdict.deductions,
      note: input.note,
      initiated_by: input.actorId,
      status: "created",
    })
    .select("id")
    .maybeSingle();

  if (insertError || !created) {
    if (insertError?.code === UNIQUE_VIOLATION) {
      return {
        ok: false,
        reason: "conflict",
        message:
          "A refund for this order is already being processed. Refresh to see it.",
      };
    }
    if (insertError?.message.includes("refund_exceeds_captured")) {
      return {
        ok: false,
        reason: "conflict",
        message:
          "That would refund more than was ever captured for this order. " +
          "Refresh — another refund has been recorded since this page loaded.",
      };
    }
    return {
      ok: false,
      reason: "error",
      message: "The refund could not be recorded, so nothing was sent to Razorpay.",
    };
  }

  const sent = await createRazorpayRefund({
    providerPaymentId: source.provider_payment_id,
    amountPaise: verdict.refundPaise,
    refundRowId: created.id,
    orderNumber: context.order.order_number,
  });

  if (!sent.ok) {
    const failureReason =
      sent.state === "unknown"
        ? "No answer from Razorpay — the refund may still have gone through. " +
          "Press 'Check Razorpay' before trying again; if it went through it " +
          "will be matched to this attempt."
        : sent.description;
    const { error: failError } = await admin
      .from("refunds")
      .update({ status: "failed", failure_reason: failureReason })
      .eq("id", created.id);
    if (failError) {
      console.error(
        `[refunds] could not mark refund ${created.id} failed: ${failError.message}`,
      );
    }
    return {
      ok: false,
      reason: "provider",
      message:
        sent.state === "unknown"
          ? "Razorpay did not answer. The refund may or may not exist — press " +
            "'Check Razorpay' to find out before trying again."
          : `Razorpay refused the refund: ${sent.description}`,
    };
  }

  const { error: pendingError } = await admin
    .from("refunds")
    .update({
      razorpay_refund_id: sent.refund.providerRefundId,
      status: "pending",
    })
    .eq("id", created.id);
  if (pendingError) {
    /**
     * The refund exists at Razorpay and our row does not know it. Loud, but
     * not fatal: the webhook and the import both match by `refund_row_id`
     * and will finish the bookkeeping this update could not.
     */
    console.error(
      `[refunds] refund ${sent.refund.providerRefundId} created but row ` +
        `${created.id} could not be updated: ${pendingError.message}`,
    );
  }

  await writeHistory(
    context.order.id,
    context.order.status,
    `Refund of ${formatPaise(verdict.refundPaise)} sent to Razorpay ` +
      `(${sent.refund.providerRefundId}, ${verdict.reason}). ` +
      `It is complete when Razorpay's webhook confirms it.`,
    input.actorId,
    // The customer's version of the same event: the amount, which is theirs to
    // check, and none of the mechanism.
    `We have sent ${formatPaise(verdict.refundPaise)} back to you.`,
  );

  return {
    ok: true,
    amountPaise: verdict.refundPaise,
    razorpayRefundId: sent.refund.providerRefundId,
  };
}

/* ---------------------------------------------------------------- webhook -- */

export type RefundApplication =
  | { status: "applied" }
  | { status: "duplicate" }
  | { status: "not_found" }
  | { status: "failed"; retryable: boolean; message: string };

/**
 * The webhook's half: claim the event, settle the row, stamp the ledger.
 * Same discipline as `recordAndApply` for payments — the claim is first so
 * concurrent deliveries serialise on the database, and it is released on any
 * path that did not finish so a redelivery is processed rather than swallowed.
 */
export async function recordAndApplyRefund(
  event: VerifiedRefundEvent,
): Promise<RefundApplication> {
  const admin = createAdminClient();

  const { error: claimError } = await admin.from("payment_events").insert({
    provider: "razorpay",
    event_id: event.eventId,
    event_type: event.eventType,
  });
  if (claimError) {
    if (claimError.code === UNIQUE_VIOLATION) return { status: "duplicate" };
    return {
      status: "failed",
      retryable: true,
      message: `could not record the refund event — ${claimError.message}`,
    };
  }

  let orderId: string | null;
  try {
    orderId = await settleFromProvider(admin, {
      providerRefundId: event.providerRefundId,
      providerPaymentId: event.providerPaymentId,
      amountPaise: event.amountPaise,
      rawStatus: event.eventType === "refund.processed" ? "processed" : "failed",
      refundRowId: event.refundRowId,
    });
  } catch (error) {
    await releaseRefundClaim(admin, event.eventId);
    return {
      status: "failed",
      retryable: true,
      message:
        error instanceof Error ? error.message : "settling the refund failed",
    };
  }

  if (orderId === null) {
    // A refund along a payment this deployment has never seen — dev and
    // preview share the test account, same as payments. Release so a manual
    // resend can be reprocessed once somebody works out why.
    await releaseRefundClaim(admin, event.eventId);
    return { status: "not_found" };
  }

  const { error: stampError } = await admin
    .from("payment_events")
    .update({
      processed_at: new Date().toISOString(),
      result: "applied",
      order_id: orderId,
    })
    .eq("provider", "razorpay")
    .eq("event_id", event.eventId);
  if (stampError) {
    console.error(
      `[refunds] could not stamp event ${event.eventId}: ${stampError.message}`,
    );
  }

  return { status: "applied" };
}

async function releaseRefundClaim(
  admin: ReturnType<typeof createAdminClient>,
  eventId: string,
): Promise<void> {
  const { error } = await admin
    .from("payment_events")
    .delete()
    .eq("provider", "razorpay")
    .eq("event_id", eventId)
    .is("processed_at", null);
  if (error) {
    console.error(
      `[refunds] could not release event claim ${eventId}: ${error.message}`,
    );
  }
}

/* ----------------------------------------------------------------- settle -- */

/**
 * Make the database agree with one provider-side refund. Returns the order id
 * it touched, or null when the refund belongs to no order we have. Idempotent:
 * running it twice converges, which is what lets the webhook and the import
 * share it without coordinating.
 */
async function settleFromProvider(
  admin: ReturnType<typeof createAdminClient>,
  provided: {
    providerRefundId: string;
    providerPaymentId: string;
    amountPaise: number;
    rawStatus: string;
    refundRowId: string | null;
  },
): Promise<string | null> {
  const settledStatus =
    provided.rawStatus === "processed"
      ? "processed"
      : provided.rawStatus === "failed"
        ? "failed"
        : "pending";

  let row = await maybeRow<{
    id: string;
    order_id: string;
    status: string;
    amount_paise: number;
  }>(
    "refunds.settle.byRefundId",
    admin
      .from("refunds")
      .select("id, order_id, status, amount_paise")
      .eq("razorpay_refund_id", provided.providerRefundId)
      .maybeSingle(),
  );

  /**
   * No row knows this `rfnd_`. Two honest explanations, tried in order:
   * an attempt of ours whose response was lost (matched by the note), or a
   * refund issued in the Razorpay dashboard (imported as its own row).
   */
  if (!row && provided.refundRowId) {
    const orphan = await maybeRow<{
      id: string;
      order_id: string;
      status: string;
      amount_paise: number;
      razorpay_refund_id: string | null;
    }>(
      "refunds.settle.byRowId",
      admin
        .from("refunds")
        .select("id, order_id, status, amount_paise, razorpay_refund_id")
        .eq("id", provided.refundRowId)
        .maybeSingle(),
    );
    if (orphan && orphan.razorpay_refund_id === null) {
      const { error } = await admin
        .from("refunds")
        .update({ razorpay_refund_id: provided.providerRefundId })
        .eq("id", orphan.id)
        .is("razorpay_refund_id", null);
      if (error) {
        throw new Error(
          `adopting refund ${provided.providerRefundId} onto row ` +
            `${orphan.id} failed: ${error.message}`,
        );
      }
      row = orphan;
    }
  }

  if (!row) {
    const payment = await maybeRow<{ id: string; order_id: string }>(
      "refunds.settle.payment",
      admin
        .from("payments")
        .select("id, order_id")
        .eq("provider", "razorpay")
        .eq("provider_payment_id", provided.providerPaymentId)
        .maybeSingle(),
    );
    if (!payment) return null;

    const { error } = await admin.from("refunds").insert({
      order_id: payment.order_id,
      payment_id: payment.id,
      razorpay_refund_id: provided.providerRefundId,
      amount_paise: provided.amountPaise,
      reason: "other",
      note: "Recorded from Razorpay — this refund was issued outside the admin.",
      status: settledStatus,
      processed_at: settledStatus === "processed" ? new Date().toISOString() : null,
      failure_reason:
        settledStatus === "failed" ? "Razorpay reported the refund failed." : null,
    });
    if (error) {
      // A concurrent settle won the insert. Converged; nothing left to do.
      if (error.code === UNIQUE_VIOLATION) return payment.order_id;
      throw new Error(
        `recording dashboard refund ${provided.providerRefundId} failed: ${error.message}`,
      );
    }

    await afterSettle(admin, payment.order_id, provided, settledStatus);
    return payment.order_id;
  }

  // Terminal states never regress: a processed refund stays processed
  // whatever a late or replayed event says.
  if (row.status === "processed" || row.status === settledStatus) {
    return row.order_id;
  }
  if (settledStatus === "pending") return row.order_id;

  const { error } = await admin
    .from("refunds")
    .update(
      settledStatus === "processed"
        ? { status: "processed", processed_at: new Date().toISOString() }
        : {
            status: "failed",
            failure_reason: "Razorpay reported the refund failed.",
          },
    )
    .eq("id", row.id);
  if (error) {
    throw new Error(
      `settling refund ${provided.providerRefundId} failed: ${error.message}`,
    );
  }

  await afterSettle(admin, row.order_id, provided, settledStatus);
  return row.order_id;
}

/**
 * The order-level consequences of a settled refund: the history line the
 * timeline shows, and `payment_status` flipping to `refunded` when every
 * captured paise has gone back.
 */
async function afterSettle(
  admin: ReturnType<typeof createAdminClient>,
  orderId: string,
  provided: { providerRefundId: string; amountPaise: number },
  settledStatus: string,
): Promise<void> {
  const order = await maybeRow<{ status: OrderStatus; payment_status: string }>(
    "refunds.afterSettle.order",
    admin
      .from("orders")
      .select("status, payment_status")
      .eq("id", orderId)
      .maybeSingle(),
  );
  if (!order) return;

  if (settledStatus === "processed") {
    const [payments, refunds] = await Promise.all([
      rows<{ amount: number }>(
        "refunds.afterSettle.captured",
        admin
          .from("payments")
          .select("amount")
          .eq("order_id", orderId)
          .eq("status", "captured"),
      ),
      rows<{ amount_paise: number }>(
        "refunds.afterSettle.processed",
        admin
          .from("refunds")
          .select("amount_paise")
          .eq("order_id", orderId)
          .eq("status", "processed"),
      ),
    ]);
    const captured = payments.reduce((sum, row) => sum + row.amount, 0);
    const processed = refunds.reduce((sum, row) => sum + row.amount_paise, 0);

    if (captured > 0 && processed >= captured && order.payment_status !== "refunded") {
      const { error } = await admin
        .from("orders")
        .update({ payment_status: "refunded" })
        .eq("id", orderId);
      if (error) {
        console.error(
          `[refunds] could not mark order ${orderId} refunded: ${error.message}`,
        );
      }
    }
  }

  await writeHistory(
    orderId,
    order.status,
    settledStatus === "processed"
      ? `Refund of ${formatPaise(provided.amountPaise)} confirmed by Razorpay ` +
        `(${provided.providerRefundId}).`
      : `Razorpay reported refund ${provided.providerRefundId} failed. ` +
        `Nothing moved; the amount is available to refund again.`,
    null,
    /*
      A confirmed refund is worth telling the customer about; a failed one is
      not, and that asymmetry is deliberate. A failure is the shop's problem to
      retry — it moved no money and the customer can do nothing with the news
      except worry. Null leaves the timeline showing the status label alone.
    */
    settledStatus === "processed"
      ? `${formatPaise(provided.amountPaise)} is on its way back to your account. ` +
        `Refunds usually take ${REFUND_ARRIVAL_WINDOW} to arrive.`
      : null,
  );
}

/**
 * A timeline line that must not sink the operation it describes: history is
 * evidence, not a dependency, so failures are logged and swallowed — the same
 * stance `transition.ts` takes.
 */
async function writeHistory(
  orderId: string,
  status: OrderStatus,
  note: string,
  actorId: string | null,
  /**
   * What the **customer** reads on their own order page, or null when this
   * event has nothing to say to them.
   *
   * `note` above is an engineer's audit line and every one of them in this file
   * names a provider id, a reason code or the webhook. Those are exactly right
   * in an audit trail and were being printed straight onto the customer's
   * timeline: `rfnd_TNeaZX8YweRyFi`, `cancelled_before_dispatch`, "webhook".
   * Two audiences, two columns, and null is the safe default.
   */
  customerNote: string | null = null,
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("order_status_history").insert({
    order_id: orderId,
    status,
    note,
    customer_note: customerNote,
    changed_by: actorId,
  });
  if (error) {
    console.error(
      `[refunds] history line for order ${orderId} was not written: ${error.message}`,
    );
  }
}

/* ----------------------------------------------------------------- import -- */

export type ImportRefundsResult =
  | { ok: true; checked: number; recorded: number; settled: number }
  | { ok: false; message: string };

/**
 * Pull the provider's word for every refund on this order's payments, and make
 * the database match. This is how refunds issued by hand in the Razorpay
 * dashboard — including any issued before this code existed — become visible,
 * and how a timed-out attempt is resolved either way.
 */
export async function importRefundsForOrder(
  orderId: string,
): Promise<ImportRefundsResult> {
  const admin = createAdminClient();

  const payments = await rows<{ provider_payment_id: string | null }>(
    "refunds.import.payments",
    admin
      .from("payments")
      .select("provider_payment_id")
      .eq("order_id", orderId)
      .eq("provider", "razorpay")
      .not("provider_payment_id", "is", null),
  );
  if (payments.length === 0) {
    return {
      ok: false,
      message: "This order has no Razorpay payment to check refunds against.",
    };
  }

  let checked = 0;
  let recorded = 0;
  let settled = 0;

  for (const payment of payments) {
    if (!payment.provider_payment_id) continue;
    const result = await fetchPaymentRefunds(payment.provider_payment_id);
    if (!result.ok) {
      return {
        ok: false,
        message: `Razorpay could not be checked: ${result.description}`,
      };
    }

    for (const provided of result.refunds) {
      checked += 1;
      const before = await refundKnown(admin, provided);
      try {
        await settleFromProvider(admin, {
          providerRefundId: provided.providerRefundId,
          providerPaymentId: provided.providerPaymentId,
          amountPaise: provided.amountPaise,
          rawStatus: provided.rawStatus,
          refundRowId: provided.refundRowId,
        });
      } catch (error) {
        return {
          ok: false,
          message:
            error instanceof Error ? error.message : "recording a refund failed",
        };
      }
      if (!before.existed) recorded += 1;
      else if (before.status !== provided.rawStatus) settled += 1;
    }
  }

  return { ok: true, checked, recorded, settled };
}

async function refundKnown(
  admin: ReturnType<typeof createAdminClient>,
  provided: ProviderRefund,
): Promise<{ existed: boolean; status: string | null }> {
  const row = await maybeRow<{ status: string }>(
    "refunds.import.known",
    admin
      .from("refunds")
      .select("status")
      .eq("razorpay_refund_id", provided.providerRefundId)
      .maybeSingle(),
  );
  return { existed: row !== null, status: row?.status ?? null };
}
