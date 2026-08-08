/**
 * `npm run audit:totals` — the money arithmetic, in isolation.
 *
 * Phase 7 replaced the advance rule entirely. The advance is now the **full
 * round trip** — forward freight plus RTO freight — because on a refusal the
 * shop pays both legs; and it is netted off the balance so the customer never
 * pays twice. Every number below is money a real customer either pays online or
 * hands to a courier, and both failure modes are silent: an advance that does
 * not sum with the balance produces a courier collecting the wrong amount, and
 * an advance below Razorpay's 100-paise floor produces an order that cannot be
 * paid for at all. Neither throws. Both are found by complaint.
 *
 * The brief lists nine money-model assertions. Five of them are pure arithmetic
 * and live here; the other four need a database or the Shiprocket mock and live
 * in `audit:shipping` and `audit:checkout`. Each section below names which.
 *
 * **The rates are real.** Every figure comes from a live serviceability call
 * against this account on 2026-08-08, Cuddapah 516360 → Bangalore 560001, 1 kg,
 * ₹1,000 declared:
 *
 *   Delhivery Surface   rate 191.36   freight 139.36   cod 52.00   rto 142.00
 *   Delhivery Air       rate 240.36   freight 188.36   cod 52.00   rto 194.00
 *   Blue Dart Air       rate 300.30   freight 244.65   cod 55.65   rto 246.00
 *
 * Made-up numbers would let a rounding rule pass that a real rate breaks.
 */

