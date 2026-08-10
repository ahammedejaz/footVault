/**
 * `npm run audit:delivery` — the owner's five delivery decisions, proved.
 *
 * Batch 2 changed what a customer is charged, and every one of those changes is
 * the kind that fails silently. A COD fee that keeps being charged when it
 * should not is a rupee figure on a receipt nobody reads; a COD fee that stops
 * being charged is margin gone with no error anywhere. So each decision below is
 * pinned to an assertion, named after the decision, and one of them is pinned to
 * a real order number.
 *
 * The decisions, as given on 2026-08-09:
 *
 *   **2** — the free-delivery threshold applies to Pay on Delivery as well as
 *           prepaid. That it did not was the original bug.
 *   **3** — `waive_cod_fee_above_threshold = false`: keep charging the
 *           cash-handling fee even when delivery is free.
 *   **4** — `fallback_behaviour = refuse_cod`: no live quote, no cash order.
 *           Prepaid goes through, labelled an estimate.
 *   **6** — a flat delivery fee with a toggle, making no Shiprocket call, whose
 *           Pay-on-Delivery deposit is configured rather than assumed.
 *   **9** — `codHandlingPaise` is Shiprocket's `cod_charges` or zero, never
 *           derived from fee constants.
 *
 * Pure: no database, no browser, no Shiprocket. `deliveryFee` takes a verdict
 * and a settings object and returns a fee, so every branch is reachable by
 * constructing the two inputs — including the branches a live account would not
 * produce on demand, like a courier outage during a festival sale.
 *
 * **The rates are real.** Every figure comes from a live serviceability call
 * against this account, Cuddapah 516360 → Bangalore 560001, 1 kg, ₹1,000
 * declared: Delhivery Surface `rate 191.36`, `freight 139.36`, `cod_charges 52`,
 * `rto_charges 142`. Made-up numbers would let a rounding rule pass that a real
 * rate breaks.
 */

import {
  advanceForFlat,
  flatModeDepositPaise,
  type FlatDepositRule,
} from "../../src/lib/payments/advance";
import { codWithheldFor } from "../../src/lib/orders/totals";
import { readFileSync } from "node:fs";

import { deliveryFee } from "../../src/lib/shipping/fee";
import {
  FLAT_SERVICEABILITY,
  UNKNOWN_SERVICEABILITY,
  type ServiceabilityVerdict,
} from "../../src/lib/shipping/serviceability";
import type { ShippingSettings } from "../../src/lib/shipping/settings";

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

/** Delhivery Surface on the tested lane, in paise. */
const SURFACE = { rate: 19_136, freight: 13_936, cod: 5_200, rto: 14_200 };

/** The free-delivery threshold as the owner has it today: ₹6,499. */
const FREE_ABOVE = 649_900;

function live(over: Partial<ServiceabilityVerdict> = {}): ServiceabilityVerdict {
  return {
    ...UNKNOWN_SERVICEABILITY,
    source: "shiprocket",
    deliverable: true,
    codAvailable: true,
    forwardCostPaise: SURFACE.rate,
    freightPaise: SURFACE.freight,
    codFeePaise: SURFACE.cod,
    rtoCostPaise: SURFACE.rto,
    courierName: "Delhivery Surface",
    courierId: 12,
    estimatedDays: 4,
    ...over,
  };
}

/**
 * Settings as the owner set them on 2026-08-09.
 *
 * Written out rather than read from the database on purpose: this file has to
 * keep proving the rule after somebody edits the live row, and a test that reads
 * production settings passes for whatever the settings happen to say.
 */
function settings(over: Partial<ShippingSettings> = {}): ShippingSettings {
  return {
    freeAbovePaise: FREE_ABOVE,
    prepaidEstimateFeePaise: 19_900,
    codEnabled: true,
    courierSelectionMode: "shiprocket" as const,
    courierPriceTolerancePercent: null,
    codMinimumOrderValuePaise: 99_900,
    codAdvanceMaximumPaise: 50_000,
    includeGstInAdvance: false,
    prepaidDiscount: { mode: "flat", value: 0 },
    maxTotalDiscountPercent: null,
    shippingRateMode: "live",
    flatShippingFeePaise: 0,
    flatCodDeposit: { mode: "unset" },
    waiveCodFeeAboveThreshold: false,
    fallbackBehaviour: "refuse_cod",
    rtoDeductionPolicy: "actual_freight",
    rtoDeductionFlatPaise: 0,
    walletLowBalancePaise: null,
    ...over,
  };
}

