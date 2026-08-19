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
  inventoryDrift,
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
  const [{ rows, total }, drift] = await Promise.all([
    listInventory(params, stock, LOW_STOCK_THRESHOLD),
    /**
     * Checked on every render rather than behind a button, because a button is
     * a thing nobody presses. It is one aggregate over an indexed table and it
     * answers zero rows on a healthy shop.
     *
     * A failed check renders as a failed check. `null` here means "we could not
     * ask", which is not the same as "nothing is wrong" and must not look like
     * it.
     */
    inventoryDrift().catch(() => null),
  ]);

  return (
    <>
      <PageHeader
        title="Inventory"
        description="How many of each size and colour you have. Come here after a delivery, a stocktake, or when a number looks wrong. Tap any number to change it — every change is recorded with your name and the reason you give. Opens with the sizes you have none of, at the top."
      />

      <AdminPage className="space-y-4">
        {/*
          Drift means the ledger and the count disagree — the ledger is the only
          record of *why* a number is what it is, so a drifting size is one
          nobody can be asked about. It has been detectable since Phase 5 and
          was only ever reachable from a test script.
        */}
        {drift === null ? (
          <p
            role="status"
            className="border-state-low/50 bg-state-low/5 rounded-md border p-3 text-sm text-pretty"
          >
            <strong>The stock check could not run.</strong> That is not the same
            as everything being correct — it means we could not compare the
            counts against their history just now. Reload in a moment.
          </p>
        ) : drift.length > 0 ? (
          <div
            role="status"
            className="border-destructive/50 bg-destructive/5 rounded-md border p-3 text-sm text-pretty"
          >
            <p>
              <strong>
                {drift.length === 1
                  ? "One size does not match its history."
                  : `${drift.length} sizes do not match their history.`}
              </strong>{" "}
              The count says one thing and the record of every change says
              another, so somebody has changed a number outside this screen.
              Correct the count here and give a reason, and the two agree again.
            </p>
            <ul className="mt-2 space-y-1 font-mono text-xs">
              {drift.slice(0, 8).map((row) => (
                <li key={row.variantId} className="tabular-nums">
                  {row.sku} — counted {row.stock}, history says {row.ledgerTotal}{" "}
                  ({row.drift > 0 ? "+" : ""}
                  {row.drift})
                </li>
              ))}
            </ul>
            {drift.length > 8 ? (
              <p className="text-muted-foreground mt-1 text-xs">
                …and {drift.length - 8} more.
              </p>
            ) : null}
          </div>
        ) : null}
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
                    {/* stickyEnd: the count is the row's action (StockCell is
                        a button), and on a phone it sat at x=688 in a 360px
                        viewport — the brands bug, found by the 2026-08-20
                        sweep. */}
                    <SortableTh
                      column="stock_quantity"
                      params={params}
                      basePath="/admin/inventory"
                      extras={extras}
                      numeric
                      initialDir="asc"
                      stickyEnd
                    >
                      This size
                    </SortableTh>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.variantId} className="group/row hover:bg-muted/40">
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
                      <Td numeric className="pr-1" stickyEnd>
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
