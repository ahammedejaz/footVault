/**
 * `npm run audit:delivery-estimate` — the date arithmetic matches the words.
 *
 * The defect this guards against is not a missing feature, it is a sentence and
 * a calculation disagreeing: the checkout said *"after dispatch"* while the
 * number under it counted from the moment of ordering. So every case below is
 * about **when the clock starts**, and the pair either side of 11:00 is the
 * point of the whole file.
 *
 * ## What it would look like if this were broken
 *
 * Asserting "an estimate comes back" would pass with the cutoff ignored
 * entirely — the shape is identical either way, only the date differs by one.
 * So the assertions are on *specific dates*, computed by hand in the test
 * names, and the 10:59/11:00 pair is asserted to differ by exactly one day. A
 * change that dropped the cutoff would still return a well-formed estimate and
 * would fail here.
 *
 * Timezone handling gets the same treatment. An hours-based bug is invisible if
 * every fixture is at midday UTC, so the fixtures deliberately sit either side
 * of the IST/UTC date boundary — 23:30 IST is 18:00 UTC the same day, and
 * 00:30 IST is 19:00 UTC the *previous* day.
 *
 * No browser, no network.
 */

import {
  PICKUP_CUTOFF_HOUR_IST,
  deliveryEstimate,
  describeCutoff,
  describeEstimate,
  formatEstimateDate,
} from "../../src/lib/shipping/estimate";

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

/** An instant, given an IST wall-clock time. IST is UTC+5:30. */
function ist(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - 330 * 60_000);
}

/** The IST calendar date of an estimate field, as YYYY-MM-DD, for assertions. */
function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/* ------------------------------------------------------- 1 · the cutoff -- */

console.log("\n\x1b[1m1 · the 11:00 pickup cutoff\x1b[0m");

const before = deliveryEstimate({
  days: 4,
  placedAt: ist(2026, 8, 10, PICKUP_CUTOFF_HOUR_IST - 1, 59),
});
const after = deliveryEstimate({
  days: 4,
  placedAt: ist(2026, 8, 10, PICKUP_CUTOFF_HOUR_IST, 0),
});

check(
  "10:59 dispatches the same day",
  before.known && iso(before.dispatchDate) === "2026-08-10",
  before.known ? iso(before.dispatchDate) : "unknown",
);
check(
  "11:00 dispatches the next day",
  after.known && iso(after.dispatchDate) === "2026-08-11",
  after.known ? iso(after.dispatchDate) : "unknown",
);
check(
  "one minute across the cutoff moves arrival by exactly one day",
  before.known &&
    after.known &&
    (after.earliest.getTime() - before.earliest.getTime()) / 86_400_000 === 1,
  before.known && after.known
    ? `${iso(before.earliest)} → ${iso(after.earliest)}`
    : "unknown",
);
check(
  "only the late one reports missing the cutoff",
  before.known && after.known && !before.missedCutoff && after.missedCutoff,
);

/**
 * The owner's worked example, and the sentence that started this: an order
 * placed at 14:00 does not start its clock today.
 */
const afternoon = deliveryEstimate({
  days: 4,
  placedAt: ist(2026, 8, 10, 14, 0),
});
check(
  "Monday 14:00 + 4 days arrives from the 15th, not the 14th",
  afternoon.known && iso(afternoon.earliest) === "2026-08-15",
  afternoon.known ? iso(afternoon.earliest) : "unknown",
);

/* ------------------------------------------------ 2 · the real lanes ----- */

console.log("\n\x1b[1m2 · the lanes the brief named\x1b[0m");

const lanes: { place: string; days: number; expected: string }[] = [
  { place: "Delhi", days: 7, expected: "2026-08-17" },
  { place: "Hyderabad", days: 4, expected: "2026-08-14" },
  { place: "Bangalore", days: 4, expected: "2026-08-14" },
  { place: "Cuddapah (local)", days: 3, expected: "2026-08-13" },
];

for (const lane of lanes) {
  const estimate = deliveryEstimate({
    days: lane.days,
    placedAt: ist(2026, 8, 10, 9, 0),
  });
  check(
    `${lane.place}: ${lane.days} days from a 09:00 order`,
    estimate.known && iso(estimate.earliest) === lane.expected,
    estimate.known ? iso(estimate.earliest) : "unknown",
  );
}

