import "server-only";

import type { Database } from "@/lib/database.types";
import {
  canTransition,
  isTerminalStatus,
  type ApplyPaymentResult,
  type OrderStatus,
  type PaymentStatus,
} from "@/lib/orders/types";
import type { PaymentOutcome } from "@/lib/payments/types";
import { maybeRow } from "@/lib/queries/run";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The only thing in this codebase that moves order state from a payment event.
 *
 * `src/lib/payments/` proves an event is genuine and turns it into a
 * `PaymentOutcome`; this turns a `PaymentOutcome` into a row change. Keeping
 * the two apart is what stops the transition rules from being reimplemented,
 * slightly differently, in every provider that gets added.
 *
 * **Safe to call repeatedly with the same eventId, by construction.** The first
 * thing it does is insert into `payment_events`, whose `unique (provider,
 * event_id)` makes a second delivery lose with 23505 — before anything has been
 * read, let alone written. That is a database guarantee rather than a
 * check-then-act.
 *
 * A 23505 is resolved rather than assumed. If the existing row has a
 * `processed_at`, the event is genuinely handled and this returns `duplicate`.
 * If it does not, the row is *adopted* and this call finishes it. That second
 * case is not a loophole, it is the supported shape: `recordAndApply` in
 * `src/lib/payments/apply.ts` deliberately claims the row first — so that the
 * ledger write happens before anything reads an order — and leaves `order_id`,
 * `processed_at` and `result` to this function. Treating its pre-claim as a
 * duplicate would make every real webhook a silent no-op and leave every paid
 * order sitting in `pending` with a 200 in the log and no error anywhere.
 *
 * **The pre-claim is what serialises deliveries, not this one.** Agent E's
 * review established that: through the webhook route, the inner claim below
 * always loses to the row `recordAndApply` inserted three lines earlier, always
 * finds `processed_at` null, and always adopts — so it is a lookup of this
 * request's own row, never a gate. The gate is the outer claim, which *is*
 * exclusive: ten simultaneous deliveries of one event produced exactly one
 * ledger row, one confirmation and one payment row. An earlier version of this
 * comment claimed adoption let two simultaneous deliveries both proceed. It
 * does not, and the claim was never the thing to worry about — the thing to
 * worry about was the `orders` row between the read and the write, and that is
 * what the compare-and-swap below now holds.
 *
 * The inner claim stays anyway. It is what makes this function safe to call
 * from anywhere that is not the route — including its own harness — and it
 * costs one insert.
 *
 * The one place it deletes the claim is when nothing was applied at all: an
 * event for an order we cannot resolve, or an error mid-flight. Keeping the
 * claim in those cases would make Razorpay's next retry a no-op and strand the
 * order in `pending` forever. Every step below is individually idempotent, so
 * re-running one is cheaper than not running it.
 *
 * **A failed payment does not cancel the order.** Razorpay fires
 * `payment.failed` for a declined card that the customer then retries in the
 * same modal against the same order; cancelling on the first failure would
 * restock the units out from under the second attempt and hand them to somebody
 * else. Failures are recorded and nothing moves.
 *
 * The consequence is that an abandoned `pending` order holds its stock, and
 * left unattended that is a free denial-of-inventory attack: start a Razorpay
 * checkout, close the tab, repeat until the shop reads sold out. The
 * adversarial review filed it as the phase's one high-severity finding. What
 * closes it is `public.release_abandoned_orders()`, run every ten minutes by
 * `pg_cron` job 1, which cancels and restocks anything still unpaid after
 * thirty minutes and skips any order with an authorised-but-unsettled payment.
 * See `supabase/migrations/20260808100000_release_abandoned_orders.sql`.
 *
 * **An underpaid capture does not confirm the order.** A payment bound to a
 * provider order we created cannot normally settle for a different amount, so a
 * mismatch is a bug in our plumbing, a partial-payment feature nobody asked
 * for, or a forged event — and in every one of those cases confirming an order
 * for less money than it costs is the wrong reflex. Under-payment leaves the
 * order `pending` and `unpaid`, records what actually arrived, and returns
 * `illegal_transition` so a human looks. Over-payment *does* confirm: the
 * customer has paid at least what was owed and must not be stranded because we
 * owe them change. Both are logged loudly and written into the event ledger.
 */

type TxnStatus = Database["public"]["Enums"]["payment_txn_status"];
type OrderPatch = Database["public"]["Tables"]["orders"]["Update"];

