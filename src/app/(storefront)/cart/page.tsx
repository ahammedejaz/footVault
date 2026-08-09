import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

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
 *
 * The page is capped at `6xl`, not `7xl`, and the items column is a bounded
 * panel. At 1280 the old layout gave a single line item 816px of row and then
 * left 480px of nothing under it beside a full-height summary — which read as a
 * page that had failed to load the rest of the bag. A bag is a funnel, not a
 * catalog; there is no content here that wants 1280px.
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
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="font-display text-4xl font-extrabold tracking-[-0.03em] uppercase">
        Your bag
      </h1>

      {mergedCount > 0 ? <MergedNotice count={mergedCount} /> : null}

      {cart.lines.length === 0 ? (
        <EmptyState
          title="Nothing in your bag yet"
          body="Start with the new arrivals — every card shows the full size run, so you can see what we hold in your size before you open anything."
          action={{
            href: "/collection/new-arrivals",
            label: "See new arrivals",
          }}
        />
      ) : (
        <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_23rem] lg:grid-rows-[auto_1fr] lg:gap-10">
          <section aria-label="Items in your bag">
            <CartNotices adjustments={cart.adjustments} />

            <div className="border-border rounded-lg border">
              <CartLines lines={cart.lines} className="px-4" />

              {/*
                The way out, and the thing that closes the column.

                A bag with one shoe in it needs a route back to the shop more
                than a bag with five does, and it is the one-item bag that had
                the hole in it. Putting the count beside the link gives the
                footer a second job — it is the only place the line count is
                written down, the summary having only ever said it to a screen
                reader.
              */}
              <div className="border-border flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t px-4 py-2">
                <Link
                  href="/shop"
                  className="hover:text-orange-ink inline-flex min-h-11 items-center gap-2 rounded-lg font-mono text-xs tracking-[0.06em] uppercase transition-colors"
                >
                  <ArrowLeft className="size-3.5" aria-hidden />
                  Continue shopping
                </Link>
                <p className="text-muted-foreground font-mono text-xs tracking-[0.06em] tabular-nums">
                  {cart.count} {cart.count === 1 ? "item" : "items"}
                </p>
              </div>
            </div>
          </section>

          {/* `row-span-2`, with `grid-rows-[auto_1fr]` on the container, is
              what puts the third item *beside* the summary instead of under it.
              Without the span, row one is as tall as the summary and the
              sign-in card lands 308px below the items panel it belongs under;
              without the explicit tracks, the browser shares the summary's
              height between the two rows and opens an 83px hole instead. */}
          <aside
            aria-label="Order summary"
            className="lg:sticky lg:top-24 lg:row-span-2 lg:self-start"
          >
            <div className="bg-fog border-border rounded-lg border p-5">
              <h2 className="font-mono text-xs tracking-[0.06em] uppercase">
                Summary
              </h2>

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
                <CouponField appliedCode={cart.couponCode} />
              </div>
            </div>
          </aside>

          {/*
            The sign-in offer is a third grid item, not a second card in the
            summary column, and that is a layout decision doing two jobs. In
            source order it comes after the summary, so a customer scrolling a
            phone reaches the total and the Checkout button before anything
            pitches an account at them — the offer stays an offer and never
            becomes a gate. From `lg` auto-placement drops it into row two of
            the first column, under the items, where it takes 190px out of the
            247px of nothing that a one-item bag used to leave beside a
            full-height summary.
          */}
          {user ? null : (
            <div className="border-border rounded-lg border p-5 lg:col-start-1">
              <p className="text-sm text-pretty">
                Signing in keeps this bag on your next phone, and puts your
                orders in one place. It is not needed to buy.
              </p>
              <GoogleSignInForm className="mt-3" next="/cart" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
