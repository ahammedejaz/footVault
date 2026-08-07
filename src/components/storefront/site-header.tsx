import Link from "next/link";
import { Heart, Menu, Search, ShoppingBag } from "lucide-react";

import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { getCategoryTree } from "@/lib/queries/catalog";
import { primaryNav } from "@/lib/site-config";

type NavItem = { label: string; href: string; children?: NavItem[] };

/**
 * Navigation is the live category tree, not a hard-coded list: a category the
 * owner adds in Phase 6 appears in the header without a deploy. `primaryNav`
 * from site-config is the fallback for a cold database, so the shell never
 * renders a bare bar.
 */
async function getNav(): Promise<NavItem[]> {
  try {
    const tree = await getCategoryTree();
    if (tree.length === 0) return [...primaryNav];
    return [
      ...tree.map((node) => ({
        label: node.name,
        href: `/shop/${node.slug}`,
        children: node.children.map((child) => ({
          label: child.name,
          href: `/shop/${child.slug}`,
        })),
      })),
      { label: "New in", href: "/collection/new-arrivals" },
      { label: "Sale", href: "/shop?on_sale=true" },
    ];
  } catch {
    return [...primaryNav];
  }
}

/**
 * Sticky storefront header. Nav collapses into a sheet below `lg`, because the
 * top-level categories cannot sit beside the logo and the utility icons at
 * 390px without either wrapping or shrinking below the tap floor.
 *
 * Below `sm` only search and bag stay in the bar — those are the two that carry
 * the purchase. Saved items moves into the sheet: the wordmark must not wrap,
 * so the lockup cannot shrink, and a fourth 44px target overflows a 360px
 * screen.
 */
export async function SiteHeader() {
  const nav = await getNav();

  return (
    <header className="bg-background/95 border-border supports-[backdrop-filter]:bg-background/80 sticky top-0 z-50 border-b backdrop-blur">
      {/* gap-1 below `sm`: at 390px the menu button, the lockup and the utility
          icons together leave no room for gap-2, and the lockup cannot shrink
          because the wordmark must not wrap. */}
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-1 px-4 sm:gap-2 sm:px-6">
        <Sheet>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              aria-label="Open menu"
            >
              <Menu />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[min(20rem,85vw)] overflow-y-auto p-0">
            <SheetHeader className="border-border border-b px-5 py-4">
              <SheetTitle className="text-left">
                <Logo />
              </SheetTitle>
            </SheetHeader>
            <nav aria-label="Main" className="px-2 py-3">
              <ul>
                {nav.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="hover:bg-muted font-display flex min-h-11 items-center rounded-lg px-3 text-lg font-bold tracking-[-0.02em] uppercase"
                    >
                      {item.label}
                    </Link>
                    {item.children?.length ? (
                      <ul className="mb-2 ml-3">
                        {item.children.map((child) => (
                          <li key={child.href}>
                            <Link
                              href={child.href}
                              className="text-muted-foreground hover:text-foreground flex min-h-11 items-center rounded-lg px-3 text-sm"
                            >
                              {child.label}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
              <ul className="border-border mt-3 border-t pt-3">
                <li>
                  <Link
                    href="/wishlist"
                    className="hover:bg-muted flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm"
                  >
                    <Heart className="size-4" />
                    Saved items
                  </Link>
                </li>
              </ul>
            </nav>
          </SheetContent>
        </Sheet>

        <Link
          href="/"
          className="mr-auto inline-flex min-h-11 items-center rounded-lg lg:mr-8"
        >
          <Logo />
          <span className="sr-only">Foot Vault home</span>
        </Link>

        <nav aria-label="Main" className="mr-auto hidden lg:block">
          <ul className="flex items-center gap-1">
            {nav.map((item) => (
              <li key={item.href} className="group relative">
                <Link
                  href={item.href}
                  className="hover:text-orange-ink after:bg-orange relative flex min-h-11 items-center px-3 text-sm font-medium after:absolute after:inset-x-3 after:bottom-3 after:h-px after:origin-left after:scale-x-0 after:transition-transform hover:after:scale-x-100"
                >
                  {item.label}
                </Link>
                {item.children?.length ? (
                  /* Opens on hover and on keyboard focus. `invisible` rather
                     than `hidden` so the links stay in the tab order and the
                     panel can be reached without a mouse. */
                  <div className="invisible absolute top-full left-0 z-50 pt-1 opacity-0 transition-[opacity,visibility] group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
                    <ul className="border-border bg-background min-w-44 rounded-lg border p-1 shadow-lg">
                      {item.children.map((child) => (
                        <li key={child.href}>
                          <Link
                            href={child.href}
                            className="hover:bg-muted flex min-h-11 items-center rounded-lg px-3 text-sm"
                          >
                            {child.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </nav>

        <Button variant="ghost" size="icon" asChild>
          <Link href="/search" aria-label="Search">
            <Search />
          </Link>
        </Button>
        <Button variant="ghost" size="icon" className="hidden sm:inline-flex" asChild>
          <Link href="/wishlist" aria-label="Saved items">
            <Heart />
          </Link>
        </Button>
        <Button variant="ghost" size="icon" asChild>
          <Link href="/cart" aria-label="Bag, 0 items">
            <ShoppingBag />
          </Link>
        </Button>
      </div>
    </header>
  );
}
