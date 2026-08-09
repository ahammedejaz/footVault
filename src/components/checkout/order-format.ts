import type { OrderStatus, PaymentStatus } from "@/lib/orders/types";
import { formatPaise } from "@/lib/format";
import { REFUND_ARRIVAL_WINDOW } from "@/lib/orders/customer-copy";
import type { PaymentMethod } from "@/lib/payments/types";

/**
 * How an order is worded.
 *
 * Here rather than in `src/lib/format.ts` because that module is money and
 * units for the whole storefront, and none of this is reusable outside an
 * order. Here rather than in `src/lib/orders/` because that is the state
 * machine and its owner is not the person choosing adjectives.
 *
 * The status *names* are the database's. The sentences are ours, and they say
 * what happens next rather than restating the noun — "Packed" tells a customer
 * nothing they cannot read off the chip.
 */

/**
 * Both formatters pin `Asia/Kolkata`.
 *
 * These strings are rendered on the server and hydrated in the browser. Without
 * a fixed zone the two disagree for anyone outside IST, which React reports as
 * a hydration mismatch and a customer reads as the date changing when the page
 * finishes loading. The market is India, so IST is also the right answer for
 * the customer, not just for the diff.
 */
const DATE = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});

const DATE_TIME = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Kolkata",
});

export function formatOrderDate(iso: string): string {
  return DATE.format(new Date(iso));
}

export function formatOrderDateTime(iso: string): string {
  return DATE_TIME.format(new Date(iso));
}

/* --------------------------------------------------------------- statuses -- */

export type StatusCopy = {
  /** The chip. One word where one word will do. */
  label: string;
  /** What it means for the customer, in a sentence. */
  blurb: string;
};

export const ORDER_STATUS_COPY: Readonly<Record<OrderStatus, StatusCopy>> = {
  pending: {
    label: "Awaiting payment",
    blurb:
      "We are holding these for you. The order confirms as soon as the payment settles.",
  },
  confirmed: {
    label: "Confirmed",
    blurb: "We have your order and your pairs are set aside. Packing is next.",
  },
  packed: {
    label: "Packed",
    blurb: "Boxed and waiting for the courier to collect.",
  },
  shipped: {
    label: "Shipped",
    blurb:
      "On its way. The courier will call the number on this order before delivering.",
  },
  delivered: {
    label: "Delivered",
    blurb:
      "Delivered. Anything not right can go back within the returns window.",
  },
  cancelled: {
    label: "Cancelled",
    blurb: "This order was cancelled and the pairs went back on the shelf.",
  },
  // Said from the customer's side, not the courier's. "RTO" is a logistics
  // acronym; "on its way back to us" is what happened.
  returning: {
    label: "Coming back",
    blurb: "This parcel is on its way back to us.",
  },
  returned: {
    label: "Returned",
    blurb: "Returned to us.",
  },
};

export const PAYMENT_STATUS_LABEL: Readonly<Record<PaymentStatus, string>> = {
  unpaid: "Not paid yet",
  paid: "Paid",
  refunded: "Refunded",
};

/**
 * The one sentence the confirmation page leads with.
 *
 * Payment method and payment status together, because the honest answer differs
 * by both: an unpaid COD order is completely normal and an unpaid Razorpay
 * order is not, and a customer who cannot tell those apart will either worry
 * about nothing or ignore something.
 *
 * ## Why this is a switch now
 *
 * It used to be a chain of `if`s that handled `paid` and let everything else
 * fall through to *"We have not seen your payment settle yet… reload this page
 * rather than paying again"*. `refunded` is everything else. So the customer of
 * FV-2026-00623 — whose ₹135 had been captured, refunded and confirmed by
 * webhook — was told their payment had not settled and invited to reload.
 *
 * A `switch` over `PaymentStatus` with no default makes the next status added to
 * that enum a **compile error** here rather than a sentence shown to somebody
 * whose money is in the wrong place. That is the whole reason for the shape.
 *
 * ## And why `cancelled` has a matrix rather than a blurb
 *
 * Fixing the cancel guard (9B) created a state that could not exist before:
 * `cancelled` **and** `refunded`. The cancelled blurb says the pairs went back
 * on the shelf and says nothing about the money, which is the only thing the
 * customer wants to know. Both halves are needed, and which second half is true
 * depends on what was actually taken.
 *
 * **No figure is named for a refund, deliberately.** The exact amount lives in
 * `refunds.amount_paise`, which a customer cannot read — the RLS policy grants
 * `select` to admins only — and the nearest number on the order,
 * `advance_amount`, is *not* the refunded amount when a refund was partial or
 * carried an RTO deduction. Naming a figure here would mean either widening that
 * policy or printing a number that is sometimes wrong, and a wrong refund figure
 * is worse than no figure.
 */
