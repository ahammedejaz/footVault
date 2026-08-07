/**
 * Structural defaults for the shell.
 *
 * These are placeholders with a defined end date: from Phase 7 every value here
 * is read from the `site_settings` table so the owner can change the phone
 * number, the announcement, or the returns window from /admin/settings without
 * a deploy. Nothing here is customer data or catalog content — it is the
 * scaffolding those tables will fill.
 */
export const siteConfig = {
  name: "Foot Vault",
  tagline: "Every step counts",
  description:
    "Sneakers, formal shoes, boots and sandals for men, women and kids. Free returns within 7 days.",
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
} as const;

/** Returns window in days. Moves to site_settings in Phase 7. */
export const RETURN_WINDOW_DAYS = 7;

/**
 * Fallback navigation.
 *
 * The header builds its nav from the live category tree; this is what it falls
 * back to when the database is unreachable, so the shell still renders links
 * that resolve rather than an empty bar. Every href here is a real route.
 */
export const primaryNav = [
  { label: "Men", href: "/shop/men" },
  { label: "Women", href: "/shop/women" },
  { label: "Kids", href: "/shop/kids" },
  { label: "New in", href: "/collection/new-arrivals" },
  { label: "Sale", href: "/shop?on_sale=true" },
] as const;

export const footerNav = [
  {
    heading: "Shop",
    links: [
      { label: "All footwear", href: "/shop" },
      { label: "New arrivals", href: "/collection/new-arrivals" },
      { label: "Monsoon ready", href: "/collection/monsoon-ready" },
      { label: "Men", href: "/shop/men" },
      { label: "Women", href: "/shop/women" },
      { label: "Kids", href: "/shop/kids" },
    ],
  },
  {
    heading: "Help",
    links: [
      { label: "Contact us", href: "/page/contact" },
      { label: "Shipping", href: "/page/shipping" },
      { label: "Returns", href: "/page/returns" },
      { label: "Size guide", href: "/page/size-guide" },
    ],
  },
  {
    heading: "Foot Vault",
    links: [
      { label: "About", href: "/page/about" },
      { label: "Privacy", href: "/page/privacy" },
      { label: "Terms", href: "/page/terms" },
    ],
  },
] as const;