/** What the provider's verdict means for the attempt record. */
function txnStatusFor(outcome: PaymentOutcome["status"]): TxnStatus {
  if (outcome === "captured") return "captured";
  if (outcome === "pending") return "pending";
  return "failed";
}

/**
 * Payment records only ever move forward.
 *
 * A late `payment.failed` for a first attempt can arrive after the `captured`
 * for the second, because webhook delivery order is not a promise anybody
 * makes. Letting it overwrite `captured` would tell support that a customer who
 * paid did not.
 */
function advanceTxnStatus(current: TxnStatus, next: TxnStatus): TxnStatus {
  if (current === "refunded") return current;
  if (current === "captured" && next !== "refunded") return current;
  return next;
}

/**
 * How many times to re-read and re-decide before giving up on the swap.
 *
 * Three, because each retry means another writer beat us to the row, and a
 * fourth consecutive loss is not contention — it is something rewriting this
 * order in a loop, which the provider's own redelivery is a better answer to
 * than spinning here holding a claim.
 */
const CAS_ATTEMPTS = 3;

type OrderRow = {
  id: string;
  status: OrderStatus;
  payment_status: PaymentStatus;
  grand_total: number;
};

type Decision = {
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  note: string | null;
  /** Set when the event is real but the transition it implies is not legal. */
  illegal: string | null;
  /** What the order costs, per the order itself. */
  expected: number;
  /** Positive when the provider paid less than `expected`; negative when more. */
  shortfall: number;
  patch: OrderPatch;
};

/**
 * What this event means for this order, decided against one read.
 *
 * Pure, and separated from the write on purpose: the caller may have to run it
 * two or three times against successively fresher reads, and a decision
 * function that also wrote would make that impossible to do safely.
 */
function decide(
  order: OrderRow,
  outcome: PaymentOutcome,
  recordedAmount: number,
): Decision {
  // The order's own total is the authority on what it costs. `payments.amount`
  // is written from the same local in the same request today, so the two cannot
  // disagree — but reading the order means a future change that let them drift
  // could not silently point the mismatch check at the wrong number.
  const expected = order.grand_total || recordedAmount;
  const captured = outcome.status === "captured";
  const shortfall = captured ? expected - outcome.amountPaise : 0;

  let status = order.status;
  let paymentStatus = order.payment_status;
  let note: string | null = null;
  let illegal: string | null = null;

  if (captured && shortfall > 0) {
    // Less money arrived than the order costs. The payment row already records
    // what the provider claimed; the order deliberately does not move, because
    // confirming here would ship goods that are not paid for and no automatic
    // rule can safely decide otherwise.
    illegal =
      `Capture is short by ${shortfall} paise — expected ${expected}, ` +
      `received ${outcome.amountPaise}. The order has been left pending and unpaid ` +
      "for a human to resolve.";
    note = illegal;
  } else if (captured) {
    // Over-payment lands here too, on purpose: the customer has paid at least
    // what was owed, so their order proceeds and the difference is a refund we
    // owe rather than a reason to strand them.
    paymentStatus = "paid";
    if (
      order.status === "pending" &&
      canTransition(order.status, "confirmed")
    ) {
      status = "confirmed";
      note =
        shortfall < 0
          ? `Payment captured; ${-shortfall} paise overpaid`
          : "Payment captured";
    } else if (isTerminalStatus(order.status)) {
      // The money arrived anyway. Record it — payment_status still becomes
      // `paid` — but do not claim the transition happened, because it did not
      // and somebody owes this customer a refund.
      illegal =
        `Payment captured for an order that is already ${order.status}. ` +
        "The customer has been charged and a refund is owed.";
      note = illegal;
    }
  }
  // `pending` (authorised, not settled) and `failed` both leave the order
  // exactly where it is. See the header for why a failure does not cancel.

  const patch: OrderPatch = {};
  if (status !== order.status) patch.status = status;
  if (paymentStatus !== order.payment_status)
    patch.payment_status = paymentStatus;
  if (outcome.providerPaymentId)
    patch.payment_reference = outcome.providerPaymentId;

  return { status, paymentStatus, note, illegal, expected, shortfall, patch };
}

/**
 * The audit row. Never fatal: the order has already moved by the time this
 * runs, and a missing timeline entry is not worth telling the provider to
 * redeliver a payment that has settled.
 */