export function whatHappensNext(order: {
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod;
  totals?: { advanceAmount: number; balanceDueOnDelivery: number };
}): string {
  if (order.status === "cancelled") return cancelledCopy(order.paymentStatus);
  if (order.status === "returned") return ORDER_STATUS_COPY.returned.blurb;

  switch (order.paymentStatus) {
    case "refunded":
      return `Your money is on its way back to you. ${REFUND_TIMING}`;

    case "paid":
      return order.paymentMethod === "cod"
        ? codBalance(order.totals)
        : "Your payment has gone through. We will email you when the parcel leaves us.";

    case "unpaid":
      /**
       * A Pay-on-Delivery order that has not settled has taken **nothing** yet,
       * so it cannot be told what it has paid. The order is written `pending` /
       * `unpaid` before the Razorpay modal opens, and a customer who dismisses
       * that modal was on this page being told they had already paid ₹281.
       */
      return order.paymentMethod === "cod"
        ? "We are holding these for you. The order confirms as soon as the amount " +
            "due now settles — nothing has been taken yet."
        : "We have not seen your payment settle yet. This can take a minute — reload this page rather than paying again, and nothing has been charged twice if you do.";
  }
}

/**
 * A cancellation, and what happened to the money.
 *
 * Its own function so the switch has to satisfy a `string` return type: a fourth
 * `PaymentStatus` becomes "not all code paths return a value" here, rather than
 * falling quietly through to the general copy below. Inlined in the caller it
 * would have done exactly that.
 */
function cancelledCopy(paymentStatus: PaymentStatus): string {
  const closed = ORDER_STATUS_COPY.cancelled.blurb;
  switch (paymentStatus) {
    case "unpaid":
      return `${closed} Nothing was charged.`;
    case "paid":
      // Reachable only through a refund that has settled the balance — the
      // cancel guard refuses while anything is still outstanding — or through a
      // payment row that has not caught up with its refund yet. Both mean money
      // is coming back.
      return `${closed} Anything you paid is being returned to you. ${REFUND_TIMING}`;
    case "refunded":
      return `${closed} Your money is on its way back to you. ${REFUND_TIMING}`;
  }
}

/**
 * How long money takes to come back.
 *
 * The window itself is shared with `src/lib/orders/refunds.ts`, which writes the
 * same fact onto the timeline when Razorpay confirms a refund. Two typed copies
 * of "5–7 working days" is one edit away from telling a customer two different
 * things about the same money.
 */
const REFUND_TIMING = `Refunds usually reach your account in ${REFUND_ARRIVAL_WINDOW}.`;

/**
 * What a settled Pay-on-Delivery order still owes at the door.
 *
 * Both numbers, always. This line used to say only "pay the delivery agent in
 * cash when your parcel arrives", which under the old model was true and under
 * this one leaves the customer believing they have paid nothing. That belief is
 * what gets a parcel refused at the door, and a refused parcel costs the shop
 * both legs of the delivery.
 */
function codBalance(totals?: {
  advanceAmount: number;
  balanceDueOnDelivery: number;
}): string {
  const balance = totals?.balanceDueOnDelivery ?? 0;
  if (balance === 0) return "Paid in full. Nothing left to do.";
  const paid = totals?.advanceAmount ?? 0;
  return (
    `You have paid ${formatPaise(paid)}. The courier will collect ` +
    `${formatPaise(balance)} in cash when your parcel arrives — keep the exact ` +
    "amount ready if you can."
  );
}
