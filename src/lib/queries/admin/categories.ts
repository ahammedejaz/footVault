import "server-only";

import type { ListParams } from "@/lib/admin/list-params";
import { rows } from "@/lib/queries/run";
import { createClient } from "@/lib/supabase/server";

/**
 * The category tree, as the owner edits it.
 *
 * **Why this reads the whole table rather than paging it in SQL.** A tree is
 * not a list: page two of a flat query is a handful of nodes whose parents are
 * on page one, which renders as a set of orphans with no indentation to explain
 * them. So the shape is read whole, assembled here, and *then* paginated over
 * top-level categories — a subtree is never split across a page boundary. The
 * set this reads is bounded by what a shop can navigate: the storefront header
 * renders it as a menu bar, so a catalog with 400 categories is already broken
 * on the shop long before it is slow here. `MAX_CATEGORIES` is the ceiling, and
 * `capped` says so out loud rather than silently truncating the tree.
 *
 * **Two levels, not arbitrary depth.** `src/components/storefront/site-header.tsx`
 * renders `tree.map(node => node.children.map(child => …))` and stops. A
 * grandchild is therefore invisible on the shop while looking perfectly present
 * in the panel, which is the worst possible failure: the owner files products
 * into a category no customer can reach. The schema says the same thing —
 * `supabase/migrations/…_catalog.sql` comments the self-reference as "one level
 * of nesting (Men -> Sneakers)" — so the indent control refuses to go deeper
 * and `MAX_CATEGORY_DEPTH` is the single number both sides read.
 */

/** Root is 0. A child is 1. There is no 2 — see the note above. */
export const MAX_CATEGORY_DEPTH = 1;

/** More than a navigable shop can have. Reaching it is reported, not hidden. */
const MAX_CATEGORIES = 500;

/**
 * The category tree is sorted by the thing this screen edits, so there is
 * nothing to offer a sort control over — see the page for the argument. The
 * allow-list still exists because `parseListParams` guarantees the URL shape
 * that `Pagination` and `listHref` read.
 */
export const CATEGORY_SORTS = ["sort_order"] as const;
export type CategorySort = (typeof CATEGORY_SORTS)[number];

export type AdminCategoryRow = {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  description: string | null;
  imageUrl: string | null;
  sortOrder: number;
  isActive: boolean;
  /** 0 for a top-level category, 1 for a sub-category. */
  depth: number;
  /** Live products filed directly here. What the owner sees on the row. */
  productCount: number;
  /** Including soft-deleted ones. What the delete guard has to count. */
  productCountIncludingDeleted: number;
  /** Live products here and in everything beneath. */
  productCountDeep: number;
  childCount: number;
  /** Named so a delete confirmation can say which ones are in the way. */
  childNames: string[];
  /** Position among its own siblings, so the ends can disable their arrows. */
  index: number;
  siblingCount: number;
  /** True when this row is why a search kept its branch. */
  matched: boolean;
};

/** Every category, flat, for the parent and "move products to" pickers. */
export type CategoryOption = {
  id: string;
  /** "Men › Sneakers", so two categories called "Sneakers" are tellable apart. */
  path: string;
  depth: number;
  /** Itself and everything under it — a re-parent into one of these is a loop. */
  subtreeIds: string[];
};

export type CategoryTree = {
  rows: AdminCategoryRow[];
  /** Top-level categories after search. What `Pagination` counts. */
  total: number;
  options: CategoryOption[];
  /** True when the shop has more categories than this screen will read. */
  capped: boolean;
  /** Categories no product can be filed under without breaking the header. */
  totalCategories: number;
};

type Raw = {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  description: string | null;
  image_url: string | null;
  sort_order: number;
  is_active: boolean;
};