async function recordHistory(
  admin: ReturnType<typeof createAdminClient>,
  orderId: string,
  decision: Decision,
): Promise<void> {
  const { error } = await admin.from("order_status_history").insert({
    order_id: orderId,
    status: decision.status,
    note: decision.note,
  });
  if (error) {
    console.error(
      `[payments] history row failed for ${orderId}: ${error.message}`,
    );
  }
}

type Claim = { kind: "claimed"; id: string } | { kind: "duplicate" };

/**
 * Take the ledger row for this event, or discover that it is already finished.
 *
 * The insert is first and the select is second, in that order, because the
 * other way round is a race: two deliveries both read "not handled" and both
 * proceed. Here the unique index picks a winner and the loser only then asks
 * what it lost to.
 */
async function claimEvent(
  admin: ReturnType<typeof createAdminClient>,
  provider: "cod" | "razorpay",
  eventId: string,
  eventType: string,
): Promise<Claim> {
  const { data, error } = await admin
    .from("payment_events")
    .insert({ provider, event_id: eventId, event_type: eventType })
    .select("id")
    .maybeSingle();

  if (!error && data) return { kind: "claimed", id: data.id };
  if (error && error.code !== "23505") {
    throw new Error(
      `applyPaymentOutcome: could not record event — ${error.message} [${error.code}]`,
    );
  }
  if (!error) {
    throw new Error("applyPaymentOutcome: recording the event returned no row");
  }

  const existing = await maybeRow<{ id: string; processed_at: string | null }>(
    "applyPaymentOutcome.existingEvent",
    admin
      .from("payment_events")
      .select("id, processed_at")
      .eq("provider", provider)
      .eq("event_id", eventId)
      .maybeSingle(),
  );

  // Lost the insert and then could not find the winner: the row was released
  // between the two statements. Throwing asks the provider to redeliver, which
  // is right — guessing either way here would either drop the event or double
  // it, and both are worse than one more delivery.
  if (!existing) {
    throw new Error(
      `applyPaymentOutcome: event ${eventId} conflicted but then vanished`,
    );
  }
  if (existing.processed_at) return { kind: "duplicate" };
  return { kind: "claimed", id: existing.id };
}

/** Nothing was applied, so the claim must not block the provider's retry. */
async function releaseClaim(
  admin: ReturnType<typeof createAdminClient>,
  eventRowId: string,
): Promise<void> {
  const { error } = await admin
    .from("payment_events")
    .delete()
    .eq("id", eventRowId);
  if (error) {
    // Loud, because the consequence is a stuck order: the retry will now see a
    // duplicate and do nothing.
    console.error(
      `[payments] could not release event claim ${eventRowId}: ${error.message}`,
    );
  }
}

