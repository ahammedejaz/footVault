import Link from "next/link";
import { Check, SlidersHorizontal, X } from "lucide-react";

import { FilterSheetLoader } from "@/components/storefront/filter-sheet-loader";
import { Button } from "@/components/ui/button";
import {
  COLOR_FAMILY_SWATCH,
  type CatalogFacets,
  type Facet,
} from "@/lib/catalog-types";
import { formatPaise } from "@/lib/format";
import {
  LISTING_SORTS,
  SEARCH_SORTS,
  SORT_LABELS,
  activeFilterChips,
  clearedHref,
  dropParams,
  first,
  pageHref,
  setParam,
  toArray,
  toggleParam,
  type RawSearchParams,
} from "@/lib/queries/search-params";
import type { SortKey } from "@/lib/queries/catalog";
import { cn } from "@/lib/utils";

/**
 * Filters, built entirely out of links.
 *
 * Every option is an anchor to the same route with the query string rewritten,
 * which means the whole panel works with JavaScript disabled, costs no
 * hydration, and gives the browser real history — filter to size 9, hit back,
 * and you are on the unfiltered list rather than on the previous page of the
 * site.
 *
 * Every option also carries its count, and an option that would return nothing
 * says so *before* it is tapped rather than after. That number is the whole
 * reason catalog_query() exists: it is computed with the option's own dimension
 * lifted, so ticking a second size widens the list instead of emptying it.
 */

type PanelProps = {
  facets: CatalogFacets;
  params: RawSearchParams;
  pathname: string;
};

