import type { Metadata } from "next";
import Link from "next/link";

import { BrandForm } from "@/components/admin/brands/brand-form";
import { BrandRowActions } from "@/components/admin/brands/brand-row-actions";
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
import {
  BRAND_SORTS,
  listBrands,
  type BrandFilter,
  type BrandSort,
} from "@/lib/queries/admin/brands";

export const metadata: Metadata = { title: "Brands" };
export const dynamic = "force-dynamic";

const FILTERS: { value: BrandFilter; label: string }[] = [
  { value: "", label: "All" },
  { value: "active", label: "In the shop" },
  { value: "inactive", label: "Hidden" },
];

/**
 * The makers the shop stocks.
 *
 * A flat table, unlike categories, so it takes the panel's usual furniture
 * whole: server-side paging, sortable headers, a search box that writes to the
 * URL. The one thing it does differently is the delete control, which is only
 * rendered for a brand nothing is using — see `BrandRowActions` for why a
 * button that always refuses is worse than no button.
 */
export default async function AdminBrandsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const params = parseListParams<BrandSort>(sp, {
    sortable: BRAND_SORTS,
    defaultSort: "name",
    defaultDir: "asc",
  });

  const showParam = typeof sp.show === "string" ? sp.show : "";
  const filter: BrandFilter = (["active", "inactive"] as const).includes(
    showParam as "active" | "inactive",
  )
    ? (showParam as BrandFilter)
    : "";

  const extras = { show: filter || undefined };
  const { rows, total } = await listBrands(params, filter);

  return (
    <>
      <PageHeader
        title="Brands"
        description="Every maker a product can carry. Customers filter the shop by these."
      >
        <BrandForm triggerLabel="Add brand" triggerVariant="default" />
      </PageHeader>

      <AdminPage className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            label="Search brands"
            placeholder="Name or web address"
            hidden={extras}
          />
        </div>

        <nav aria-label="Filter brands" className="flex flex-wrap gap-1.5">
          {FILTERS.map((option) => (
            <Link
              key={option.value || "all"}
              href={listHref(
                "/admin/brands",
                params,
                { page: 1 },
                { show: option.value || undefined },
              )}
              aria-current={filter === option.value ? "true" : undefined}
              className={
                // 36px visual, 44px reach — the same bargain the `sm` button
                // size makes, because these sit above a table an owner taps at
                // speed on a tablet.
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
              body="No brand name or web address contains that. Try a shorter search, or clear the filter."
              actionHref="/admin/brands"
              actionLabel="Show every brand"
            />
          ) : (
            <div className="space-y-3">
              <EmptyState
                title="No brands yet"
                body="A brand is the maker on a product — Nike, Bata, Woodland. Add the ones you stock and customers can filter the shop by them."
              />
              <div className="flex justify-center">
                <BrandForm
                  triggerLabel="Add the first brand"
                  triggerVariant="default"
                />
              </div>
            </div>
          )
        ) : (
          <>
            <TableWrap label="Brands">
              <Table className="min-w-[46rem]">
                <thead>
                  <tr>
                    <Th className="w-14">Logo</Th>
                    <SortableTh
                      column="name"
                      params={params}
                      basePath="/admin/brands"
                      extras={extras}
                    >
                      Name
                    </SortableTh>
                    <SortableTh
                      column="slug"
                      params={params}
                      basePath="/admin/brands"
                      extras={extras}
                    >
                      Web address
                    </SortableTh>
                    <Th numeric>Products</Th>
                    <Th>In the shop</Th>
                    <SortableTh
                      column="created_at"
                      params={params}
                      basePath="/admin/brands"
                      extras={extras}
                      initialDir="desc"
                    >
                      Added
                    </SortableTh>
                    <Th className="text-right" stickyEnd>
                      Edit
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((brand) => (
                    <tr
                      key={brand.id}
                      className="group/row hover:bg-muted/40"
                    >
                      <Td>
                        {/*
                          A logo address the owner pasted is not necessarily one
                          of next.config's remotePatterns, and the optimiser
                          answers 400 rather than degrading. A 36px thumbnail on
                          an admin screen is not worth a broken image on the very
                          page that exists to manage it.
                        */}
                        {brand.logoUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element -- unoptimisable by design; see the note above
                          <img
                            src={brand.logoUrl}
                            alt=""
                            className="border-border size-9 rounded-sm border object-contain"
                          />
                        ) : (
                          <span
                            className="bg-muted text-muted-foreground flex size-9 items-center justify-center rounded-sm font-mono text-xs"
                            aria-hidden
                          >
                            {brand.name.slice(0, 2).toUpperCase()}
                          </span>
                        )}
                      </Td>
                      <Td className="max-w-[14rem]">
                        <span className="block truncate font-medium">
                          {brand.name}
                        </span>
                      </Td>
                      <Td className="text-muted-foreground max-w-[12rem]">
                        <span className="block truncate font-mono text-xs">
                          {brand.slug}
                        </span>
                      </Td>
                      <Td numeric>
                        {brand.productCount > 0 ? (
                          <Link
                            href={`/admin/products?brand=${brand.slug}`}
                            className="underline-offset-4 hover:underline"
                          >
                            {brand.productCount}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </Td>
                      <Td>
                        {brand.isActive ? (
                          <Chip tone="good">shown</Chip>
                        ) : (
                          <Chip tone="neutral">hidden</Chip>
                        )}
                      </Td>
                      <Td className="text-muted-foreground whitespace-nowrap">
                        {formatDate(brand.createdAt)}
                      </Td>
                      <Td className="pr-1" stickyEnd>
                        <BrandRowActions
                          brand={{
                            id: brand.id,
                            name: brand.name,
                            slug: brand.slug,
                            logoUrl: brand.logoUrl,
                            isActive: brand.isActive,
                          }}
                          productCount={brand.productCount}
                          productCountIncludingHidden={
                            brand.productCountIncludingDeleted
                          }
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
              basePath="/admin/brands"
              extras={extras}
            />
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