export async function applyPaymentOutcome(input: {
  eventId: string;
  provider: "cod" | "razorpay";
  providerOrderId: string | null;
  eventType: string;
  outcome: PaymentOutcome;
}): Promise<ApplyPaymentResult> {
  const admin = createAdminClient();

  const claim = await claimEvent(
    admin,
    input.provider,
    input.eventId,
    input.eventType,
  );
  if (claim.kind === "duplicate") {
    return {
      applied: false,
      reason: "duplicate",
      message: `Event ${input.eventId} has already been handled.`,
    };
  }

  try {
    const providerOrderId =
      input.providerOrderId ?? input.outcome.providerOrderId;

    const payment = providerOrderId
      ? await maybeRow<{
          id: string;
          order_id: string;
          status: TxnStatus;
          provider_payment_id: string | null;
          amount: number;
        }>(
          "applyPaymentOutcome.payment",
          admin
            .from("payments")
            .select("id, order_id, status, provider_payment_id, amount")
            .eq("provider", input.provider)
            .eq("provider_order_id", providerOrderId)
            .maybeSingle(),
        )
      : null;

    if (!payment) {
      await releaseClaim(admin, claim.id);
      return {
        applied: false,
        reason: "not_found",
        message: `No order is associated with provider order ${providerOrderId ?? "(none)"}.`,
      };
    }

    // The payment record moves first and on its own. It is keyed by the
    // provider's ids rather than by order state, so nothing races it — and
    // doing it here lifts a whole round trip out of the read-decide-write
    // window on the order, which is the window E-2 was firing into.
    const txn = advanceTxnStatus(
      payment.status,
      txnStatusFor(input.outcome.status),
    );
    const paymentPatch: Database["public"]["Tables"]["payments"]["Update"] = {
      status: txn,
      raw_status: input.outcome.rawStatus,
    };
    // Claim the payment id once. Overwriting it would lose the attempt that
    // actually settled when a later event names a different one.
    if (input.outcome.providerPaymentId && !payment.provider_payment_id) {
      paymentPatch.provider_payment_id = input.outcome.providerPaymentId;
    }

    const paymentError = (
      await admin.from("payments").update(paymentPatch).eq("id", payment.id)
    ).error;
    if (paymentError) {
      throw new Error(
        `applyPaymentOutcome.payments: ${paymentError.message} [${paymentError.code}]`,
      );
    }

    let settled: Decision | null = null;

    for (
      let attempt = 0;
      attempt < CAS_ATTEMPTS && settled === null;
      attempt++
    ) {
      const order = await maybeRow<OrderRow>(
        "applyPaymentOutcome.order",
        admin
          .from("orders")
          .select("id, status, payment_status, grand_total")
          .eq("id", payment.order_id)
          .maybeSingle(),
      );

      if (!order) {
        await releaseClaim(admin, claim.id);
        return {
          applied: false,
          reason: "not_found",
          message: "The order this payment belongs to no longer exists.",
        };
      }

      const decision = decide(order, input.outcome, payment.amount);

      if (Object.keys(decision.patch).length === 0) {
        // Nothing to write on the order, so there is no race to lose. A verdict
        // with nothing to patch still deserves its audit row.
        if (decision.illegal) await recordHistory(admin, order.id, decision);
        settled = decision;
        break;
      }

      // **Compare and swap.** `.eq("status", order.status)` is the whole of the
      // fix for E-2 and E-5: the row has to still be the one this decision was
      // made from. A cancellation committing in the gap — which is exactly what
      // the abandoned-order sweep is — matches zero rows here instead of
      // silently overwriting `cancelled` with `confirmed` and leaving a live
      // order whose units are already back on the shelf. A second capture
      // arriving under a different idempotency key loses the same way, re-reads
      // `confirmed`, and writes no second timeline entry.
      const { data: swapped, error: swapError } = await admin
        .from("orders")
        .update(decision.patch)
        .eq("id", order.id)
        .eq("status", order.status)
        .select("id");

      if (swapError) {
        throw new Error(
          `applyPaymentOutcome.orders: ${swapError.message} [${swapError.code}]`,
        );
      }
      // Somebody moved it. Go round again and decide against what actually won.
      if ((swapped?.length ?? 0) !== 1) continue;

      if (decision.status !== order.status || decision.illegal) {
        await recordHistory(admin, order.id, decision);
      }
      settled = decision;
    }

    if (settled === null) {
      // Three reads in a row lost the swap. Something is rewriting this order
      // faster than we can decide about it, so hand it back to the provider
      // rather than guess. The claim is released by the catch below, which is
      // what makes the redelivery meaningful.
      throw new Error(
        `applyPaymentOutcome: order ${payment.order_id} changed under every attempt to apply ` +
          `${input.eventType}`,
      );
    }

    // Ids and integers only — never the payload.
    if (settled.shortfall !== 0) {
      console.error(
        `[payments] amount mismatch on order ${payment.order_id}: ` +
          `expected ${settled.expected} paise, provider reported ${input.outcome.amountPaise}`,
      );
    }

    const settleError = (
      await admin
        .from("payment_events")
        .update({
          processed_at: new Date().toISOString(),
          // Free text by design — this is a log. The mismatch case spells out
          // both numbers so the ledger answers the question without a join.
          result:
            settled.shortfall !== 0
              ? `amount_mismatch:expected=${settled.expected},received=${input.outcome.amountPaise}`
              : settled.illegal
                ? "illegal_transition"
                : "applied",
          order_id: payment.order_id,
        })
        .eq("id", claim.id)
    ).error;
    if (settleError) {
      console.error(
        `[payments] could not settle event ${input.eventId}: ${settleError.message}`,
      );
    }

    if (settled.illegal) {
      return {
        applied: false,
        reason: "illegal_transition",
        message: settled.illegal,
      };
    }
    return {
      applied: true,
      status: settled.status,
      paymentStatus: settled.paymentStatus,
    };
  } catch (error) {
    // Nothing here is half-done in a way a replay makes worse: the transition
    // is guarded by canTransition and the payment record only moves forward.
    // Letting the retry through is strictly better than a stuck order.
    await releaseClaim(admin, claim.id);
    throw error;
  }
}
