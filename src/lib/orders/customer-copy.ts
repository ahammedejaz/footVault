/**
 * Sentences the customer reads, where more than one surface has to say the same
 * thing.
 *
 * 9C split `order_status_history` into an internal `note` and a customer-facing
 * `customer_note`, which fixed the audience problem and created a smaller one:
 * the same fact is now written in two places. The refund timing is stated by the
 * order page (`whatHappensNext`) *and* by the timeline entry that
 * `src/lib/orders/refunds.ts` writes when Razorpay confirms a refund. Two
 * independently-typed copies of "5–7 working days" is one edit away from a
 * customer being told two different things about the same money.
 *
 * Only facts that genuinely appear twice belong here. A sentence with one home
 * should stay in it — a copy file that collects every string is a second place
 * to look for the one you want to change.
 *
 * Deliberately free of `server-only`: the page renders this in the browser and
 * the refund writer uses it on the server, and that is the point.
 */

/**
 * How long money takes to come back.
 *
 * Razorpay settles a refund to the issuing bank in one to two working days and
 * the bank takes the rest; 5–7 is the honest outer bound to quote a customer, and
 * quoting the shorter one produces a support conversation on day three.
 */
export const REFUND_ARRIVAL_WINDOW = "5–7 working days";
