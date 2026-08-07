import type { Metadata } from "next";

import { EmptyState } from "@/components/storefront/empty-state";

export const metadata: Metadata = {
  title: "Your bag",
  robots: { index: false, follow: false },
};

/**
 * The bag.
 *
 * Phase 4 wires the guest cart, the merge-on-login and the coupon field. Until
 * then this renders the real empty state rather than 404ing, because the bag
 * icon in the header has to lead somewhere, and "nothing in it yet" is the
 * honest answer.
 */
export default function CartPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <h1 className="font-display text-4xl font-extrabold tracking-[-0.03em] uppercase">
        Your bag
      </h1>
      <EmptyState
        title="Nothing in your bag yet"
        body="Start with the new arrivals — every card shows the full size run, so you can see what we hold in your size before you open anything."
        action={{ href: "/collection/new-arrivals", label: "See new arrivals" }}
      />
    </div>
  );
}