/* ------------------------------------ 2 · free delivery reaches cash ------ */

section("decision 2 · the free threshold applies to Pay on Delivery too");
{
  const above = 700_000;

  const prepaid = deliveryFee({
    method: "razorpay",
    subtotalPaise: above,
    verdict: live(),
    settings: settings(),
  });
  const cod = deliveryFee({
    method: "cod",
    subtotalPaise: above,
    verdict: live(),
    settings: settings(),
  });

  check(
    "prepaid above the threshold pays nothing to have it delivered",
    prepaid.shippingFeePaise === 0 && prepaid.feePaise === 0,
    rupees(prepaid.feePaise),
  );
  check(
    "Pay on Delivery above the threshold also pays nothing for the delivery",
    cod.shippingFeePaise === 0,
    rupees(cod.shippingFeePaise),
  );
  check(
    "both are recorded as free rather than as a courier rate",
    prepaid.basis === "free" && cod.basis === "free",
    `${prepaid.basis} / ${cod.basis}`,
  );

  /**
   * The regression, stated as the bug rather than as the fix.
   *
   * Before Batch 2 the free branch was gated `!isCod`, so this same order paid
   * the full ₹200 rounded courier rate while an identical card order paid
   * nothing — and no line on the page explained the difference.
   */
  check(
    "the old bug is gone: a cash order is no longer charged full freight above the threshold",
    cod.shippingFeePaise < 20_000,
    `charged ${rupees(cod.shippingFeePaise)} for the forward leg`,
  );

  const below = deliveryFee({
    method: "cod",
    subtotalPaise: 500_000,
    verdict: live(),
    settings: settings(),
  });
  check(
    "below the threshold a cash order still pays the live rate, rounded up to ₹10",
    below.feePaise === 20_000 && below.basis === "live",
    `${rupees(below.feePaise)} / ${below.basis}`,
  );

  const disabled = deliveryFee({
    method: "cod",
    subtotalPaise: 10_000_000,
    verdict: live(),
    settings: settings({ freeAbovePaise: 0 }),
  });
  check(
    "a threshold of zero disables the free tier rather than making everything free",
    disabled.basis === "live" && disabled.feePaise === 20_000,
    `${disabled.basis} / ${rupees(disabled.feePaise)}`,
  );
}

/* --------------------------- 3 · the cash-handling fee survives free ------ */

section("decision 3 · free delivery does not waive the cash-handling fee");
{
  const cod = deliveryFee({
    method: "cod",
    subtotalPaise: 700_000,
    verdict: live(),
    settings: settings(),
  });

  check(
    "the cash-handling fee is still charged on a free delivery",
    cod.codHandlingPaise === SURFACE.cod,
    `${rupees(cod.codHandlingPaise)}, expected ${rupees(SURFACE.cod)}`,
  );
  check(
    "and it is the whole of what the customer pays for delivery",
    cod.feePaise === SURFACE.cod,
    rupees(cod.feePaise),
  );
  check(
    "so it can be drawn as its own line: shipping + handling = total",
    cod.shippingFeePaise + cod.codHandlingPaise === cod.feePaise,
  );

  const prepaid = deliveryFee({
    method: "razorpay",
    subtotalPaise: 700_000,
    verdict: live(),
    settings: settings(),
  });
  check(
    "a prepaid order above the threshold pays nothing at all — the reason to prepay",
    prepaid.feePaise === 0 && cod.feePaise > prepaid.feePaise,
    `${rupees(prepaid.feePaise)} against ${rupees(cod.feePaise)}`,
  );

  const waived = deliveryFee({
    method: "cod",
    subtotalPaise: 700_000,
    verdict: live(),
    settings: settings({ waiveCodFeeAboveThreshold: true }),
  });
  check(
    "the toggle is real: turning it on does waive the fee",
    waived.codHandlingPaise === 0 && waived.feePaise === 0,
    rupees(waived.feePaise),
  );
  check(
    "and turning it on does not waive the fee below the threshold",
    deliveryFee({
      method: "cod",
      subtotalPaise: 500_000,
      verdict: live(),
      settings: settings({ waiveCodFeeAboveThreshold: true }),
    }).codHandlingPaise === SURFACE.cod,
  );
}

/* ------------------------------------- 9 · the ₹150 that never existed ---- */

