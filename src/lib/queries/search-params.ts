import type { ProductFilters, SortKey } from "@/lib/queries/catalog";
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
const SORTS: SortKey[] = ["newest", "price-asc", "price-desc"];

export const SORT_LABELS: Record<SortKey, string> = {
  newest: "Newest",
  "price-asc": "Price, low to high",
  "price-desc": "Price, high to low",
};

/**
 * Filters live in the URL, so a filtered listing is shareable and the back
 * button behaves. This is the one place that reads them, and it is deliberately
 * forgiving: an unknown `?sort=cheapest` falls back to the default rather than
 * 500ing a page someone was linked to.
 */
export function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  // `?size=8&size=9` arrives as an array; `?size=8,9` as a string. Both are
  // things people paste, so both work.
  const values = Array.isArray(value) ? value : value.split(",");
  return values.map((v) => v.trim()).filter(Boolean);
}

function toPaise(value: string | string[] | undefined): number | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  if (!first) return undefined;
  const rupees = Number.parseInt(first, 10);
  return Number.isFinite(rupees) && rupees >= 0 ? rupees * 100 : undefined;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseFilters(
  params: RawSearchParams,
  overrides: Partial<ProductFilters> = {},
): ProductFilters {
  const gender = first(params.gender);
  const type = first(params.type);
  const sort = first(params.sort);
  const page = Number.parseInt(first(params.page) ?? "1", 10);

  return {
    gender: GENDERS.includes(gender as Gender) ? (gender as Gender) : undefined,
    footwearType: TYPES.includes(type as FootwearType)
      ? (type as FootwearType)
      : undefined,
    brandSlugs: toArray(params.brand),
    sizes: toArray(params.size),
    colors: toArray(params.color),
    minPrice: toPaise(params.min),
    maxPrice: toPaise(params.max),
    inStockOnly: first(params.in_stock) === "true",
    onSale: first(params.on_sale) === "true",
    search: first(params.q),
    sort: SORTS.includes(sort as SortKey) ? (sort as SortKey) : "newest",
    page: Number.isFinite(page) && page > 0 ? page : 1,
    ...overrides,
  };
}

/**
 * Build the href for toggling one facet, preserving everything else.
 *
 * Page is dropped on every change: a customer on page 4 who ticks "size 9"
 * should land on page 1 of the new result set, not on a page that may no longer
 * exist.
 */
export function toggleParam(
  params: RawSearchParams,
  key: string,
  value: string,
  pathname: string,
): string {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (k === "page" || k === key) continue;
    for (const item of toArray(v)) next.append(k, item);
  }

  const current = toArray(params[key]);
  const updated = current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value];
  for (const item of updated) next.append(key, item);

  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function setParam(
  params: RawSearchParams,
  key: string,
  value: string | null,
  pathname: string,
): string {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (k === "page" || k === key) continue;
    for (const item of toArray(v)) next.append(k, item);
  }
  if (value !== null) next.append(key, value);
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

/** Facets currently applied, for the "clear" row above the grid. */
export function activeFilterChips(
  params: RawSearchParams,
  pathname: string,
): Array<{ label: string; href: string }> {
  const chips: Array<{ label: string; href: string }> = [];
  for (const size of toArray(params.size)) {
    chips.push({ label: `UK ${size}`, href: toggleParam(params, "size", size, pathname) });
  }
  for (const color of toArray(params.color)) {
    chips.push({ label: color, href: toggleParam(params, "color", color, pathname) });
  }
  for (const brand of toArray(params.brand)) {
    chips.push({ label: brand, href: toggleParam(params, "brand", brand, pathname) });
  }
  if (first(params.in_stock) === "true") {
    chips.push({
      label: "In stock only",
      href: setParam(params, "in_stock", null, pathname),
    });
  }
  if (first(params.on_sale) === "true") {
    chips.push({ label: "On sale", href: setParam(params, "on_sale", null, pathname) });
  }
  return chips;
}
