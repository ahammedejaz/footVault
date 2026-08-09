import type { Metadata } from "next";

import { AddressBook } from "@/components/checkout/address-book";
import { GoogleSignInForm } from "@/components/storefront/sign-in";
import { getCurrentUser } from "@/lib/auth";
import { listAddresses } from "@/lib/queries/addresses";

export const metadata: Metadata = {
  title: "Your addresses",
  robots: { index: false, follow: false },
};

/**
 * The address book.
 *
 * Checkout can add to this list — "save this address for next time" — but it is
 * the wrong place to prune one: a "remove" button beside a delivery address, on
 * the screen where somebody is about to spend money, is a mistake waiting to be
 * made. So the book has a home, and checkout only ever reads it and appends.
 *
 * Signed-in only, because `addresses.user_id` is `not null`. A guest's address
 * lives on their order and nowhere else, which is the copy that matters anyway.
 */
export default async function AccountAddressesPage() {
  const user = await getCurrentUser();
  const addresses = user ? await listAddresses() : [];

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <h1 className="font-display text-4xl font-extrabold tracking-[-0.03em] uppercase">
        Your addresses
      </h1>

      {!user ? (
        <div className="border-border mt-8 rounded-lg border p-6 text-center">
          <p className="text-base text-pretty">
            Saved addresses need an account — there is nowhere to keep them
            otherwise. Checkout never asks for one; this is the part that gets
            faster if you have it.
          </p>
          <div className="mx-auto mt-5 max-w-xs">
            <GoogleSignInForm next="/account/addresses" />
          </div>
        </div>
      ) : (
        <>
          <p className="text-muted-foreground mt-3 text-base text-pretty">
            The default is the one checkout preselects. Editing anything here
            never changes an order already placed — what ships is a copy taken
            at the time. Changing a PIN code can change the delivery charge and
            whether Pay on Delivery is offered; checkout works that out again
            when you next order.
          </p>
          <AddressBook addresses={addresses} />
        </>
      )}
    </div>
  );
}