section("decision 9 · the cash-handling line is Shiprocket's, or it is nothing");
{
  /**
   * **FV-2026-00571 carries a ₹150 cash-handling line no courier ever charged.**
   *
   * It came from the old no-quote branch computing
   * `fallback_fee_paise.cod − fallback_fee_paise.razorpay` — ₹349 − ₹199 — and
   * presenting the difference between two numbers the owner typed as though it
   * were `cod_charges`. Both constants are gone from settings, so the
   * subtraction has nothing left to work with; this asserts the outcome anyway,
   * because the outcome is what reached a customer.
   */
  const outage = deliveryFee({
    method: "cod",
    subtotalPaise: 149_900,
    verdict: { ...UNKNOWN_SERVICEABILITY, reason: "timeout" },
    settings: settings(),
  });

  check(
    "FV-2026-00571: with no quote the cash-handling line is zero, not ₹150",
    outage.codHandlingPaise === 0,
    `got ${rupees(outage.codHandlingPaise)}`,
  );
  check(
    "and specifically not the ₹150 that order was charged",
    outage.codHandlingPaise !== 15_000,
  );

  const flat = deliveryFee({
    method: "cod",
    subtotalPaise: 149_900,
    verdict: FLAT_SERVICEABILITY,
    settings: settings({ shippingRateMode: "flat", flatShippingFeePaise: 9_900 }),
  });
  check(
    "in flat mode it is zero too — Shiprocket was never asked",
    flat.codHandlingPaise === 0,
    rupees(flat.codHandlingPaise),
  );

  check(
    "when Shiprocket does answer, the line is exactly its cod_charges",
    deliveryFee({
      method: "cod",
      subtotalPaise: 149_900,
      verdict: live(),
      settings: settings(),
    }).codHandlingPaise === SURFACE.cod,
  );

  /**
   * The fee is rounded once on the total and the named line carries the
   * remainder, so the split can never round the customer upwards twice.
   */
  const rounded = deliveryFee({
    method: "cod",
    subtotalPaise: 149_900,
    verdict: live(),
    settings: settings(),
  });
  check(
    "the total is rounded, the split is not: 139.36 + 52.00 → ₹200.00, of which ₹52.00",
    rounded.feePaise === 20_000 &&
      rounded.codHandlingPaise === 5_200 &&
      rounded.shippingFeePaise === 14_800,
    `${rupees(rounded.feePaise)} = ${rupees(rounded.shippingFeePaise)} + ${rupees(rounded.codHandlingPaise)}`,
  );

  check(
    "a prepaid order never carries a cash-handling line at all",
    deliveryFee({
      method: "razorpay",
      subtotalPaise: 149_900,
      verdict: live(),
      settings: settings(),
    }).codHandlingPaise === 0,
  );

  /**
   * A courier that answers without `cod_charges` is not an invitation to
   * estimate one. The customer pays the rounded rate and the shop absorbs
   * whatever the collection cost turns out to be.
   */
  check(
    "a quote missing cod_charges produces no line rather than a guessed one",
    deliveryFee({
      method: "cod",
      subtotalPaise: 149_900,
      verdict: live({ codFeePaise: null }),
      settings: settings(),
    }).codHandlingPaise === 0,
  );
}

/* --------------------------------------------- 6 · the flat-fee toggle ---- */

