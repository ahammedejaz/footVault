import type {
  CatalogFacets,
  ProductFilters,
  SortKey,
} from "@/lib/queries/catalog";
import type { Database } from "@/lib/database.types";

type Gender = Database["public"]["Enums"]["gender_group"];
type FootwearType = Database["public"]["Enums"]["footwear_type"];

export type RawSearchParams = Record<string, string | string[] | undefined>;

const GENDERS: Gender[] = ["men", "women", "unisex", "kids"];
const TYPES: FootwearType[] = [
  "sneaker",
  "formal",
  "sandal",
  "slide",
  "boot",
  "sports",
  "flipflop",
];
const SORTS: SortKey[] = ["newest", "price-asc", "price-desc", "relevance"];

export const SORT_LABELS: Record<SortKey, string> = {
  newest: "Newest",
  "price-asc": "Price, low to high",
  "price-desc": "Price, high to low",
  relevance: "Best match",
};

/** The sorts a listing offers. Relevance only means anything with a query. */
export const LISTING_SORTS: SortKey[] = ["newest", "price-asc", "price-desc"];
export const SEARCH_SORTS: SortKey[] = ["relevance", "price-asc", "price-desc"];

/**
 * Filters live in the URL, so a filtered listing is shareable, the back button
 * behaves, and the whole panel works with JavaScript off. This is the one place
 * that reads them, and it is deliberately forgiving: an unknown `?sort=cheapest`
 * falls back to the default rather than 500ing a page someone was linked to.
 */
export function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  // `?size=8&size=9` arrives as an array; `?size=8,9` as a string. Both are
  // things people paste, so both work.
  const values = Array.isArray(value) ? value : value.split(",");
  return values.map((v) => v.trim()).filter(Boolean);
}

export function first(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Rupees in the URL, paise in the database. `?min=2000` is ₹2,000. */
function toPaise(value: string | string[] | undefined): number | undefined {
  const raw = first(value);
  if (!raw) return undefined;
  const rupees = Number.parseInt(raw, 10);
  return Number.isFinite(rupees) && rupees >= 0 ? rupees * 100 : undefined;
}

export function parseFilters(
  params: RawSearchParams,
  overrides: Partial<ProductFilters> = {},
): ProductFilters {
  const gender = first(params.gender);
  const type = first(params.type);
  const sort = first(params.sort);
  const page = Number.parseInt(first(params.page) ?? "1", 10);
  const search = first(params.q)?.trim() || undefined;
  const minPrice = toPaise(params.min);
  const maxPrice = toPaise(params.max);

  return {
    gender: GENDERS.includes(gender as Gender) ? (gender as Gender) : undefined,
    footwearType: TYPES.includes(type as FootwearType)
      ? (type as FootwearType)
      : undefined,
    brandSlugs: toArray(params.brand),
    sizes: toArray(params.size),
    colors: toArray(params.color),
    // A range typed backwards is a slip, not a request for nothing. Swap it.
    minPrice:
      minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice
        ? maxPrice
        : minPrice,
    maxPrice:
      minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice
        ? minPrice
        : maxPrice,
    inStockOnly: first(params.in_stock) === "true",
    onSale: first(params.on_sale) === "true",
    search,
    sort: SORTS.includes(sort as SortKey)
      ? (sort as SortKey)
      : search
        ? "relevance"
        : "newest",
    page: Number.isFinite(page) && page > 0 ? page : 1,
    ...overrides,
  };
}

/**
 * Rebuild the query string with one key changed, preserving everything else.
 *
 * `page` is dropped on every change: a customer on page 4 who ticks "size 9"
 * should land on page 1 of the new result set, not on a page that may no longer
 * exist.
 */
function rebuild(
  params: RawSearchParams,
  key: string,
  values: string[],
  pathname: string,
): string {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (k === "page" || k === key) continue;
    for (const item of toArray(v)) next.append(k, item);
  }
  for (const item of values) next.append(key, item);
  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function toggleParam(
  params: RawSearchParams,
  key: string,
  value: string,
  pathname: string,
): string {
  const current = toArray(params[key]);
  return rebuild(
    params,
    key,
    current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value],
    pathname,
  );
}

export function setParam(
  params: RawSearchParams,
  key: string,
  value: string | null,
  pathname: string,
): string {
  return rebuild(params, key, value === null ? [] : [value], pathname);
}

/** Remove several keys at once — the price range is two params, one chip. */
export function dropParams(
  params: RawSearchParams,
  keys: string[],
  pathname: string,
): string {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (k === "page" || keys.includes(k)) continue;
    for (const item of toArray(v)) next.append(k, item);
  }
  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function pageHref(
  params: RawSearchParams,
  page: number,
  pathname: string,
): string {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (k === "page") continue;
    for (const item of toArray(v)) next.append(k, item);
  }
  if (page > 1) next.append("page", String(page));
  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** Everything except the search term, so "clear all" does not clear the query. */
export function clearedHref(params: RawSearchParams, pathname: string): string {
  const q = first(params.q);
  return q ? `${pathname}?q=${encodeURIComponent(q)}` : pathname;
}

export type FilterChip = { key: string; label: string; href: string };

/**
 * The facets currently applied, as removable chips.
 *
 * Labels come from the facet list rather than the raw slug so the chip reads
 * "New Balance" and not "new-balance" — and a `?brand=nonsense` someone pasted
 * shows the slug rather than disappearing, which is the honest failure.
 */
export function activeFilterChips(
  params: RawSearchParams,
  pathname: string,
  facets: CatalogFacets,
  formatPrice: (paise: number) => string,
): FilterChip[] {
  const chips: FilterChip[] = [];
  const labelOf = (list: { value: string; label: string }[], value: string) =>
    list.find((f) => f.value === value)?.label ?? value;

  for (const size of toArray(params.size)) {
    chips.push({
      key: `size-${size}`,
      label: `UK ${size}`,
      href: toggleParam(params, "size", size, pathname),
    });
  }
  for (const color of toArray(params.color)) {
    chips.push({
      key: `color-${color}`,
      label: labelOf(facets.colors, color),
      href: toggleParam(params, "color", color, pathname),
    });
  }
  for (const brand of toArray(params.brand)) {
    chips.push({
      key: `brand-${brand}`,
      label: labelOf(facets.brands, brand),
      href: toggleParam(params, "brand", brand, pathname),
    });
  }
  const gender = first(params.gender);
  if (gender && GENDERS.includes(gender as Gender)) {
    chips.push({
      key: `gender-${gender}`,
      label: labelOf(facets.genders, gender),
      href: setParam(params, "gender", null, pathname),
    });
  }

  const min = toPaise(params.min);
  const max = toPaise(params.max);
  if (min !== undefined || max !== undefined) {
    const label =
      min !== undefined && max !== undefined
        ? `${formatPrice(min)} – ${formatPrice(max)}`
        : min !== undefined
          ? `Over ${formatPrice(min)}`
          : `Under ${formatPrice(max!)}`;
    chips.push({
      key: "price",
      label,
      href: dropParams(params, ["min", "max"], pathname),
    });
  }

  if (first(params.in_stock) === "true") {
    chips.push({
      key: "in-stock",
      label: "In stock only",
      href: setParam(params, "in_stock", null, pathname),
    });
  }
  if (first(params.on_sale) === "true") {
    chips.push({
      key: "on-sale",
      label: "On sale",
      href: setParam(params, "on_sale", null, pathname),
    });
  }
  return chips;
}
