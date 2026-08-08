import { AddressCard } from "@/components/checkout/address-card";
import { OrderLines } from "@/components/checkout/order-lines";
import { OrderTimeline } from "@/components/checkout/order-timeline";
import {
  PAYMENT_STATUS_LABEL,
  whatHappensNext,
} from "@/components/checkout/order-format";
import { Totals } from "@/components/checkout/totals";
import type { OrderView } from "@/lib/orders/types";
import type { PaymentMethod } from "@/lib/payments/types";

/**
 * An order, in full — the same body on the confirmation page and in the account
 * history, because they are the same information and two of them would drift.
 *
 * What differs is only the frame: the confirmation adds the just-placed banner
 * and the offer of an account, the account page adds the way back to the list.
 *
 * The sections answer, in order, the four questions somebody actually opens
 * this page with: what happens now, what did I buy, where is it going, what did
 * I pay. The timeline sits under the first because it is the evidence for it.
 */
export function OrderDetail({ order }: { order: OrderView }) {
  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_23rem] lg:gap-10">
      <div className="min-w-0 space-y-10">
        <section aria-labelledby="order-next-heading">
          <h2 id="order-next-heading" className="text-lg font-semibold">
            What happens next
          </h2>
          <p className="mt-2 text-base text-pretty">{whatHappensNext(order)}</p>
          <OrderTimeline timeline={order.timeline} />
        </section>

        <section aria-labelledby="order-items-heading">
          <h2 id="order-items-heading" className="text-lg font-semibold">
            What you bought
          </h2>
          <div className="mt-2">
            <OrderLines lines={order.lines} />
          </div>
        </section>

        <section aria-labelledby="order-delivery-heading">
          <h2 id="order-delivery-heading" className="text-lg font-semibold">
            Where it is going
          </h2>
          <div className="border-border mt-4 rounded-lg border p-4">
            <AddressCard address={order.shippingAddress} />
          </div>

          {order.contactEmail || order.contactPhone ? (
            <p className="text-muted-foreground mt-3 text-sm text-pretty">
              We will reach you on{" "}
              {[order.contactEmail, order.contactPhone ? `+91 ${order.contactPhone}` : null]
                .filter(Boolean)
                .join(" and ")}
              .
            </p>
          ) : null}

          {order.customerNote ? (
            <div className="bg-fog mt-4 rounded-lg p-4">
              <p className="font-mono text-xs tracking-[0.06em] uppercase">Your note</p>
              <p className="mt-1.5 text-sm text-pretty">{order.customerNote}</p>
            </div>
          ) : null}
        </section>
      </div>

      <aside aria-labelledby="order-payment-heading" className="lg:sticky lg:top-24 lg:self-start">
        <div className="bg-fog border-border rounded-lg border p-5">
          <h2
            id="order-payment-heading"
            className="font-mono text-xs tracking-[0.06em] uppercase"
          >
            What you paid
          </h2>

          <dl className="border-border mt-4 space-y-2 border-b pb-4 text-sm">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">Method</dt>
              <dd className="font-medium">{METHOD_LABEL[order.paymentMethod]}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">Status</dt>
              <dd className="font-medium">{PAYMENT_STATUS_LABEL[order.paymentStatus]}</dd>
            </div>
          </dl>

          <div className="mt-4">
            <Totals totals={order.totals} itemCount={order.lines.length} />
          </div>
        </div>
      </aside>
    </div>
  );
}

/**
 * The method as a customer names it.
 *
 * Not `PaymentMethodCopy.label`, which comes from the adapter and is only
 * reachable on the server through `getPaymentAdapter()`. A placed order records
 * the method it used even if that adapter has since been switched off, so this
 * page has to be able to name a method that is no longer on offer.
 */
const METHOD_LABEL: Readonly<Record<PaymentMethod, string>> = {
  cod: "Cash on delivery",
  razorpay: "Card, UPI or netbanking",
};