section("decision 6 · the flat delivery fee, and the deposit behind it");
{
  const flatSettings = settings({
    shippingRateMode: "flat",
    flatShippingFeePaise: 9_900,
  });

  const flat = deliveryFee({
    method: "razorpay",
    subtotalPaise: 149_900,
    verdict: FLAT_SERVICEABILITY,
    settings: flatSettings,
  });

  check(
    "flat mode charges the configured fee and nothing else",
    flat.feePaise === 9_900 && flat.shippingFeePaise === 9_900,
    rupees(flat.feePaise),
  );
  check("and records itself as flat, not as a courier rate", flat.basis === "flat");
  check(
    "the mode is frozen onto the quote so an order can say which regime priced it",
    flat.rateMode === "flat",
  );
  check(
    "a live quote freezes the other one",
    deliveryFee({
      method: "razorpay",
      subtotalPaise: 149_900,
      verdict: live(),
      settings: settings(),
    }).rateMode === "live",
  );
  check(
    "flat mode carries no courier costs, because none were fetched",
    flat.costForwardPaise === null && flat.costRtoPaise === null,
  );

  check(
    "free delivery still beats the flat fee — a promise outranks a price",
    deliveryFee({
      method: "razorpay",
      subtotalPaise: 700_000,
      verdict: FLAT_SERVICEABILITY,
      settings: flatSettings,
    }).feePaise === 0,
  );

  /* ---- the deposit rule ---- */

  const deposit = (rule: FlatDepositRule, fee = 9_900) =>
    flatModeDepositPaise({ rule, flatShippingFeePaise: fee });

  check(
    "unset returns null — never a number, never zero",
    deposit({ mode: "unset" }) === null,
  );
  check(
    "a multiplier of 2 against a ₹99 flat fee deposits ₹198 — one journey each way",
    deposit({ mode: "multiplier", multiplier: 2 }) === 19_800,
    String(deposit({ mode: "multiplier", multiplier: 2 })),
  );
  check(
    "a fixed deposit is taken as typed",
    deposit({ mode: "fixed", paise: 25_000 }) === 25_000,
  );
  check(
    "a multiplier against a flat fee of zero is nothing, so it returns null",
    deposit({ mode: "multiplier", multiplier: 2 }, 0) === null,
  );

  /**
   * The whole point of the rule: **no path collects nothing.** A deposit of a
   * rupee against a ₹281 round trip is order FV-2026-00488 arrived at by
   * configuration instead of by code.
   */
  const secured = advanceForFlat({
    rule: { maximumPaise: 50_000, includeGst: false },
    depositPaise: 19_800,
    grandTotalPaise: 159_800,
  });
  check(
    "a flat-mode cash order is secured by a real deposit, not by ₹1",
    secured.advancePaise >= 19_800,
    rupees(secured.advancePaise),
  );
  check(
    "the balance still lands on a whole rupee so the courier can collect it",
    secured.balanceDuePaise % 100 === 0,
    rupees(secured.balanceDuePaise),
  );
  check(
    "and advance + balance is still exactly the order total",
    secured.advancePaise + secured.balanceDuePaise === 159_800,
  );

  /**
   * GST is not applied to a flat deposit. `includeGstInAdvance` exists to
   * recover the tax Shiprocket adds to a freight bill, and a figure the owner
   * typed never carried one — inflating it would charge tax on a tax that does
   * not exist.
   */
  check(
    "GST is not added to a deposit the owner typed",
    advanceForFlat({
      rule: { maximumPaise: 0, includeGst: true },
      depositPaise: 20_000,
      grandTotalPaise: 300_000,
    }).advancePaise === 20_000,
  );
  check(
    "the cap still binds a flat deposit",
    advanceForFlat({
      rule: { maximumPaise: 15_000, includeGst: false },
      depositPaise: 40_000,
      grandTotalPaise: 300_000,
    }).cappedBy === "maximum",
  );
}

/* ------------------------------- 4 · no live quote, no Pay on Delivery ---- */

section("decision 4 · refuse_cod, and the flat-mode trap it must not spring");
{
  const outage = deliveryFee({
    method: "razorpay",
    subtotalPaise: 149_900,
    verdict: { ...UNKNOWN_SERVICEABILITY, reason: "timeout" },
    settings: settings(),
  });

  check(
    "prepaid still sells during a courier outage",
    outage.feePaise === 19_900,
    rupees(outage.feePaise),
  );
  check(
    "and it is marked unavailable, so the checkout can label it an estimate",
    outage.basis === "unavailable",
    outage.basis,
  );

  /**
   * **The interaction this section exists for.**
   *
   * Flat mode and a courier outage both mean "there is no rate from Shiprocket",
   * and they must not share a code path. `refuse_cod` withdraws Pay on Delivery
   * on an outage — but flat mode has no quote *by the owner's choice*, and if it
   * were routed through the same branch then switching to a festival price would
   * silently switch off Pay on Delivery for the whole shop. A pricing toggle
   * causing a business outage is the failure this asserts against.
   */
  const flat = deliveryFee({
    method: "cod",
    subtotalPaise: 149_900,
    verdict: FLAT_SERVICEABILITY,
    settings: settings({ shippingRateMode: "flat", flatShippingFeePaise: 9_900 }),
  });
  /*
    Compared through widened bindings. Against the literals directly TypeScript
    narrows both sides and reduces the comparison to a constant — a test that
    passes because it cannot fail, which is worse than no test at all.
  */
  const flatBasis: string = flat.basis;
  const outageBasis: string = outage.basis;
  check("flat mode reports itself as flat", flatBasis === "flat", flatBasis);
  check(
    "and not as an unavailable quote, so a festival price is never mistaken for a courier outage",
    flatBasis !== outageBasis && outageBasis === "unavailable",
    `flat=${flatBasis} outage=${outageBasis}`,
  );

  /**
   * A courier that answers but quotes nobody is an outage, not a rate. The
   * source says we reached Shiprocket; it does not say Shiprocket gave us a
   * number, and a null rate priced as a live one would be free delivery.
   */
  check(
    "a Shiprocket answer with no rate in it is unavailable, not live",
    deliveryFee({
      method: "razorpay",
      subtotalPaise: 149_900,
      verdict: live({ forwardCostPaise: null }),
      settings: settings(),
    }).basis === "unavailable",
  );

  check(
    "an unserviceable route is unavailable rather than free",
    deliveryFee({
      method: "razorpay",
      subtotalPaise: 149_900,
      verdict: {
        ...UNKNOWN_SERVICEABILITY,
        source: "shiprocket",
        deliverable: false,
        codAvailable: false,
        reason: "no courier serves this route",
      },
      settings: settings(),
    }).deliverable === false,
  );
}

