"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Heart, LogOut, MapPin, Package, User } from "lucide-react";

import { SignInDialog } from "@/components/storefront/sign-in";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCurrentPath } from "@/hooks/use-current-path";
import { signOut } from "@/lib/actions/auth";

/**
 * The account control in the header.
 *
 * Shaped as a view model rather than importing the server-side `CurrentUser`
 * type: this is a Client Component, and the boundary between the two halves of
 * the app is worth keeping structural rather than relying on type-only imports
 * being erased.
 */
export type AccountUser = {
  name: string | null;
  email: string | null;
};

export function AccountMenu({ user }: { user: AccountUser | null }) {
  const [prompting, setPrompting] = useState(false);
  const signOutForm = useRef<HTMLFormElement>(null);
  const here = useCurrentPath();

  if (!user) {
    return (
      <>
        <Button
          variant="ghost"
          size="icon"
          // Below `sm` the bar holds search and bag only — those two carry the
          // purchase. Signing in lives in the drawer at that width.
          className="hidden sm:inline-flex"
          aria-label="Sign in"
          onClick={() => setPrompting(true)}
        >
          <User />
        </Button>
        <SignInDialog
          open={prompting}
          onOpenChange={setPrompting}
          title="Sign in"
          reason="Your bag comes with you, your saved shoes stay saved, and your orders are all in one place."
        />
      </>
    );
  }

  const label = user.name ?? user.email ?? "Account";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="hidden sm:inline-flex"
          aria-label={`Account, signed in as ${label}`}
        >
          <User />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {/*
          The identity is a door, not a caption. "Signed in as X" that goes
          nowhere leaves /account — the page that introduces orders and
          addresses — reachable from nothing, which audit:reachability now
          fails a build over.
        */}
        <DropdownMenuItem asChild>
          <Link href="/account" className="block">
            <span className="min-w-0">
              <span className="text-muted-foreground block font-mono text-xs tracking-[0.06em] uppercase">
                Signed in
              </span>
              <span className="mt-0.5 block truncate">{label}</span>
            </span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account/orders">
            <Package aria-hidden />
            Your orders
          </Link>
        </DropdownMenuItem>
        {/*
          The address book was reachable from nowhere: /account/addresses
          existed, its overview page linked to it, and no menu linked to
          either. A page with no inbound link does not exist for a customer —
          which is how "address editing is missing" got reported against a
          feature that was built.
        */}
        <DropdownMenuItem asChild>
          <Link href="/account/addresses">
            <MapPin aria-hidden />
            Addresses
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/wishlist">
            <Heart aria-hidden />
            Saved items
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/*
          A form, not a link: signing out changes state, and a GET that changes
          state is something a prefetcher will happily follow on its own.

          The form sits outside the menu item and is submitted by it. Nesting a
          submit button inside a DropdownMenuItem loses the click — Radix
          selects the item and unmounts the menu, and the form goes with it
          before the browser gets round to submitting.
        */}
        <form ref={signOutForm} action={signOut} className="hidden">
          <input type="hidden" name="next" value={here} readOnly />
        </form>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            signOutForm.current?.requestSubmit();
          }}
        >
          <LogOut aria-hidden />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
