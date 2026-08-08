import type { Metadata } from "next";
import Link from "next/link";
import { CornerDownRight } from "lucide-react";

import { CategoryForm } from "@/components/admin/categories/category-form";
import { CategoryRowActions } from "@/components/admin/categories/category-row-actions";
import { DeleteCategory } from "@/components/admin/categories/delete-category";
import { SearchField } from "@/components/admin/search-field";
import { Pagination, Table, TableWrap, Td, Th } from "@/components/admin/table";
import { AdminPage, Chip, EmptyState, PageHeader } from "@/components/admin/ui";
import { parseListParams, type SearchParams } from "@/lib/admin/list-params";
import {
  CATEGORY_SORTS,
  listCategoryTree,
  MAX_CATEGORY_DEPTH,
  type CategorySort,
} from "@/lib/queries/admin/categories";

export const metadata: Metadata = { title: "Categories" };
export const dynamic = "force-dynamic";

/**
 * How the shop is grouped, shown as the tree it actually is.
 *
 * **No sortable columns, and that is the design rather than an omission.** The
 * order of this table *is* the thing the screen edits — it is what the shop's
 * menu renders, top to bottom — so a control that re-sorts the view by name
 * would leave a set of "move up" arrows next to rows whose position on screen
 * no longer means anything. Every other list in the panel sorts; this one has
 * one true order and four buttons for changing it.
 *
 * **Pagination is over top-level categories.** Paging a flat query would put a
 * sub-category on page two with its parent on page one, which renders as an
 * unexplained orphan. A subtree is never split.
 *
 * Search keeps whole branches: matching a sub-category shows the parent above
 * it, greyed, so the owner can see which "Sneakers" they are looking at.
 */
