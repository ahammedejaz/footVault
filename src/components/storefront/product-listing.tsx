import { EmptyState } from "@/components/storefront/empty-state";
import {
  ActiveFilters,
  FilterSheet,
  FilterSidebar,
  Pagination,
  SortLinks,
} from "@/components/storefront/filter-panel";
import { ProductGrid } from "@/components/storefront/product-card";
import { getFilterFacets, listProducts, type ProductFilters } from "@/lib/queries/catalog";
import { parseFilters, type RawSearchParams } from "@/lib/queries/search-params";

/**
 * The listing, shared by /shop, /shop/[category] and /search.
 *
 * All three differ only in their heading and their fixed filter, so the layout,
 * the facets, the sort and the pagination live here once.
 */
export async function ProductListing({
  params,
  pathname,
  overrides,
  title,
  description,
  emptyBody,
}: {
  params: RawSearchParams;
  pathname: string;
  overrides?: Partial<ProductFilters>;
  title: string;
  description?: string | null;
  emptyBody?: string;
}) {
  const filters = parseFilters(params, overrides);
  const [{ products, total, page, pageCount }, facets] = await Promise.all([
    listProducts(filters),
    getFilterFacets({ categorySlug: overrides?.categorySlug }),
  ]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:py-14">
      <header className="max-w-2xl">
        <h1 className="font-display text-4xl font-extrabold tracking-[-0.03em] uppercase">
          {title}
        </h1>
        {description ? (
          <p className="text-muted-foreground mt-3 text-base text-pretty">
            {description}
          </p>
        ) : null}
      </header>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <FilterSheet
            facets={facets}
            params={params}
            pathname={pathname}
            total={total}
          />
          <p
            className="text-muted-foreground font-mono text-xs tracking-[0.06em]"
            aria-live="polite"
          >
            {total} {total === 1 ? "style" : "styles"}
          </p>
        </div>
        <SortLinks params={params} pathname={pathname} />
      </div>

      <div className="mt-4">
        <ActiveFilters params={params} pathname={pathname} />
      </div>

      <div className="mt-8 flex gap-10">
        <FilterSidebar facets={facets} params={params} pathname={pathname} />

        <div className="min-w-0 flex-1">
          {products.length === 0 ? (
            <EmptyState
              title="Nothing matches that"
              body={
                emptyBody ??
                "No shoe in the shop fits every filter at once. Try dropping one — the size run on each card shows what we hold."
              }
              action={{ href: pathname, label: "Clear the filters" }}
            />
          ) : (
            <>
              <ProductGrid products={products} />
              <Pagination
                params={params}
                pathname={pathname}
                page={page}
                pageCount={pageCount}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