function FacetGroup({
  legend,
  children,
}: {
  legend: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-border border-t py-5 first:border-t-0 first:pt-0">
      <h3 className="font-mono text-xs tracking-[0.06em] uppercase">
        {legend}
      </h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/**
 * One option.
 *
 * `aria-pressed` belongs on a button, not on a link — axe flags it on an
 * anchor, and a screen reader announces "link, not pressed" which is nonsense.
 * A filter link is a navigation to a filtered view, so the state it carries is
 * `aria-current`, and the count is part of the accessible name so "Black, 12
 * products" is what gets read rather than "Black 12".
 */
function FacetLink({
  href,
  active,
  count,
  label,
  spoken,
  swatch,
  className,
}: {
  href: string;
  active: boolean;
  count: number;
  label: string;
  /** What the option is called when it is read rather than seen. */
  spoken?: string;
  swatch?: string | null;
  className?: string;
}) {
  const empty = count === 0;

  /*
    Read aloud, the visible markup is "9 20" — a size and a number with nothing
    joining them. The whole chip is therefore hidden from assistive technology
    and replaced with one sentence: "UK 9, 20 styles". The number stays visible
    because seeing it is the point.
  */
  const body = (
    <>
      {swatch !== undefined ? (
        <span
          aria-hidden
          className="border-border size-3.5 shrink-0 rounded-full border"
          style={{ backgroundColor: swatch ?? "transparent" }}
        />
      ) : null}
      {active ? <Check className="size-3.5 shrink-0" aria-hidden /> : null}
      <span aria-hidden>{label}</span>
      <span
        aria-hidden
        className={cn("font-mono text-xs", active ? "text-ink/70" : "text-dim")}
      >
        {count}
      </span>
      <span className="sr-only">
        {spoken ?? label},{" "}
        {count === 0
          ? "no styles"
          : `${count} ${count === 1 ? "style" : "styles"}`}
        {active ? ", applied" : ""}
      </span>
    </>
  );

  const shared = cn(
    "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm transition-colors",
    className,
  );

  // Nothing behind it: shown, dimmed, and not a link. Removing it would make
  // the run of options jump around as filters change, which is worse.
  if (empty && !active) {
    return (
      <span
        className={cn(shared, "border-border/60 text-dim cursor-not-allowed")}
        aria-disabled="true"
      >
        {body}
      </span>
    );
  }

  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={cn(
        shared,
        active
          ? "border-orange bg-orange text-ink font-medium"
          : "border-border hover:border-foreground",
      )}
    >
      {body}
    </Link>
  );
}

/** Price buckets derived from what the listing actually holds. */
function priceBuckets(range: { min: number; max: number } | null) {
  if (!range || range.max <= range.min) return [];
  const stops = [200000, 500000, 1000000].filter(
    (stop) => stop > range.min && stop < range.max,
  );
  if (stops.length === 0) return [];

  const buckets: Array<{ label: string; min?: number; max?: number }> = [];
  buckets.push({ label: `Under ${formatPaise(stops[0]!)}`, max: stops[0] });
  for (let i = 0; i < stops.length - 1; i++) {
    buckets.push({
      label: `${formatPaise(stops[i]!)} – ${formatPaise(stops[i + 1]!)}`,
      min: stops[i],
      max: stops[i + 1],
    });
  }
  buckets.push({
    label: `${formatPaise(stops[stops.length - 1]!)} and up`,
    min: stops[stops.length - 1],
  });
  return buckets;
}

export function FilterBody({ facets, params, pathname }: PanelProps) {
  const sizes = toArray(params.size);
  const colors = toArray(params.color);
  const brands = toArray(params.brand);
  const gender = first(params.gender);
  const inStock = first(params.in_stock) === "true";
  const onSale = first(params.on_sale) === "true";
  const min = first(params.min);
  const max = first(params.max);
  const buckets = priceBuckets(facets.price);

  const rangeHref = (bucket: { min?: number; max?: number }) => {
    const cleared = dropParams(params, ["min", "max"], pathname);
    const url = new URL(cleared, "https://x.invalid");
    if (bucket.min !== undefined)
      url.searchParams.append("min", String(bucket.min / 100));
    if (bucket.max !== undefined)
      url.searchParams.append("max", String(bucket.max / 100));
    return `${url.pathname}${url.search}`;
  };

  const rangeActive = (bucket: { min?: number; max?: number }) =>
    (bucket.min === undefined ? !min : min === String(bucket.min / 100)) &&
    (bucket.max === undefined ? !max : max === String(bucket.max / 100));

  return (
    <div>
      {facets.sizes.length > 0 ? (
        <FacetGroup legend="Size · UK">
          {/* The same run, in the same order, as the strip on every card. */}
          <ul className="flex flex-wrap gap-2">
            {facets.sizes.map((size) => (
              <li key={size.value}>
                <FacetLink
                  href={toggleParam(params, "size", size.value, pathname)}
                  active={sizes.includes(size.value)}
                  count={size.count}
                  label={size.label}
                  spoken={`UK ${size.label}`}
                  className="min-w-11 font-mono tabular-nums"
                />
              </li>
            ))}
          </ul>
        </FacetGroup>
      ) : null}

      {facets.colors.length > 0 ? (
        <FacetGroup legend="Colour">
          <ul className="flex flex-wrap gap-2">
            {facets.colors.map((color) => (
              <li key={color.value}>
                <FacetLink
                  href={toggleParam(params, "color", color.value, pathname)}
                  active={colors.includes(color.value)}
                  count={color.count}
                  label={color.label}
                  swatch={COLOR_FAMILY_SWATCH[color.value] ?? null}
                />
              </li>
            ))}
          </ul>
        </FacetGroup>
      ) : null}

      {facets.brands.length > 1 ? (
        <FacetGroup legend="Brand">
          <ul className="flex flex-wrap gap-2">
            {facets.brands.map((brand) => (
              <li key={brand.value}>
                <FacetLink
                  href={toggleParam(params, "brand", brand.value, pathname)}
                  active={brands.includes(brand.value)}
                  count={brand.count}
                  label={brand.label}
                />
              </li>
            ))}
          </ul>
        </FacetGroup>
      ) : null}

      {facets.genders.length > 1 ? (
        <FacetGroup legend="For">
          <ul className="flex flex-wrap gap-2">
            {facets.genders.map((entry) => (
              <li key={entry.value}>
                <FacetLink
                  href={setParam(
                    params,
                    "gender",
                    gender === entry.value ? null : entry.value,
                    pathname,
                  )}
                  active={gender === entry.value}
                  count={entry.count}
                  label={entry.label}
                />
              </li>
            ))}
          </ul>
        </FacetGroup>
      ) : null}

      {buckets.length > 0 ? (
        <FacetGroup legend="Price">
          {/*
            Buckets rather than a two-handled slider: a slider needs JavaScript
            to mean anything, needs a keyboard story of its own, and on a phone
            asks for a precision nobody wants. These are four taps that always
            land, and the stops come from what the listing actually holds.
          */}
          <ul className="flex flex-col gap-2">
            {buckets.map((bucket) => (
              <li key={bucket.label}>
                <Link
                  href={
                    rangeActive(bucket)
                      ? dropParams(params, ["min", "max"], pathname)
                      : rangeHref(bucket)
                  }
                  aria-current={rangeActive(bucket) ? "true" : undefined}
                  className={cn(
                    "flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm transition-colors",
                    rangeActive(bucket)
                      ? "border-orange bg-orange text-ink font-medium"
                      : "border-border hover:border-foreground",
                  )}
                >
                  {rangeActive(bucket) ? (
                    <Check className="size-3.5" aria-hidden />
                  ) : null}
                  {bucket.label}
                </Link>
              </li>
            ))}
          </ul>
        </FacetGroup>
      ) : null}

      <FacetGroup legend="Availability">
        <ul className="flex flex-wrap gap-2">
          <li>
            <FacetLink
              href={setParam(
                params,
                "in_stock",
                inStock ? null : "true",
                pathname,
              )}
              active={inStock}
              count={facets.inStock}
              label="In stock only"
            />
          </li>
          <li>
            <FacetLink
              href={setParam(
                params,
                "on_sale",
                onSale ? null : "true",
                pathname,
              )}
              active={onSale}
              count={facets.onSale}
              label="On sale"
            />
          </li>
        </ul>
      </FacetGroup>
    </div>
  );
}

/** Desktop: a real rail. Below `lg` this is hidden in favour of the sheet. */
export function FilterRail(props: PanelProps) {
  return (
    <aside aria-label="Filters" className="hidden w-60 shrink-0 lg:block">
      <FilterBody {...props} />
    </aside>
  );
}

/**
 * Mobile: the same links, in a bottom sheet with a sticky result count.
 *
 * The sheet's open state lives in the URL (`?panel=filters`), which is what
 * lets a customer tap four facets in a row without the panel closing under
 * them — each tap is a real navigation, and the panel comes back open on the
 * other side with counts that are now true. It also means the "Filters" button
 * is a link: with JavaScript off it renders the panel inline rather than doing
 * nothing.
 */
export function FilterTrigger({
  params,
  pathname,
  activeCount,
}: {
  params: RawSearchParams;
  pathname: string;
  activeCount: number;
}) {
  return (
    <Button variant="outline" className="lg:hidden" asChild>
      <Link
        href={setParam(params, "panel", "filters", pathname)}
        scroll={false}
      >
        <SlidersHorizontal />
        Filters
        {activeCount > 0 ? (
          <span className="bg-orange text-ink inline-flex size-5 items-center justify-center rounded-full font-mono text-xs font-medium">
            {activeCount}
          </span>
        ) : null}
      </Link>
    </Button>
  );
}

/**
 * The mobile filter panel.
 *
 * Rendered only when `?panel=filters` is in the URL — which is to say, only
 * when the customer has asked for it. The loader below is what keeps the
 * dialog, the portal and the swipe handler out of the bundle until then; on a
 * desktop, where the rail is always visible, they are never fetched at all.
 */
export function FilterPanelSheet({
  facets,
  params,
  pathname,
  total,
}: PanelProps & { total: number }) {
  const open = first(params.panel) === "filters";
  if (!open) return null;

  const closeHref = setParam(params, "panel", null, pathname);
  return (
    <FilterSheetLoader
      closeHref={closeHref}
      footer={
        <Link
          href={closeHref}
          scroll={false}
          className="bg-primary text-primary-foreground flex h-13 items-center justify-center rounded-lg px-7 text-base font-semibold"
        >
          {total === 0
            ? "No results"
            : `Show ${total} ${total === 1 ? "style" : "styles"}`}
        </Link>
      }
      clearHref={clearedHref(params, pathname)}
    >
      <FilterBody facets={facets} params={params} pathname={pathname} />
    </FilterSheetLoader>
  );
}

export function SortLinks({
  params,
  pathname,
  hasQuery,
}: {
  params: RawSearchParams;
  pathname: string;
  hasQuery: boolean;
}) {
  const options: SortKey[] = hasQuery ? SEARCH_SORTS : LISTING_SORTS;
  const fallback: SortKey = hasQuery ? "relevance" : "newest";
  const current = (first(params.sort) as SortKey | undefined) ?? fallback;

  return (
    <div className="flex items-center gap-2">
      <h2 className="text-dim sr-only font-mono text-xs tracking-[0.06em] uppercase sm:not-sr-only">
        Sort
      </h2>
      <ul className="flex flex-wrap items-center gap-1">
        {options.map((key) => (
          <li key={key}>
            <Link
              href={setParam(
                params,
                "sort",
                key === fallback ? null : key,
                pathname,
              )}
              aria-current={current === key ? "true" : undefined}
              className={cn(
                "inline-flex min-h-11 items-center rounded-lg px-3 text-sm transition-colors",
                current === key
                  ? "text-foreground decoration-orange font-medium underline decoration-2 underline-offset-8"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {SORT_LABELS[key]}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ActiveFilters({ params, pathname, facets }: PanelProps) {
  const chips = activeFilterChips(params, pathname, facets, formatPaise);
  if (chips.length === 0) return null;

  return (
    <div>
      <h2 className="sr-only">Filters applied</h2>
      <ul className="flex flex-wrap items-center gap-2">
        {chips.map((chip) => (
          <li key={chip.key}>
            <Link
              href={chip.href}
              className="hit-44 border-border hover:border-foreground inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-3 text-sm transition-colors"
            >
              {chip.label}
              <X className="size-3.5" aria-hidden />
              <span className="sr-only">— remove this filter</span>
            </Link>
          </li>
        ))}
        <li>
          <Link
            href={clearedHref(params, pathname)}
            className="hit-44 text-muted-foreground hover:text-foreground inline-flex min-h-9 items-center px-2 text-sm underline underline-offset-4"
          >
            Clear all
          </Link>
        </li>
      </ul>
    </div>
  );
}

export function Pagination({
  params,
  pathname,
  page,
  pageCount,
}: {
  params: RawSearchParams;
  pathname: string;
  page: number;
  pageCount: number;
}) {
  if (pageCount <= 1) return null;

  // Pagination rather than infinite scroll: the page number lives in the URL
  // alongside the filters, so a result set stays linkable and the back button
  // returns you to the page you were on. Infinite scroll would also put the
  // footer — where the policies and contact details live — out of reach.
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);

  return (
    <nav aria-label="Pagination" className="mt-14 flex justify-center">
      <ul className="flex flex-wrap items-center gap-1">
        <li>
          {page === 1 ? (
            <span className="text-dim inline-flex min-h-11 items-center rounded-lg px-3 text-sm">
              Previous
            </span>
          ) : (
            <Link
              href={pageHref(params, page - 1, pathname)}
              rel="prev"
              className="hover:bg-muted inline-flex min-h-11 items-center rounded-lg px-3 text-sm"
            >
              Previous
            </Link>
          )}
        </li>
        {pages.map((n) => (
          <li key={n}>
            <Link
              href={pageHref(params, n, pathname)}
              aria-current={n === page ? "page" : undefined}
              aria-label={`Page ${n}`}
              className={cn(
                "inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg font-mono text-sm tabular-nums",
                n === page ? "bg-ink text-paper font-medium" : "hover:bg-muted",
              )}
            >
              {n}
            </Link>
          </li>
        ))}
        <li>
          {page === pageCount ? (
            <span className="text-dim inline-flex min-h-11 items-center rounded-lg px-3 text-sm">
              Next
            </span>
          ) : (
            <Link
              href={pageHref(params, page + 1, pathname)}
              rel="next"
              className="hover:bg-muted inline-flex min-h-11 items-center rounded-lg px-3 text-sm"
            >
              Next
            </Link>
          )}
        </li>
      </ul>
    </nav>
  );
}

export type { Facet };
