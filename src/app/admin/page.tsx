import type { Metadata } from "next";
import Link from "next/link";

import {
  AdminPage,
  Chip,
  EmptyState,
  ORDER_STATUS_TONE,
  PageHeader,
  Panel,
  StatTile,
} from "@/components/admin/ui";
import { ShiprocketWalletStatus } from "@/components/admin/shipping/wallet-status";
import { Table, TableWrap, Td, Th } from "@/components/admin/table";
import { Button } from "@/components/ui/button";
import { formatPaise } from "@/lib/format";
import { coinLiability } from "@/lib/queries/admin/loyalty";
import {
  relativeAge,
  type ModeCheck,
  type WebhookHealth,
} from "@/lib/payments/health";
import {
  getDashboard,
  LOW_STOCK_THRESHOLD,
  type RefundQueue,
} from "@/lib/queries/admin/dashboard";
import { shiprocketWalletStatus } from "@/lib/shipping/wallet";

export const metadata: Metadata = { title: "Dashboard" };

/** Every admin page reads live rows behind a session. Nothing here is static. */
export const dynamic = "force-dynamic";

/**
 * What the owner sees first.
 *
 * Six numbers and two short tables, chosen by asking what a person opening this
 * on a tablet at nine in the morning actually needs: what came in overnight,
 * what has to go out today, and what is about to run out. Anything that is not
 * one of those three questions belongs on the page that owns it.
 *
 * Every tile is a link into the list that explains it, because a number the
 * owner cannot act on is decoration.
 */
