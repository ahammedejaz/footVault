"use client";

import Link from "next/link";
import { Dialog } from "radix-ui";
import { ShoppingBag, X } from "lucide-react";

import { CartLines } from "@/components/storefront/cart-lines";
import { FreeShippingMeter } from "@/components/storefront/free-shipping-meter";
import { Button } from "@/components/ui/button";
import { useSwipeDismiss } from "@/hooks/use-swipe-dismiss";
import { formatPaise } from "@/lib/format";
import { useBagUi } from "@/lib/stores/bag";

/**
 * The bag, without leaving the page.
 *
 * A customer who has just added something wants to check it and carry on
 * browsing; sending them to /cart costs them their place in a grid they were
 * halfway down, and the trip back is a second page load. The /cart page still
 * exists and is still the real thing — this is the shortcut, not a replacement.
 *
 * It fetches on open rather than being rendered into every page, because
 * rendering it everywhere would put a four-table join in front of every route
 * on the site for a panel most visits never open. Same `getCart()` underneath,
 * so the numbers cannot disagree with the page.
 *
 * Closable four ways, like the navigation drawer: the button, the backdrop,
 * Escape, and a swipe back towards the edge it came from.
 */
export function BagDrawer() {
  const open = useBagUi((state) => state.drawerOpen);
  const setOpen = useBagUi((state) => state.setDrawerOpen);
  const cart = useBagUi((state) => state.cart);
  const failed = useBagUi((state) => state.failed);
  const load = useBagUi((state) => state.refresh);

  const swipe = useSwipeDismiss({ side: "right", onDismiss: () => setOpen(false) });

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          className="bg-background data-open:animate-in data-open:slide-in-from-right-10 data-closed:animate-out data-closed:slide-out-to-right-10 fixed inset-y-0 right-0 z-50 flex w-[min(28rem,92vw)] flex-col border-l shadow-lg"
          style={swipe.style}
          {...swipe.handlers}
        >
          <div className="border-border flex items-center justify-between border-b px-4 py-3">
            <Dialog.Title className="font-display text-lg font-bold tracking-[-0.02em] uppercase">
              Your bag
              {cart && cart.count > 0 ? (
                <span className="text-muted-foreground ml-2 font-mono text-xs tracking-[0.06em] tabular-nums">
                  {cart.count}
                </span>
              ) : null}
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close your bag">
                <X />
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">
            What is in your bag. Swipe right, tap outside or press Escape to close.
          </Dialog.Description>

          <div data-swipe-scroller className="min-h-0 flex-1 overflow-y-auto px-4">
            {failed ? (
              <div className="py-16 text-center">
                <p className="text-base text-pretty">Your bag could not be loaded.</p>
                <Button variant="outline" className="mt-4" onClick={() => void load()}>
                  Try again
                </Button>
              </div>
            ) : !cart ? (
              // Not a spinner: the panel has already animated in, and a spinner
              // in a panel that is still moving reads as two things loading.
              <p className="text-muted-foreground py-16 text-center font-mono text-xs tracking-[0.06em] uppercase">
                Reading your bag
              </p>
            ) : cart.lines.length === 0 ? (
              <div className="py-16 text-center">
                <ShoppingBag className="text-line mx-auto size-10" aria-hidden />
                <p className="mt-4 text-base font-medium">Nothing in your bag yet</p>
                <p className="text-muted-foreground mt-2 text-sm text-pretty">
                  Every card shows the full size run, so you can see what we hold in
                  your size before you open anything.
                </p>
                <Button asChild className="mt-6" onClick={() => setOpen(false)}>
                  <Link href="/collection/new-arrivals">See new arrivals</Link>
                </Button>
              </div>
            ) : (
              <CartLines lines={cart.lines} onChanged={load} compact />
            )}
          </div>

          {cart && cart.lines.length > 0 ? (
            <div className="border-border space-y-4 border-t px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
              <FreeShippingMeter freeShipping={cart.freeShipping} />
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-xs tracking-[0.06em] uppercase">Subtotal</span>
                <span className="font-mono text-lg font-medium tabular-nums">
                  {formatPaise(cart.subtotal)}
                </span>
              </div>
              <p className="text-muted-foreground text-xs">
                Shipping and any discount are worked out at checkout.
              </p>
              <div className="grid gap-2">
                <Button size="lg" asChild onClick={() => setOpen(false)}>
                  <Link href="/cart">Go to your bag</Link>
                </Button>
              </div>
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
