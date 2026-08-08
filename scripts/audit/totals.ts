/**
 * `npm run audit:totals` — the money arithmetic, in isolation.
 *
 * The brief names this as a gate in as many words: *"A Pay-on-Delivery order's
 * advance, balance and total sum correctly, and the Shiprocket COD amount equals
 * the balance. Assert it, don't eyeball it."* The Shiprocket half lives in
 * `audit:shipping`, which has the mock; this half is pure arithmetic and needs
 * nothing but the functions.
 *
 * Why it is worth its own suite: every number here is money that a real customer
 * either pays online or hands to a courier, and the two failure modes are both
 * silent. An advance that rounds below Razorpay's 100-paise floor produces an
 * order that cannot be paid for. An advance and balance that do not sum to the
 * total produce a courier collecting the wrong amount, which is discovered by
 * complaint rather than by exception.
 */

import {
  advanceFor,
  type AdvanceRule,
  type CodAdvanceMode,
} from "../../src/lib/payments/advance";
import { MIN_CHARGEABLE_PAISE } from "../../src/lib/payments/types";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed += 1;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const rule = (
  mode: CodAdvanceMode,
  minimumPaise = 9_900,
  fixedPaise = 9_900,
): AdvanceRule => ({ mode, minimumPaise, fixedPaise });

/* ------------------------------------------------------ the three modes -- */

section("1 · the advance rule honours its mode");

{
  const r = advanceFor({
    rule: rule("shipping_fee"),
    deliveryTotalPaise: 22_000,
    grandTotalPaise: 171_900,
  });
  check("shipping_fee: advance is the delivery total", r.advancePaise === 22_000,
    `got ${r.advancePaise}`);
  check("shipping_fee: balance is the rest", r.balanceDuePaise === 149_900,
    `got ${r.balanceDuePaise}`);
}

{
  const r = advanceFor({
    rule: rule("fixed", 9_900, 9_900),
    deliveryTotalPaise: 22_000,
    grandTotalPaise: 171_900,
  });
  check("fixed: advance ignores the delivery total", r.advancePaise === 9_900,
    `got ${r.advancePaise}`);
}

{
  const r = advanceFor({
    rule: rule("greater_of", 9_900),
    deliveryTotalPaise: 22_000,
    grandTotalPaise: 171_900,
  });
  check("greater_of: takes the delivery total when it is larger",
    r.advancePaise === 22_000, `got ${r.advancePaise}`);
}

{
  const r = advanceFor({
    rule: rule("greater_of", 9_900),
    deliveryTotalPaise: 0,
    grandTotalPaise: 1_699_900,
  });
  check("greater_of: takes the minimum when delivery is free",
    r.advancePaise === 9_900, `got ${r.advancePaise}`);
  check("greater_of: balance is the total less the advance",
    r.balanceDuePaise === 1_690_000, `got ${r.balanceDuePaise}`);
}

/* ------------------------------------------------- the floor that matters -- */

section("2 · an advance is never unchargeable");

{
  // The brief: "Never produce an advance below Razorpay's 100 paise minimum. If
  // the computed advance would be zero, fall back to the configured minimum."
  const r = advanceFor({
    rule: rule("shipping_fee"),
    deliveryTotalPaise: 0,
    grandTotalPaise: 1_699_900,
  });
  check("shipping_fee with free delivery still charges the minimum",
    r.advancePaise === 9_900, `got ${r.advancePaise}`);
}

for (const mode of ["shipping_fee", "fixed", "greater_of"] as CodAdvanceMode[]) {
  const r = advanceFor({
    // A minimum of zero is an owner typo, not an instruction to stop securing
    // the order. It must still clear Razorpay's floor.
    rule: rule(mode, 0, 0),
    deliveryTotalPaise: 0,
    grandTotalPaise: 500_000,
  });
  check(`${mode}: a zero minimum still clears Razorpay's floor`,
    r.advancePaise >= MIN_CHARGEABLE_PAISE, `got ${r.advancePaise}`);
}

/* ------------------------------------------------------- the invariants -- */

section("3 · advance + balance = total, always");

{
  const cases: Array<[CodAdvanceMode, number, number, number]> = [
    // mode, delivery, grandTotal, minimum
    ["greater_of", 22_000, 171_900, 9_900],
    ["greater_of", 0, 1_699_900, 9_900],
    ["shipping_fee", 34_900, 234_900, 9_900],
    ["fixed", 19_900, 169_800, 9_900],
    ["greater_of", 19_900, 19_900, 9_900], // delivery is the whole order
    ["greater_of", 500_000, 100_000, 9_900], // delivery exceeds the total
    ["fixed", 0, 150, 9_900], // an absurdly small order
  ];

  let allSum = true;
  let allNonNegative = true;
  let allWithinTotal = true;

  for (const [mode, delivery, total, minimum] of cases) {
    const r = advanceFor({
      rule: rule(mode, minimum),
      deliveryTotalPaise: delivery,
      grandTotalPaise: total,
    });
    if (r.advancePaise + r.balanceDuePaise !== total) {
      allSum = false;
      failures.push(
        `sum broke: ${mode} delivery=${delivery} total=${total} → ` +
          `${r.advancePaise}+${r.balanceDuePaise}`,
      );
    }
    if (r.balanceDuePaise < 0) allNonNegative = false;
    if (r.advancePaise > total) allWithinTotal = false;
  }

  check("every case sums to the grand total", allSum);
  check("the balance is never negative", allNonNegative);
  check("the advance never exceeds the order total", allWithinTotal);
}

section("4 · integer paise only");

{
  const r = advanceFor({
    rule: rule("greater_of", 9_901),
    deliveryTotalPaise: 22_001,
    grandTotalPaise: 171_901,
  });
  check("advance is a safe integer", Number.isSafeInteger(r.advancePaise));
  check("balance is a safe integer", Number.isSafeInteger(r.balanceDuePaise));
}

/* ------------------------------------------------------------- verdict -- */

console.log(
  `\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m` +
    (failures.length ? `\n\n${failures.map((f) => `  · ${f}`).join("\n")}` : ""),
);
process.exit(failed > 0 ? 1 : 0);
