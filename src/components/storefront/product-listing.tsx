import Link from "next/link";
import { Suspense } from "react";

import {
  ActiveFilters,
  FilterPanelSheet,
  FilterRail,
  FilterTrigger,
  Pagination,
  SortLinks,
} from "@/components/storefront/filter-panel";
import { ProductGrid } from "@/components/storefront/product-card";
import { ScrollRestore } from "@/components/storefront/scroll-restore";
import { listProducts, type ProductFilters } from "@/lib/queries/catalog";
import {
  activeFilterChips,
  clearedHref,
  parseFilters,
  type RawSearchParams,
} from "@/lib/queries/search-params";
import { formatPaise } from "@/lib/format";

/**
 * The listing, shared by /shop, /shop/[category], /collection/[slug] and
 * /search. All four differ only in their heading and their fixed filter, so
 * the layout, the facets, the sort and the pagination live here once.
 */
export async function ProductListing({
  params,
  pathname,
  overrides,
  heading,
  eyebrow,
  description,
  escape,
}: {
  params: RawSearchParams;
  pathname: string;
  overrides?: Partial<ProductFilters>;
  heading: string;
  eyebrow?: string;
  description?: string | null;
  /** Where an empty result should send someone. The parent category, usually. */
  escape?: { href: string; label: string };
}) {
  const filters = parseFilters(params, overrides);
  const { products, total, page, pageCount, facets } = await listProducts(filters);

  const chips = activeFilterChips(params, pathname, facets, formatPaise);
  const cleared = clearedHref(params, pathname);
  const countLabel = `${total} ${total === 1 ? "style" : "styles"}`;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:py-12">
      <Suspense fallback={null}>
        <ScrollRestore />
      </Suspense>

      <header className="max-w-2xl">
        {eyebrow ? (
          <p className="text-muted-foreground font-mono text-xs tracking-[0.14em] uppercase">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="font-display mt-2 text-4xl font-extrabold tracking-[-0.03em] text-balance uppercase">
          {heading}
        </h1>
        {description ? (
          <p className="text-muted-foreground mt-3 text-base text-pretty">
            {description}
          </p>
        ) : null}
      </header>

      <div className="border-border mt-8 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b pb-4">
        <div className="flex items-center gap-3">
          <FilterTrigger
            params={params}
            pathname={pathname}
            activeCount={chips.length}
          />
          {/*
            The count is the one thing on this page that must never be stale or
            hidden, so it is announced as well as shown: a customer who applies
            a filter with a screen reader on hears the new number without having
            to go looking for it.
          */}
          <p
            className="text-muted-foreground font-mono text-xs tracking-[0.06em]"
            aria-live="polite"
            aria-atomic="true"
          >
            {countLabel}
          </p>
        </div>
        <SortLinks
          params={params}
          pathname={pathname}
          hasQuery={Boolean(filters.search)}
        />
      </div>

      {chips.length > 0 ? (
        <div className="mt-4">
          <ActiveFilters params={params} pathname={pathname} facets={facets} />
        </div>
      ) : null}

      <div className="mt-8 flex gap-10">
        <FilterRail facets={facets} params={params} pathname={pathname} />

        <div className="min-w-0 flex-1">
          {products.length === 0 ? (
            <EmptyResult
              chips={chips.length}
              clearedHref={cleared}
              escape={escape}
              query={filters.search}
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

      <FilterPanelSheet
        facets={facets}
        params={params}
        pathname={pathname}
        total={total}
      />
    </div>
  );
}

/**
 * The empty result, with a way out.
 *
 * Which way out depends on why it is empty, because "clear the filters" is
 * useless advice to someone who has not set any.
 */
function EmptyResult({
  chips,
  clearedHref,
  escape,
  query,
}: {
  chips: number;
  clearedHref: string;
  escape?: { href: string; label: string };
  query?: string;
}) {
  const filtered = chips > 0;

  return (
    <div className="border-border mx-auto max-w-md rounded-lg border border-dashed px-6 py-16 text-center">
      <div className="tread-rule mx-auto w-24" aria-hidden="true" />
      <h2 className="font-display mt-8 text-2xl font-bold tracking-[-0.02em] uppercase">
        {filtered ? "Nothing matches all of that" : "Nothing here yet"}
      </h2>
      <p className="text-muted-foreground mt-3 text-base text-pretty">
        {filtered
          ? `No shoe in the shop fits ${chips === 1 ? "that filter" : `all ${chips} filters`} at once. Every option in the panel carries its count, so the ones with a zero beside them are the ones to drop.`
          : query
            ? `Nothing here is called “${query}”. Try a brand on its own, or the category below.`
            : "This shelf is empty at the moment. The rest of the shop is one tap away."}
      </p>
      <div className="mt-7 flex flex-wrap justify-center gap-3">
        {filtered ? (
          <Link
            href={clearedHref}
            className="bg-primary text-primary-foreground inline-flex h-11 items-center rounded-lg px-5 text-sm font-semibold"
          >
            Clear the filters
          </Link>
        ) : null}
        {escape ? (
          <Link
            href={escape.href}
            className="border-foreground/25 hover:border-foreground hover:bg-foreground hover:text-background inline-flex h-11 items-center rounded-lg border px-5 text-sm font-medium transition-colors"
          >
            {escape.label}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
