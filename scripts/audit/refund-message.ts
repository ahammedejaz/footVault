/**
 * The sentence the owner reads when they try to cancel an order that has
 * already been paid.
 *
 * Refunds do not exist yet, so this sentence *is* the refund mechanism: the
 * owner reads it, opens Razorpay, and moves the money by hand. That makes its
 * two numbers load-bearing in a way error copy usually is not — and one of them
 * is easy to get wrong in the direction that costs the shop money.
 *
 * On a Pay-on-Delivery order the advance and the order total are different
 * amounts, sometimes by a factor of five. Refunding the total would send back
 * money the shop never received, because the courier never collected the
 * balance on an order that is being cancelled. The assertions below exist to
 * make that specific mistake impossible to reintroduce.
 *
 * Pure. No database, no network. `refundInstruction` was exported from
 * `transition.ts` for exactly this.
 */
import { formatPaise } from "../../src/lib/format";
import { refundInstruction } from "../../src/lib/orders/transition";

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail = ""): void {
  checks++;
  if (!condition) failures++;
  console.log(
    `  ${condition ? "ok  " : "FAIL"}  ${label}${condition || !detail ? "" : `\n          ${detail}`}`,
  );
}

console.log("\nRefund instruction on a paid order\n");

/* ── Pay on Delivery: the case the wording exists for ─────────────────────── */
// Real shape, from live order FV-2026-00571: ₹1,848 total, ₹349 advance taken.
const cod = refundInstruction({
  payment_method: "cod",
  advance_amount: 34900,
  grand_total: 184800,
  payment_reference: "pay_TNEWQBLIJ4gAGN",
});

console.log(" pay on delivery:");
console.log(`   → ${cod}\n`);
ok("names the advance actually captured", cod.includes(formatPaise(34900)), cod);
ok("names the payment id", cod.includes("pay_TNEWQBLIJ4gAGN"), cod);
ok(
  "says the total is NOT the figure to refund",
  cod.includes("not the") && cod.includes(formatPaise(184800)),
  cod,
);
// The one that matters. A message that told the owner to refund ₹1,848 on an
// order where ₹349 was taken would cost the shop ₹1,499 every time it is obeyed.
ok(
  "never instructs a refund OF the total",
  !new RegExp(`Refund ${formatPaise(184800).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(cod),
  cod,
);

/* ── Prepaid: advance == grand_total, so no confusing aside ───────────────── */
// Real shape, from live order FV-2026-00487.
const prepaid = refundInstruction({
  payment_method: "razorpay",
  advance_amount: 169800,
  grand_total: 169800,
  payment_reference: "pay_TN9GKQluiI5ExB",
});

console.log("\n prepaid:");
console.log(`   → ${prepaid}\n`);
ok(
  "names the captured amount",
  prepaid.includes(formatPaise(169800)),
  prepaid,
);
ok("names the payment id", prepaid.includes("pay_TN9GKQluiI5ExB"), prepaid);
ok(
  "omits the 'not the total' aside, which cannot apply here",
  !prepaid.includes("not the"),
  prepaid,
);

/* ── Degenerate rows: say something true, never print a wrong number ───────── */
console.log("\n missing data:");
const noRef = refundInstruction({
  payment_method: "cod",
  advance_amount: 34900,
  grand_total: 184800,
  payment_reference: null,
});
ok(
  "no payment reference → says so, does not print null",
  !noRef.includes("null") && noRef.includes("search Razorpay by order number"),
  noRef,
);

const noAmount = refundInstruction({
  payment_method: "cod",
  advance_amount: null,
  grand_total: 184800,
  payment_reference: "pay_X",
});
ok(
  "no advance → does not claim a figure",
  !noAmount.includes(formatPaise(0)) && noAmount.includes("captured at checkout"),
  noAmount,
);

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks\n`,
);
process.exit(failures === 0 ? 0 : 1);
