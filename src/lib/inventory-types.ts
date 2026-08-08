/**
 * Inventory view models, shared by the server that reads them and the client
 * that renders them.
 *
 * No server dependency, for the same structural reason as `cart-types.ts`,
 * `catalog-types.ts` and `orders/types.ts`. `StockCell` is a Client Component
 * and it needs this shape; importing it from `@/lib/queries/admin/inventory`
 * would reach into a `server-only` module.
 *
 * That import type-checks and builds, which is exactly why it is banned rather
 * than left to judgement: a `import type` is erased, so nothing complains — and
 * the next edit that needs one more thing from that file turns it into a value
 * import, which is a build error at best and a service-role client in the
 * browser bundle at worst. CI fails the PR on the type-only form so the
 * boundary stays structural. It caught this file's absence on the first run.
 */

/** One line of a variant's stock ledger, as the admin panel renders it. */
export type MovementRow = {
  id: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  note: string | null;
  createdAt: string;
  /** Null for movements nobody made by hand — the sweep, the opening balance. */
  actorName: string | null;
};
