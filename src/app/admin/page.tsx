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
import { Table, TableWrap, Td, Th } from "@/components/admin/table";
import { Button } from "@/components/ui/button";
import { formatPaise } from "@/lib/format";
import {
  getDashboard,
  LOW_STOCK_THRESHOLD,
} from "@/lib/queries/admin/dashboard";

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
  const snapshot = await getDashboard();

  return (
    <>
      <PageHeader title="Dashboard" description="Today, and what needs doing.">
        <Button size="sm" asChild>
          <Link href="/admin/products/new">Add a product</Link>
        </Button>
      </PageHeader>

      <AdminPage className="space-y-5">
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
