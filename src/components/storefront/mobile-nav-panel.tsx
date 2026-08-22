"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Dialog } from "radix-ui";
import { ChevronDown, Heart, LogOut, MapPin, Package, X } from "lucide-react";

import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import type { AccountUser } from "@/components/storefront/account-menu";
import { GoogleSignInForm } from "@/components/storefront/sign-in";
import type { NavItem } from "@/components/storefront/nav-types";
import { signOut } from "@/lib/actions/auth";
import { useCurrentPath } from "@/hooks/use-current-path";
import { useSwipeDismiss } from "@/hooks/use-swipe-dismiss";
import { cn } from "@/lib/utils";

/**
 * The mobile drawer.
 *
 * Closable four ways, because a drawer that traps you is the worst thing on a
 * phone: the close button, the backdrop, Escape (both from Radix), and a swipe
 * back towards the left edge it came from.
 *
 * Nesting is an accordion rather than a second screen. A drill-down needs a
 * back affordance and loses the customer's place; an accordion keeps the whole
 * tree on one surface, and the section for the page you are on opens itself.
 */
export function MobileNavPanel({
  items,
  user,
  branding,
  open,
  onOpenChange,
}: {
  items: NavItem[];
  user: AccountUser | null;
  /** The shop's own mark and name, so the drawer matches the header above it. */
  branding: { logoUrl: string | null; shopName: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const setOpen = onOpenChange;
  const pathname = usePathname();
  const here = useCurrentPath();
  const swipe = useSwipeDismiss({
    side: "left",
    onDismiss: () => setOpen(false),
  });

  // Navigating closes the drawer. Reset during render, not in an effect: an
  // effect would show the drawer over the new page for a frame first.
  const [lastPath, setLastPath] = React.useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setOpen(false);
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          className="bg-background data-open:animate-in data-open:slide-in-from-left-10 data-closed:animate-out data-closed:slide-out-to-left-10 fixed inset-y-0 left-0 z-50 flex w-[min(22rem,88vw)] flex-col border-r shadow-lg"
          style={swipe.style}
          {...swipe.handlers}
        >
          <div className="border-border flex items-center justify-between border-b px-4 py-3">
            <Dialog.Title asChild>
              <span>
                <Logo src={branding.logoUrl} name={branding.shopName} />
                <span className="sr-only">{branding.shopName} menu</span>
              </span>
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close menu">
                <X />
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">
            Every department, with its shelves underneath. Swipe left, tap
            outside or press Escape to close.
          </Dialog.Description>

          <nav
            aria-label="Main"
            data-swipe-scroller
            className="min-h-0 flex-1 overflow-y-auto px-2 py-3"
          >
            <ul>
              {items.map((item) => (
                <NavBranch key={item.href} item={item} pathname={pathname} />
              ))}
            </ul>

            {/*
              The same destinations the desktop account menu offers, because
              below `lg` this drawer is the only menu there is. "Your orders"
              was missing from here for two phases — reachable on a laptop,
              gone on the phone that placed the order. Orders and addresses
              need a signed-in customer (the pages themselves ask for one);
              saved items work for guests too and stay unconditional.
            */}
            <ul className="border-border mt-3 border-t pt-3">
              {user ? (
                <>
                  <li>
                    <Link
                      href="/account/orders"
                      className="hover:bg-muted flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm"
                    >
                      <Package className="size-4" aria-hidden />
                      Your orders
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/account/addresses"
                      className="hover:bg-muted flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm"
                    >
                      <MapPin className="size-4" aria-hidden />
                      Addresses
                    </Link>
                  </li>
                </>
              ) : null}
              <li>
                <Link
                  href="/wishlist"
                  className="hover:bg-muted flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm"
                >
                  <Heart className="size-4" aria-hidden />
                  Saved items
                </Link>
              </li>
            </ul>
          </nav>

          {/*
            Signing in lives at the bottom of the drawer because below `sm` the
            header bar has room for search and bag and nothing else — those two
            carry the purchase, and a fourth 44px target overflows a 360px
            screen. It is the last thing in the panel rather than the first
            because browsing is what the drawer is for.
          */}
          <div className="border-border border-t px-4 py-4">
            {user ? (
              <form
                action={signOut}
                className="flex items-center justify-between gap-3"
              >
                <input type="hidden" name="next" value={here} readOnly />
                {/* The identity is a door: it opens the account overview,
                    the same as the desktop menu. */}
                <Link
                  href="/account"
                  className="hover:bg-muted -mx-2 min-w-0 rounded-lg px-2 py-1"
                >
                  <span className="text-muted-foreground block font-mono text-xs tracking-[0.06em] uppercase">
                    Signed in
                  </span>
                  <span className="block truncate text-sm">
                    {user.name ?? user.email}
                  </span>
                </Link>
                <SignOutButton />
              </form>
            ) : (
              <GoogleSignInForm />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Signing out takes a server round trip and then a redirect, and the drawer
 * used to give that second nothing — a pressed button that looks exactly like
 * an unpressed one is how the same press gets made twice.
 */
function SignOutButton() {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant="outline"
      size="sm"
      className="shrink-0"
      disabled={pending}
    >
      <LogOut aria-hidden />
      {pending ? "Signing out…" : "Sign out"}
    </Button>
  );
}

function NavBranch({ item, pathname }: { item: NavItem; pathname: string }) {
  const children = item.children ?? [];
  const contains =
    pathname === item.href ||
    pathname.startsWith(`${item.href}/`) ||
    children.some((child) => pathname === child.href);
  const [open, setOpen] = React.useState(contains);

  if (children.length === 0) {
    return (
      <li>
        <Link
          href={item.href}
          aria-current={pathname === item.href ? "page" : undefined}
          className="hover:bg-muted font-display flex min-h-12 items-center rounded-lg px-3 text-lg font-bold tracking-[-0.02em] uppercase"
        >
          {item.label}
        </Link>
      </li>
    );
  }

  return (
    <li>
      <div className="flex items-center">
        <Link
          href={item.href}
          aria-current={pathname === item.href ? "page" : undefined}
          className="hover:bg-muted font-display flex min-h-12 flex-1 items-center rounded-lg px-3 text-lg font-bold tracking-[-0.02em] uppercase"
        >
          {item.label}
        </Link>
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} what is in ${item.label}`}
          className="hover:bg-muted flex size-12 shrink-0 items-center justify-center rounded-lg"
        >
          <ChevronDown
            className={cn("size-4 transition-transform", open && "rotate-180")}
            aria-hidden
          />
        </button>
      </div>
      {open ? (
        <ul className="mb-2 ml-3 border-l pl-2">
          {children.map((child) => (
            <li key={child.href}>
              <Link
                href={child.href}
                aria-current={pathname === child.href ? "page" : undefined}
                className="text-muted-foreground hover:text-foreground flex min-h-11 items-center rounded-lg px-3 text-sm"
              >
                {child.label}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