check(
  "Delhi and Bangalore do not get the same answer",
  (() => {
    const delhi = deliveryEstimate({ days: 7, placedAt: ist(2026, 8, 10, 9) });
    const blr = deliveryEstimate({ days: 4, placedAt: ist(2026, 8, 10, 9) });
    return delhi.known && blr.known && iso(delhi.earliest) !== iso(blr.earliest);
  })(),
  "the whole point — one number for every destination was the defect",
);

/* --------------------------------------------- 3 · the timezone edges ---- */

console.log("\n\x1b[1m3 · IST calendar days, not UTC ones\x1b[0m");

/**
 * 23:30 IST on the 10th is 18:00 UTC on the 10th — same UTC date, so a naive
 * implementation happens to be right here.
 */
const lateEvening = deliveryEstimate({
  days: 3,
  placedAt: ist(2026, 8, 10, 23, 30),
});
check(
  "23:30 IST is still the 10th in IST",
  lateEvening.known && iso(lateEvening.dispatchDate) === "2026-08-11",
  lateEvening.known ? `dispatch ${iso(lateEvening.dispatchDate)}` : "unknown",
);

/**
 * 00:30 IST on the 11th is **19:00 UTC on the 10th** — a different UTC date.
 * This is the case that catches an implementation working in UTC days: it would
 * call this the 10th and dispatch a day early.
 */
const afterMidnight = deliveryEstimate({
  days: 3,
  placedAt: ist(2026, 8, 11, 0, 30),
});
check(
  "00:30 IST on the 11th is the 11th, not the 10th",
  afterMidnight.known && iso(afterMidnight.dispatchDate) === "2026-08-11",
  afterMidnight.known
    ? `dispatch ${iso(afterMidnight.dispatchDate)} (placed 19:00 UTC on the 10th)`
    : "unknown",
);
check(
  "and it is before the cutoff, so it goes out that morning",
  afterMidnight.known && !afterMidnight.missedCutoff,
);

check(
  "a formatted date reads back the day that was computed",
  formatEstimateDate(new Date(Date.UTC(2026, 7, 15))).includes("15"),
  formatEstimateDate(new Date(Date.UTC(2026, 7, 15))),
);

/* ------------------------------------------ 4 · honest about not knowing -- */

console.log("\n\x1b[1m4 · no number when there is no answer\x1b[0m");

for (const [label, days] of [
  ["a lookup that did not answer", null],
  ["a nonsense zero", 0],
  ["a negative", -3],
] as const) {
  const estimate = deliveryEstimate({ days, placedAt: ist(2026, 8, 10, 9) });
  check(`${label} produces no date`, !estimate.known);
}

const vague = describeEstimate({ known: false, reason: "noQuote" });
check(
  "the no-quote sentence contains no number at all",
  !/\d/.test(vague),
  `"${vague}"`,
);
check(
  "and it does not claim a range either",
  !/day|week/i.test(vague.replace(/dispatched/i, "")),
  "honest vagueness, not a quieter guess",
);

const noPin = describeEstimate({ known: false, reason: "noPin" });
check(
  "not knowing the destination asks for one rather than guessing",
  !/\d/.test(noPin) && /pin code/i.test(noPin),
  `"${noPin}"`,
);

/* --------------------------------------------------------- 5 · the copy -- */

console.log("\n\x1b[1m5 · what the customer actually reads\x1b[0m");

const sentence = describeEstimate(afternoon);
check(
  "a known estimate names dates rather than a count of days",
  /Arriving/.test(sentence) && !/\bdays\b/.test(sentence),
  `"${sentence}"`,
);

const cutoffNote = describeCutoff(afternoon);
check(
  "an order past the cutoff explains why dispatch is tomorrow",
  cutoffNote !== null && cutoffNote.includes(String(PICKUP_CUTOFF_HOUR_IST)),
  cutoffNote ?? "(none)",
);
check(
  "an order before the cutoff says nothing about it",
  describeCutoff(before) === null,
  "no explanation is needed when nothing surprising happened",
);

/* --------------------------------------------------------------- report -- */

console.log(
  failed === 0
    ? `\n\x1b[1m\x1b[32mdelivery-estimate: ${passed} checks, all green.\x1b[0m\n`
    : `\n\x1b[1m\x1b[31mdelivery-estimate: ${failed} of ${passed + failed} checks failed.\x1b[0m\n`,
);
if (failed > 0) process.exit(1);
