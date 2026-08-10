/**
 * When the parcel actually arrives, said the same way everywhere.
 *
 * ## The problem
 *
 * The shop told every customer "about 4 days". The real figures from the live
 * serviceability response are Delhi 7, Hyderabad and Bangalore 4, Cuddapah
 * local 3 — and the correct number was already in the response the shop fetches
 * on every quote. It simply was not shown on most surfaces, and where it was
 * shown it was expressed as *"about 4 days after dispatch"*, which quietly
 * pushes the hardest part of the question onto the customer: **when is
 * dispatch?**
 *
 * ## The cutoff, which is the whole reason this is a module
 *
 * Pickup is at 11:00. An order placed at 14:00 does not start its clock today —
 * it is picked up tomorrow. So "4 days" placed on Monday afternoon is Friday,
 * not Thursday, and the copy already said *"after dispatch"* while the
 * arithmetic behind it counted from the moment of ordering. Saying "after
 * dispatch" and then not modelling dispatch is the specific defect here: the
 * words were right and the number under them was not.
 *
 * Every surface that promises a date resolves it here, so the checkout, the
 * confirmation and the account page cannot drift apart — which is the same
 * discipline `computeOrderTotals` applies to money.
 *
 * ## What is deliberately not modelled
 *
 * **Holidays and weekends.** Shiprocket's `estimated_delivery_days` is a
 * calendar-day figure produced by the courier that will actually carry the
 * parcel, and it already reflects that courier's own working pattern on that
 * lane. Layering a second working-day calculation on top would be this codebase
 * inventing a number rather than reading one — the exact habit that produced
 * "about 4 days". The one thing modelled is the cutoff, because that is *our*
 * operational fact rather than the courier's, and nothing else knows it.
 *
 * A range rather than a single day is also deliberate. A courier's estimate is
 * a median, not a promise, and a shop that names one date is a shop that gets a
 * phone call on that date.
 */

/**
 * The hour, in IST, after which an order waits for tomorrow's pickup.
 *
 * The owner's figure. It lives here rather than in `site_settings` because it
 * is not a price and nothing on any screen edits it; if the pickup slot ever
 * moves, this is the one line, and `audit:delivery-estimate` covers the
 * boundary either side of it.
 */
export const PICKUP_CUTOFF_HOUR_IST = 11;

/** Widen the courier's median into a range, because a median is not a promise. */
const RANGE_PADDING_DAYS = 1;

export type DeliveryEstimate =
  | {
      known: true;
      /** Local IST calendar date the parcel is handed to the courier. */
      dispatchDate: Date;
      /** Earliest and latest plausible arrival, inclusive. */
      earliest: Date;
      latest: Date;
      /** True when the order missed today's pickup. */
      missedCutoff: boolean;
    }
  | {
      known: false;
      /**
       * Why there is no date. The caller renders honest vagueness rather than a
       * precise figure that is wrong — `noQuote` is a live-lookup failure,
       * `noPin` is simply not knowing where it is going yet.
       */
      reason: "noQuote" | "noPin";
    };

/**
 * The IST calendar date of an instant, as a UTC-midnight `Date`.
 *
 * Working in "IST calendar days" rather than in instants is what stops an order
 * placed at 23:30 IST on the 3rd being reported as the 3rd in Delhi and the 4th
 * in London. `Date` has no timezone-aware arithmetic, so the shift is done
 * explicitly and the result is only ever formatted with `timeZone: "UTC"` by
 * `formatEstimateDate` — treating it as a *calendar date* rather than a moment.
 */
function istCalendarDate(at: Date): Date {
  const IST_OFFSET_MINUTES = 330;
  const shifted = new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000);
  return new Date(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    ),
  );
}

/** The IST hour of an instant, 0–23. */
function istHour(at: Date): number {
  const IST_OFFSET_MINUTES = 330;
  return new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000).getUTCHours();
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/**
 * Work out when a parcel ordered at `placedAt` should arrive.
 *
 * `days` is Shiprocket's own figure for this lane, or null when the lookup did
 * not answer. Null in means "unknown" out — never a default, because a default
 * here is a promise the shop has not checked.
 */
export function deliveryEstimate(input: {
  days: number | null;
  placedAt: Date;
}): DeliveryEstimate {
  if (input.days === null || !Number.isFinite(input.days) || input.days <= 0) {
    return { known: false, reason: "noQuote" };
  }

  const placedDate = istCalendarDate(input.placedAt);
  const missedCutoff = istHour(input.placedAt) >= PICKUP_CUTOFF_HOUR_IST;
  const dispatchDate = missedCutoff ? addDays(placedDate, 1) : placedDate;

  const earliest = addDays(dispatchDate, Math.round(input.days));
  const latest = addDays(earliest, RANGE_PADDING_DAYS);

  return { known: true, dispatchDate, earliest, latest, missedCutoff };
}

/**
 * `Asia/Kolkata` is deliberately **not** used here.
 *
 * The dates produced above are already IST calendar dates carried as
 * UTC-midnight instants. Formatting one in `Asia/Kolkata` would add another
 * five and a half hours and roll every date forward by one. Formatting in UTC
 * reads back exactly the calendar date that was computed — this is the one
 * place in the codebase where UTC is the correct zone, and the reason is that
 * the value is a date rather than a moment.
 */
const ESTIMATE_DATE = new Intl.DateTimeFormat("en-IN", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

export function formatEstimateDate(date: Date): string {
  return ESTIMATE_DATE.format(date);
}

/**
 * The sentence a customer reads, from an estimate.
 *
 * One function so the checkout, the confirmation and the account page cannot
 * word it three ways — and so the honest-vagueness cases are written once,
 * where they can be read next to the confident one.
 */
export function describeEstimate(estimate: DeliveryEstimate): string {
  if (!estimate.known) {
    return estimate.reason === "noPin"
      ? "Enter a pin code and we will tell you when it arrives."
      : // Deliberately no number. A courier lookup that did not answer is not a
        // reason to guess; it is a reason to say we will confirm.
        "We could not reach the courier for a date just now. We will confirm it when your parcel is dispatched.";
  }

  return `Arriving ${formatEstimateDate(estimate.earliest)} – ${formatEstimateDate(estimate.latest)}`;
}

/** Why dispatch is tomorrow, for the surfaces with room to explain. */
export function describeCutoff(estimate: DeliveryEstimate): string | null {
  if (!estimate.known || !estimate.missedCutoff) return null;
  return `Orders after ${PICKUP_CUTOFF_HOUR_IST}:00 are collected the next day, so this one is dispatched ${formatEstimateDate(estimate.dispatchDate)}.`;
}
