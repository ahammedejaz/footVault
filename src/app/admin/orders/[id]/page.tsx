import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { OrderActions } from "@/components/admin/orders/order-actions";
import {
  ShippingPanel,
  type ShipmentView,
} from "@/components/admin/orders/shipping-panel";
import { AdminPage, Chip, ORDER_STATUS_TONE, Panel, PageHeader } from "@/components/admin/ui";
import { formatPaise } from "@/lib/format";
import { getOrderDetail, getOrderShipment } from "@/lib/queries/admin/orders";

export const metadata: Metadata = { title: "Order" };
export const dynamic = "force-dynamic";

/**
 * One order, and everything that can be done to it.
 *
 * This page is where the phase's two halves meet. The five Shiprocket actions
 * have existed since the last phase — written, guarded, rate-limited, covered
 * by `npm run audit:shipping` — with nothing in the interface calling them; and
 * the money split that Part 0 introduced has to be legible to whoever is about
 * to hand a parcel to a courier. Both live here.
 *
 * The order of the panels is the order of the questions actually asked while
 * standing at the counter: what is owed, what do I do next, what is in the box,
 * where does it go, and what has happened so far.
 */
export default async function AdminOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const order = await getOrderDetail(id);
  if (!order) notFound();

  const shipmentRow = await getOrderShipment(order.id);

  /**
   * Mapped to a plain shape rather than passed through.
   *
   * `ShipmentRow` comes from `src/lib/shipping/fulfilment.ts`, which is
   * `server-only`; handing it to a Client Component compiles today and pulls a
   * Supabase server client into the browser bundle one careless edit later. CI
   * greps for exactly that — see `9440fa0` — so the boundary is a mapping, not
   * a type assertion.
   */
  const shipment: ShipmentView | null = shipmentRow
    ? {
        status: shipmentRow.status,
        shiprocketOrderId: shipmentRow.shiprocket_order_id,
        shipmentId: shipmentRow.shipment_id,
        awbCode: shipmentRow.awb_code,
        courierName: shipmentRow.courier_name,
        labelUrl: shipmentRow.label_url,
        manifestUrl: shipmentRow.manifest_url,
        invoiceUrl: shipmentRow.invoice_url,
        pickupScheduledAt: shipmentRow.pickup_scheduled_at,
        deliveredAt: shipmentRow.delivered_at,
        codCollectableAmount: shipmentRow.cod_collectable_amount,
        trackedAt: shipmentRow.tracked_at,
      }
    : null;

  const paysOnDelivery = order.balanceDueOnDelivery > 0;
  const forwardLeg = order.shippingFee - order.codHandlingFee;

  return (
    <AdminPage>
      <PageHeader
        title={order.orderNumber}
        description={`Placed ${new Date(order.placedAt).toLocaleString()}${order.isGuest ? " · guest checkout" : ""}`}
      >
        <Link
          href="/admin/orders"
          className="hit-44 inline-flex items-center gap-1 text-sm underline underline-offset-2"
        >
          <ArrowLeft aria-hidden className="size-4" />
          All orders
        </Link>
      </PageHeader>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Chip tone={ORDER_STATUS_TONE[order.status] ?? "neutral"}>
          {order.status}
        </Chip>
        <Chip tone={order.paymentStatus === "paid" ? "good" : "neutral"}>
          {order.paymentStatus} online
        </Chip>
        <Chip tone="neutral">
          {paysOnDelivery ? "Pay on Delivery" : "Prepaid"}
        </Chip>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          {/*
            The money first, and the balance in the largest type on the page.
            It is the figure the courier will be handed, and the one number here
            that costs real money to get wrong.
          */}
          <Panel title="The money">
            <dl className="space-y-2 text-sm">
              <Money label="Goods" value={order.subtotal} />
              <Money
                label="Delivery"
                value={forwardLeg}
                free={forwardLeg === 0}
              />
              {order.codHandlingFee > 0 ? (
                <Money
                  label="Pay-on-delivery fee"
                  value={order.codHandlingFee}
                />
              ) : null}
              {order.discountTotal > 0 ? (
                <Money label="Discount" value={-order.discountTotal} />
              ) : null}
            </dl>
            <div className="border-border mt-3 flex items-baseline justify-between border-t pt-3">
              <span className="font-mono text-xs tracking-[0.06em] uppercase">
                Order total
              </span>
              <span className="font-mono text-base font-medium tabular-nums">
                {formatPaise(order.grandTotal)}
              </span>
            </div>

            <div className="border-border mt-4 grid gap-3 rounded-md border p-3 sm:grid-cols-2">
              <div>
                <p className="text-muted-foreground font-mono text-xs tracking-[0.06em] uppercase">
                  Paid online
                </p>
                <p className="mt-1 text-xl font-extrabold tabular-nums">
                  {formatPaise(order.advanceAmount)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground font-mono text-xs tracking-[0.06em] uppercase">
                  Courier collects
                </p>
                <p
                  className={`mt-1 text-xl font-extrabold tabular-nums ${paysOnDelivery ? "" : "text-muted-foreground"}`}
                >
                  {formatPaise(order.balanceDueOnDelivery)}
                </p>
                {order.cashCollectedAt ? (
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    Received {new Date(order.cashCollectedAt).toLocaleString()}
                  </p>
                ) : null}
              </div>
            </div>
          </Panel>

          <Panel
            title="Shipping"
            description="Each step is safe to press twice. Nothing here happens automatically."
          >
            <ShippingPanel
              orderId={order.id}
              shipment={shipment}
              balanceDueOnDelivery={order.balanceDueOnDelivery}
              paysOnDelivery={paysOnDelivery}
              canShip={order.status !== "pending"}
            />
          </Panel>

          <Panel title={`What is in the box (${order.items.length})`}>
            <ul className="divide-border divide-y">
              {order.items.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-baseline justify-between gap-2 py-2 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-pretty">
                      {item.productName}
                    </p>
                    <p className="text-muted-foreground font-mono text-xs">
                      UK {item.size} · {item.color} · {item.sku} ×{" "}
                      {item.quantity}
                    </p>
                  </div>
                  <p className="font-mono text-sm tabular-nums">
                    {formatPaise(item.lineTotal)}
                  </p>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Timeline">
            {order.history.length === 0 ? (
              <p className="text-muted-foreground text-sm">Nothing yet.</p>
            ) : (
              <ol className="space-y-3">
                {order.history.map((entry) => (
                  <li key={entry.id} className="text-sm">
                    <p className="font-medium capitalize">{entry.status}</p>
                    {entry.note ? (
                      <p className="text-pretty">{entry.note}</p>
                    ) : null}
                    <p className="text-muted-foreground font-mono text-xs">
                      {new Date(entry.createdAt).toLocaleString()}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel title="Do something">
            <OrderActions
              orderId={order.id}
              status={order.status}
              balanceDueOnDelivery={order.balanceDueOnDelivery}
              cashCollectedAt={order.cashCollectedAt}
              deliveredAt={order.deliveredAt}
            />
          </Panel>

          <Panel title="Where it goes">
            <address className="text-sm not-italic">
              {order.address.recipientName}
              <br />
              {order.address.line1}
              <br />
              {order.address.line2 ? (
                <>
                  {order.address.line2}
                  <br />
                </>
              ) : null}
              {order.address.city}, {order.address.state}{" "}
              {order.address.postalCode}
              <br />
              {order.address.phone}
            </address>
            {order.contactEmail || order.contactPhone ? (
              <p className="text-muted-foreground mt-3 text-sm break-words">
                {[order.contactEmail, order.contactPhone]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            ) : null}
            {order.customerNote ? (
              <p className="border-border mt-3 rounded-md border p-2 text-sm text-pretty">
                {order.customerNote}
              </p>
            ) : null}
          </Panel>

          {order.payments.length > 0 ? (
            <Panel title="Payments">
              <ul className="space-y-2">
                {order.payments.map((payment) => (
                  <li key={payment.id} className="text-sm">
                    <p className="flex items-baseline justify-between gap-2">
                      <span className="capitalize">{payment.status}</span>
                      <span className="font-mono tabular-nums">
                        {formatPaise(payment.amount)}
                      </span>
                    </p>
                    <p className="text-muted-foreground font-mono text-xs break-all">
                      {payment.providerPaymentId ?? payment.providerOrderId}
                    </p>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>
      </div>
    </AdminPage>
  );
}

function Money({
  label,
  value,
  free,
}: {
  label: string;
  value: number;
  free?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono tabular-nums">
        {free ? "Free" : formatPaise(value)}
      </dd>
    </div>
  );
}
