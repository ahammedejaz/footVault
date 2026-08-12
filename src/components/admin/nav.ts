/**
 * The admin's navigation, as data.
 *
 * Shared by the sidebar and the small-screen drawer so the two cannot disagree
 * about what exists — which they did in Phase 4's storefront chrome, where the
 * mobile menu was a hand-copied subset that went stale the first time a route
 * was added.
 *
 * No icons carried here. An icon is a rendering decision and this list is what
 * the panel *is*; keeping lucide out of it also keeps this importable from a
 * Server Component without pulling a client library along.
 */

export type AdminNavItem = {
  href: string;
  label: string;
  /** What the owner would call it, for the drawer's secondary line. */
  hint: string;
  /**
   * Whether a child route should light this up. `/admin` would otherwise match
   * every path in the panel, and `/admin/products` would match
   * `/admin/products/new`, which is correct — but only one of those is.
   */
  exact?: boolean;
};

export const ADMIN_NAV: readonly AdminNavItem[] = [
  {
    href: "/admin",
    label: "Dashboard",
    hint: "Today at a glance",
    exact: true,
  },
  { href: "/admin/orders", label: "Orders", hint: "Take, pack and ship" },
  {
    href: "/admin/rto",
    label: "Returns to origin",
    hint: "Parcels coming back",
  },
  { href: "/admin/products", label: "Products", hint: "Everything you sell" },
  { href: "/admin/inventory", label: "Inventory", hint: "Stock, by size" },
  {
    href: "/admin/categories",
    label: "Categories",
    hint: "How the shop is grouped",
  },
  { href: "/admin/brands", label: "Brands", hint: "Makers you stock" },
  { href: "/admin/coupons", label: "Coupons", hint: "Codes and offers" },
  {
    href: "/admin/loyalty",
    label: "Vault Coins",
    hint: "The programme, and what it owes",
  },
  {
    href: "/admin/reviews",
    label: "Reviews",
    hint: "What customers said, and removals",
  },
  { href: "/admin/customers", label: "Customers", hint: "Who has bought what" },
  { href: "/admin/media", label: "Media", hint: "Uploaded photographs" },
  {
    href: "/admin/appearance",
    label: "Appearance",
    hint: "The homepage, arranged",
  },
  {
    href: "/admin/settings",
    label: "Settings",
    hint: "Shop details and rules",
  },
  {
    href: "/admin/health",
    label: "Health",
    hint: "Is the machinery alive",
  },
] as const;

/** Whether `pathname` is inside `item`. */
export function isActive(item: AdminNavItem, pathname: string): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