export async function listCategoryTree(
  params: ListParams<CategorySort>,
): Promise<CategoryTree> {
  const supabase = await createClient();

  const all = await rows<Raw>(
    "admin.categories.tree",
    supabase
      .from("categories")
      .select(
        `id, name, slug, parent_id, description, image_url, sort_order, is_active`,
      )
      // Ties on sort_order are the normal state, not an edge case: the column
      // defaults to 0, so a shop that has never reordered anything has every
      // category at 0. Name breaks the tie so the order is at least stable
      // between requests, and the move controls renumber as they go.
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true })
      .limit(MAX_CATEGORIES + 1),
  );

  const capped = all.length > MAX_CATEGORIES;
  const categories = capped ? all.slice(0, MAX_CATEGORIES) : all;

  /**
   * Counts come from one pass over `products` rather than a count per category.
   *
   * The embedded form — `categories.select("id, products(count)")` — is one
   * query and reads better, and it is what this started as. It cannot express
   * "live products only" without `products!inner`, which turns the embed into
   * an inner join and drops every empty category from the tree. Since the empty
   * ones are exactly the rows the owner is most likely to be deleting, that is
   * the wrong thing to lose.
   */
  const products = await rows<{
    category_id: string | null;
    deleted_at: string | null;
  }>(
    "admin.categories.productCounts",
    supabase
      .from("products")
      .select("category_id, deleted_at")
      .not("category_id", "is", null),
  );

  const live = new Map<string, number>();
  const any = new Map<string, number>();
  for (const product of products) {
    const key = product.category_id;
    if (!key) continue;
    any.set(key, (any.get(key) ?? 0) + 1);
    if (product.deleted_at === null) live.set(key, (live.get(key) ?? 0) + 1);
  }

  const childrenOf = new Map<string | null, Raw[]>();
  const byId = new Map(categories.map((row) => [row.id, row]));
  /** Where each row actually sits, after the capping fix-up below. */
  const parentKey = new Map<string, string | null>();
  for (const row of categories) {
    // A parent that is not in this result set — because the tree was capped —
    // would otherwise take its children out of the tree entirely. Treating it
    // as a root keeps every row reachable.
    const parent =
      row.parent_id && byId.has(row.parent_id) ? row.parent_id : null;
    parentKey.set(row.id, parent);
    const bucket = childrenOf.get(parent);
    if (bucket) bucket.push(row);
    else childrenOf.set(parent, [row]);
  }

  const term = params.q.trim().toLowerCase();
  const isMatch = (row: Raw) =>
    term.length === 0 ||
    row.name.toLowerCase().includes(term) ||
    row.slug.toLowerCase().includes(term);

  /** Live products here and below. Computed once, bottom-up. */
  const deepCount = new Map<string, number>();
  function countDeep(id: string): number {
    const cached = deepCount.get(id);
    if (cached !== undefined) return cached;
    let total = live.get(id) ?? 0;
    for (const child of childrenOf.get(id) ?? []) total += countDeep(child.id);
    deepCount.set(id, total);
    return total;
  }

  /**
   * A search keeps a whole branch when anything in it matches.
   *
   * Filtering to only the matching rows would show a sub-category with no
   * indication of what it sits under, and the owner's next question is always
   * "which Sneakers is that" — so the ancestors come along, greyed by not being
   * marked as matches.
   */
  function branchMatches(row: Raw): boolean {
    if (isMatch(row)) return true;
    return (childrenOf.get(row.id) ?? []).some(branchMatches);
  }

  const roots = (childrenOf.get(null) ?? []).filter(branchMatches);
  const from = (params.page - 1) * params.perPage;
  const pageRoots = roots.slice(from, from + params.perPage);

  const flat: AdminCategoryRow[] = [];

  /**
   * Position among *all* of a row's siblings, not among the ones on screen.
   *
   * Getting this from the rendered list instead is the bug that makes the first
   * category on page two think it is already at the top — and makes a search
   * that hides one sibling grey out an arrow that works perfectly well. The
   * move buttons act on the real order, so the thing that enables them has to
   * be read from the real order too.
   */
  function walk(row: Raw, depth: number) {
    const siblings = childrenOf.get(parentKey.get(row.id) ?? null) ?? [];
    flat.push({
      id: row.id,
      name: row.name,
      slug: row.slug,
      parentId: row.parent_id,
      description: row.description,
      imageUrl: row.image_url,
      sortOrder: row.sort_order,
      isActive: row.is_active,
      depth,
      productCount: live.get(row.id) ?? 0,
      productCountIncludingDeleted: any.get(row.id) ?? 0,
      productCountDeep: countDeep(row.id),
      // From the whole tree, not the filtered view: a search that hides a
      // sub-category must not make its parent look safe to delete.
      childCount: (childrenOf.get(row.id) ?? []).length,
      childNames: (childrenOf.get(row.id) ?? []).map((child) => child.name),
      index: siblings.findIndex((sibling) => sibling.id === row.id),
      siblingCount: siblings.length,
      matched: isMatch(row),
    });
    for (const child of (childrenOf.get(row.id) ?? []).filter(branchMatches)) {
      walk(child, depth + 1);
    }
  }
  for (const root of pageRoots) walk(root, 0);

  /**
   * The pickers see every category, not only the page — a re-parent is allowed
   * to reach across a pagination boundary the owner never asked for.
   */
  const options: CategoryOption[] = [];
  function collect(row: Raw, depth: number, prefix: string) {
    const path = prefix ? `${prefix} › ${row.name}` : row.name;
    const subtreeIds: string[] = [row.id];
    const kids = childrenOf.get(row.id) ?? [];
    options.push({ id: row.id, path, depth, subtreeIds });
    for (const child of kids) {
      const before = options.length;
      collect(child, depth + 1, path);
      for (let i = before; i < options.length; i += 1) {
        subtreeIds.push(options[i]!.id);
      }
    }
  }
  for (const root of childrenOf.get(null) ?? []) collect(root, 0, "");

  return {
    rows: flat,
    total: roots.length,
    options,
    capped,
    totalCategories: categories.length,
  };
}
