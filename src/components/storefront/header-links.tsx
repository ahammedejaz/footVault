"use client";

import Link from "next/link";

import { CountBadge, useCount } from "@/components/storefront/count-badge";
import { Button } from "@/components/ui/button";

/**
 * The two utility icons.
 *
 * Client components only because the count is client state; the icon itself is
 * passed in from the server, so the SVG is in the first HTML and the badge is
 * the only thing waiting on JavaScript.
 *
 * The count goes into the accessible name rather than being left as a loose
 * "3" beside an icon — "Bag, 3 items" is the whole message in one utterance.
 */
export function BagLink({ children }: { children: React.ReactNode }) {
  const count = useCount("bag");
  return (
    <Button variant="ghost" size="icon" className="relative" asChild>
      <Link
        href="/cart"
        aria-label={count === 1 ? "Bag, 1 item" : `Bag, ${count} items`}
      >
        {children}
        <CountBadge of="bag" />
      </Link>
    </Button>
  );
}

export function SavedLink({ children }: { children: React.ReactNode }) {
  const count = useCount("saved");
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
      <Link
        href="/wishlist"
        aria-label={count === 1 ? "Saved items, 1 item" : `Saved items, ${count} items`}
      >
        {children}
        <CountBadge of="saved" />
      </Link>
    </Button>
  );
}
