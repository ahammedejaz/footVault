/**
 * `npm run audit:courier-choice` — the shop picks its own courier, on evidence.
 *
 * The finding this comes from: on both lanes tested, **Shiprocket's recommended
 * courier scored worst of the available set on all three metrics.** The fixture
 * below is built to that shape on purpose — the recommendation is the cheapest
 * *and* the worst — so a selector that quietly deferred to either price or the
 * recommendation would be visible here.
 *
 * ## What it would look like if this were broken
 *
 * "A courier came back" is true of every mode and every bug, so nothing asserts
 * that. Each case names **which** courier must win and why, and the modes are
 * asserted to disagree with each other on the same input — a selector that
 * ignored its mode argument would return one courier three times and fail.
 *
 * The unset-tolerance case asserts a *refusal*, not a fallback. A selector that
 * defaulted the missing number to zero would silently become "cheapest", and a
 * test asserting "something sensible came back" would pass while the owner's
 * decision had been made for them.
 */

import {
  chooseCourier,
  courierScore,
  type CourierSelectionMode,
} from "../../src/lib/shipping/courier-choice";
import type { CourierQuote } from "../../src/lib/shipping/serviceability";

let failed = 0;
let passed = 0;

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function courier(over: Partial<CourierQuote> & { id: number; name: string }): CourierQuote {
  return {
    ratePaise: 10000,
    freightPaise: 9000,
    codFeePaise: 1000,
    rtoPaise: 8000,
    days: 4,
    cod: true,
    rating: null,
    slaAdherence: null,
    rtoPerformance: null,
    trackingPerformance: null,
    deliveryPerformance: null,
    excluded: false,
    ...over,
  };
}

/**
 * The observed shape: the recommendation is cheapest and worst on all three.
 * "Sturdy" costs 8% more and is far better rated; "Gold" is better still but
 * 40% more, so it is outside any sane tolerance.
 */
const LANE: CourierQuote[] = [
  courier({
    id: 1,
    name: "Budget Express",
    ratePaise: 10000,
    slaAdherence: 41,
    rtoPerformance: 38,
    trackingPerformance: 44,
  }),
  courier({
    id: 2,
    name: "Sturdy Logistics",
    ratePaise: 10800,
    slaAdherence: 92,
    rtoPerformance: 88,
    trackingPerformance: 90,
  }),
  courier({
    id: 3,
    name: "Gold Courier",
    ratePaise: 14000,
    slaAdherence: 97,
    rtoPerformance: 95,
    trackingPerformance: 96,
  }),
  courier({ id: 4, name: "India Post", ratePaise: 4000, excluded: true }),
];

const RECOMMENDED = 1;

console.log("\n\x1b[1m1 · each mode picks a different courier\x1b[0m");

const results = new Map<CourierSelectionMode, string>();
for (const mode of ["cheapest", "shiprocket", "best_rated"] as const) {
  const choice = chooseCourier({
    couriers: LANE,
    mode,
    tolerancePercent: 10,
    recommendedCourierId: RECOMMENDED,
  });
  results.set(mode, choice.ok ? choice.courier.name : `refused: ${choice.reason}`);
}

check(
  "cheapest takes the cheapest",
  results.get("cheapest") === "Budget Express",
  results.get("cheapest"),
);
check(
  "shiprocket takes the recommendation",
  results.get("shiprocket") === "Budget Express",
  results.get("shiprocket"),
);
check(
  "best_rated takes the well-rated one just above it",
  results.get("best_rated") === "Sturdy Logistics",
  results.get("best_rated"),
);
check(
  "the modes genuinely disagree",
  new Set(results.values()).size > 1,
  "a selector ignoring its mode would return one name three times",
);

console.log("\n\x1b[1m2 · the tolerance is a real ceiling\x1b[0m");

