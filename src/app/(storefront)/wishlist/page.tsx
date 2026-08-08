import type { Metadata } from "next";

import { EmptyState } from "@/components/storefront/empty-state";
import { GoogleSignInForm } from "@/components/storefront/sign-in";
import { WishlistRow } from "@/components/storefront/wishlist-row";
import { getCurrentUser } from "@/lib/auth";
import { getWishlist } from "@/lib/queries/wishlist";

export const metadata: Metadata = {
  title: "Saved items",
  robots: { index: false, follow: false },
};

/**
 * Saved items.
 *
 * Signed out this is a pitch rather than a wall: the page explains what an
 * account buys you and offers the one way in. There is nothing to hide here —
 * an empty saved list and a signed-out saved list look the same to everyone
 * except the person who has one.
 */
export default async function WishlistPage() {
  const user = await getCurrentUser();
  const items = user ? await getWishlist() : [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <h1 className="font-display text-4xl font-extrabold tracking-[-0.03em] uppercase">
        Saved items
      </h1>

      {!user ? (
        <div className="border-border mt-8 rounded-lg border p-6 text-center">
          <p className="text-base text-pretty">
            Saving keeps a pair to hand while you decide, on every device you
            use. It needs an account — a list that lives in one browser is a
            list you lose.
          </p>
          <div className="mx-auto mt-5 max-w-xs">
            <GoogleSignInForm next="/wishlist" />
          </div>
          <p className="text-muted-foreground mt-4 font-mono text-xs tracking-[0.06em]">
            You never need an account to buy.
          </p>
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="You have not saved anything"
          body="Saving keeps a pair to hand while you decide. Nothing here yet — the shop is the place to start."
          action={{ href: "/shop", label: "Shop all footwear" }}
        />
      ) : (
        <ul className="mt-6">
          {items.map((product) => (
            <WishlistRow key={product.id} product={product} />
          ))}
        </ul>
      )}
    </div>
  );
}
