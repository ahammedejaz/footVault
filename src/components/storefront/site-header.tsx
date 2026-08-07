import Link from "next/link";
import { Heart, ShoppingBag } from "lucide-react";

import { Logo } from "@/components/brand/logo";
import { AccountMenu } from "@/components/storefront/account-menu";
import { BagLink, SavedLink } from "@/components/storefront/header-links";
import { MegaNav } from "@/components/storefront/mega-nav";
import { MobileNav } from "@/components/storefront/mobile-nav";
import { SearchButton } from "@/components/storefront/search-button";
import type { NavItem } from "@/components/storefront/nav-types";
import { deferIfPrerendering } from "@/lib/prerender";
import { cachedCategoryTree, cachedPopularBrands } from "@/lib/queries/cached";
import { getCurrentUser } from "@/lib/auth";
import { primaryNav } from "@/lib/site-config";

/**
 * Navigation is the live category tree, not a hard-coded list: a category the
 * owner adds in Phase 6 appears in the header without a deploy. `primaryNav`
 * from site-config is the fallback for a cold database, so the shell never
 * renders a bare bar — and the failure is logged rather than swallowed, because
 * a header quietly falling back to five hard-coded links is exactly the kind of
 * thing that survives to production unnoticed.
 */
async function getNav(): Promise<NavItem[]> {
  try {
    const tree = await cachedCategoryTree();
    if (tree.length === 0) return [...primaryNav];
    return [
      ...tree.map((node) => ({
        label: node.name,
        href: `/shop/${node.slug}`,
        children: node.children.map((child) => ({
          label: child.name,
          href: `/shop/${child.slug}`,
          description: child.description,
        })),
      })),
      { label: "New in", href: "/collection/new-arrivals" },
      { label: "Sale", href: "/shop?on_sale=true" },
    ];
  } catch (error) {
    // At build time, render this route on demand rather than baking a
    // navigation that would never recover.
    await deferIfPrerendering("header nav", error);
    console.error(
      "[header] category tree unavailable, falling back to the static nav",
      error,
    );
    return [...primaryNav];
  }
}

/** Entry points offered inside the search overlay before anything is typed. */
async function getPopularSearches(): Promise<Array<{ label: string; href: string }>> {
  try {
    const brands = await cachedPopularBrands(5);
    return [
      { label: "New arrivals", href: "/collection/new-arrivals" },
      { label: "On sale", href: "/shop?on_sale=true" },
      ...brands.map((brand) => ({
        label: brand.label,
        href: `/shop?brand=${brand.value}`,
      })),
    ];
  } catch (error) {
    await deferIfPrerendering("header popular searches", error);
    console.error("[header] popular searches unavailable", error);
    return [{ label: "All footwear", href: "/shop" }];
  }
}

/**
 * Sticky storefront header. Nav collapses into a drawer below `lg`, because the
 * top-level categories cannot sit beside the logo and the utility icons at
 * 390px without either wrapping or shrinking below the tap floor.
 */
export async function SiteHeader() {
  const [nav, popular, user] = await Promise.all([
    getNav(),
    getPopularSearches(),
    getCurrentUser(),
  ]);

  return (
    <header className="bg-background/95 border-border supports-[backdrop-filter]:bg-background/80 sticky top-0 z-50 border-b backdrop-blur">
      {/* gap-1 below `sm`: at 390px the menu button, the lockup and the utility
          icons together leave no room for gap-2, and the lockup cannot shrink
          because the wordmark must not wrap. */}
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-1 px-4 sm:gap-2 sm:px-6">
        <MobileNav
          items={nav}
          user={user ? { name: user.name, email: user.email } : null}
        />

        <Link
          href="/"
          className="mr-auto inline-flex min-h-11 items-center rounded-lg lg:mr-8"
        >
          <Logo />
          <span className="sr-only">Foot Vault home</span>
        </Link>

        <MegaNav items={nav} />

        <SearchButton popular={popular} />
        <AccountMenu user={user ? { name: user.name, email: user.email } : null} />
        <SavedLink>
          <Heart />
        </SavedLink>
        <BagLink>
          <ShoppingBag />
        </BagLink>
      </div>
    </header>
  );
}
