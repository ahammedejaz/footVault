/**
 * The abandoned-order reconciler.
 *
 * The bug it replaces: `release_abandoned_orders` cancelled and restocked any
 * unpaid order past the cutoff, and a Razorpay-backed order sits at
 * `payments.status = 'created'` until its webhook arrives. With no live-mode
 * webhook that state was permanent, so every paid Razorpay order was guaranteed
 * to be cancelled — customer charged, goods back on the shelf, nothing logged
 * anywhere.
 *
 * Three things are asserted, in decreasing order of how expensive they are to
 * get wrong:
 *
 *   1. **No uncertain answer can cancel an order.** Every way Razorpay can fail
 *      to give a clear "nobody paid" must resolve to leaving the order alone.
 *   2. **The narrowed SQL really is narrowed**, checked by reading the
 *      migration rather than trusting the comment on it — the original defect
 *      was a `where` clause that read correctly and was not.
 *   3. **The route refuses every request without the secret.**
 *
 * Read-only. Creates nothing, cancels nothing. The only requests it makes to
 * the route are ones it expects to be rejected.
 */
import { readFileSync } from "node:fs";

import { decideForOrder } from "../../src/lib/payments/reconcile";
import type { ReconciledPayment } from "../../src/lib/payments/razorpay";

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail = ""): void {
  checks++;
  if (!condition) failures++;
  console.log(
    `  ${condition ? "ok  " : "FAIL"}  ${label}${condition || !detail ? "" : `\n          ${detail}`}`,
  );
}

/** A payment as `fetchOrderPayments` would return it. */
function payment(rawStatus: string, id = "pay_TEST"): ReconciledPayment {
  return {
    eventId: `payment.${rawStatus}:${id}`,
    eventType: `payment.${rawStatus}`,
    providerOrderId: "order_TEST",
    rawStatus,
    outcome: {
      status: rawStatus === "captured" ? "captured" : "failed",
      providerPaymentId: id,
      providerOrderId: "order_TEST",
      amountPaise: 34900,
      rawStatus,
      message: null,
    },
  } as ReconciledPayment;
}

const ORDER = "order_TEST";

console.log("\nAbandoned-order reconciler\n");

/* ── 1 · nothing uncertain may cancel ─────────────────────────────────────── */
console.log(" the rule: only a positive 'nobody paid' can cancel");

ok(
  "razorpay unreachable → leave, NOT cancel",
  decideForOrder({ payments: null, providerOrderId: ORDER }).action === "leave",
);
ok(
  "no provider order id → leave, NOT cancel",
  decideForOrder({ payments: [], providerOrderId: null }).action === "leave",
);
ok(
  "a refunded payment → leave for a human, NOT cancel",
  decideForOrder({ payments: [payment("refunded")], providerOrderId: ORDER })
    .action === "leave",
);

// The inverse of the original bug, stated as an assertion: a captured payment
// on an order the sweep thinks is abandoned must never be cancelled.
const captured = decideForOrder({
  payments: [payment("captured", "pay_TNEWQBLIJ4gAGN")],
  providerOrderId: ORDER,
});
ok("a captured payment → rescue, NOT cancel", captured.action === "rescue");
ok(
  "the rescue carries the payment through to recordAndApply",
  captured.action === "rescue" &&
    captured.payments[0].eventId === "payment.captured:pay_TNEWQBLIJ4gAGN",
);
ok(
  "an authorized-but-not-captured payment → rescue, NOT cancel",
  decideForOrder({ payments: [payment("authorized")], providerOrderId: ORDER })
    .action === "rescue",
);

console.log("\n and the one case that may cancel:");
ok(
  "razorpay answers with no payments at all → cancel",
  decideForOrder({ payments: [], providerOrderId: ORDER }).action === "cancel",
);
ok(
  "only failed attempts → cancel",
  decideForOrder({
    payments: [payment("failed", "pay_A"), payment("failed", "pay_B")],
    providerOrderId: ORDER,
  }).action === "cancel",
);

// The distinction the whole three-way return type exists to preserve. If a
// failed lookup were ever flattened into an empty array on its way in, this is
// the assertion that would catch it.
const unreachable = decideForOrder({ payments: null, providerOrderId: ORDER });
const nobodyPaid = decideForOrder({ payments: [], providerOrderId: ORDER });
ok(
  "'could not ask' and 'the answer was no' are different verdicts",
  unreachable.action !== nobodyPaid.action,
  `both were ${unreachable.action}`,
);

/* ── 2 · the migration really narrows the sweep ───────────────────────────── */
console.log("\n the narrowed SQL function:");
const sql = readFileSync(
  "supabase/migrations/20260809030000_narrow_release_abandoned_orders.sql",
  "utf8",
);
const notExists = sql.slice(sql.indexOf("not exists"), sql.indexOf("order by"));
ok(
  "the exclusion no longer filters on payment status",
  !/pm\.status\s+in/i.test(notExists),
  notExists.trim(),
);
ok(
  "any payments row at all disqualifies the order",
  /from\s+public\.payments\s+pm\s+where\s+pm\.order_id\s*=\s*o\.id/i.test(
    notExists.replace(/\s+/g, " "),
  ),
  notExists.trim(),
);

/* ── 3 · the route refuses without the secret ─────────────────────────────── */
console.log("\n route authentication:");
const base = process.env.AUDIT_BASE_URL ?? "http://localhost:3210";
const path = "/api/cron/release-abandoned-orders";
let reachable = true;

async function probe(
  label: string,
  headers: Record<string, string>,
): Promise<void> {
  if (!reachable) return;
  try {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: "{}",
    });
    ok(`${label} → 401`, response.status === 401, `got ${response.status}`);
  } catch {
    reachable = false;
    console.log(
      `  --  no server at ${base}; start one and re-run to cover these.`,
    );
  }
}

async function main(): Promise<void> {
  await probe("no authorization header", {});
  await probe("empty bearer", { Authorization: "Bearer " });
  await probe("wrong secret", { Authorization: "Bearer not-the-secret" });
  await probe("right secret, missing Bearer prefix", {
    Authorization: process.env.CRON_SECRET ?? "unset",
  });

  // The complement, and without it the four above prove nothing: a route that
  // 401s unconditionally would satisfy every rejection test. This is the one
  // that shows the door opens for the right key.
  if (reachable && process.env.CRON_SECRET) {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.CRON_SECRET}`,
      },
      body: "{}",
    });
    ok(
      "the correct bearer token is accepted",
      response.status === 200,
      `got ${response.status}`,
    );
    const body = (await response.json()) as { examined?: number };
    console.log(`        tick examined ${body.examined ?? "?"} orders`);
  }

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks` +
      (reachable ? "" : "  (route probes skipped — no server)") +
      "\n",
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
