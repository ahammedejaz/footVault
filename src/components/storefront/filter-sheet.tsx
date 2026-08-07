"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Dialog } from "radix-ui";
import { X } from "lucide-react";

import { useSwipeDismiss } from "@/hooks/use-swipe-dismiss";
import { Button } from "@/components/ui/button";

/**
 * The mobile filter panel.
 *
 * Open state is a URL parameter, not React state, and that is the whole trick:
 * every facet inside is a plain link, so tapping one is a navigation — and the
 * panel comes back open on the other side, with counts that are now true. The
 * alternative, holding drafts in local state, means either a second source of
 * truth for what is filtered or counts that lie until you commit.
 *
 * `forceMount` keeps the panel in the DOM across those navigations so the
 * open animation does not replay on every tap.
 */
export function FilterSheet({
  open = true,
  closeHref,
  clearHref,
  footer,
  children,
}: {
  open?: boolean;
  closeHref: string;
  clearHref: string;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const close = React.useCallback(() => {
    router.push(closeHref, { scroll: false });
  }, [router, closeHref]);

  const swipe = useSwipeDismiss({ side: "bottom", onDismiss: close });

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 z-50 bg-black/40 lg:hidden" />
        <Dialog.Content
          className="bg-background data-open:animate-in data-open:slide-in-from-bottom-10 data-closed:animate-out data-closed:slide-out-to-bottom-10 fixed inset-x-0 bottom-0 z-50 flex max-h-[86vh] flex-col rounded-t-xl border-t shadow-lg lg:hidden"
          style={swipe.style}
          {...swipe.handlers}
        >
          {/* A real grab handle, so the gesture is discoverable rather than
              something a customer has to guess at. */}
          <div className="flex justify-center pt-3 pb-1" aria-hidden>
            <span className="bg-border h-1 w-10 rounded-full" />
          </div>

          <div className="flex items-center justify-between px-4 pb-2">
            <Dialog.Title className="font-display text-lg font-bold tracking-[-0.02em] uppercase">
              Filters
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close filters">
                <X />
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">
            Every option shows how many styles are behind it. Choosing one applies it
            straight away.
          </Dialog.Description>

          <div data-swipe-scroller className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {children}
          </div>

          {/* Sticky, because on a long facet list the way out must never be
              somewhere you have to scroll back to find. */}
          <div className="bg-background border-border flex items-center gap-3 border-t px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <Link
              href={clearHref}
              scroll={false}
              className="text-muted-foreground hover:text-foreground inline-flex min-h-11 shrink-0 items-center px-2 text-sm underline underline-offset-4"
            >
              Clear all
            </Link>
            <div className="flex-1">{footer}</div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