/* ------------------------------ 7 · the Pay-on-Delivery toggle, both paths -- */

section("decision 7 · cod_enabled is refused at the API, not just hidden in the UI");
{
  const base = {
    codEnabled: true,
    courierSelectionMode: "shiprocket" as const,
    courierPriceTolerancePercent: null,
    codBlocked: false,
    belowMinimum: false,
    flatMode: false,
    roundTripPaise: 28_136,
    flatDepositPaise: null,
    fallbackBehaviour: "refuse_cod" as const,
    courierTakesCash: true,
  };

  check(
    "with everything in order, Pay on Delivery is offered",
    codWithheldFor(base) === null,
    String(codWithheldFor(base)),
  );

  /**
   * **The API half of the toggle.**
   *
   * The owner's requirement: honoured at the checkout UI *and* refused at the
   * API. The UI hides a method it is told is unavailable; this is the decision
   * the server makes for itself, which is what makes the switch a control rather
   * than a suggestion. `placeOrder` gates on exactly this — see the
   * `method === "cod" && !totals.codAvailable` branch in
   * `src/lib/actions/checkout.ts` — so a request that never rendered the UI is
   * refused the same way.
   */
  check(
    "cod_enabled = false withholds it at the server, whatever the browser sent",
    codWithheldFor({ ...base, codEnabled: false }) === "settings",
    String(codWithheldFor({ ...base, codEnabled: false })),
  );
  check(
    "a customer who has had cash withdrawn is refused for the same reason",
    codWithheldFor({ ...base, codBlocked: true }) === "settings",
  );
  check(
    "and the shop switch wins even when everything else is perfect",
    codWithheldFor({
      ...base,
      codEnabled: false,
      roundTripPaise: 28_136,
      courierTakesCash: true,
    }) === "settings",
  );

  /* ---- the other four reasons, kept apart so the wording can differ ---- */

  check(
    "a basket under the minimum says so — the only one the customer can fix",
    codWithheldFor({ ...base, belowMinimum: true }) === "below_minimum",
  );
  check(
    "and it is not masked by a courier problem they cannot act on",
    codWithheldFor({
      ...base,
      belowMinimum: true,
      courierTakesCash: false,
    }) === "below_minimum",
  );
  check(
    "decision 4: no round trip in live mode withholds it as no_quote",
    codWithheldFor({ ...base, roundTripPaise: null }) === "no_quote",
  );
  check(
    "a PIN where no courier collects cash is its own reason",
    codWithheldFor({ ...base, courierTakesCash: false }) === "courier",
  );

  /**
   * The interaction again, at the layer that acts on it. Flat mode has no round
   * trip and must not be read as an outage — but it still needs a deposit, so it
   * lands on `deposit_unset` rather than being waved through.
   */
  check(
    "flat mode with no deposit configured is deposit_unset, not no_quote",
    codWithheldFor({ ...base, flatMode: true, roundTripPaise: null }) ===
      "deposit_unset",
    String(codWithheldFor({ ...base, flatMode: true, roundTripPaise: null })),
  );
  check(
    "flat mode WITH a deposit offers Pay on Delivery — the festival sale still sells",
    codWithheldFor({
      ...base,
      flatMode: true,
      roundTripPaise: null,
      flatDepositPaise: 19_800,
    }) === null,
  );
  check(
    "allow_all without a deposit is still refused — no path collects nothing",
    codWithheldFor({
      ...base,
      roundTripPaise: null,
      fallbackBehaviour: "allow_all",
    }) === "deposit_unset",
  );
  check(
    "allow_all with a deposit does keep selling through an outage",
    codWithheldFor({
      ...base,
      roundTripPaise: null,
      fallbackBehaviour: "allow_all",
      flatDepositPaise: 19_800,
    }) === null,
  );

  /**
   * **The property, stated as a property rather than as a list of cases.**
   *
   * Every combination of the eight inputs is enumerated and each one that offers
   * Pay on Delivery is checked for something securing it. A new branch added
   * later that forgets a deposit fails here without anybody remembering to write
   * a case for it.
   */
  const bools = [true, false];
  let offered = 0;
  let unsecured: string | null = null;
  for (const codEnabled of bools)
    for (const codBlocked of bools)
      for (const belowMinimum of bools)
        for (const flatMode of bools)
          for (const roundTripPaise of [28_136, null])
            for (const flatDepositPaise of [19_800, null])
              for (const fallbackBehaviour of ["refuse_cod", "allow_all"] as const)
                for (const courierTakesCash of bools) {
                  const args = {
                    codEnabled,
                    codBlocked,
                    belowMinimum,
                    flatMode,
                    roundTripPaise,
                    flatDepositPaise,
                    fallbackBehaviour,
                    courierTakesCash,
                  };
                  if (codWithheldFor(args) !== null) continue;
                  offered += 1;
                  if (roundTripPaise === null && flatDepositPaise === null)
                    unsecured ??= JSON.stringify(args);
                }

  check(
    `all ${offered} accepting combinations have something securing the order`,
    unsecured === null,
    unsecured ? `offered with nothing to collect: ${unsecured}` : "",
  );
}

