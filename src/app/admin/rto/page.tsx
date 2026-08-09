import type { Metadata } from "next";
import Link from "next/link";

import { Table, TableWrap, Td, Th } from "@/components/admin/table";
import {
  AdminPage,
  Chip,
  EmptyState,
  PageHeader,
  StatTile,
} from "@/components/admin/ui";
import { formatPaise } from "@/lib/format";
import { rtoOverview, type RtoOverviewRow } from "@/lib/orders/rto";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Returns to origin" };
export const dynamic = "force-dynamic";

/**
 * Which parcels came back, from where, and at what cost.
 *
 * Three questions, in the order the owner asks them: how much is coming back
 * (the tiles), what exactly and from which PIN codes (the table), and **who
 * keeps doing it** — a phone number on two or more RTO orders is flagged,
 * because repeat refusals concentrate the loss and the owner's remedy is
 * withdrawing Pay on Delivery from that one customer
 * (`profiles.cod_blocked_at`), not from the shop.
 *
 * Quoted and actual freight sit side by side on purpose. The quote is the
 * estimate frozen at checkout; the actual is what Shiprocket billed, typed in
 * from their panel on the order page. The gap between the two columns is the
 * forecast error the owner is paying for.
 *
 * Reads through the caller's RLS-bound client, like every list under
 * `/admin` — the admin policies let it through and a bug in this page still
 * hits a closed door in Postgres.
 */
export default async function AdminRtoPage() {
  const overview = await rtoOverview(await createClient());

  return (
    <>
      <PageHeader
        title="Returns to origin"
        description="Parcels the courier is bringing back, or has brought back. Receive and restock each one from its order page."
      />

      <AdminPage className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Came back"
            value={overview.rows.length}
            hint="Returning now, or returned with an RTO on record"
          />
          <StatTile
            label="Quoted return freight"
            value={formatPaise(overview.quotedTotalPaise)}
            hint="Estimates frozen at checkout"
          />
          <StatTile
            label="Actually charged"
            value={formatPaise(overview.actualTotalPaise)}
            hint="Typed from Shiprocket's panel, where recorded"
          />
          <StatTile
            label="Repeat phone numbers"
            value={overview.repeatPhoneCount}
            hint="On two or more RTO orders"
            tone={overview.repeatPhoneCount > 0 ? "warn" : "neutral"}
          />
        </div>

        {overview.rows.length === 0 ? (
          <EmptyState
            title="Nothing has come back"
            body="When a courier reports RTO, the order moves here on the next tracking refresh. Receiving and restocking happen on the order's own page."
            actionHref="/admin/orders?status=shipped"
            actionLabel="See what is on the road"
          />
        ) : (
          <TableWrap label="Returns to origin">
            <Table className="min-w-[56rem]">
              <thead>
                <tr>
                  <Th>Order</Th>
                  <Th>Reported</Th>
                  <Th>Status</Th>
                  <Th>PIN code</Th>
                  <Th>Phone</Th>
                  <Th numeric>Quoted</Th>
                  <Th numeric>Actual</Th>
                  <Th>The parcel</Th>
                </tr>
              </thead>
              <tbody>
                {overview.rows.map((row) => (
                  <tr key={row.id} className="hover:bg-muted/40">
                    <Td>
                      <Link
                        href={`/admin/orders/${row.id}`}
                        className="font-mono text-xs tracking-[0.06em] underline-offset-4 hover:underline"
                      >
                        {row.orderNumber}
                      </Link>
                    </Td>
                    <Td className="text-muted-foreground whitespace-nowrap">
                      {row.rtoAt ? formatDate(row.rtoAt) : "—"}
                    </Td>
                    <Td>
                      <Chip tone={row.status === "returning" ? "warn" : "bad"}>
                        {row.status}
                      </Chip>
                    </Td>
                    <Td className="font-mono text-xs">{row.pincode ?? "—"}</Td>
                    <Td>
                      <span className="font-mono text-xs">
                        {row.phone ?? "—"}
                      </span>
                      {row.repeatOffender ? (
                        <Chip tone="bad" className="ml-2">
                          repeat
                        </Chip>
                      ) : null}
                    </Td>
                    <Td numeric className="whitespace-nowrap">
                      {row.quotedRtoPaise !== null
                        ? formatPaise(row.quotedRtoPaise)
                        : "—"}
                    </Td>
                    <Td numeric className="whitespace-nowrap">
                      {row.actualRtoPaise !== null
                        ? formatPaise(row.actualRtoPaise)
                        : "—"}
                    </Td>
                    <Td className="text-muted-foreground text-xs whitespace-nowrap">
                      {parcelState(row)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </AdminPage>
    </>
  );
}

/**
 * Where each parcel is in the receive → inspect → restock walk, as one phrase.
 * The action always lives on the order page; this column only says how far it
 * has got, so the owner can scan for the ones still needing hands.
 */
function parcelState(row: RtoOverviewRow): string {
  if (row.restockedAt) return "restocked";
  if (row.condition === "damaged") return "damaged — written off";
  if (row.receivedAt) return "received, awaiting restock";
  if (row.status === "returned") return "returned, not yet received";
  return "on its way back";
}

/** Short, shop-local, and never the raw ISO string. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    timeZone: "Asia/Kolkata",
  });
}
