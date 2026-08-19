import Link from "next/link";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { listHref, type ListParams } from "@/lib/admin/list-params";
import { cn } from "@/lib/utils";

/**
 * The admin table.
 *
 * Server Components throughout — sorting and paging are anchors, so the only
 * JavaScript on a list page is the search box. See `src/lib/admin/list-params.ts`
 * for why the state lives in the URL.
 *
 * **It scrolls sideways rather than reflowing into cards.** The owner is
 * comparing rows, and a card list makes "which of these is lowest" a memory
 * exercise. `overflow-x-auto` on the wrapper with `min-w-` on the table keeps
 * the columns aligned and lets a tablet in portrait swipe across them, which is
 * the same gesture the rest of the tablet uses. The wrapper is focusable so a
 * keyboard user can scroll it too — a scroll container that only a mouse can
 * reach is an accessibility failure that looks like a working table.
 *
 * **The actions column pins to the right edge (`stickyEnd`), and that is a
 * correctness fix rather than a flourish.** Sideways scrolling is fine for
 * *reading* columns; it is not fine for the column that holds Edit and Delete.
 * On a phone a 46rem table shows about a third of itself, so those controls sat
 * roughly two screen-widths off to the right — present in the DOM, reachable by
 * swiping, and invisible to anyone who did not already know they were there.
 * The owner's report was that the panel offered no way to add or remove a
 * brand. The buttons had been there the whole time.
 */

