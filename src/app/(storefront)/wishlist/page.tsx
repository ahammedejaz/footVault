import type { Metadata } from "next";

import { EmptyState } from "@/components/storefront/empty-state";

export const metadata: Metadata = {
  title: "Saved items",
  robots: { index: false, follow: false },
};

/** Saved items land with the cart in Phase 4; the empty state is the real one. */
export default function WishlistPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <h1 className="font-display text-4xl font-extrabold tracking-[-0.03em] uppercase">
        Saved items
      </h1>
      <EmptyState
        title="You have not saved anything"
        body="Saving keeps a pair to hand while you decide. Nothing here yet — the shop is the place to start."
        action={{ href: "/shop", label: "Shop all footwear" }}
      />
    </div>
  );
}
