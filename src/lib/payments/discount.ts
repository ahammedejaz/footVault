/**
 * The shop's one rounding rule for money taken *off* an order.
 *
 * There is exactly one of these on purpose. A percentage discount produces a
 * fraction of a rupee — 20% of ₹3,999 is ₹799.80 — and the question of what
 * happens to those 80 paise has to have the same answer everywhere, or the
 * prepaid discount and a coupon on the same catalogue round in opposite
 * directions and no one can explain the total.
 *
 * ## The rule: round **up**, in the customer's favour, then cap
 *
 * The owner's decision, 2026-08-09:
 *
 * > "Round the discount UP to whole rupees, not down. The only difference is
 * > who gets the sub-rupee, and it should be the customer. Worth at most 99
 * > paise per discounted order. Floor at max_discount so rounding up can never
 * > breach a cap."
 *
 * Two things follow, and both are the point:
 *
 * 1. **The discount is a whole number of rupees**, so a total built from whole
 *    rupees stays whole. That matters most for Pay on Delivery, where the
 *    courier collects cash at the door and sub-rupee coins are effectively out
 *    of circulation — a balance of ₹3,249.20 is not physically collectable, and
 *    Shiprocket would be handed those 20 paise as a collectable figure that the
 *    reconciler then has to explain. Delivery is already rounded up to the
 *    nearest ₹10 (`ROUND_UP_TO_PAISE` in `src/lib/shipping/fee.ts`), so with
 *    this the only remaining source of paise in a total is a catalogue price
 *    that carries them.
 * 2. **The cap is applied after the rounding, never before.** Rounding up a
 *    figure that was already sitting exactly on a ceiling would push it through
 *    — 20% of ₹3,999 capped at ₹799.50 must come out at ₹799.50 and not at
 *    ₹800. So the order is: compute, round up, then take the smaller of that
 *    and every cap. This is why the caps are a parameter here rather than
 *    something each caller applies afterwards: a caller that clamps first and
 *    rounds second has silently written a different rule.
 */

/**
 * A discount in paise, rounded up to a whole rupee and held inside its caps.
 *
 * `caps` is every ceiling that applies, in paise — the goods total always, and
 * a coupon's `max_discount` when there is one. Zero and negative inputs return
 * zero rather than throwing: a discount is an optional thing, and "no discount"
 * is a normal answer rather than a failure.
 */
export function roundedDiscountPaise(
  rawPaise: number,
  ...caps: number[]
): number {
  if (!Number.isFinite(rawPaise) || rawPaise <= 0) return 0;

  const roundedUp = Math.ceil(rawPaise / RUPEE_IN_PAISE) * RUPEE_IN_PAISE;

  // `Math.min` over an empty list is Infinity, which is the right identity here:
  // with no caps supplied the rounded figure stands.
  const ceiling = Math.min(...caps.filter((cap) => Number.isFinite(cap)));
  return Math.max(0, Math.min(roundedUp, ceiling));
}

const RUPEE_IN_PAISE = 100;
