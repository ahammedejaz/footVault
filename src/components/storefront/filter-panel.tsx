import Link from "next/link";
import { Check, SlidersHorizontal, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import type { getFilterFacets } from "@/lib/queries/catalog";
import {
  SORT_LABELS,
  activeFilterChips,
  pageHref,
  setParam,
  toArray,
  toggleParam,
  type RawSearchParams,
} from "@/lib/queries/search-params";
import { cn } from "@/lib/utils";

type Facets = Awaited<ReturnType<typeof getFilterFacets>>;

/**
 * Filters, built entirely out of links.
 *
 * Every option is an anchor to the same route with the query string rewritten,
 * which means the whole panel works with JavaScript disabled, costs no
 * hydration, and gives the browser real history entries — a customer who
 * filters to size 9 and hits back lands on the unfiltered list, not on the
 * previous page of the site.
 */

function FacetGroup({
  legend,
  children,
}: {
  legend: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-border border-t py-5 first:border-t-0 first:pt-0">
      <h3 className="font-mono text-xs tracking-[0.06em] uppercase">{legend}</h3>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function FacetLink({
  href,
  active,
  children,
  className,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      aria-pressed={active}
      className={cn(
        "border-border inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm transition-colors",
        active
          ? "border-orange bg-orange text-ink font-medium"
          : "hover:border-foreground",
        className,
      )}
    >
      {children}
    </Link>
  );
}

function FilterBody({
  facets,
  params,
  pathname,
}: {
  facets: Facets;
  params: RawSearchParams;
  pathname: string;
}) {
  const sizes = toArray(params.size);
  const colors = toArray(params.color);
  const brands = toArray(params.brand);
  const inStock = params.in_stock === "true";
  const onSale = params.on_sale === "true";

  return (
    <div>
      <FacetGroup legend="Size">
        {/* The same run, in the same order, as the strip on every card. */}
        <ul className="flex flex-wrap gap-2">
          {facets.sizes.map((size) => (
            <li key={size}>
              <FacetLink
                href={toggleParam(params, "size", size, pathname)}
                active={sizes.includes(size)}
                className="min-w-11 font-mono tabular-nums"
              >
                {size}
              </FacetLink>
            </li>
          ))}
        </ul>
      </FacetGroup>

      <FacetGroup legend="Colour">
        <ul className="flex flex-wrap gap-2">
          {facets.colors.map((color) => {
            const active = colors.includes(color.name);
            return (
              <li key={color.name}>
                <FacetLink
                  href={toggleParam(params, "color", color.name, pathname)}
                  active={active}
                >
                  <span
                    aria-hidden
                    className="border-border/70 size-3.5 shrink-0 rounded-full border"
                    style={{ backgroundColor: color.hex ?? "transparent" }}
                  />
                  {color.name}
                </FacetLink>
              </li>
            );
          })}
        </ul>
      </FacetGroup>

      <FacetGroup legend="Brand">
        <ul className="flex flex-wrap gap-2">
          {facets.brands.map((brand) => (
            <li key={brand.slug}>
              <FacetLink
                href={toggleParam(params, "brand", brand.slug, pathname)}
                active={brands.includes(brand.slug)}
              >
                {brand.name}
              </FacetLink>
            </li>
          ))}
        </ul>
      </FacetGroup>

      <FacetGroup legend="Availability">
        <ul className="flex flex-wrap gap-2">
          <li>
            <FacetLink
              href={setParam(params, "in_stock", inStock ? null : "true", pathname)}
              active={inStock}
            >
              {inStock ? <Check className="size-3.5" /> : null}
              In stock only
            </FacetLink>
          </li>
          <li>
            <FacetLink
              href={setParam(params, "on_sale", onSale ? null : "true", pathname)}
              active={onSale}
            >
              {onSale ? <Check className="size-3.5" /> : null}
              On sale
            </FacetLink>
          </li>
        </ul>
      </FacetGroup>
    </div>
  );
}

/** Desktop: a real sidebar. Below `lg` this is hidden in favour of the sheet. */
export function FilterSidebar(props: {
  facets: Facets;
  params: RawSearchParams;
  pathname: string;
}) {
  return (
    <aside aria-label="Filters" className="hidden w-60 shrink-0 lg:block">
      <FilterBody {...props} />
    </aside>
  );
}

/**
 * Mobile: a bottom sheet, not a cramped sidebar. Tapping a facet navigates and
 * closes the sheet with it, which is the behaviour on every store a customer
 * already uses.
 */
export function FilterSheet({
  facets,
  params,
  pathname,
  total,
}: {
  facets: Facets;
  params: RawSearchParams;
  pathname: string;
  total: number;
}) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" className="lg:hidden">
          <SlidersHorizontal />
          Filters
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="font-display text-lg font-bold tracking-[-0.02em] uppercase">
            Filters
          </SheetTitle>
        </SheetHeader>
        <div className="px-4 pb-8">
          <FilterBody facets={facets} params={params} pathname={pathname} />
          <p className="text-muted-foreground mt-6 font-mono text-xs tracking-[0.06em]">
            {total} {total === 1 ? "style" : "styles"} match
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function SortLinks({
  params,
  pathname,
}: {
  params: RawSearchParams;
  pathname: string;
}) {
  const current = (params.sort as string) ?? "newest";
  return (
    <ul className="flex flex-wrap items-center gap-1">
      {(Object.keys(SORT_LABELS) as Array<keyof typeof SORT_LABELS>).map((key) => (
        <li key={key}>
          <Link
            href={setParam(params, "sort", key === "newest" ? null : key, pathname)}
            aria-pressed={current === key}
            className={cn(
              "inline-flex min-h-11 items-center rounded-lg px-3 text-sm transition-colors",
              current === key
                ? "text-foreground font-medium underline decoration-orange decoration-2 underline-offset-8"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {SORT_LABELS[key]}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function ActiveFilters({
  params,
  pathname,
}: {
  params: RawSearchParams;
  pathname: string;
}) {
  const chips = activeFilterChips(params, pathname);
  if (chips.length === 0) return null;

  return (
    <ul className="flex flex-wrap items-center gap-2">
      {chips.map((chip) => (
        <li key={chip.label}>
          <Link
            href={chip.href}
            className="border-border hover:border-foreground inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-3 text-sm transition-colors"
          >
            {chip.label}
            <X className="size-3.5" aria-hidden />
            <span className="sr-only">Remove filter</span>
          </Link>
        </li>
      ))}
      <li>
        <Link
          href={pathname}
          className="text-muted-foreground hover:text-foreground inline-flex min-h-9 items-center px-2 text-sm underline underline-offset-4"
        >
          Clear all
        </Link>
      </li>
    </ul>
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
          <Link
            href={pageHref(params, page - 1, pathname)}
            aria-disabled={page === 1}
            className={cn(
              "inline-flex min-h-11 items-center rounded-lg px-3 text-sm",
              page === 1
                ? "text-muted-foreground pointer-events-none"
                : "hover:bg-muted",
            )}
          >
            Previous
          </Link>
        </li>
        {pages.map((n) => (
          <li key={n}>
            <Link
              href={pageHref(params, n, pathname)}
              aria-current={n === page ? "page" : undefined}
              className={cn(
                "inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg font-mono text-sm tabular-nums",
                n === page
                  ? "bg-ink text-paper font-medium"
                  : "hover:bg-muted",
              )}
            >
              {n}
            </Link>
          </li>
        ))}
        <li>
          <Link
            href={pageHref(params, page + 1, pathname)}
            aria-disabled={page === pageCount}
            className={cn(
              "inline-flex min-h-11 items-center rounded-lg px-3 text-sm",
              page === pageCount
                ? "text-muted-foreground pointer-events-none"
                : "hover:bg-muted",
            )}
          >
            Next
          </Link>
        </li>
      </ul>
    </nav>
  );
}
