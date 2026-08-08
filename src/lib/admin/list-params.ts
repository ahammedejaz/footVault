/**
 * Search, sort and page, held in the URL rather than in component state.
 *
 * Every admin table reads its parameters from here and every control that
 * changes one is a `<Link>`. That has three consequences worth stating, because
 * they are the reason for the choice rather than side effects of it:
 *
 *   - **The back button works.** An owner who filters to unfulfilled orders,
 *     opens one, and presses back lands on the filtered list. With state in a
 *     client component they land on page one of everything, which on a tablet
 *     with sixty orders is the difference between a usable panel and a
 *     frustrating one.
 *   - **A view is a URL.** "Look at this" is a link, and a bookmark for
 *     low-stock survives a reload.
 *   - **It costs almost no JavaScript.** Sorting and paging are anchors; only
 *     the search box needs a client component, because typing has to debounce.
 *
 * Everything is clamped and allow-listed here rather than at the call sites.
 * `sort` in particular reaches a PostgREST `.order()` — an unvalidated column
 * name from a query string is how a table starts accepting arbitrary ordering
 * expressions, so a value that is not in the caller's own list is replaced with
 * the default rather than passed through.
 */

export type SortDirection = "asc" | "desc";

export type ListParams<Sort extends string = string> = {
  q: string;
  page: number;
  perPage: number;
  sort: Sort;
  dir: SortDirection;
};

export type SearchParams = Record<string, string | string[] | undefined>;

/** 25 fits a tablet in landscape without scrolling the header off. */
export const DEFAULT_PER_PAGE = 25;
const MAX_PER_PAGE = 100;
/** Longer than any product name in the catalog, and short enough to bound a LIKE. */
const MAX_QUERY = 80;

export function parseListParams<Sort extends string>(
  searchParams: SearchParams,
  options: {
    sortable: readonly Sort[];
    defaultSort: Sort;
    defaultDir?: SortDirection;
    perPage?: number;
  },
): ListParams<Sort> {
  const sortRaw = single(searchParams.sort);
  const dirRaw = single(searchParams.dir);

  return {
    q: single(searchParams.q).trim().slice(0, MAX_QUERY),
    page: Math.max(1, toInt(single(searchParams.page), 1)),
    perPage: Math.min(
      MAX_PER_PAGE,
      Math.max(
        1,
        toInt(
          single(searchParams.perPage),
          options.perPage ?? DEFAULT_PER_PAGE,
        ),
      ),
    ),
    // Allow-listed against the caller's own columns. Anything else is the
    // default, silently — a table that errors because somebody edited the URL
    // is worse than one that ignores them.
    sort: options.sortable.includes(sortRaw as Sort)
      ? (sortRaw as Sort)
      : options.defaultSort,
    dir:
      dirRaw === "asc" || dirRaw === "desc"
        ? dirRaw
        : (options.defaultDir ?? "desc"),
  };
}

/**
 * A URL for the same table with some parameters changed.
 *
 * Changing anything except the page resets to page one. Without that rule,
 * searching while on page four shows an empty table and an owner concludes
 * there are no results — the commonest way a paginated search feels broken.
 */
export function listHref(
  basePath: string,
  current: ListParams & Record<string, unknown>,
  patch: Partial<ListParams> & Record<string, string | number | undefined>,
  extras?: Record<string, string | undefined>,
): string {
  const next = { ...current, ...patch };
  const params = new URLSearchParams();

  if (next.q) params.set("q", String(next.q));
  if (patch.page === undefined && Object.keys(patch).length > 0) next.page = 1;
  if (next.page && Number(next.page) > 1) params.set("page", String(next.page));
  if (next.sort) params.set("sort", String(next.sort));
  if (next.dir) params.set("dir", String(next.dir));
  if (next.perPage && Number(next.perPage) !== DEFAULT_PER_PAGE) {
    params.set("perPage", String(next.perPage));
  }

  for (const [key, value] of Object.entries(extras ?? {})) {
    const patched = (patch as Record<string, unknown>)[key];
    const resolved = patched === undefined ? value : String(patched);
    if (resolved) params.set(key, resolved);
  }

  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

/** PostgREST's `.range()` bounds for a page. */
export function rangeFor(params: ListParams): [number, number] {
  const from = (params.page - 1) * params.perPage;
  return [from, from + params.perPage - 1];
}

/**
 * A `%term%` pattern with PostgREST's own metacharacters neutralised.
 *
 * `%` and `_` are wildcards inside LIKE, and `,` and `)` terminate a value
 * inside PostgREST's `or=(…)` syntax. A product search for "50%" would
 * otherwise match everything, and a comma would produce a filter the parser
 * reads as two.
 */
export function likePattern(term: string): string {
  return `%${term.replace(/[%_,)(\\]/g, (c) => `\\${c}`)}%`;
}

function single(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function toInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