/* -------------------------------------------------------------- summary -- */

/* ---------------- the courier-call backstop, and how it degrades ---------- */

console.log("\n\x1b[1mThe backstop on courier calls\x1b[0m");

/*
 * `consumeRateLimit` fails open — right for a cart write, wrong here. This is
 * the one limiter in the codebase whose fail-open direction exposes something:
 * every other policy bounds work against Postgres using a counter in Postgres,
 * so an outage removes the guard and the target together. This one guards the
 * Shiprocket quota, which an outage does not touch, from a public Server
 * Action.
 *
 * Two properties, and both are the owner's conditions rather than mine:
 *
 *   the cap must be high enough that no real customer reaches it, and
 *   a trip must degrade to the labelled-estimate path, never to an error —
 *   because a limiter that throws at checkout takes Pay on Delivery away from
 *   somebody who was about to buy something.
 */
{
  const quoteSource = readFileSync("src/lib/shipping/quote.ts", "utf8");
  const capMatch = /COURIER_CALLS_PER_HOUR = (\d+)/.exec(quoteSource);
  const cap = capMatch ? Number(capMatch[1]) : 0;

  check("a per-instance courier budget exists", cap > 0, `${cap}/hour`);
  check(
    "it is far above anything a real shop's customers produce",
    cap >= 300,
    `${cap}/hour is ${Math.round(cap / 60)}/minute sustained`,
  );

  const tripBlock = quoteSource.slice(
    quoteSource.indexOf("if (!withinCourierBudget("),
    quoteSource.indexOf("try {", quoteSource.indexOf("if (!withinCourierBudget(")),
  );
  check(
    "a trip returns a verdict rather than throwing",
    !/throw/.test(tripBlock) && /UNKNOWN_SERVICEABILITY/.test(tripBlock),
  );
  /*
    Read from source rather than imported: `serviceability.ts` is server-only.
    The properties that matter are what the constant *says*, and a gate that
    cannot load the module can still read it.
  */
  const svc = readFileSync("src/lib/shipping/serviceability.ts", "utf8");
  const unknownBlock = svc.slice(
    svc.indexOf("export const UNKNOWN_SERVICEABILITY"),
    svc.indexOf("};", svc.indexOf("export const UNKNOWN_SERVICEABILITY")),
  );
  check(
    "and that verdict is the one a courier outage produces",
    /source:\s*"unknown"/.test(unknownBlock),
  );
  check(
    "so the customer is never told the shop does not deliver there",
    /deliverable:\s*true/.test(unknownBlock),
    "deliverable stays true; only the price becomes an estimate",
  );
  check(
    "the trip is logged loudly, because it should never happen",
    /console\.error\(/.test(tripBlock),
    "either the counter is down or the shop is being scraped",
  );
}

console.log(
  `\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m`,
);
if (failed > 0) {
  console.log("\nFailures:");
  for (const failure of failures) console.log(`  · ${failure}`);
  process.exit(1);
}
