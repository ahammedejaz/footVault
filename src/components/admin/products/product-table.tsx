"use client";

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { ConfirmAction } from "@/components/admin/confirm-action";
import { SortableTh, Table, TableWrap, Td, Th } from "@/components/admin/table";
import { Chip } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import type { ListParams } from "@/lib/admin/list-params";
import { RestoreButton } from "@/components/admin/products/restore-button";
import {
  deleteProduct,
  purgeProduct,
  setProductsActive,
} from "@/lib/actions/admin/products";
import { formatPaise } from "@/lib/format";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { ProductListRow } from "@/components/admin/products/types";

/**
 * The products table, and the one thing on this page that has to be a Client
 * Component.
 *
 * Sorting and paging are still anchors — `SortableTh` is rendered from here but
 * is nothing more than a `<Link>`, so the URL stays the source of truth for the
 * view. What forces the boundary is the selection: bulk activate needs a set of
 * ids that survives across rows, and there is no honest way to hold that in a
 * URL an owner is expected to read.
 *
 * The selection is deliberately **not** persisted across pages. A tick on page
 * one that silently applies after the owner has navigated to page three is a
 * bulk action nobody consented to; clearing on navigation is the safe default
 * and costs one extra pass with the finger.
 */
export function ProductTable({
  rows,
  params,
  basePath,
  extras,
}: {
  rows: ProductListRow[];
  params: ListParams;
  basePath: string;
  extras: Record<string, string | undefined>;
}) {
  const router = useRouter();
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(
    new Set(),
  );
  const [pending, setPending] = React.useState(false);

  /**
   * A row that is no longer on screen cannot stay selected.
   *
   * Adjusted during render rather than in an effect on `[rows]`: the effect
   * version renders once with the stale selection — "4 selected" over three
   * rows — commits, and corrects itself on the next pass. Setting state during
   * render of the same component makes React discard the in-progress render and
   * redo it before anything reaches the DOM.
   */
  const ids = rows.map((row) => row.id).join(",");
  const [renderedIds, setRenderedIds] = React.useState(ids);
  if (renderedIds !== ids) {
    setRenderedIds(ids);
    if (selected.size > 0) setSelected(new Set());
  }

  const selectable = rows.filter((row) => row.deletedAt === null);
  const allSelected =
    selectable.length > 0 && selectable.every((row) => selected.has(row.id));

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(selectable.map((r) => r.id)));
  }

  async function bulkSetActive(isActive: boolean) {
    setPending(true);
    const result = await setProductsActive({
      ids: [...selected],
      isActive,
    });
    setPending(false);

    if (!result.ok) {
      toast.failed(result.message);
      return;
    }
    toast.done(
      isActive
        ? `${result.updated} ${result.updated === 1 ? "product is" : "products are"} on the shop`
        : `${result.updated} ${result.updated === 1 ? "product is" : "products are"} hidden`,
      "The shop updates straight away.",
    );
    setSelected(new Set());
    router.refresh();
  }

  return (
    <div className="space-y-3">
      {/* The bar takes the row above the table rather than replacing the
          toolbar, so the search box does not move under a thumb mid-selection. */}
      {selected.size > 0 ? (
        <div
          role="group"
          aria-label="Actions for the selected products"
          className="border-border bg-muted/50 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
        >
          <p className="text-sm font-medium tabular-nums" aria-live="polite">
            {selected.size} selected
          </p>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => bulkSetActive(true)}
            >
              Put on the shop
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => bulkSetActive(false)}
            >
              Hide from the shop
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
          </div>
        </div>
      ) : null}

      <TableWrap label="Products">
        <Table className="min-w-[58rem]">
          <thead>
            <tr>
              <Th className="w-11">
                <SelectBox
                  checked={allSelected}
                  disabled={selectable.length === 0}
                  onChange={toggleAll}
                  label="Select every product on this page"
                />
              </Th>
              <SortableTh
                column="name"
                params={params}
                basePath={basePath}
                extras={extras}
              >
                Product
              </SortableTh>
              <Th>Category</Th>
              <SortableTh
                column="base_price"
                params={params}
                basePath={basePath}
                extras={extras}
                numeric
              >
                Price
              </SortableTh>
              <Th numeric>Sizes</Th>
              {/*
                Named for exactly what it counts.

                "In stock" on this page is a *product* total — every size added
                together — while the same words on /admin/inventory are one
                size's own count. Two screens showing different numbers under an
                identical heading is the report that opened Phase 7: "I cannot
                tell which number is true." Both read `stock_quantity` live and
                neither is wrong; the heading was.
              */}
              <Th numeric>
                <span title="Every size of this product added together. For one size's own count, open Inventory.">
                  All sizes
                </span>
              </Th>
              <Th>On the shop</Th>
              <SortableTh
                column="updated_at"
                params={params}
                basePath={basePath}
                extras={extras}
                initialDir="desc"
              >
                Changed
              </SortableTh>
              {/* Named for a screen reader, blank for everyone else — a pinned
                  column with a visible heading of "Actions" would spend the one
                  bit of width this column has on a word nobody needs. */}
              <Th stickyEnd>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="group/row hover:bg-muted/40">
                <Td>
                  <SelectBox
                    checked={selected.has(row.id)}
                    disabled={row.deletedAt !== null}
                    onChange={() => toggle(row.id)}
                    label={`Select ${row.name}`}
                  />
                </Td>

                <Td className="max-w-[20rem]">
                  <div className="flex items-center gap-2.5">
                    <Thumbnail row={row} />
                    <span className="min-w-0">
                      <Link
                        href={`/admin/products/${row.id}`}
                        className="block truncate font-medium underline-offset-4 hover:underline"
                      >
                        {row.name}
                      </Link>
                      <span className="text-muted-foreground block truncate text-xs">
                        {row.brandName ?? "No brand"} ·{" "}
                        <span className="font-mono">{row.slug}</span>
                      </span>
                    </span>
                  </div>
                </Td>

                <Td className="max-w-[10rem] truncate">
                  {row.categoryName ?? (
                    <span className="text-muted-foreground">—</span>
                  )}
                </Td>

                <Td numeric className="whitespace-nowrap">
                  {row.salePrice ? (
                    <>
                      <span className="text-muted-foreground line-through">
                        {formatPaise(row.basePrice)}
                      </span>{" "}
                      <span className="font-medium">
                        {formatPaise(row.salePrice)}
                      </span>
                    </>
                  ) : (
                    formatPaise(row.basePrice)
                  )}
                </Td>

                <Td numeric>{row.variantCount}</Td>

                <Td
                  numeric
                  className={cn(
                    row.variantCount > 0 &&
                      row.totalStock === 0 &&
                      "text-destructive font-semibold",
                  )}
                >
                  {row.totalStock}
                </Td>

                <Td>
                  {row.deletedAt ? (
                    <Chip tone="bad">removed</Chip>
                  ) : row.isActive ? (
                    <Chip tone="good">on</Chip>
                  ) : (
                    <Chip tone="neutral">off</Chip>
                  )}
                </Td>

                <Td className="text-muted-foreground whitespace-nowrap">
                  {formatDate(row.updatedAt)}
                </Td>

                <Td stickyEnd>
                  <div className="flex items-center justify-end gap-1.5">
                    {row.deletedAt ? (
                      <>
                        <RestoreButton id={row.id} name={row.name} />
                        {/*
                          The bottom of the drawer, and the only place it is
                          offered.

                          A soft-deleted product is kept because past orders
                          point at it, which is right — but it made "Removed" a
                          list that could only ever grow, and the owner asked to
                          be able to empty it. Reachable only from this filter
                          on purpose: emptying a bin is a different act from
                          throwing something into it, and putting both on a live
                          row would put the irreversible one a mis-tap away from
                          the reversible one.
                        */}
                        <ConfirmAction
                          subject={`Delete ${row.name} from the database?`}
                          consequence={
                            row.hasOrders
                              ? "The orders it appears on keep every line exactly as it reads today — name, size, price, picture — but they stop being linked to this product, so it will no longer be counted in what you have sold. Its sizes and photographs go with it. Nothing can bring this back."
                              : "It, its sizes and its photographs go for good. No order refers to it, so nothing else changes. Nothing can bring this back."
                          }
                          confirmLabel="Delete it for good"
                          triggerLabel="Delete for good"
                          triggerVariant="ghost"
                          triggerClassName="text-muted-foreground hover:text-destructive"
                          requireTyping="delete"
                          action={() => purgeProduct({ id: row.id })}
                          successMessage={`${row.name} is gone from the database`}
                        />
                      </>
                    ) : (
                      <>
                        <Button variant="outline" size="sm" asChild>
                          <Link href={`/admin/products/${row.id}`}>Edit</Link>
                        </Button>
                        <ConfirmAction
                          subject={`Delete ${row.name}?`}
                          consequence={
                            row.hasOrders
                              ? "This product is on past orders, so it will be hidden rather than removed — the shop stops showing it and every order keeps its history. You can put it back from the Removed filter."
                              : "It has never been ordered, so it goes for good, along with its sizes and photographs. This cannot be undone."
                          }
                          confirmLabel={
                            row.hasOrders ? "Hide it" : "Delete it forever"
                          }
                          triggerLabel="Delete"
                          triggerVariant="ghost"
                          requireTyping={row.hasOrders ? undefined : "delete"}
                          action={() => deleteProduct({ id: row.id })}
                          successMessage={
                            row.hasOrders
                              ? `${row.name} is hidden from the shop`
                              : `${row.name} has been deleted`
                          }
                        />
                      </>
                    )}
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
    </div>
  );
}

/**
 * A checkbox with a 44px reach.
 *
 * The box itself is 20px, which is what a checkbox should look like next to
 * 14px table text; the `<label>` around it carries the padding that makes the
 * target big enough to hit on a tablet, and carries the accessible name so
 * every row's tick says which product it ticks.
 */
function SelectBox({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <label
      className={cn(
        "-m-3 inline-flex size-11 cursor-pointer items-center justify-center p-3",
        disabled && "cursor-not-allowed opacity-40",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        aria-label={label}
        className="accent-foreground size-5 cursor-[inherit]"
      />
    </label>
  );
}

function Thumbnail({ row }: { row: ProductListRow }) {
  if (!row.imageUrl) {
    return (
      <span
        aria-hidden
        className="bg-muted text-muted-foreground grid size-10 shrink-0 place-items-center rounded-sm font-mono text-xs"
      >
        —
      </span>
    );
  }
  return (
    <Image
      src={row.imageUrl}
      alt=""
      width={40}
      height={40}
      className="bg-muted size-10 shrink-0 rounded-sm object-cover"
    />
  );
}

/** Short, shop-local, and never the raw ISO string. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    timeZone: "Asia/Kolkata",
  });
}
