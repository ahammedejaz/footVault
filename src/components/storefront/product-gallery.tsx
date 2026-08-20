"use client";

import * as React from "react";
import { ProductImage as ProductPhoto } from "@/components/storefront/product-image";
import { Dialog } from "radix-ui";
import { X, ZoomIn } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ProductImage } from "@/lib/catalog-types";
import { cn } from "@/lib/utils";

/**
 * The gallery, and the payoff for the outsole reveal on the card.
 *
 * One DOM tree at every width, not two. The first version rendered a touch
 * carousel and a desktop pane side by side and hid one with `lg:hidden` — which
 * meant the browser downloaded every frame twice, because `display: none` stops
 * an element painting and does not stop its image loading. The waterfall showed
 * the hero requested at High priority and again at Low, and on the product page
 * that is the LCP image.
 *
 * So there is one scroller. On touch it is swiped and the dots follow it; on a
 * pointer the thumbnails drive it and the frame magnifies under the cursor.
 * Native overflow either way, so the swipe is the browser's own and the gallery
 * works before hydration.
 *
 * Frames are announced through one `aria-live` region rather than by moving
 * focus: a screen-reader user changing colourway should hear "showing the
 * outsole, frame 2 of 4", not be teleported into a list of buttons.
 */
export function ProductGallery({
  images,
  productName,
}: {
  images: ProductImage[];
  productName: string;
}) {
  const [active, setActive] = React.useState(0);
  const [zoomed, setZoomed] = React.useState(false);
  const [origin, setOrigin] = React.useState("50% 50%");
  const scroller = React.useRef<HTMLUListElement | null>(null);

  // A colourway change replaces the image set; frame 3 of the old set is not
  // frame 3 of the new one. Reset during render so the new first frame is what
  // paints, and move the scroller in an effect because that is a DOM write.
  const key = images.map((image) => image.url).join("|");
  const [lastKey, setLastKey] = React.useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setActive(0);
  }
  React.useEffect(() => {
    scroller.current?.scrollTo({ left: 0, behavior: "auto" });
  }, [key]);

  if (images.length === 0) return null;
  const index = Math.min(active, images.length - 1);
  const current = images[index]!;

  const scrollTo = (to: number) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({
      left: to * el.clientWidth,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
    setActive(to);
  };

  return (
    <div>
      {/* The zoom button is a sibling of the scroller, not a child: a <ul> may
          only contain <li>, and a button smuggled inside one is invalid markup
          that assistive technology is entitled to skip. */}
      <div
        className="group relative"
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setOrigin(
            `${((event.clientX - box.left) / box.width) * 100}% ${((event.clientY - box.top) / box.height) * 100}%`,
          );
        }}
        onMouseLeave={() => setOrigin("50% 50%")}
      >
        <ul
          ref={scroller}
          // A scroll container with nothing focusable inside it can be scrolled
          // with a finger and with a wheel and by nothing else. Making the region
          // itself focusable is what gives it to the keyboard, and the arrow keys
          // then move a whole frame at a time rather than a few pixels.
          tabIndex={0}
          // No `role="group"` here: it would override the list role and orphan
          // every <li> inside it. A labelled list is already the right thing.
          aria-label={`${productName} images`}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
              event.preventDefault();
              const next = index + (event.key === "ArrowRight" ? 1 : -1);
              if (next >= 0 && next < images.length) scrollTo(next);
            }
          }}
          onScroll={(event) => {
            const el = event.currentTarget;
            const next = Math.round(el.scrollLeft / el.clientWidth);
            setActive((prev) => (prev === next ? prev : next));
          }}
          className="rail bg-photo -mx-4 flex snap-x snap-mandatory overflow-x-auto sm:mx-0 sm:rounded-lg lg:cursor-zoom-in"
        >
          {images.map((image, i) => (
            <li
              key={image.url}
              className="relative aspect-4/5 w-full shrink-0 snap-start"
            >
              <ProductPhoto
                src={image.url}
                // The first frame names the product; the rest are the same shoe
                // from another angle, and a screen reader reading four near
                // identical sentences is worse than reading one.
                alt={i === 0 ? image.alt : ""}
                aria-hidden={i === 0 ? undefined : true}
                fill
                priority={i === 0}
                loading={i === 0 ? "eager" : "lazy"}
                fetchPriority={i === 0 ? "high" : "auto"}
                sizes="(max-width: 1024px) 100vw, 640px"
                style={i === index ? { transformOrigin: origin } : undefined}
                className={cn(
                  "object-cover transition-transform duration-300",
                  i === index && "lg:group-hover:scale-[2]",
                )}
              />
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={() => setZoomed(true)}
          className="bg-background/90 absolute right-3 bottom-3 z-10 hidden size-11 items-center justify-center rounded-lg border shadow-sm lg:inline-flex"
        >
          <ZoomIn className="size-4" aria-hidden />
          <span className="sr-only">Open {current.alt} at full size</span>
        </button>
      </div>

      {images.length > 1 ? (
        <>
          {/* Dots on touch, thumbnails on a pointer — both drive the same
              scroller, so there is one source of truth for which frame is up. */}
          <div className="mt-3 flex items-center justify-center gap-2 lg:hidden">
            {images.map((image, i) => (
              <button
                key={image.url}
                type="button"
                onClick={() => scrollTo(i)}
                aria-label={`Show frame ${i + 1} of ${images.length}: ${image.alt}`}
                aria-current={i === index ? "true" : undefined}
                className="flex size-11 items-center justify-center"
              >
                <span
                  className={cn(
                    "block size-2 rounded-full transition-colors",
                    i === index ? "bg-ink" : "bg-border",
                  )}
                />
              </button>
            ))}
          </div>

          <ul className="mt-3 hidden gap-3 lg:flex">
            {images.map((image, i) => (
              <li key={image.url}>
                <button
                  type="button"
                  onClick={() => scrollTo(i)}
                  aria-current={i === index ? "true" : undefined}
                  aria-label={`Show ${image.alt}`}
                  className={cn(
                    "bg-photo relative block size-20 overflow-hidden rounded-lg border-2 transition-colors",
                    i === index
                      ? "border-orange"
                      : "border-border hover:border-foreground",
                  )}
                >
                  <ProductPhoto
                    src={image.url}
                    alt=""
                    aria-hidden
                    fill
                    loading="lazy"
                    sizes="80px"
                    className="object-cover"
                  />
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {`Showing ${current.alt}. Frame ${index + 1} of ${images.length}.`}
      </p>

      <Dialog.Root open={zoomed} onOpenChange={setZoomed}>
        <Dialog.Portal>
          <Dialog.Overlay className="data-open:animate-in data-open:fade-in-0 fixed inset-0 z-50 bg-black/80" />
          <Dialog.Content className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <Dialog.Title className="sr-only">{productName}</Dialog.Title>
            <Dialog.Description className="sr-only">
              {current.alt}
            </Dialog.Description>
            <div className="bg-photo relative aspect-4/5 h-full max-h-[88vh] overflow-hidden rounded-lg">
              <ProductPhoto
                src={current.url}
                alt={current.alt}
                fill
                sizes="90vw"
                className="object-contain"
              />
            </div>
            <Dialog.Close asChild>
              <Button
                variant="secondary"
                size="icon"
                className="absolute top-5 right-5"
                aria-label="Close the full-size image"
              >
                <X />
              </Button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
