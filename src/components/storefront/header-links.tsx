"use client";

import Link from "next/link";

import { CountBadge, countLabel } from "@/components/storefront/count-badge";
import { Button } from "@/components/ui/button";
import { useBagUi } from "@/lib/stores/bag";

/**
 * The two utility icons.
 *
 * The counts are server facts, passed straight through — see count-badge.tsx
 * for why they are no longer client state.
 *
 * The bag opens the drawer rather than navigating. A customer who has just
 * added something wants to see it and carry on browsing, and a full page
 * navigation to /cart costs them their place in a grid they were halfway down.
 * The link is still a real `<a href="/cart">`, so middle-click, ⌘-click and
 * JavaScript-off all reach the page.
 */
export function BagLink({ count, children }: { count: number; children: React.ReactNode }) {
  const openDrawer = useBagUi((state) => state.openDrawer);

  return (
    <Button variant="ghost" size="icon" className="relative" asChild>
      <Link
        href="/cart"
        aria-label={countLabel("Bag", count)}
        onClick={(event) => {
          // Let the browser do its thing for anything that is not a plain
          // left-click: a modified click means "open this somewhere else".
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          if (event.button !== 0) return;
          event.preventDefault();
          openDrawer();
        }}
      >
        {children}
        <CountBadge count={count} />
      </Link>
    </Button>
  );
}

export function SavedLink({ count, children }: { count: number; children: React.ReactNode }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      // Below `sm` only search and bag stay in the bar: those two carry the
      // purchase, and a fourth 44px target overflows a 360px screen. Saved
      // items moves into the drawer.
      className="relative hidden sm:inline-flex"
      asChild
    >
      <Link href="/wishlist" aria-label={countLabel("Saved items", count)}>
        {children}
        <CountBadge count={count} />
      </Link>
    </Button>
  );
}
