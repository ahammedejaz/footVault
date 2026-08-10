import "server-only";

import type { Database } from "@/lib/database.types";
import { sendOrderConfirmation, sendOwnerNewOrder } from "@/lib/email";
import {
  canTransition,
  isTerminalStatus,
  type ApplyPaymentResult,
  type OrderStatus,
  type PaymentStatus,
  type ShippingAddress,
} from "@/lib/orders/types";
import type { PaymentMethod, PaymentOutcome } from "@/lib/payments/types";
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
 * **An underpaid capture does not confirm the order** — where "underpaid" means
 * short of what was owed *online*, which for a Pay-on-Delivery order is the
 * advance rather than the total. A payment bound to a
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
  /** What was owed **online**. Equals `grand_total` for a prepaid order. */
  advance_amount: number;
};

type Decision = {
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  note: string | null;
  /**
   * The same event in the customer's own register, or null when it has nothing
   * to say to them. `note` here is written for whoever is reconciling a payment
   * — "Capture is short by 4200 paise" — and was being printed on the
   * customer's order page.
   */
  customerNote: string | null;
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
  /**
   * What was owed **online** — which is not the same as what the order costs.
   *
   * This is the line that makes Pay on Delivery possible, and getting it wrong
   * would have been silent and total. The guard below refuses any capture
   * smaller than `expected`, on the sound reasoning that a payment bound to a
   * provider order we created cannot settle for a different amount. Under the
   * Pay-on-Delivery model a capture is *supposed* to be short — ₹220 against a
   * ₹1,719 order — so comparing against `grand_total` would fire the guard on
   * the happy path and leave **every** such order stranded `pending` until the
   * abandonment sweep cancelled it. The customer would have been charged, and
   * their order would have quietly disappeared.
   *
   * The fix is not to weaken the guard — it is to give it the right
   * expectation. A Pay-on-Delivery capture of exactly the advance is full
   * payment of everything owed online, and anything else is still refused.
   *
   * `advance_amount` is set on every new order (it equals `grand_total` for
   * prepaid), so the fallbacks only cover rows written before this column
   * existed. `payments.amount` is written from the same local in the same
   * request, so the two cannot disagree today — but reading the order means a
   * future change that let them drift could not silently point the mismatch
   * check at the wrong number.
   */
  const expected = order.advance_amount || order.grand_total || recordedAmount;
  const captured = outcome.status === "captured";
  const shortfall = captured ? expected - outcome.amountPaise : 0;

  let status = order.status;
  let paymentStatus = order.payment_status;
  let note: string | null = null;
  let customerNote: string | null = null;
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
      /*
        The one event on the whole timeline a customer is actually waiting for.
        "Payment captured" is the provider's word for it; this is the shop's.

        The two failure branches around this one stay null on purpose. A short
        capture and a capture against a terminal order both need a person to
        sort out, and telling the customer "capture is short by 4200 paise"
        gives them something to worry about and nothing to do about it.
      */
      customerNote =
        "Payment received. Your order is confirmed and we are getting it ready.";
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

  return {
    status,
    paymentStatus,
    note,
    customerNote,
    illegal,
    expected,
    shortfall,
    patch,
  };
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
    customer_note: decision.customerNote,
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

/**
 * Tell the customer their order is confirmed, and tell the owner there is a
 * parcel to pack. This — not order creation — is where both emails live.
 *
 * They used to be sent from the checkout action, on the row being written,
 * which told a customer who closed the Razorpay modal "order confirmed" for an
 * order the sweep would cancel, and alerted the owner to a sale that never
 * happened. The webhook is the source of truth for payment everywhere else in
 * this codebase; this is the email layer inheriting it. For Pay on Delivery the
 * trigger is the same by construction: the deposit is a Razorpay capture and
 * arrives through this exact seam.
 *
 * A second read rather than widening the CAS select: the loop's query is on the
 * hot path of a webhook and re-runs up to three times, and none of these
 * columns has anything to do with the decision. This runs once, after the row
 * has already moved, so its cost is paid on the transition rather than on every
 * attempt. The caller gates it on `customerNote`, which `decide()` sets only on
 * the one branch that moves a pending order to confirmed — so a redelivered
 * webhook cannot email anybody twice.
 *
 * **Never allowed to matter.** A missing address, a missing email, a dead mail
 * provider — all of them end here with a log line. The customer's money has
 * moved and their order is confirmed; nothing about that may depend on an email.
 */
async function notifyOrderConfirmed(
  admin: ReturnType<typeof createAdminClient>,
  orderId: string,
): Promise<void> {
  try {
    const order = await maybeRow<{
      order_number: string;
      placed_at: string;
      payment_method: string;
      contact_email: string | null;
      contact_phone: string | null;
      coupon_code: string | null;
      subtotal: number;
      discount_total: number;
      prepaid_discount: number;
      coupon_discount: number;
      shipping_fee: number;
      cod_handling_fee: number;
      tax_total: number;
      grand_total: number;
      advance_amount: number;
      balance_due_on_delivery: number;
      shipping_address: ShippingAddress | null;
    }>(
      "notifyOrderConfirmed.order",
      admin
        .from("orders")
        .select(
          "order_number, placed_at, payment_method, contact_email, contact_phone, " +
            "coupon_code, subtotal, discount_total, prepaid_discount, coupon_discount, " +
            "shipping_fee, cod_handling_fee, tax_total, grand_total, advance_amount, " +
            "balance_due_on_delivery, shipping_address",
        )
        .eq("id", orderId)
        .maybeSingle(),
    );
    if (!order?.shipping_address) return;

    const { data: itemRows, error: itemsError } = await admin
      .from("order_items")
      .select("product_name, sku, color, size, quantity, line_total")
      .eq("order_id", orderId);
    if (itemsError) {
      console.error(
        `[email] could not read items for order ${orderId}: ${itemsError.message}`,
      );
      return;
    }

    const method: PaymentMethod =
      order.payment_method === "cod" ? "cod" : "razorpay";
    const address = order.shipping_address;
    const lines = (itemRows ?? []).map((item) => ({
      productName: item.product_name,
      sku: item.sku,
      colour: item.color,
      size: item.size,
      quantity: item.quantity,
      lineTotal: item.line_total,
    }));

    /**
     * Concurrent, not sequential: each adapter call has its own timeout, and
     * they are independent messages to different people. `allSettled` because
     * a rejection escaping here would surface as a webhook failure — and a
     * redelivery — for a payment that has already settled.
     */
    await Promise.allSettled([
      order.contact_email
        ? sendOrderConfirmation({
            orderNumber: order.order_number,
            to: order.contact_email,
            customerName: address.recipientName,
            paymentMethod: method,
            lines,
            couponCode: order.coupon_code,
            totals: {
              subtotal: order.subtotal,
              discountTotal: order.discount_total,
              prepaidDiscount: order.prepaid_discount,
              couponDiscount: order.coupon_discount,
              shippingFee: order.shipping_fee,
              forwardShippingFee: order.shipping_fee - order.cod_handling_fee,
              codHandlingFee: order.cod_handling_fee,
              taxTotal: order.tax_total,
              grandTotal: order.grand_total,
              advanceAmount: order.advance_amount,
              balanceDueOnDelivery: order.balance_due_on_delivery,
            },
            shippingAddress: address,
          })
        : Promise.resolve(),
      sendOwnerNewOrder({
        orderNumber: order.order_number,
        placedAt: order.placed_at,
        paymentMethod: method,
        lines,
        shippingAddress: address,
        grandTotal: order.grand_total,
        advanceAmount: order.advance_amount,
        balanceDueOnDelivery: order.balance_due_on_delivery,
        contactPhone: order.contact_phone ?? address.phone,
        contactEmail: order.contact_email,
      }),
    ]);
  } catch (error) {
    console.error(
      `[email] order-confirmed notices failed for order ${orderId}: ` +
        (error instanceof Error ? error.message : "unknown"),
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
          .select("id, status, payment_status, grand_total, advance_amount")
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

    /*
      The customer's confirmation and the owner's new-order alert — the only
      moment either is allowed to exist.

      Gated on `customerNote`, which `decide()` sets only on the branch that
      actually moved a pending order to confirmed. That is deliberately the
      narrowest possible trigger: a duplicate delivery loses the compare-and-swap
      and re-decides against `confirmed`, which produces no customerNote, so a
      redelivered webhook cannot email the same customer — or the owner — twice.

      It runs after `payment_events` is settled, so a mail failure cannot make us
      return non-2xx to Razorpay and have a delivered payment redelivered.
    */
    if (settled.customerNote) {
      await notifyOrderConfirmed(admin, payment.order_id);
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
