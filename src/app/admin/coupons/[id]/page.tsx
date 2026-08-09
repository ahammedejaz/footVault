import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CouponForm } from "@/components/admin/coupons/coupon-form";
import { Table, TableWrap, Td, Th } from "@/components/admin/table";
import { AdminPage, Chip, EmptyState, PageHeader } from "@/components/admin/ui";
import { formatPaise } from "@/lib/format";
import { getCoupon } from "@/lib/queries/admin/coupons";

export const metadata: Metadata = { title: "Coupon" };
export const dynamic = "force-dynamic";

/**
 * One coupon: its terms, who it is for, and the ledger of who used it.
 *
 * The redemptions table is the §9F requirement asked for by name — "who used
 * it, on which order, for how much" — and the `released` chip is the part
 * that keeps the counter honest: a cancelled order gives the use back, and a
 * ledger that hid that would disagree with `used / limit` on the list page.
 */
export default async function AdminCouponPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const coupon = await getCoupon(id);
  if (!coupon) notFound();

  return (
    <>
      <PageHeader
        title={coupon.code}
        description={
          coupon.type === "percent"
            ? `${coupon.value}% off the goods${coupon.maxDiscount ? `, capped at ${formatPaise(coupon.maxDiscount)}` : ""}.`
            : `${formatPaise(coupon.value)} off the goods.`
        }
      >
        <CouponForm
          coupon={{
            id: coupon.id,
            code: coupon.code,
            type: coupon.type,
            value: coupon.value,
            minOrderValue: coupon.minOrderValue,
            maxDiscount: coupon.maxDiscount,
            usageLimit: coupon.usageLimit,
            perUserLimit: coupon.perUserLimit,
            audience: coupon.audience,
            startsAt: coupon.startsAt,
            expiresAt: coupon.expiresAt,
            isActive: coupon.isActive,
          }}
          audience={coupon.customers}
          triggerLabel="Edit"
        />
      </PageHeader>

      <AdminPage className="space-y-6">
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="State">
            {coupon.isActive ? (
              <Chip tone="good">switched on</Chip>
            ) : (
              <Chip tone="neutral">switched off</Chip>
            )}
          </Fact>
          <Fact label="Window (IST)">
            {coupon.startsAt || coupon.expiresAt
              ? `${coupon.startsAt ? formatIST(coupon.startsAt) : "now"} → ${coupon.expiresAt ? formatIST(coupon.expiresAt) : "no end"}`
              : "Always on while switched on"}
          </Fact>
          <Fact label="Used">
            {coupon.usedCount}
            {coupon.usageLimit !== null ? ` of ${coupon.usageLimit}` : ""}
            {coupon.perUserLimit !== null
              ? ` · ${coupon.perUserLimit} per customer`
              : ""}
          </Fact>
          <Fact label="Minimum order">
            {coupon.minOrderValue > 0
              ? formatPaise(coupon.minOrderValue)
              : "None"}
          </Fact>
        </dl>

        {coupon.audience === "specific_customers" ? (
          <section className="space-y-2">
            <h2 className="font-mono text-xs tracking-[0.06em] uppercase">
              Who may use it
            </h2>
            {coupon.customers.length ? (
              <ul className="text-sm">
                {coupon.customers.map((customer) => (
                  <li key={customer.userId} className="py-1">
                    <Link
                      href={`/admin/customers?q=${encodeURIComponent(customer.name ?? "")}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {customer.name ?? "Unnamed customer"}
                    </Link>
                    {customer.email ? (
                      <span className="text-muted-foreground">
                        {" "}
                        · {customer.email}
                      </span>
                    ) : null}
                    {customer.phone ? (
                      <span className="text-muted-foreground">
                        {" "}
                        · {customer.phone}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-destructive text-sm text-pretty">
                The list is empty, so this code refuses everyone. Add people in
                Edit, or switch the audience to Everyone.
              </p>
            )}
          </section>
        ) : null}

        <section className="space-y-2">
          <h2 className="font-mono text-xs tracking-[0.06em] uppercase">
            Redemptions
          </h2>
          {coupon.redemptions.length === 0 ? (
            <EmptyState
              title="Not used yet"
              body="Every order this code discounts will be listed here, with what it took off."
            />
          ) : (
            <TableWrap label="Redemptions">
              <Table className="min-w-[40rem]">
                <thead>
                  <tr>
                    <Th>Order</Th>
                    <Th>Customer</Th>
                    <Th numeric>Took off</Th>
                    <Th>When (IST)</Th>
                    <Th>State</Th>
                  </tr>
                </thead>
                <tbody>
                  {coupon.redemptions.map((redemption) => (
                    <tr key={redemption.id} className="hover:bg-muted/40">
                      <Td>
                        <Link
                          href={`/admin/orders/${redemption.orderId}`}
                          className="font-mono underline-offset-4 hover:underline"
                        >
                          {redemption.orderNumber ?? redemption.orderId.slice(0, 8)}
                        </Link>
                      </Td>
                      <Td className="text-muted-foreground">
                        {redemption.customerName ?? "Guest"}
                      </Td>
                      <Td numeric>
                        <span className="font-mono">
                          −{formatPaise(redemption.discountPaise)}
                        </span>
                      </Td>
                      <Td className="text-muted-foreground whitespace-nowrap">
                        {formatIST(redemption.redeemedAt)}
                      </Td>
                      <Td>
                        {redemption.releasedAt ? (
                          <Chip tone="neutral">released</Chip>
                        ) : (
                          <Chip tone="good">stands</Chip>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </section>
      </AdminPage>
    </>
  );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-border rounded-lg border p-3">
      <dt className="text-muted-foreground font-mono text-xs tracking-[0.06em] uppercase">
        {label}
      </dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}

function formatIST(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}
