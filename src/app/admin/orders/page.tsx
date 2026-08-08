import type { Metadata } from "next";
import Link from "next/link";

import { SearchField } from "@/components/admin/search-field";
import {
  Pagination,
  SortableTh,
  Table,
  TableWrap,
  Td,
  Th,
} from "@/components/admin/table";
import {
  AdminPage,
  Chip,
  EmptyState,
  ORDER_STATUS_TONE,
  PageHeader,
} from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import {
  listHref,
  parseListParams,
  type SearchParams,
} from "@/lib/admin/list-params";
import { formatPaise } from "@/lib/format";
import { ORDER_TRANSITIONS, type OrderStatus } from "@/lib/orders/types";
import {
  listOrders,
  ORDER_SORTS,
  type OrderSort,
} from "@/lib/queries/admin/orders";

export const metadata: Metadata = { title: "Orders" };
export const dynamic = "force-dynamic";

const STATUSES = Object.keys(ORDER_TRANSITIONS) as OrderStatus[];

/**
 * Every order, filtered by what the owner is actually trying to do.
 *
 * The status filter is a row of links rather than a `<select>`: on a tablet a
 * native select is a full-screen wheel for a choice between eight things, and
 * the owner switches between "to fulfil" and "everything" constantly. Links
 * also mean each view is a URL the dashboard tiles can point straight at.
 */
export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const params = parseListParams<OrderSort>(sp, {
    sortable: ORDER_SORTS,
    defaultSort: "placed_at",
    defaultDir: "desc",
  });

  const statusParam = typeof sp.status === "string" ? sp.status : "";
  const status = (STATUSES as string[]).includes(statusParam)
    ? (statusParam as OrderStatus)
    : "";
  const from = typeof sp.from === "string" ? sp.from : "";
  const to = typeof sp.to === "string" ? sp.to : "";

  const extras = {
    status: status || undefined,
    from: from || undefined,
    to: to || undefined,
  };
  const { rows, total } = await listOrders(params, { status, from, to });

  return (
    <>
      <PageHeader
        title="Orders"
        description="Search by order number, phone or email. Filter by where each one has got to."
      />

      <AdminPage className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            label="Search orders"
            placeholder="Order number, phone or email"
            hidden={extras}
          />
        </div>

        <nav aria-label="Filter by status" className="flex flex-wrap gap-1.5">
          <FilterChip
            href={listHref(
              "/admin/orders",
              params,
              { page: 1 },
              { ...extras, status: undefined },
            )}
            active={status === ""}
          >
            All
          </FilterChip>
          {STATUSES.map((value) => (
            <FilterChip
              key={value}
              href={listHref(
                "/admin/orders",
                params,
                { page: 1 },
                { ...extras, status: value },
              )}
              active={status === value}
            >
              {value}
            </FilterChip>
          ))}
        </nav>

        {rows.length === 0 ? (
          <EmptyState
            title={
              params.q || status ? "Nothing matches that" : "No orders yet"
            }
            body={
              params.q || status
                ? "Try a different search, or clear the filter to see everything."
                : "Orders appear here the moment somebody buys something. Add a product and share the shop to get started."
            }
            actionHref={
              params.q || status ? "/admin/orders" : "/admin/products/new"
            }
            actionLabel={params.q || status ? "Clear filters" : "Add a product"}
          />
        ) : (
          <>
            <TableWrap label="Orders">
              <Table className="min-w-[52rem]">
                <thead>
                  <tr>
                    <SortableTh
                      column="order_number"
                      params={params}
                      basePath="/admin/orders"
                      extras={extras}
                    >
                      Order
                    </SortableTh>
                    <SortableTh
                      column="placed_at"
                      params={params}
                      basePath="/admin/orders"
                      extras={extras}
                      initialDir="desc"
                    >
                      Placed
                    </SortableTh>
                    <Th>Customer</Th>
                    <SortableTh
                      column="status"
                      params={params}
                      basePath="/admin/orders"
                      extras={extras}
                    >
                      Status
                    </SortableTh>
                    <Th>Payment</Th>
                    <Th>Tracking</Th>
                    <SortableTh
                      column="grand_total"
                      params={params}
                      basePath="/admin/orders"
                      extras={extras}
                      numeric
                      initialDir="desc"
                    >
                      Total
                    </SortableTh>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((order) => (
                    <tr key={order.id} className="hover:bg-muted/40">
                      <Td>
                        <Link
                          href={`/admin/orders/${order.id}`}
                          className="font-mono text-xs tracking-[0.06em] underline-offset-4 hover:underline"
                        >
                          {order.orderNumber}
                        </Link>
                        <span className="text-muted-foreground ml-2 text-xs">
                          {order.itemCount}{" "}
                          {order.itemCount === 1 ? "line" : "lines"}
                        </span>
                      </Td>
                      <Td className="text-muted-foreground whitespace-nowrap">
                        {formatDate(order.placedAt)}
                      </Td>
                      <Td className="max-w-[13rem]">
                        <span className="block truncate">
                          {order.recipient}
                        </span>
                        <span className="text-muted-foreground block truncate text-xs">
                          {order.contactPhone ?? order.contactEmail ?? "—"}
                        </span>
                      </Td>
                      <Td>
                        <Chip
                          tone={ORDER_STATUS_TONE[order.status] ?? "neutral"}
                        >
                          {order.status}
                        </Chip>
                      </Td>
                      <Td>
                        <Chip
                          tone={
                            order.paymentStatus === "paid" ? "good" : "neutral"
                          }
                        >
                          {order.paymentMethod === "cod"
                            ? "On delivery"
                            : order.paymentStatus}
                        </Chip>
                      </Td>
                      <Td className="max-w-[10rem]">
                        {order.awb ? (
                          <span className="block truncate font-mono text-xs">
                            {order.awb}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                        {order.courier ? (
                          <span className="text-muted-foreground block truncate text-xs">
                            {order.courier}
                          </span>
                        ) : null}
                      </Td>
                      {/*
                        The total, and underneath it what the courier still has
                        to collect. The owner scans this column to know what
                        cash is owed on the round, so the balance belongs beside
                        the total rather than one click away.
                      */}
                      <Td numeric>
                        {formatPaise(order.grandTotal)}
                        {order.balanceDueOnDelivery > 0 ? (
                          <span className="text-muted-foreground block text-xs whitespace-nowrap">
                            {formatPaise(order.advanceAmount)} paid ·{" "}
                            {formatPaise(order.balanceDueOnDelivery)} at door
                          </span>
                        ) : null}
                      </Td>
                      <Td>
                        <Button variant="outline" size="sm" asChild>
                          <Link href={`/admin/orders/${order.id}`}>Open</Link>
                        </Button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
            <Pagination
              params={params}
              total={total}
              basePath="/admin/orders"
              extras={extras}
            />
          </>
        )}
      </AdminPage>
    </>
  );
}

function FilterChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={
        // 36px visual, 44px reach — the same bargain the `sm` button size makes,
        // because these sit above a table an owner taps at speed on a tablet.
        "relative inline-flex min-h-9 items-center rounded-sm px-3 font-mono text-xs tracking-[0.06em] uppercase transition-colors " +
        "before:absolute before:top-1/2 before:left-1/2 before:h-11 before:w-full before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] " +
        (active
          ? "bg-foreground text-background"
          : "bg-muted text-muted-foreground hover:text-foreground")
      }
    >
      {children}
    </Link>
  );
}

/** Short, shop-local, and never the raw ISO string. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}
