import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { recordAndApply } from "@/lib/payments/apply";
import { fetchOrderPayments } from "@/lib/payments/razorpay";
import { decideForOrder } from "@/lib/payments/reconcile";
import { createAdminClient } from "@/lib/supabase/admin";
import { stockChangedFromRoute } from "@/lib/stock-freshness";

/**
 * The half of the abandoned-order sweep that has to ask Razorpay first.
 *
 * `release_abandoned_orders` cancels unpaid orders and puts their stock back.
 * It runs inside Postgres, which cannot make an HTTP call, so it decided
 * whether a customer had paid using only rows we had written — and a
 * Razorpay-backed order sits at `payments.status = 'created'` until its webhook
 * lands. For the whole period in which no live webhook existed, "charged" and
 * "abandoned" were the same state to that function, and it cancelled both.
 *
 * The split, and why it is drawn here:
 *
 *   - **Postgres keeps the safe subset.** The narrowed function now takes only
 *     orders with *no payments row at all* — pure Pay-on-Delivery abandonment,
 *     where there is nothing to ask anyone about.
 *   - **This route takes the rest**, because deciding them requires an answer
 *     from Razorpay, and only application code can get one.
 *
 * **The rule that matters more than any other here: never cancel on an
 * unknown.** A timeout, a 500, a rate limit, a shape we do not recognise —
 * every one of them leaves the order exactly as it was, to be looked at again
 * next tick. The cost of waiting is a customer's stock held slightly longer.
 * The cost of guessing wrong is cancelling an order somebody has paid for and
 * restocking goods they own. Those are not comparable, so the code does not
 * treat them as comparable.
 *
 * **Idempotency is inherited, not invented.** Everything found here goes
 * through `recordAndApply` — the same seam the webhook uses — with event ids
 * derived by the same function. A payment reconciled here and its webhook
 * arriving an hour later collapse to one application via
 * `payment_events_unique_per_provider`. There is deliberately no second
 * mechanism; a second mechanism is how the two drift.
 *
 * Scheduled by pg_cron calling pg_net, not by Vercel Cron: this project is on
 * Vercel's Hobby plan, where a sub-daily cron expression fails the deployment
 * outright. See `claudeExecutionReport/phase-8-hardening.md`, check 3.
 */

/** `node:crypto` for the constant-time compare. Not available on the edge runtime. */
export const runtime = "nodejs";

/** Never cached, never prerendered. It moves money-adjacent state. */
export const dynamic = "force-dynamic";

/**
 * How many orders one tick will look at.
 *
 * Each costs a Razorpay round trip, so an unbounded batch after an outage is a
 * self-inflicted rate-limit incident on the API that takes the shop's money.
 * The remainder is not lost — it is simply next tick's work.
 */
const MAX_ORDERS_PER_TICK = 50;

/** Matches `release_abandoned_orders`' own default. One cutoff, one meaning. */
const ABANDONED_AFTER_MINUTES = 30;

