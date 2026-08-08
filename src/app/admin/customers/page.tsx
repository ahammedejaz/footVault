import { CodBlockControl } from "@/components/admin/customers/cod-block-control";
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
import { AdminPage, EmptyState, PageHeader } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import { parseListParams, type SearchParams } from "@/lib/admin/list-params";
import { formatPaise } from "@/lib/format";
import {
  CUSTOMER_SORTS,
  listCustomers,
  type CustomerSort,
} from "@/lib/queries/admin/customers";

export const metadata: Metadata = { title: "Customers" };
export const dynamic = "force-dynamic";

/**
 * Who has bought what.
 *
 * **This screen reads and does nothing else, on purpose.** There is no edit
 * control, no delete, no password reset and no role switch anywhere on it or in
 * the module behind it — not because those are hard, but because a shop tablet
 * spends its day unlocked on a counter and the blast radius of a mis-tap on
 * somebody else's account is not worth the convenience. Changing a customer's
 * details is something the customer does from their own account page.
 *
 * The columns are the two halves of one question — who is this, and what have
 * they bought — and nothing else is read. No addresses, no order contents, no
 * auth fields.
 *
 * **Only name and joined-date sort.** Orders, spend and last-order are
 * aggregates over a second table; PostgREST cannot order by one, and sorting
 * them in the query module would sort the twenty-five rows on the current page
 * while looking like it had sorted all of them. A wrong sort the owner cannot
 * see is worse than a missing one. See `src/lib/queries/admin/customers.ts`.
 *
 * **Guests are not here.** A guest checkout has no account to list; those
 * orders are on the orders screen, searchable by the phone number or email
 * given at the till.
 */
export default async function AdminCustomersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const params = parseListParams<CustomerSort>(sp, {
    sortable: CUSTOMER_SORTS,
    defaultSort: "created_at",
    defaultDir: "desc",
  });

  const { rows, total } = await listCustomers(params);

  return (
    <>
      <PageHeader
        title="Customers"
        description="Everyone with an account, and what they have spent. Come here to see who is worth keeping and to stop Pay on Delivery for anyone who keeps refusing parcels. Names and addresses are theirs to change, not yours."
      />

      <AdminPage className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            label="Search customers"
            placeholder="Name, email or phone"
          />
        </div>

        {rows.length === 0 ? (
          <EmptyState
            title={params.q ? "Nobody matches that" : "No customers yet"}
            body={
              params.q
                ? "Try part of a name, the phone number, or the email address they ordered with. Guest checkouts are on the orders screen instead."
                : "An account appears here the first time somebody registers. Share the shop, and take an order — a guest checkout shows up on the orders screen rather than here."
            }
            actionHref={params.q ? "/admin/customers" : "/admin/orders"}
            actionLabel={params.q ? "Show everyone" : "See orders"}
          />
        ) : (
          <>
            <TableWrap label="Customers">
              <Table className="min-w-[50rem]">
                <thead>
                  <tr>
                    <SortableTh
                      column="full_name"
                      params={params}
                      basePath="/admin/customers"
                    >
                      Name
                    </SortableTh>
                    <Th>Contact</Th>
                    <Th numeric>Orders</Th>
                    <Th numeric>Spent</Th>
                    <Th>Last order</Th>
                    <SortableTh
                      column="created_at"
                      params={params}
                      basePath="/admin/customers"
                      initialDir="desc"
                    >
                      Joined
                    </SortableTh>
                    <Th className="text-right">Pay on Delivery</Th>
                    <Th className="text-right">Orders</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((customer) => {
                    // The orders screen searches order number, phone and email.
                    // Email first because it is the one a customer spells
                    // correctly on the telephone.
                    const lookup = customer.email ?? customer.phone;
                    return (
                      <tr key={customer.id} className="hover:bg-muted/40">
                        <Td className="max-w-[14rem]">
                          <span className="block truncate font-medium">
                            {customer.name ?? "No name given"}
                          </span>
                        </Td>
                        <Td className="max-w-[16rem]">
                          <span className="block truncate">
                            {customer.email ?? (
                              <span className="text-muted-foreground">
                                No email on any order
                              </span>
                            )}
                          </span>
                          <span className="text-muted-foreground block truncate font-mono text-xs">
                            {customer.phone ?? "—"}
                          </span>
                        </Td>
                        <Td numeric>
                          {customer.orderCount === 0 ? (
                            <span className="text-muted-foreground">0</span>
                          ) : (
                            customer.orderCount
                          )}
                        </Td>
                        <Td numeric>
                          {customer.lifetimeValue === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            formatPaise(customer.lifetimeValue)
                          )}
                        </Td>
                        <Td className="text-muted-foreground whitespace-nowrap">
                          {customer.lastOrderAt
                            ? formatDate(customer.lastOrderAt)
                            : "Never"}
                        </Td>
                        <Td className="text-muted-foreground whitespace-nowrap">
                          {formatDate(customer.joinedAt)}
                        </Td>
                        <Td className="text-right">
                          <CodBlockControl
                            customerId={customer.id}
                            customerName={customer.name ?? "this customer"}
                            blocked={customer.codBlockedAt !== null}
                            reason={customer.codBlockedReason}
                          />
                        </Td>
                        <Td className="pr-1 text-right">
                          {customer.orderCount > 0 && lookup ? (
                            <Button variant="outline" size="sm" asChild>
                              <Link
                                href={`/admin/orders?q=${encodeURIComponent(lookup)}`}
                              >
                                Open
                                <span className="sr-only">
                                  {" "}
                                  the orders for{" "}
                                  {customer.name ?? "this customer"}
                                </span>
                              </Link>
                            </Button>
                          ) : (
                            <span className="text-muted-foreground text-xs">
                              {customer.orderCount > 0
                                ? "No email or phone to search by"
                                : "—"}
                            </span>
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </TableWrap>

            <Pagination
              params={params}
              total={total}
              basePath="/admin/customers"
            />

            <p className="text-muted-foreground text-sm text-pretty">
              Spent excludes cancelled and returned orders. The email shown is
              the one used on their most recent order — somebody who has never
              ordered has none here.
            </p>
          </>
        )}
      </AdminPage>
    </>
  );
}

/** Short, shop-local, and never the raw ISO string. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}
