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

/**
 * The headings the sections are filed under, in the order they are shown.
 *
 * ## Why the panel grew headings
 *
 * Sixteen links with a two-line description each is roughly 900 pixels of
 * undifferentiated list, and the owner's complaint about it was the right one:
 * a flat list of everything is a list you read from the top every time, because
 * nothing tells you which third of it your task is in. Grouping does not remove
 * a single link — it means "where do I change the returns policy" is answered
 * by reading five headings instead of sixteen labels.
 *
 * The order is the working day rather than the alphabet: what happened today,
 * what to send out, what is for sale, what the shop looks like, and the
 * machinery underneath.
 */
export const ADMIN_NAV_GROUPS = [
  "Today",
  "Selling",
  "What you sell",
  "The website",
  "Offers and customers",
  "The shop itself",
] as const;

export type AdminNavGroup = (typeof ADMIN_NAV_GROUPS)[number];

export type AdminNavItem = {
  href: string;
  label: string;
  /** Which heading this sits under. */
  group: AdminNavGroup;
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
    group: "Today",
    hint: "Today at a glance",
    exact: true,
  },
  {
    href: "/admin/orders",
    label: "Orders",
    group: "Selling",
    hint: "Take, pack and ship",
  },
  {
    href: "/admin/rto",
    label: "Returns to origin",
    group: "Selling",
    hint: "Parcels coming back",
  },
  {
    href: "/admin/products",
    label: "Products",
    group: "What you sell",
    hint: "Everything you sell",
  },
  {
    href: "/admin/inventory",
    label: "Inventory",
    group: "What you sell",
    hint: "Stock, by size",
  },
  {
    href: "/admin/categories",
    label: "Categories",
    group: "What you sell",
    hint: "How the shop is grouped, and their pictures",
  },
  {
    href: "/admin/brands",
    label: "Brands",
    group: "What you sell",
    hint: "Makers you stock, and their logos",
  },
  {
    href: "/admin/appearance",
    label: "Appearance",
    group: "The website",
    hint: "The homepage, arranged",
  },
  {
    href: "/admin/pages",
    label: "Pages",
    group: "The website",
    hint: "About, Contact and the policies",
  },
  {
    href: "/admin/media",
    label: "Media",
    group: "The website",
    hint: "Uploaded photographs",
  },
  {
    href: "/admin/coupons",
    label: "Coupons",
    group: "Offers and customers",
    hint: "Codes and offers",
  },
  {
    href: "/admin/loyalty",
    label: "Vault Coins",
    group: "Offers and customers",
    hint: "The programme, and what it owes",
  },
  {
    href: "/admin/reviews",
    label: "Reviews",
    group: "Offers and customers",
    hint: "What customers said, and removals",
  },
  {
    href: "/admin/customers",
    label: "Customers",
    group: "Offers and customers",
    hint: "Who has bought what",
  },
  {
    href: "/admin/settings",
    label: "Settings",
    group: "The shop itself",
    hint: "Shop details, logo and rules",
  },
  {
    href: "/admin/health",
    label: "Health",
    group: "The shop itself",
    hint: "Is the machinery alive",
  },
] as const;

/**
 * The same list, under its headings, for rendering.
 *
 * Derived rather than declared, so `ADMIN_NAV` stays the single flat source
 * every screen and both gates already iterate — `audit:admin-mobile` walks it
 * to visit every page at 360px, and `audit:admin-pages` compares it against the
 * routes that exist. A second hand-maintained nested copy is exactly the
 * "hand-maintained list that rots" failure class the 2026-08-20 sweep was
 * organised around.
 *
 * A group with no items is dropped, so removing the last screen in a section
 * removes its heading rather than leaving a label over nothing.
 */
export const ADMIN_NAV_SECTIONS: readonly {
  label: AdminNavGroup;
  items: readonly AdminNavItem[];
}[] = ADMIN_NAV_GROUPS.map((label) => ({
  label,
  items: ADMIN_NAV.filter((item) => item.group === label),
})).filter((section) => section.items.length > 0);

/** Whether `pathname` is inside `item`. */
export function isActive(item: AdminNavItem, pathname: string): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