export async function POST(request: Request): Promise<NextResponse> {
  if (!authorised(request)) {
    // No detail. The only correct client knows the secret already, and
    // everybody else learns nothing about whether the route or the token was
    // the problem.
    console.warn("[cron/release-abandoned] rejected: bad or missing token");
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const admin = createAdminClient();
  const cutoff = new Date(
    Date.now() - ABANDONED_AFTER_MINUTES * 60_000,
  ).toISOString();

  /**
   * Orders old enough to look abandoned that **have** a payment attempt.
   *
   * `!inner` on payments is what draws the line against the Postgres function:
   * it takes the rows with no payments at all, this takes the rows with some.
   * Neither can see the other's set, so no order is considered twice and none
   * falls between them.
   */
  const { data: candidates, error } = await admin
    .from("orders")
    .select("id, order_number, payments!inner(provider_order_id, status)")
    .eq("status", "pending")
    .eq("payment_status", "unpaid")
    .lt("placed_at", cutoff)
    .order("placed_at", { ascending: true })
    .limit(MAX_ORDERS_PER_TICK);

  if (error) {
    console.error("[cron/release-abandoned] could not read candidates", {
      message: error.message,
      code: error.code,
    });
    // 500 so a monitored failure is visible as one. Nothing has been changed.
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  const tally = {
    examined: 0,
    rescued: 0,
    cancelled: 0,
    leftAlone: 0,
    unreachable: 0,
  };

  for (const order of candidates ?? []) {
    tally.examined++;

    // The row that carries the id Razorpay knows this order by. A payments row
    // without one cannot be asked about, so it is left alone rather than
    // guessed at.
    const providerOrderId =
      order.payments.find((row) => row.provider_order_id)?.provider_order_id ??
      null;

    if (!providerOrderId) {
      console.warn("[cron/release-abandoned] payment row carries no order id", {
        orderNumber: order.order_number,
      });
      tally.leftAlone++;
      continue;
    }

    const found = await fetchOrderPayments(providerOrderId);
    const decision = decideForOrder({
      // `null` is the whole contract with `decideForOrder`: a failed lookup
      // must not arrive there as an empty list, because an empty list means
      // "Razorpay says nobody paid" and that answer cancels the order.
      payments: found.ok ? found.payments : null,
      providerOrderId,
    });

    if (decision.action === "leave") {
      console.warn("[cron/release-abandoned] order left untouched", {
        orderNumber: order.order_number,
        why: decision.why,
        detail: found.ok ? undefined : found.description,
      });
      if (found.ok) tally.leftAlone++;
      else tally.unreachable++;
      continue;
    }

    if (decision.action === "rescue") {
      // The customer paid and the webhook never told us. Apply it properly
      // rather than merely declining to cancel — the order should confirm, the
      // way it would have if the webhook had arrived.
      for (const payment of decision.payments) {
        const applied = await recordAndApply({
          eventId: payment.eventId,
          provider: "razorpay",
          providerOrderId: payment.providerOrderId,
          eventType: payment.eventType,
          outcome: payment.outcome,
        });
        console.info("[cron/release-abandoned] rescued a paid order", {
          orderNumber: order.order_number,
          eventId: payment.eventId,
          status: applied.status,
        });
      }
      tally.rescued++;
      continue;
    }

    // Razorpay answered, and nothing on this order was ever authorised. This is
    // genuine abandonment, and it is the only path to a cancellation.
    const { data: verdict, error: cancelError } = await admin.rpc(
      "cancel_order_with_restock",
      {
        p_order_id: order.id,
        p_reason: "Released automatically: unpaid and abandoned",
        p_require_unpaid: true,
        p_release_cart: false,
        p_movement_reason: "sweep",
        // Reached only after Razorpay has confirmed nothing was ever authorised,
        // so "nothing has been charged" is a fact here rather than a hope.
        p_customer_note:
          "We did not receive a payment for this order, so it was cancelled and " +
          "the pairs went back on sale. Nothing has been charged.",
      },
    );

    if (cancelError) {
      console.error("[cron/release-abandoned] cancel failed", {
        orderNumber: order.order_number,
        message: cancelError.message,
      });
      tally.leftAlone++;
      continue;
    }

    if (verdict === "cancelled") {
      tally.cancelled++;
    } else {
      // `already_paid` here would mean a capture landed between the question
      // and the answer. The guard inside the function is what makes that a
      // refusal rather than a loss, and it is worth seeing.
      console.warn("[cron/release-abandoned] cancel declined", {
        orderNumber: order.order_number,
        verdict,
      });
      tally.leftAlone++;
    }
  }

  /**
   * The Route Handler variant, not `stockChanged()`. This line shipped with
   * the Server-Action-only `updateTag` inside it, which throws in a route —
   * so the first tick that actually *cancelled* something would have died
   * with a 500 after the cancel, with pg_cron's caller reading only "the
   * request was queued". Nothing in production ever cancelled through here
   * before the gate drove this path end to end (Batch 3), which is the only
   * reason the crash had never been seen.
   */
  if (tally.cancelled > 0) stockChangedFromRoute();

  console.info("[cron/release-abandoned] tick complete", tally);
  return NextResponse.json({ ok: true, ...tally });
}

/**
 * A bearer token compared in constant time.
 *
 * `===` on a secret leaks its prefix through timing. That is a marginal attack
 * over the public internet and it costs one function to remove, which is a
 * trade worth taking on the endpoint that can cancel orders.
 *
 * Absent `CRON_SECRET` denies everything. The alternative — an unset secret
 * meaning "open" — is how this endpoint would quietly become public the first
 * time an environment variable failed to copy across.
 */
function authorised(request: Request): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) {
    console.error(
      "[cron/release-abandoned] CRON_SECRET is not set, so every request is refused. " +
        "Set it in the Vercel project and in the Vault secret pg_cron reads.",
    );
    return false;
  }

  const header = request.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (offered.length === 0) return false;

  const a = Buffer.from(offered, "utf8");
  const b = Buffer.from(expected, "utf8");
  // `timingSafeEqual` throws on a length mismatch, which would itself be a
  // length oracle and a 500. Compare lengths first and keep the comparison for
  // the equal-length case, which is the one that matters.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