export function TableWrap({
  children,
  label,
  className,
}: {
  children: React.ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn(
        "border-border overflow-x-auto rounded-md border",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Table({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <table className={cn("w-full border-collapse text-sm", className)}>
      {children}
    </table>
  );
}

/**
 * The pinned-to-the-right-edge column, shared by `Th` and `Td`.
 *
 * **The shadow is doing the job a border cannot.** The table is
 * `border-collapse: collapse`, and a collapsed border belongs to the table's
 * border grid rather than to the cell — so it stays where the grid put it while
 * the sticky cell travels, and the divider ends up stranded mid-row. A
 * `box-shadow` is painted by the cell itself and moves with it, which is why
 * this is an inset shadow rather than `border-l`.
 *
 * The opaque background is not optional either: without it the columns being
 * scrolled underneath read straight through the buttons.
 */
const STICKY_END =
  "bg-background sticky right-0 shadow-[inset_1px_0_0_var(--border)]";

export function Th({
  children,
  className,
  numeric,
  scope = "col",
  stickyEnd,
}: {
  children?: React.ReactNode;
  className?: string;
  numeric?: boolean;
  scope?: "col" | "row";
  /** Pins the column to the right edge while the table scrolls under it. */
  stickyEnd?: boolean;
}) {
  return (
    <th
      scope={scope}
      className={cn(
        "bg-muted/60 text-muted-foreground border-border border-b px-3 py-2 text-left font-mono text-xs font-normal tracking-[0.06em] whitespace-nowrap uppercase",
        numeric && "text-right",
        // `z-20` against the body cells' `z-10`: both are sticky, and without
        // the order stated the rows slide over the header.
        stickyEnd && `${STICKY_END} bg-muted z-20`,
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  numeric,
  stickyEnd,
}: {
  children?: React.ReactNode;
  className?: string;
  numeric?: boolean;
  /** Pins the cell to the right edge while the table scrolls under it. */
  stickyEnd?: boolean;
}) {
  return (
    <td
      className={cn(
        "border-border border-b px-3 py-2 align-middle",
        numeric && "text-right tabular-nums",
        // `group-hover/row` rather than inheriting the row's own
        // `hover:bg-muted/40`: the opaque background this cell needs would
        // otherwise make it the one cell in the row that does not light up,
        // which reads as a rendering fault rather than as a pinned column.
        stickyEnd && `${STICKY_END} z-10 group-hover/row:bg-muted/40`,
        className,
      )}
    >
      {children}
    </td>
  );
}

/**
 * A column header that sorts.
 *
 * `aria-sort` on the `<th>` is what a screen reader announces; the arrow is what
 * everyone else reads. Both come from the same prop, so a column cannot look
 * sorted and announce unsorted.
 *
 * Clicking the active column flips direction; clicking another switches to it
 * and starts at the direction that column is most useful in — descending for a
 * date, ascending for a name — which the caller passes rather than this
 * guessing from the key.
 */
export function SortableTh({
  children,
  column,
  params,
  basePath,
  extras,
  numeric,
  initialDir = "asc",
  stickyEnd,
}: {
  children: React.ReactNode;
  column: string;
  params: ListParams;
  basePath: string;
  extras?: Record<string, string | undefined>;
  numeric?: boolean;
  initialDir?: "asc" | "desc";
  /**
   * Pins the column to the right edge while the table scrolls under it.
   * Added 2026-08-20 when the phone sweep found the inventory stock buttons
   * at x=688 in a 360px viewport — the capability lived on `Th` alone, so a
   * sortable actions column could not have it. Same class as the CouponForm
   * overflow patch: the primitive owns the fix, not one call site.
   */
  stickyEnd?: boolean;
}) {
  const active = params.sort === column;
  const nextDir = active ? (params.dir === "asc" ? "desc" : "asc") : initialDir;
  const Icon = !active
    ? ChevronsUpDown
    : params.dir === "asc"
      ? ArrowUp
      : ArrowDown;

  return (
    <th
      scope="col"
      aria-sort={
        active ? (params.dir === "asc" ? "ascending" : "descending") : "none"
      }
      className={cn(
        "bg-muted/60 text-muted-foreground border-border border-b px-1 py-1 text-left font-mono text-xs font-normal tracking-[0.06em] whitespace-nowrap uppercase",
        numeric && "text-right",
        stickyEnd && `${STICKY_END} bg-muted z-20`,
      )}
    >
      <Link
        href={listHref(
          basePath,
          params,
          { sort: column, dir: nextDir },
          extras,
        )}
        className={cn(
          "hover:text-foreground inline-flex min-h-9 items-center gap-1 rounded-sm px-2 transition-colors",
          active && "text-foreground",
        )}
      >
        {children}
        <Icon className="size-3 shrink-0" aria-hidden />
      </Link>
    </th>
  );
}

/**
 * Server-side pagination.
 *
 * States the range and the total in words rather than only drawing arrows,
 * because "26–50 of 312" answers the question the owner actually has, which is
 * how much is left.
 */
export function Pagination({
  params,
  total,
  basePath,
  extras,
}: {
  params: ListParams;
  total: number;
  basePath: string;
  extras?: Record<string, string | undefined>;
}) {
  const pages = Math.max(1, Math.ceil(total / params.perPage));
  const from = total === 0 ? 0 : (params.page - 1) * params.perPage + 1;
  const to = Math.min(total, params.page * params.perPage);

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 pt-3"
    >
      <p className="text-muted-foreground text-sm tabular-nums">
        {total === 0 ? "Nothing to show" : `${from}–${to} of ${total}`}
      </p>
      {pages > 1 ? (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={params.page <= 1}
            asChild={params.page > 1}
          >
            {params.page > 1 ? (
              <Link
                href={listHref(
                  basePath,
                  params,
                  { page: params.page - 1 },
                  extras,
                )}
              >
                Previous
              </Link>
            ) : (
              <span>Previous</span>
            )}
          </Button>
          <span className="text-muted-foreground text-sm tabular-nums">
            Page {params.page} of {pages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={params.page >= pages}
            asChild={params.page < pages}
          >
            {params.page < pages ? (
              <Link
                href={listHref(
                  basePath,
                  params,
                  { page: params.page + 1 },
                  extras,
                )}
              >
                Next
              </Link>
            ) : (
              <span>Next</span>
            )}
          </Button>
        </div>
      ) : null}
    </nav>
  );
}