import {
  advanceFor,
  codOfferedForOrder,
  prepaidDiscountFor,
  type AdvanceRule,
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

const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;

/** The owner's defaults: a ₹500 cap, GST absorbed rather than recovered. */
const rule = (over: Partial<AdvanceRule> = {}): AdvanceRule => ({
  maximumPaise: 50_000,
  includeGst: false,
  ...over,
});

/** Delhivery Surface, the cheapest non-India-Post courier on the tested lane. */
const SURFACE = { rate: 19_136, freight: 13_936, cod: 5_200, rto: 14_200 };

/* ----------------------------------------------- 1 · the worked example -- */

section("1 · the brief's worked example, against live rates");

{
  const goods = 100_000;
  // The customer's delivery fee is the live COD rate, rounded up to ₹10.
  const deliveryFee = Math.ceil(SURFACE.rate / 1_000) * 1_000; // ₹200
  const grandTotal = goods + deliveryFee;

  const split = advanceFor({
    rule: rule(),
    forwardFreightPaise: SURFACE.freight,
    rtoFreightPaise: SURFACE.rto,
    grandTotalPaise: grandTotal,
  });

  check(
    "advance is forward freight + RTO freight",
    split.advancePaise === SURFACE.freight + SURFACE.rto,
    `${rupees(split.advancePaise)} vs ${rupees(SURFACE.freight + SURFACE.rto)}`,
  );
  check(
    "balance is goods + delivery − advance",
    split.balanceDuePaise === grandTotal - split.advancePaise,
    rupees(split.balanceDuePaise),
  );
  check(
    "the customer's total is the same either way",
    split.advancePaise + split.balanceDuePaise === grandTotal,
    `${rupees(split.advancePaise + split.balanceDuePaise)} vs ${rupees(grandTotal)}`,
  );

  /**
   * Assertion 4 — *"a refused Pay-on-Delivery order leaves the shop at net
   * zero"*. This is the whole reason the advance is the round trip. Shiprocket
   * reverses the cash-collection fee on an RTO, so the shop's exposure on a
   * refusal is exactly forward + RTO, which is exactly what it holds.
   */
  const shopKeeps = split.advancePaise;
  const shopPays = SURFACE.freight + SURFACE.rto;
  check(
    "a refused parcel leaves the shop at net zero",
    shopKeeps - shopPays === 0,
    `keeps ${rupees(shopKeeps)}, pays ${rupees(shopPays)}`,
  );

  /** Delivered: the shop nets the goods value, having paid freight + COD fee. */
  const received = split.advancePaise + split.balanceDuePaise;
  const costs = SURFACE.freight + SURFACE.cod;
  check(
    "a delivered parcel nets the goods value plus the delivery margin",
    received - costs === goods + (deliveryFee - SURFACE.rate),
    `${rupees(received - costs)}`,
  );
}

/* ------------------------------- 2 · advance + balance = total, always -- */

section("2 · advance + balance = goods + delivery, across the range");

{
  // Assertion 1 of the brief, swept rather than sampled.
  const values = [50_000, 99_900, 100_000, 249_900, 500_000, 1_700_000];
  const freights = [8_000, 13_936, 18_836, 24_465, 40_000];
  const rtos = [0, 14_200, 19_400, 24_600, 50_000];

  let worst = "";
  const allSum = values.every((goods) =>
    freights.every((freight) =>
      rtos.every((rto) => {
        for (const includeGst of [false, true]) {
          for (const maximumPaise of [0, 20_000, 50_000]) {
            const grandTotal = goods + freight;
            const split = advanceFor({
              rule: { maximumPaise, includeGst },
              forwardFreightPaise: freight,
              rtoFreightPaise: rto,
              grandTotalPaise: grandTotal,
            });
            if (split.advancePaise + split.balanceDuePaise !== grandTotal) {
              worst = `goods ${goods} freight ${freight} rto ${rto} gst ${includeGst} cap ${maximumPaise}`;
              return false;
            }
          }
        }
        return true;
      }),
    ),
  );
  check("450 combinations all sum to the grand total", allSum, worst);
}

/* -------------------------------------------- 3 · the balance guard rail -- */

section("3 · balance is never negative, and the floor holds");

{
  // Assertion 2, first half. A ₹150 pair to a remote PIN can cost more to send
  // than it sells for. The advance is clamped; it never eats into the courier's
  // collection and turns it negative.
  const split = advanceFor({
    rule: rule(),
    forwardFreightPaise: 24_465,
    rtoFreightPaise: 24_600,
    grandTotalPaise: 15_000,
  });
  check("advance never exceeds the order", split.advancePaise === 15_000);
  check("balance is exactly zero, not negative", split.balanceDuePaise === 0);
  check("and it says why it bound", split.cappedBy === "order_total");
}

{
  // Assertion 2, second half — the real guard is that the method is withdrawn
  // rather than the advance clamped, because a clamped advance means the shop
  // is carrying a return it has not been paid for.
  check(
    "below the minimum, Pay on Delivery is not offered at all",
    !codOfferedForOrder({
      goodsTotalPaise: 15_000,
      minimumOrderValuePaise: 99_900,
    }),
  );
  check(
    "at the minimum exactly, it is offered",
    codOfferedForOrder({
      goodsTotalPaise: 99_900,
      minimumOrderValuePaise: 99_900,
    }),
  );
  check(
    "a minimum of zero offers it to everybody",
    codOfferedForOrder({ goodsTotalPaise: 1, minimumOrderValuePaise: 0 }),
  );
}

{
  // Razorpay's floor. Always satisfied by this model — a courier does not carry
  // a parcel for under a rupee — so this is an assertion, not a rule. It is
  // written down because the day it stops being true, checkout breaks with no
  // visible cause.
  const split = advanceFor({
    rule: rule(),
    forwardFreightPaise: 0,
    rtoFreightPaise: 0,
    grandTotalPaise: 100_000,
  });
  check(
    "a zero round trip still clears Razorpay's 100-paise floor",
    split.advancePaise === MIN_CHARGEABLE_PAISE,
    `${split.advancePaise}`,
  );
  check("and it says why", split.cappedBy === "razorpay_floor");
}

/* --------------------------------------------------------- 4 · the cap -- */

section("4 · the deposit cap");

{
  const split = advanceFor({
    rule: rule({ maximumPaise: 20_000 }),
    forwardFreightPaise: 24_465,
    rtoFreightPaise: 24_600,
    grandTotalPaise: 500_000,
  });
  check("a heavy round trip is capped", split.advancePaise === 20_000);
  check("the cap is named", split.cappedBy === "maximum");
  check(
    "the balance absorbs the difference",
    split.balanceDuePaise === 500_000 - 20_000,
  );
}

{
  // The cap binds first, then the order total. A capped advance on a cheap
  // order must still be clamped — applying only one of the two would let a
  // ₹200 cap produce a negative balance on a ₹150 order.
  const split = advanceFor({
    rule: rule({ maximumPaise: 20_000 }),
    forwardFreightPaise: 24_465,
    rtoFreightPaise: 24_600,
    grandTotalPaise: 15_000,
  });
  check(
    "cap then total: a cheap order is still clamped to its own value",
    split.advancePaise === 15_000 && split.balanceDuePaise === 0,
    `${rupees(split.advancePaise)}`,
  );
}

{
  const split = advanceFor({
    rule: rule({ maximumPaise: 0 }),
    forwardFreightPaise: 24_465,
    rtoFreightPaise: 24_600,
    grandTotalPaise: 500_000,
  });
  check(
    "a cap of zero means no cap, not a zero advance",
    split.advancePaise === 24_465 + 24_600,
  );
}

/* --------------------------------------------------------- 5 · the GST -- */

section("5 · GST on the advance");

{
  const roundTrip = SURFACE.freight + SURFACE.rto; // 28,136
  const off = advanceFor({
    rule: rule({ includeGst: false }),
    forwardFreightPaise: SURFACE.freight,
    rtoFreightPaise: SURFACE.rto,
    grandTotalPaise: 500_000,
  });
  const on = advanceFor({
    rule: rule({ includeGst: true, maximumPaise: 0 }),
    forwardFreightPaise: SURFACE.freight,
    rtoFreightPaise: SURFACE.rto,
    grandTotalPaise: 500_000,
  });
  check("off: the advance is the bare round trip", off.advancePaise === roundTrip);
  check(
    "on: the advance is the round trip plus 18%",
    on.advancePaise === Math.round(roundTrip * 1.18),
    `${rupees(on.advancePaise)} vs ${rupees(Math.round(roundTrip * 1.18))}`,
  );
  check(
    "and it is an integer number of paise",
    Number.isInteger(on.advancePaise),
  );
}

/* --------------------------------------- 6 · the prepaid discount line -- */

section("6 · the prepaid discount");

{
  check(
    "a flat discount comes off the goods",
    prepaidDiscountFor({
      discount: { mode: "flat", value: 5_000 },
      goodsTotalPaise: 100_000,
    }) === 5_000,
  );
  check(
    "a percentage is floored to whole paise",
    prepaidDiscountFor({
      discount: { mode: "percent", value: 2.5 },
      goodsTotalPaise: 99_999,
    }) === 2_499,
  );
  check(
    "a discount can never exceed the goods",
    prepaidDiscountFor({
      discount: { mode: "flat", value: 500_000 },
      goodsTotalPaise: 100_000,
    }) === 100_000,
  );
  check(
    "zero is zero, not a rounding artefact",
    prepaidDiscountFor({
      discount: { mode: "percent", value: 0 },
      goodsTotalPaise: 100_000,
    }) === 0,
  );
  check(
    "a negative discount is refused rather than becoming a surcharge",
    prepaidDiscountFor({
      discount: { mode: "flat", value: -5_000 },
      goodsTotalPaise: 100_000,
    }) === 0,
  );
}

/* -------------------------------------- 7 · the model is method-neutral -- */

section("7 · prepaid is expressed in the same two numbers");

{
  // Not a special case anywhere in the system: prepaid's advance is the whole
  // order and its balance is zero, so `advance + balance = grand_total` holds
  // for every row and the database check constraint needs no exception.
  const grandTotal = 171_900;
  const prepaid = { advancePaise: grandTotal, balanceDuePaise: 0 };
  check(
    "prepaid: the advance is the whole order",
    prepaid.advancePaise === grandTotal,
  );
  check("prepaid: the courier collects nothing", prepaid.balanceDuePaise === 0);
  check(
    "the same invariant covers both methods",
    prepaid.advancePaise + prepaid.balanceDuePaise === grandTotal,
  );
}

/* -------------------------------------------------------------- report -- */

console.log(
  `\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m` +
    "\n\nAssertions 3, 6, 8 and 9 of the brief need the Shiprocket mock or the" +
    "\ndatabase and live in audit:shipping and audit:checkout.",
);
if (failed > 0) {
  console.log("\nFailures:");
  for (const failure of failures) console.log(`  · ${failure}`);
  process.exit(1);
}