export default async function AdminDashboard() {
  /**
   * The wallet is fetched beside the dashboard's own numbers, not after them.
   *
   * It is the only thing on this page that leaves the building, and it is
   * written to fail soft — a Shiprocket outage comes back as "could not read"
   * rather than as a throw, so `Promise.all` cannot take the page down with it.
   * See `src/lib/shipping/wallet.ts`.
   */
  const [snapshot, wallet, liability] = await Promise.all([
    getDashboard(),
    shiprocketWalletStatus(),
    coinLiability(),
  ]);

  return (
    <>
      <PageHeader title="Dashboard" description="Today, and what needs doing.">
        <Button size="sm" asChild>
          <Link href="/admin/products/new">Add a product</Link>
        </Button>
      </PageHeader>

      <AdminPage className="space-y-5">
        {/*
          Four health strips, above the numbers rather than below them, in
          descending order of "how much money is this costing right now".
          The first two render nothing at all when there is nothing wrong; the
          wallet and the webhook always render, because the useful thing about a
          heartbeat is that you can see it beating — and a warning that has
          never once appeared is a warning nobody believes the first time it
          does.
        */}
        <RefundsOwedAlert queue={snapshot.refundsOwed} />
        <KeyModeWarning check={snapshot.keyMode} />
        <ShiprocketWalletStatus status={wallet} />
        <WebhookStatus health={snapshot.webhook} />

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
          <StatTile
            label="Orders today"
            value={snapshot.todayOrders}
            href="/admin/orders"
            hint="Since midnight, shop time"
          />
          <StatTile
            label="Taken today"
            value={formatPaise(snapshot.todayRevenuePaise)}
            hint="Excludes cancelled"
          />
          <StatTile
            label="To fulfil"
            value={snapshot.unfulfilled}
            href="/admin/orders?status=confirmed"
            hint="Confirmed or packed"
            tone={snapshot.unfulfilled > 0 ? "warn" : "neutral"}
          />
          <StatTile
            label="Awaiting payment"
            value={snapshot.pendingOrders}
            href="/admin/orders?status=pending"
            hint="Released after 30 min"
          />
          <StatTile
            label="Low stock"
            value={snapshot.lowStock}
            href="/admin/inventory?stock=low"
            hint={`${LOW_STOCK_THRESHOLD} or fewer left`}
            tone={snapshot.lowStock > 0 ? "warn" : "neutral"}
          />
          <StatTile
            label="Sold out"
            value={snapshot.outOfStock}
            href="/admin/inventory?stock=out"
            hint="Sizes at zero"
            tone={snapshot.outOfStock > 0 ? "warn" : "neutral"}
          />
          {/*
            The coin debt, where the owner cannot not see it: every coin out
            there is a discount already promised on a sale not yet made. In
            rupees once a coin is priced; in coins until then.
          */}
          <StatTile
            label="Coins owed"
            value={
              liability.rupees !== null
                ? formatPaise(liability.rupees * 100)
                : `${liability.coins}`
            }
            href="/admin/loyalty"
            hint={
              liability.rupees !== null
                ? `${liability.coins} coins at today's value`
                : "coins — no value set yet"
            }
          />
        </div>

        <div className="grid gap-5 xl:grid-cols-2">
          <Panel
            title="Latest orders"
            actions={
              <Button variant="outline" size="sm" asChild>
                <Link href="/admin/orders">All orders</Link>
              </Button>
            }
          >
            {snapshot.recent.length === 0 ? (
              <EmptyState
                title="No orders yet"
                body="When somebody buys something it appears here. Until then, check the shop looks right."
                actionHref="/"
                actionLabel="View the shop"
              />
            ) : (
              <TableWrap label="Latest orders">
                <Table>
                  <thead>
                    <tr>
                      <Th>Order</Th>
                      <Th>Customer</Th>
                      <Th>Status</Th>
                      <Th numeric>Total</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.recent.map((order) => (
                      <tr key={order.id} className="hover:bg-muted/40">
                        <Td>
                          <Link
                            href={`/admin/orders/${order.id}`}
                            className="font-mono text-xs tracking-[0.06em] underline-offset-4 hover:underline"
                          >
                            {order.orderNumber}
                          </Link>
                        </Td>
                        <Td className="max-w-[12rem] truncate">
                          {order.contactName}
                        </Td>
                        <Td>
                          <Chip
                            tone={ORDER_STATUS_TONE[order.status] ?? "neutral"}
                          >
                            {order.status}
                          </Chip>
                        </Td>
                        <Td numeric>{formatPaise(order.grandTotal)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            )}
          </Panel>

          <Panel
            title="Running out"
            description={`Sizes with ${LOW_STOCK_THRESHOLD} or fewer left.`}
            actions={
              <Button variant="outline" size="sm" asChild>
                <Link href="/admin/inventory?stock=low">All inventory</Link>
              </Button>
            }
          >
            {snapshot.lowStockRows.length === 0 ? (
              <EmptyState
                title="Nothing is running low"
                body="Every size has more than a few pairs left. This list fills itself as things sell."
                actionHref="/admin/inventory"
                actionLabel="See all stock"
              />
            ) : (
              <TableWrap label="Low stock">
                <Table>
                  <thead>
                    <tr>
                      <Th>Product</Th>
                      <Th>Size</Th>
                      <Th>Colour</Th>
                      <Th numeric>Left</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.lowStockRows.map((row) => (
                      <tr key={row.variantId} className="hover:bg-muted/40">
                        <Td className="max-w-[14rem] truncate">
                          <Link
                            href={`/admin/products/${row.productId}`}
                            className="underline-offset-4 hover:underline"
                          >
                            {row.productName}
                          </Link>
                        </Td>
                        <Td className="font-mono text-xs">UK {row.size}</Td>
                        <Td className="max-w-[9rem] truncate">{row.color}</Td>
                        <Td numeric>
                          <Chip tone={row.stock === 0 ? "bad" : "warn"}>
                            {row.stock}
                          </Chip>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            )}
          </Panel>
        </div>
      </AdminPage>
    </>
  );
}

/**
 * Money we took and did not give back.
 *
 * `cancelled` and `paid` together mean the shop kept a customer's payment —
 * either the sweep cancelled an order Razorpay had already captured, or a
 * capture landed on an order that was already dead. Stage 1 measured this at
 * zero. It is on the dashboard so that the first time it is one, somebody sees
 * it the same day rather than when the customer telephones.
 *
 * Nothing here can issue the refund, and it does not pretend to: the payment id
 * is printed because the refund is made in the Razorpay dashboard against that
 * id and nowhere else.
 */
function RefundsOwedAlert({ queue }: { queue: RefundQueue }) {
  if (queue.state === "unknown") {
    return (
      <p
        role="status"
        className="border-orange/50 bg-orange/5 rounded-md border p-3 text-sm text-pretty"
      >
        <strong>The refund queue could not be read.</strong> That is not the
        same as there being nothing to refund — it means we could not check.
        Reload in a moment.
      </p>
    );
  }
  if (queue.count === 0) return null;

  return (
    <div
      role="status"
      className="border-destructive/50 bg-destructive/5 rounded-md border p-3 text-sm text-pretty"
    >
      <p>
        <strong>
          {queue.count === 1
            ? "One cancelled order was paid for and has not been refunded."
            : `${queue.count} cancelled orders were paid for and have not been refunded.`}
        </strong>{" "}
        The shop is holding money for goods it is not going to send. Refund it
        in the Razorpay dashboard against the payment id below, and the row
        clears itself.
      </p>
      <ul className="mt-2 space-y-1 font-mono text-xs">
        {queue.rows.map((order) => (
          <li key={order.id} className="tabular-nums">
            <Link
              href={`/admin/orders/${order.id}`}
              className="tracking-[0.06em] underline-offset-4 hover:underline"
            >
              {order.orderNumber}
            </Link>{" "}
            &middot; taken{" "}
            {/*
              `advance_amount` is 0 on a fully prepaid order and carries the
              deposit on a Pay-on-Delivery one, so the amount actually charged
              is the advance when there is one and the order total otherwise.
              Same expression applyPaymentOutcome() uses to decide what it
              expected to be paid.
            */}
            {formatPaise(
              order.advancePaise > 0
                ? order.advancePaise
                : order.grandTotalPaise,
            )}{" "}
            of {formatPaise(order.grandTotalPaise)} &middot;{" "}
            {order.paymentReference ?? "no payment id recorded"} &middot;
            cancelled {relativeAge(order.cancelledAt)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Test keys on production take no money and confirm orders anyway; live keys
 * anywhere else charge whoever is testing. Neither throws, so neither is
 * visible without a line like this one.
 */
function KeyModeWarning({ check }: { check: ModeCheck }) {
  if (check.ok) return null;
  return (
    <p
      role="status"
      className="border-destructive/50 bg-destructive/5 rounded-md border p-3 text-sm text-pretty"
    >
      <strong>The Razorpay key does not match this deployment.</strong>{" "}
      {check.message}
    </p>
  );
}

/**
 * The webhook heartbeat.
 *
 * Red is reserved for the one thing that is genuinely broken: money arrived and
 * Razorpay never told us about it server-to-server. A quiet week produces no
 * webhooks and no alarm, which is the whole reason this is measured against the
 * last paid order rather than against the clock.
 */
function WebhookStatus({ health }: { health: WebhookHealth }) {
  if (health.state === "never" || health.state === "behind") {
    return (
      <p
        role="status"
        className="border-destructive/50 bg-destructive/5 rounded-md border p-3 text-sm text-pretty"
      >
        <strong>
          {health.state === "never"
            ? "Razorpay has never sent us a webhook."
            : "The webhook chain is not delivering."}
        </strong>{" "}
        {health.state === "never"
          ? "Orders are being confirmed by the customer's browser alone, so anyone who pays and closes the tab leaves an order sitting unpaid, and the sweep will cancel it."
          : `${
              health.lastEventAt
                ? `The last one arrived ${relativeAge(health.lastEventAt)}`
                : "There is no record of one ever arriving"
            }, but an order was paid ${relativeAge(health.lastPaidOrderAt)}.`}{" "}
        Check the webhook is registered and enabled in the Razorpay dashboard,
        and that its secret matches RAZORPAY_WEBHOOK_SECRET. Orders paid since
        then may still be showing as unpaid.
      </p>
    );
  }

  if (health.state === "unknown") {
    return (
      <p
        role="status"
        className="border-orange/50 bg-orange/5 rounded-md border p-3 text-sm text-pretty"
      >
        <strong>The webhook check could not run.</strong> That is not the same
        as the webhook working. Reload in a moment.
      </p>
    );
  }

  return (
    <p role="status" className="text-muted-foreground text-sm">
      {health.state === "idle"
        ? "No online payment has been taken yet, so there is nothing to check the webhook against."
        : `Last webhook: ${relativeAge(health.lastEventAt)}.`}
    </p>
  );
}