const tight = chooseCourier({
  couriers: LANE,
  mode: "best_rated",
  tolerancePercent: 2,
  recommendedCourierId: RECOMMENDED,
});
check(
  "a 2% tolerance cannot reach the 8%-dearer courier",
  tight.ok && tight.courier.name === "Budget Express",
  tight.ok ? tight.courier.name : "refused",
);

const generous = chooseCourier({
  couriers: LANE,
  mode: "best_rated",
  tolerancePercent: 50,
  recommendedCourierId: RECOMMENDED,
});
check(
  "a 50% tolerance reaches the best of all three",
  generous.ok && generous.courier.name === "Gold Courier",
  generous.ok ? generous.courier.name : "refused",
);

console.log("\n\x1b[1m3 · unset fails loudly, it does not default\x1b[0m");

const unset = chooseCourier({
  couriers: LANE,
  mode: "best_rated",
  tolerancePercent: null,
  recommendedCourierId: RECOMMENDED,
});
check(
  "best_rated with no tolerance refuses",
  !unset.ok && unset.reason === "unset",
  unset.ok ? `picked ${unset.courier.name}` : unset.reason,
);
check(
  "and it does not quietly become cheapest",
  !unset.ok,
  "silently spending the owner's money on a blank form field is the failure",
);
check(
  "the refusal names the setting to fix",
  !unset.ok && /tolerance/i.test(unset.message) && /settings/i.test(unset.message),
  !unset.ok ? unset.message.slice(0, 70) : "",
);

console.log("\n\x1b[1m4 · the awkward lanes\x1b[0m");

const excludedOnly = chooseCourier({
  couriers: [courier({ id: 9, name: "India Post", excluded: true })],
  mode: "cheapest",
  tolerancePercent: 10,
  recommendedCourierId: null,
});
check(
  "a lane of only excluded couriers is a refusal, not a pick",
  !excludedOnly.ok && excludedOnly.reason === "no_couriers",
);

const unrated = chooseCourier({
  couriers: [
    courier({ id: 5, name: "New Co", ratePaise: 10000 }),
    courier({ id: 6, name: "Also New", ratePaise: 11000 }),
  ],
  mode: "best_rated",
  tolerancePercent: 20,
  recommendedCourierId: null,
});
check(
  "when nothing is rated, best_rated takes the cheapest and says so",
  unrated.ok &&
    unrated.courier.name === "New Co" &&
    /not rated|no courier/i.test(unrated.reason),
  unrated.ok ? unrated.reason : "refused",
);

const partial = courierScore(
  courier({ id: 7, name: "Half Known", slaAdherence: 90, rtoPerformance: null, trackingPerformance: null }),
);
check(
  "a partially scored courier averages what is known, not what is missing",
  partial === 90,
  `score ${String(partial)} — treating a missing score as zero would punish a new courier`,
);
check(
  "an entirely unscored courier has no score rather than a zero",
  courierScore(courier({ id: 8, name: "Unknown" })) === null,
);

const tie = chooseCourier({
  couriers: [
    courier({ id: 10, name: "Dearer", ratePaise: 12000, slaAdherence: 90, rtoPerformance: 90, trackingPerformance: 90 }),
    courier({ id: 11, name: "Cheaper", ratePaise: 11000, slaAdherence: 90, rtoPerformance: 90, trackingPerformance: 90 }),
  ],
  mode: "best_rated",
  tolerancePercent: 50,
  recommendedCourierId: null,
});
check(
  "equally rated couriers break the tie on price, not on array order",
  tie.ok && tie.courier.name === "Cheaper",
  tie.ok ? tie.courier.name : "refused",
);

console.log(
  failed === 0
    ? `\n\x1b[1m\x1b[32mcourier-choice: ${passed} checks, all green.\x1b[0m\n`
    : `\n\x1b[1m\x1b[31mcourier-choice: ${failed} of ${passed + failed} checks failed.\x1b[0m\n`,
);
if (failed > 0) process.exit(1);
