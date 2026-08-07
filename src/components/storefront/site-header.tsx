import Link from "next/link";
import { Heart, Menu, Search, ShoppingBag, User } from "lucide-react";

import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { primaryNav } from "@/lib/site-config";

/** Reachable from the mobile sheet, since their icons do not fit the bar. */
const SECONDARY_NAV = [
  { label: "Wishlist", href: "/wishlist", icon: Heart },
  { label: "Your account", href: "/account", icon: User },
] as const;

/**
 * Sticky storefront header. Nav collapses into a sheet below `lg`, because the
 * five top-level categories cannot sit beside the logo and the utility icons at
 * 390px without either wrapping or shrinking below the tap floor.
 *
 * Below `sm` only search and bag stay in the bar — those are the two that carry
 * the purchase. Wishlist moves into the sheet: the wordmark must not wrap, so
 * the lockup cannot shrink, and a fourth 44px target overflows a 360px screen.
 *
 * The bag count is static at zero until Phase 4 wires the cart store.
 */
export function SiteHeader() {
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
          <SheetContent side="left" className="w-[min(20rem,85vw)] p-0">
            <SheetHeader className="border-border border-b px-5 py-4">
              <SheetTitle className="text-left">
                <Logo />
              </SheetTitle>
            </SheetHeader>
            <nav aria-label="Main" className="px-2 py-3">
              <ul>
                {primaryNav.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="hover:bg-muted font-display flex min-h-11 items-center rounded-lg px-3 text-lg font-bold tracking-[-0.02em] uppercase"
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
              <ul className="border-border mt-3 border-t pt-3">
                {SECONDARY_NAV.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="hover:bg-muted flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm"
                    >
                      <item.icon className="size-4" />
                      {item.label}
                    </Link>
                  </li>
                ))}
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
            {primaryNav.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="hover:text-orange-ink relative flex min-h-11 items-center px-3 text-sm font-medium after:absolute after:inset-x-3 after:bottom-3 after:h-px after:origin-left after:scale-x-0 after:bg-orange after:transition-transform hover:after:scale-x-100"
                >
                  {item.label}
                </Link>
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
          <Link href="/wishlist" aria-label="Wishlist">
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
