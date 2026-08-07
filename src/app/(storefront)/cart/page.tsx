import type { Metadata } from "next";
import Link from "next/link";

import { CartLines } from "@/components/storefront/cart-lines";
import { CartNotices } from "@/components/storefront/cart-notices";
import { CouponField } from "@/components/storefront/coupon-field";
import { EmptyState } from "@/components/storefront/empty-state";
import { FreeShippingMeter } from "@/components/storefront/free-shipping-meter";
import { MergedNotice } from "@/components/storefront/merged-notice";
import { GoogleSignInForm } from "@/components/storefront/sign-in";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth";
import { formatPaise } from "@/lib/format";
import { getCart } from "@/lib/queries/cart";

export const metadata: Metadata = {
  title: "Your bag",
  robots: { index: false, follow: false },
};

/**
 * The bag.
 *
 * Rendered from `getCart()`, which re-reads every price and stock level from
 * the catalog on every load — so the total on this page is the total the shop
 * would charge, and there is no path by which a number from a browser reaches
 * it. Anything that had to change is stated above the lines rather than applied
 * quietly.
 *
 * Signing in is offered here, never required. A guest can reach checkout with a
 * full bag; the pitch for an account is that the bag survives the phone, and it
 * is made as an offer next to the total rather than as a gate in front of it.
 */
export default async function CartPage({
  searchParams,
}: {
  searchParams: Promise<{ merged?: string }>;
}) {
  const [cart, user, params] = await Promise.all([
    getCart(),
    getCurrentUser(),
    searchParams,
  ]);

  const mergedCount = Number(params.merged ?? 0);

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <h1 className="font-display text-4xl font-extrabold tracking-[-0.03em] uppercase">
        Your bag
      </h1>

      {mergedCount > 0 ? <MergedNotice count={mergedCount} /> : null}

      {cart.lines.length === 0 ? (
        <EmptyState
          title="Nothing in your bag yet"
          body="Start with the new arrivals — every card shows the full size run, so you can see what we hold in your size before you open anything."
          action={{ href: "/collection/new-arrivals", label: "See new arrivals" }}
        />
      ) : (
        <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-16">
          <section aria-label="Items in your bag">
            <CartNotices adjustments={cart.adjustments} />
            <CartLines lines={cart.lines} />
          </section>

          <aside aria-label="Order summary" className="lg:sticky lg:top-24 lg:self-start">
            <div className="bg-fog border-border rounded-lg border p-5">
              <h2 className="font-mono text-xs tracking-[0.06em] uppercase">Summary</h2>

              <dl className="mt-4 space-y-2 text-sm">
                <div className="flex items-baseline justify-between">
                  <dt className="text-muted-foreground">
                    Subtotal
                    <span className="sr-only"> for {cart.count} items</span>
                  </dt>
                  <dd className="font-mono font-medium tabular-nums">
                    {formatPaise(cart.subtotal)}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between">
                  <dt className="text-muted-foreground">Shipping</dt>
                  <dd className="text-muted-foreground font-mono tabular-nums">
                    {cart.freeShipping.qualified ? "Free" : "At checkout"}
                  </dd>
                </div>
              </dl>

              <div className="border-border mt-4 border-t pt-4">
                <FreeShippingMeter freeShipping={cart.freeShipping} />
              </div>

              <Button size="lg" className="mt-5 w-full" asChild>
                {/* Checkout is Phase 5. The button goes to the route that will
                    exist rather than being disabled: a bag whose only button is
                    dead reads as a shop that cannot take money. */}
                <Link href="/checkout">Checkout</Link>
              </Button>

              <p className="text-muted-foreground mt-3 text-center text-xs text-pretty">
                No account needed to buy.
              </p>

              <div className="border-border mt-5 border-t pt-5">
                <CouponField />
              </div>
            </div>

            {user ? null : (
              <div className="border-border mt-4 rounded-lg border p-5">
                <p className="text-sm text-pretty">
                  Signing in keeps this bag on your next phone, and puts your orders
                  in one place. It is not needed to buy.
                </p>
                <GoogleSignInForm className="mt-3" next="/cart" />
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
