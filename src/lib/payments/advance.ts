import { MIN_CHARGEABLE_PAISE } from "@/lib/payments/types";

/**
 * How much of a Pay-on-Delivery order is paid online, and how much at the door.
 *
 * ## The model, in one sentence
 *
 * **The advance is the full round trip — forward freight plus RTO freight —
 * because on a refusal the shop pays both legs.**
 *
 * It is then netted off what the courier collects, so the customer never pays
 * twice:
 *
 * ```
 * advance = forward_freight + rto_freight        quoted live, one courier entry
 * balance = goods_total + delivery_fee − advance
 * ```
 *
 * The customer's total is identical either way; only the timing changes. What
 * changes for the shop is that a refused parcel is already paid for.
 *
 * ### Worked, against real rates from this account
 *
 * Cuddapah 516360 → Bangalore 560001, 1 kg, ₹1,000 declared, Delhivery Surface
 * (`rate: 191.36`, `freight_charge: 139.36`, `cod_charges: 52`,
 * `rto_charges: 142`):
 *
 * | | Amount |
 * |---|---|
 * | Goods | ₹1,000.00 |
 * | Delivery fee the customer pays — the live COD rate | ₹191.36 |
 * | Advance, online now — freight ₹139.36 + RTO ₹142.00 | **₹281.36** |
 * | Balance, collected in cash | **₹910.00** |
 * | Total either way | ₹1,191.36 |
 *
 * **Delivered:** ₹281.36 online + ₹910.00 cash = ₹1,191.36. The shop pays
 * ₹139.36 freight and ₹52 COD fee, and nets ₹1,000 for the goods.
 * **Refused:** the shop keeps ₹281.36 and pays ₹139.36 forward + ₹142 RTO =
 * ₹281.36. Net zero, goods back on the shelf. Shiprocket reverses the COD fee
 * on an RTO, which is exactly why the fee is **not** part of the advance —
 * recovering it would over-collect on the orders the advance exists to protect.
 *
 * ## What replaced what
 *
 * `CodAdvanceMode` — `shipping_fee`, `fixed`, `greater_of` — is gone. All three
 * priced the advance from what the *customer* was charged for delivery, which
 * has no relationship to what a refusal costs the shop: under `fixed ₹99`
 * against a ₹281 round trip, every refused parcel lost ₹182 and the shop found
 * out by reconciliation. The rule now prices the exposure directly.
 *
 * ## Why this file is still pure
 *
 * No settings reader, no cart, no order, no I/O. The checkout UI imports it to
 * *display* a split without dragging a Supabase client into the browser bundle
 * — a failure CI has already caught once. `npm run audit:totals` exercises
 * every branch and every guard rail below with no database and no browser.
 */

/**
 * Shiprocket bills freight plus 18% GST. Not a policy number and not the
 * owner's to set — it is the rate of tax — so it is a constant here and the
 * *choice to recover it* is the setting.
 */
const GST_MULTIPLIER = 1.18;

export type AdvanceRule = {
  /** Cap on the deposit, whatever the round trip costs. Zero means no cap. */
  maximumPaise: number;
  /** When true the advance is `(forward + rto) × 1.18`. */
  includeGst: boolean;
};

export type AdvanceSplit = {
  /** Charged through Razorpay now, before the order is confirmed. */
  advancePaise: number;
  /** Collected by the courier. What Shiprocket must be told to collect. */
  balanceDuePaise: number;
  /** Which guard rail bound, for the admin and for the audit. Null when none did. */
  cappedBy: "maximum" | "order_total" | "razorpay_floor" | null;
};

export function advanceFor(input: {
  rule: AdvanceRule;
  /** The forward leg **without** the cash-collection fee. */
  forwardFreightPaise: number;
  /** The return leg, from the same courier entry as the forward leg. */
  rtoFreightPaise: number;
  grandTotalPaise: number;
}): AdvanceSplit {
  const { rule, forwardFreightPaise, rtoFreightPaise, grandTotalPaise } = input;

  const roundTrip = Math.max(0, forwardFreightPaise) + Math.max(0, rtoFreightPaise);
  const withTax = rule.includeGst
    ? Math.round(roundTrip * GST_MULTIPLIER)
    : roundTrip;

  /**
   * Razorpay's floor of 100 paise is the provider's and is not negotiable: an
   * order below it cannot be created at all. Under this model it is always
   * satisfied — a courier does not carry a parcel for under a rupee — so it is
   * an assertion rather than a rule, and it is written down because the day it
   * stops being true is the day checkout breaks with no visible cause.
   */
  const floored = Math.max(withTax, MIN_CHARGEABLE_PAISE);

  /**
   * The cap, then the order total, in that order — because they answer
   * different questions and the second is not negotiable.
   *
   * The cap is the owner saying "never ask for more than this deposit". The
   * order total is arithmetic: an advance above it leaves the courier a
   * negative amount to collect, which is not a thing a courier can do. Applying
   * the cap first means a capped advance is still clamped to the total on a
   * cheap order, rather than the clamp being skipped because the cap already
   * bound.
   */
  const capped = rule.maximumPaise > 0 ? Math.min(floored, rule.maximumPaise) : floored;
  const advancePaise = Math.min(capped, grandTotalPaise);

  const cappedBy =
    advancePaise === grandTotalPaise && floored > grandTotalPaise
      ? "order_total"
      : rule.maximumPaise > 0 && capped === rule.maximumPaise && floored > rule.maximumPaise
        ? "maximum"
        : floored === MIN_CHARGEABLE_PAISE && withTax < MIN_CHARGEABLE_PAISE
          ? "razorpay_floor"
          : null;

  return {
    advancePaise,
    balanceDuePaise: grandTotalPaise - advancePaise,
    cappedBy,
  };
}

/**
 * Is Pay on Delivery offered for a basket of this size?
 *
 * Separate from `advanceFor` because it is asked *before* a quote exists — the
 * payment step has to know which methods to draw, and it must not draw one that
 * will be refused after the customer has chosen it. Below the minimum, the
 * method is withdrawn rather than the advance clamped: a clamped advance means
 * the shop is carrying a return it has not been paid for.
 */
export function codOfferedForOrder(input: {
  goodsTotalPaise: number;
  minimumOrderValuePaise: number;
}): boolean {
  return input.goodsTotalPaise >= input.minimumOrderValuePaise;
}

/**
 * What a prepaid customer is given back for paying up front.
 *
 * A line item rather than a lower price, because the owner's rule everywhere in
 * this codebase is that a difference between two payment methods must be
 * something a customer can see and point at. Rounded down, so the discount is
 * never a fraction of a paisa the total cannot express, and never more than the
 * goods it is discounting.
 */
export function prepaidDiscountFor(input: {
  discount: { mode: "flat" | "percent"; value: number };
  goodsTotalPaise: number;
}): number {
  const { discount, goodsTotalPaise } = input;
  if (discount.value <= 0 || goodsTotalPaise <= 0) return 0;
  const raw =
    discount.mode === "percent"
      ? Math.floor((goodsTotalPaise * discount.value) / 100)
      : Math.floor(discount.value);
  return Math.max(0, Math.min(raw, goodsTotalPaise));
}
