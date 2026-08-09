import type { Metadata } from "next";
import Link from "next/link";

import { CouponForm } from "@/components/admin/coupons/coupon-form";
import { CouponRowActions } from "@/components/admin/coupons/coupon-row-actions";
import { SearchField } from "@/components/admin/search-field";
import {
  Pagination,
  SortableTh,
  Table,
  TableWrap,
  Td,
  Th,
} from "@/components/admin/table";
import { AdminPage, Chip, EmptyState, PageHeader } from "@/components/admin/ui";
import {
  listHref,
  parseListParams,
  type SearchParams,
} from "@/lib/admin/list-params";
import { formatPaise } from "@/lib/format";
import {
  COUPON_SORTS,
  listCoupons,
  type CouponFilter,
  type CouponSort,
} from "@/lib/queries/admin/coupons";

export const metadata: Metadata = { title: "Coupons" };
export const dynamic = "force-dynamic";

const FILTERS: { value: CouponFilter; label: string }[] = [
  { value: "", label: "All" },
  { value: "active", label: "Switched on" },
  { value: "inactive", label: "Switched off" },
  { value: "scheduled", label: "Not started yet" },
  { value: "expired", label: "Expired" },
];

/**
 * The codes the shop honours. Every rule shown here is enforced inside the
 * order transaction — this screen manages the rows, it does not do the
 * arithmetic.
 */
export default async function AdminCouponsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const params = parseListParams<CouponSort>(sp, {
    sortable: COUPON_SORTS,
    defaultSort: "created_at",
    defaultDir: "desc",
  });

  const showParam = typeof sp.show === "string" ? sp.show : "";
  const filter: CouponFilter = (
    ["active", "inactive", "scheduled", "expired"] as const
  ).includes(showParam as "active")
    ? (showParam as CouponFilter)
    : "";

  const extras = { show: filter || undefined };
  const { rows, total } = await listCoupons(params, filter);

  return (
    <>
      <PageHeader
        title="Coupons"
        description="Codes customers type in their bag. Discounts come off the goods only, never delivery."
      >
        <CouponForm triggerLabel="Add coupon" triggerVariant="default" />
      </PageHeader>

      <AdminPage className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            label="Search coupons"
            placeholder="Code"
            hidden={extras}
          />
        </div>

        <nav aria-label="Filter coupons" className="flex flex-wrap gap-1.5">
          {FILTERS.map((option) => (
            <Link
              key={option.value || "all"}
              href={listHref(
                "/admin/coupons",
                params,
                { page: 1 },
                { show: option.value || undefined },
              )}
              aria-current={filter === option.value ? "true" : undefined}
              className={
                "relative inline-flex min-h-9 items-center rounded-sm px-3 font-mono text-xs tracking-[0.06em] uppercase transition-colors " +
                "before:absolute before:top-1/2 before:left-1/2 before:h-11 before:w-full before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] " +
                (filter === option.value
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:text-foreground")
              }
            >
              {option.label}
            </Link>
          ))}
        </nav>

        {rows.length === 0 ? (
          params.q || filter ? (
            <EmptyState
              title="Nothing matches that"
              body="No code contains that. Try a shorter search, or clear the filter."
              actionHref="/admin/coupons"
              actionLabel="Show every coupon"
            />
          ) : (
            <div className="space-y-3">
              <EmptyState
                title="No coupons yet"
                body="A coupon is a code a customer types in their bag for money off the goods. Set the value, the window and who may use it — every rule is enforced at the moment the order is placed."
              />
              <div className="flex justify-center">
                <CouponForm
                  triggerLabel="Add the first coupon"
                  triggerVariant="default"
                />
              </div>
            </div>
          )
        ) : (
          <>
            <TableWrap label="Coupons">
              <Table className="min-w-[62rem]">
                <thead>
                  <tr>
                    <SortableTh
                      column="code"
                      params={params}
                      basePath="/admin/coupons"
                      extras={extras}
                    >
                      Code
                    </SortableTh>
                    <Th>Worth</Th>
                    <Th>Window (IST)</Th>
                    <Th numeric>Used</Th>
                    <Th>Per customer</Th>
                    <Th>Who</Th>
                    <Th>State</Th>
                    <Th className="text-right">Edit</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((coupon) => (
                    <tr key={coupon.id} className="hover:bg-muted/40">
                      <Td className="max-w-[10rem]">
                        <Link
                          href={`/admin/coupons/${coupon.id}`}
                          className="block truncate font-mono font-medium underline-offset-4 hover:underline"
                        >
                          {coupon.code}
                        </Link>
                      </Td>
                      <Td className="whitespace-nowrap">
                        {coupon.type === "percent"
                          ? `${coupon.value}% off`
                          : `${formatPaise(coupon.value)} off`}
                        {coupon.maxDiscount ? (
                          <span className="text-muted-foreground">
                            {" "}
                            (max {formatPaise(coupon.maxDiscount)})
                          </span>
                        ) : null}
                        {coupon.minOrderValue > 0 ? (
                          <span className="text-muted-foreground block text-xs">
                            over {formatPaise(coupon.minOrderValue)}
                          </span>
                        ) : null}
                      </Td>
                      <Td className="text-muted-foreground text-xs whitespace-nowrap">
                        {couponWindow(coupon.startsAt, coupon.expiresAt)}
                      </Td>
                      <Td numeric>
                        <span className="font-mono">
                          {coupon.usedCount}
                          {coupon.usageLimit !== null
                            ? ` / ${coupon.usageLimit}`
                            : ""}
                        </span>
                      </Td>
                      <Td className="text-muted-foreground">
                        {coupon.perUserLimit ?? "—"}
                      </Td>
                      <Td>
                        {coupon.audience === "everyone" ? (
                          <span className="text-muted-foreground">Everyone</span>
                        ) : (
                          <Chip tone="neutral">
                            {coupon.audienceMembers.length} customer
                            {coupon.audienceMembers.length === 1 ? "" : "s"}
                          </Chip>
                        )}
                      </Td>
                      <Td>{stateChip(coupon)}</Td>
                      <Td className="pr-1">
                        <CouponRowActions
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
                          audience={coupon.audienceMembers}
                          redemptionCount={coupon.redemptionCount}
                        />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>

            <Pagination
              params={params}
              total={total}
              basePath="/admin/coupons"
              extras={extras}
            />
          </>
        )}
      </AdminPage>
    </>
  );
}

function formatIST(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}

function couponWindow(startsAt: string | null, expiresAt: string | null): string {
  if (!startsAt && !expiresAt) return "Always";
  const from = startsAt ? formatIST(startsAt) : "now";
  const to = expiresAt ? formatIST(expiresAt) : "no end";
  return `${from} → ${to}`;
}

function stateChip(coupon: {
  isActive: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  usageLimit: number | null;
  usedCount: number;
}) {
  if (!coupon.isActive) return <Chip tone="neutral">off</Chip>;
  const now = Date.now();
  if (coupon.expiresAt && now >= Date.parse(coupon.expiresAt))
    return <Chip tone="neutral">expired</Chip>;
  if (coupon.startsAt && now < Date.parse(coupon.startsAt))
    return <Chip tone="warn">not started</Chip>;
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit)
    return <Chip tone="warn">used up</Chip>;
  return <Chip tone="good">live</Chip>;
}
