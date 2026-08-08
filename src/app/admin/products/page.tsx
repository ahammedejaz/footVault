import type { Metadata } from "next";
import Link from "next/link";

import { ProductTable } from "@/components/admin/products/product-table";
import { SearchField } from "@/components/admin/search-field";
import { Pagination } from "@/components/admin/table";
import { AdminPage, EmptyState, PageHeader } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import {
  listHref,
  parseListParams,
  type SearchParams,
} from "@/lib/admin/list-params";
import {
  listAdminProducts,
  PRODUCT_SORTS,
  PRODUCT_STATUSES,
  type ProductSort,
  type ProductStatus,
} from "@/lib/queries/admin/products";

export const metadata: Metadata = { title: "Products" };
export const dynamic = "force-dynamic";

const BASE = "/admin/products";

const FILTERS: { value: ProductStatus; label: string }[] = [
  { value: "", label: "Everything" },
  { value: "live", label: "On the shop" },
  { value: "hidden", label: "Hidden" },
  { value: "removed", label: "Removed" },
];

/**
 * Everything the shop sells.
 *
 * The filter is a row of links rather than a `<select>`, for the reason the
 * orders page gives: on a tablet a native select is a full-screen wheel for a
 * choice between four things, and each view being a URL is what lets the
 * dashboard and the empty states point straight at one.
 *
 * **"Removed" is a filter and not a hidden corner.** Deleting a product that
 * has ever been ordered soft-deletes it — `admin_delete_product` decides that,
 * not this page — and a soft-deleted row with no screen that lists it is a
 * product the owner has lost rather than hidden.
 */
export default async function AdminProductsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const params = parseListParams<ProductSort>(sp, {
    sortable: PRODUCT_SORTS,
    defaultSort: "updated_at",
    defaultDir: "desc",
  });

  const statusParam = typeof sp.status === "string" ? sp.status : "";
  const status: ProductStatus = (
    PRODUCT_STATUSES as readonly string[]
  ).includes(statusParam)
    ? (statusParam as ProductStatus)
    : "";

  const extras = { status: status || undefined };
  const { rows, total } = await listAdminProducts(params, status);

  const filtering = Boolean(params.q || status);

  return (
    <>
      <PageHeader
        title="Products"
        description="What the shop sells. Come here to add a shoe, change its price or photographs, or take it off the shop. For changing how many of a size you have, use Inventory."
      >
        <Button size="sm" asChild>
          <Link href={`${BASE}/new`}>Add a product</Link>
        </Button>
      </PageHeader>

      <AdminPage className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            label="Search products"
            placeholder="Name, web address or SKU"
            hidden={extras}
          />
        </div>

        <nav aria-label="Filter products" className="flex flex-wrap gap-1.5">
          {FILTERS.map((filter) => (
            <Link
              key={filter.value || "all"}
              href={listHref(
                BASE,
                params,
                { page: 1 },
                { status: filter.value || undefined },
              )}
              aria-current={status === filter.value ? "true" : undefined}
              className={
                // 36px visual, 44px reach — the bargain the `sm` button size
                // makes, because these sit above a table tapped at speed.
                "relative inline-flex min-h-9 items-center rounded-sm px-3 font-mono text-xs tracking-[0.06em] uppercase transition-colors " +
                "before:absolute before:top-1/2 before:left-1/2 before:h-11 before:w-full before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] " +
                (status === filter.value
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:text-foreground")
              }
            >
              {filter.label}
            </Link>
          ))}
        </nav>

        {rows.length === 0 ? (
          <EmptyState
            title={
              filtering
                ? "Nothing matches that"
                : "There is nothing in the shop yet"
            }
            body={
              filtering
                ? "Try a different search, or clear the filter to see everything."
                : "Start with one pair: give it a name and a price, add the sizes you have, and put a photograph on it. You can put it on the shop when it looks right."
            }
            actionHref={filtering ? BASE : `${BASE}/new`}
            actionLabel={
              filtering ? "Show everything" : "Add your first product"
            }
          />
        ) : (
          <>
            <ProductTable
              rows={rows}
              params={params}
              basePath={BASE}
              extras={extras}
            />
            <Pagination
              params={params}
              total={total}
              basePath={BASE}
              extras={extras}
            />
          </>
        )}
      </AdminPage>
    </>
  );
}
