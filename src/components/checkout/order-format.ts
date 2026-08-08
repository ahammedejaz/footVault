import type { OrderStatus, PaymentStatus } from "@/lib/orders/types";
import { formatPaise } from "@/lib/format";
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
 */
export function whatHappensNext(order: {
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod;
  totals?: { advanceAmount: number; balanceDueOnDelivery: number };
}): string {
  if (order.status === "cancelled") return ORDER_STATUS_COPY.cancelled.blurb;
  if (order.status === "returned") return ORDER_STATUS_COPY.returned.blurb;

  if (order.paymentMethod === "cod") {
    const balance = order.totals?.balanceDueOnDelivery ?? 0;
    if (balance === 0) return "Paid in full. Nothing left to do.";
    /**
     * Both numbers, always. This line used to say only "pay the delivery agent
     * in cash when your parcel arrives", which under the old model was true and
     * under this one leaves the customer believing they have paid nothing. That
     * belief is what gets a parcel refused at the door, and a refused parcel
     * costs the shop both legs of the delivery.
     */
    const paid = order.totals?.advanceAmount ?? 0;
    return (
      `You have paid ${formatPaise(paid)}. The courier will collect ` +
      `${formatPaise(balance)} in cash when your parcel arrives — keep the exact ` +
      "amount ready if you can."
    );
  }

  if (order.paymentStatus === "paid") {
    return "Your payment has gone through. We will email you when the parcel leaves us.";
  }

  return "We have not seen your payment settle yet. This can take a minute — reload this page rather than paying again, and nothing has been charged twice if you do.";
}
