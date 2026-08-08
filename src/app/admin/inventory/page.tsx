import type { Metadata } from "next";
import Link from "next/link";

import { SearchField } from "@/components/admin/search-field";
import { StockCell } from "@/components/admin/stock-cell";
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
import {
  INVENTORY_SORTS,
  listInventory,
  LOW_STOCK_THRESHOLD,
  type InventorySort,
  type StockFilter,
} from "@/lib/queries/admin/inventory";

export const metadata: Metadata = { title: "Inventory" };
export const dynamic = "force-dynamic";

const FILTERS: { value: StockFilter; label: string }[] = [
  { value: "", label: "Every size" },
  { value: "out", label: "Sold out" },
  { value: "low", label: `${LOW_STOCK_THRESHOLD} or fewer` },
  { value: "in", label: "In stock" },
];

/**
 * Every size in the shop, with its count.
 *
 * One row per *variant*, not per product, because stock is a property of a size
 * and a colour and nothing else — a product-level view would make the owner
 * open something before they could see the number they came for.
 *
 * The count in each row is a button. See `StockCell` for why a note-bearing
 * ledger write cannot be a bare inline input, and why the movement history for
 * a size lives behind the same control.
 */
export default async function AdminInventoryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const params = parseListParams<InventorySort>(sp, {
    sortable: INVENTORY_SORTS,
    defaultSort: "stock_quantity",
    defaultDir: "asc",
    perPage: 50,
  });

  const stockParam = typeof sp.stock === "string" ? sp.stock : "";
  const stock: StockFilter = (["low", "out", "in"] as const).includes(
    stockParam as "low" | "out" | "in",
  )
    ? (stockParam as StockFilter)
    : "";

  const extras = { stock: stock || undefined };
  const { rows, total } = await listInventory(
    params,
    stock,
    LOW_STOCK_THRESHOLD,
  );

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Tap any number to change it. Every change is recorded with your name and the reason you give."
      />

      <AdminPage className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            label="Search inventory"
            placeholder="SKU, colour or size"
            hidden={extras}
          />
        </div>

        <nav
          aria-label="Filter by stock level"
          className="flex flex-wrap gap-1.5"
        >
          {FILTERS.map((filter) => (
            <Link
              key={filter.value || "all"}
              href={listHref(
                "/admin/inventory",
                params,
                { page: 1 },
                { stock: filter.value || undefined },
              )}
              aria-current={stock === filter.value ? "true" : undefined}
              className={
                "relative inline-flex min-h-9 items-center rounded-sm px-3 font-mono text-xs tracking-[0.06em] uppercase transition-colors " +
                "before:absolute before:top-1/2 before:left-1/2 before:h-11 before:w-full before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] " +
                (stock === filter.value
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
            title={params.q || stock ? "Nothing matches that" : "No sizes yet"}
            body={
              params.q || stock
                ? "Try a different search, or clear the filter to see every size."
                : "Sizes appear here once a product has them. Add a product and give it a size run."
            }
            actionHref={
              params.q || stock ? "/admin/inventory" : "/admin/products/new"
            }
            actionLabel={
              params.q || stock ? "Show every size" : "Add a product"
            }
          />
        ) : (
          <>
            <TableWrap label="Inventory">
              <Table className="min-w-[44rem]">
                <thead>
                  <tr>
                    <Th>Product</Th>
                    <SortableTh
                      column="size"
                      params={params}
                      basePath="/admin/inventory"
                      extras={extras}
                    >
                      Size
                    </SortableTh>
                    <Th>Colour</Th>
                    <SortableTh
                      column="sku"
                      params={params}
                      basePath="/admin/inventory"
                      extras={extras}
                    >
                      SKU
                    </SortableTh>
                    <Th>Listed</Th>
                    <SortableTh
                      column="stock_quantity"
                      params={params}
                      basePath="/admin/inventory"
                      extras={extras}
                      numeric
                      initialDir="asc"
                    >
                      In stock
                    </SortableTh>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.variantId} className="hover:bg-muted/40">
                      <Td className="max-w-[16rem]">
                        <Link
                          href={`/admin/products/${row.productId}`}
                          className="block truncate underline-offset-4 hover:underline"
                        >
                          {row.productName}
                        </Link>
                      </Td>
                      <Td className="font-mono text-xs whitespace-nowrap">
                        UK {row.size}
                      </Td>
                      <Td className="max-w-[10rem] truncate">{row.color}</Td>
                      <Td className="text-muted-foreground font-mono text-xs">
                        {row.sku}
                      </Td>
                      <Td>
                        {row.isActive ? (
                          <Chip tone="good">on</Chip>
                        ) : (
                          <Chip tone="neutral">off</Chip>
                        )}
                      </Td>
                      <Td numeric className="pr-1">
                        <StockCell
                          variantId={row.variantId}
                          productName={row.productName}
                          size={row.size}
                          color={row.color}
                          sku={row.sku}
                          stock={row.stock}
                          lowThreshold={LOW_STOCK_THRESHOLD}
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
              basePath="/admin/inventory"
              extras={extras}
            />
          </>
        )}
      </AdminPage>
    </>
  );
}
