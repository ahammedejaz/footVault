"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { Menu } from "lucide-react";

import { useReturnFocus } from "@/hooks/use-return-focus";
import { Button } from "@/components/ui/button";
import type { AccountUser } from "@/components/storefront/account-menu";
import type { NavItem } from "@/components/storefront/nav-types";

/**
 * The menu button. The drawer behind it loads on the first touch.
 *
 * Same reasoning as the search button: a dialog, a portal, a focus trap, a
 * gesture handler and an accordion are a lot of JavaScript to make every
 * customer download before the page paints, in service of a panel most of them
 * will never open. `onPointerDown` starts the fetch on touch-down, so by the
 * time the tap completes the chunk is usually already there.
 */
const MobileNavPanel = dynamic(
  () =>
    import("@/components/storefront/mobile-nav-panel").then(
      (m) => m.MobileNavPanel,
    ),
  { ssr: false },
);

export function MobileNav({
  items,
  user,
  branding,
}: {
  items: NavItem[];
  user: AccountUser | null;
  /** The shop's own mark and name, so the drawer matches the header above it. */
  branding: { logoUrl: string | null; shopName: string };
}) {
  const [open, setOpen] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);
  const trigger = useReturnFocus(open);

  return (
    <>
      <Button
        ref={trigger}
        variant="ghost"
        size="icon"
        className="lg:hidden"
        aria-label="Open menu"
        aria-expanded={open}
        onPointerDown={() => setMounted(true)}
        onFocus={() => setMounted(true)}
        onClick={() => {
          setMounted(true);
          setOpen(true);
        }}
      >
        <Menu />
      </Button>
      {mounted ? (
        <MobileNavPanel
          items={items}
          user={user}
          branding={branding}
          open={open}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
}