export default async function AdminCategoriesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const params = parseListParams<CategorySort>(sp, {
    sortable: CATEGORY_SORTS,
    defaultSort: "sort_order",
    defaultDir: "asc",
  });

  const { rows, total, options, capped, totalCategories } =
    await listCategoryTree(params);

  /** Only a top-level category can be a parent — the menu shows two levels. */
  const rootChoices = options
    .filter((option) => option.depth < MAX_CATEGORY_DEPTH)
    .map((option) => ({ id: option.id, path: option.path }));

  return (
    <>
      <PageHeader
        title="Categories"
        description="The groups in the shop's menu. Drag-free: use the arrows to reorder, and the indent buttons to nest one under another."
      >
        <CategoryForm
          parents={rootChoices}
          triggerLabel="Add category"
          triggerVariant="default"
        />
      </PageHeader>

      <AdminPage className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            label="Search categories"
            placeholder="Name or web address"
          />
        </div>

        {capped ? (
          <p className="border-border text-muted-foreground rounded-md border border-dashed px-3 py-2 text-sm text-pretty">
            This shop has more categories than this screen reads at once, so
            some are not shown. A menu that long is already hard for customers —
            it may be worth merging a few.
          </p>
        ) : null}

        {rows.length === 0 ? (
          params.q ? (
            <EmptyState
              title="Nothing matches that"
              body="No category name or web address contains that. Try a shorter search."
              actionHref="/admin/categories"
              actionLabel="Show every category"
            />
          ) : (
            <div className="space-y-3">
              <EmptyState
                title="No categories yet"
                body="Categories are the shop's menu — Men, Women, Sneakers, Sandals. Make the first one, then file products under it so customers have something to browse."
              />
              <div className="flex justify-center">
                <CategoryForm
                  parents={rootChoices}
                  triggerLabel="Add the first category"
                  triggerVariant="default"
                />
              </div>
            </div>
          )
        ) : (
          <>
            <TableWrap label="Categories">
              <Table className="min-w-[48rem]">
                <thead>
                  <tr>
                    <Th>Category</Th>
                    <Th numeric>Products</Th>
                    <Th>In the shop</Th>
                    <Th className="text-right">Arrange</Th>
                    <Th className="text-right">Edit</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const own = options.find((option) => option.id === row.id)
                      ?.subtreeIds ?? [row.id];

                    const nestBlockedBecause =
                      row.index === 0
                        ? "there is nothing above it to sit under"
                        : row.depth >= MAX_CATEGORY_DEPTH
                          ? "the shop's menu only shows two levels"
                          : row.childCount > 0
                            ? "it has sub-categories of its own"
                            : null;

                    return (
                      <tr
                        key={row.id}
                        className={
                          row.matched
                            ? "hover:bg-muted/40"
                            : // An ancestor kept only for context. Legible, but
                              // clearly not what was searched for.
                              "text-muted-foreground hover:bg-muted/40"
                        }
                      >
                        <Td className="max-w-[22rem]">
                          <div
                            className="flex min-w-0 items-center gap-1.5"
                            style={{
                              paddingLeft: `${row.depth * 1.25}rem`,
                            }}
                          >
                            {row.depth > 0 ? (
                              <CornerDownRight
                                className="text-muted-foreground size-3.5 shrink-0"
                                aria-hidden
                              />
                            ) : null}
                            <div className="min-w-0">
                              <span className="block truncate font-medium">
                                {row.name}
                              </span>
                              <Link
                                href={`/shop/${row.slug}`}
                                className="text-muted-foreground block truncate font-mono text-xs underline-offset-4 hover:underline"
                              >
                                /shop/{row.slug}
                              </Link>
                            </div>
                          </div>
                        </Td>
                        <Td numeric>
                          {row.productCount > 0 ? (
                            <Link
                              href={`/admin/products?category=${row.slug}`}
                              className="underline-offset-4 hover:underline"
                            >
                              {row.productCount}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                          {row.childCount > 0 &&
                          row.productCountDeep > row.productCount ? (
                            <span className="text-muted-foreground block text-xs">
                              {row.productCountDeep} with sub-categories
                            </span>
                          ) : null}
                        </Td>
                        <Td>
                          {row.isActive ? (
                            <Chip tone="good">shown</Chip>
                          ) : (
                            <Chip tone="neutral">hidden</Chip>
                          )}
                        </Td>
                        <Td className="pr-1">
                          <CategoryRowActions
                            id={row.id}
                            name={row.name}
                            isActive={row.isActive}
                            canMoveUp={row.index > 0}
                            canMoveDown={row.index < row.siblingCount - 1}
                            canNest={nestBlockedBecause === null}
                            canUnnest={row.depth > 0}
                            nestBlockedBecause={nestBlockedBecause}
                          />
                        </Td>
                        <Td className="pr-1">
                          <div className="flex items-center justify-end gap-1">
                            <CategoryForm
                              category={{
                                id: row.id,
                                name: row.name,
                                slug: row.slug,
                                description: row.description,
                                parentId: row.parentId,
                                isActive: row.isActive,
                              }}
                              parents={rootChoices.filter(
                                (choice) => !own.includes(choice.id),
                              )}
                              triggerLabel={
                                <>
                                  Edit
                                  <span className="sr-only"> {row.name}</span>
                                </>
                              }
                              triggerVariant="ghost"
                            />
                            <DeleteCategory
                              id={row.id}
                              name={row.name}
                              childNames={row.childNames}
                              productCount={row.productCountIncludingDeleted}
                              destinations={options
                                .filter((option) => option.id !== row.id)
                                .map((option) => ({
                                  id: option.id,
                                  path: option.path,
                                }))}
                            />
                          </div>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </TableWrap>

            <Pagination
              params={params}
              total={total}
              basePath="/admin/categories"
            />

            <p className="text-muted-foreground text-sm text-pretty">
              {totalCategories} categor{totalCategories === 1 ? "y" : "ies"} in
              all. Pages count top-level groups, so a group and everything under
              it always stay together.
            </p>
          </>
        )}
      </AdminPage>
    </>
  );
}
