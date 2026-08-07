"use client";

import * as React from "react";

import { Price } from "@/components/storefront/price";
import { ProductGallery } from "@/components/storefront/product-gallery";
import { SizeGuide } from "@/components/storefront/size-guide";
import { SizeSelector } from "@/components/storefront/size-selector";
import { Button } from "@/components/ui/button";
import { useUrlParam } from "@/hooks/use-url-param";
import { COLOR_FAMILY_SWATCH, type ProductDetail } from "@/lib/catalog-types";
import { cn } from "@/lib/utils";

/**
 * The buy panel: gallery, colourway, size, stock, and the two calls to action.
 *
 * One component rather than several because they are one decision. Choosing a
 * colourway changes the photography *and* the size run, and the size run drives
 * the stock line and the sticky bar; splitting that across four components
 * means four copies of the same state and one of them getting out of step.
 *
 * The URL is written with `replaceState` rather than pushed. Selecting a size
 * is picking one of a set, like a radio button, and a back button that walks
 * back through five sizes before leaving the page is a back button nobody can
 * use. The URL still updates, so the page is shareable at the state you are
 * looking at — which is the reason the brief asks for it.
 *
 * The initial state comes from `window.location` in an effect rather than from
 * `useSearchParams`, and that is load-bearing: `useSearchParams` opts the whole
 * route out of static rendering, which would put a Supabase round trip in front
 * of the LCP image on the most important page on the site. The cost is that a
 * deep link to `?size=9` highlights the 9 just after hydration rather than in
 * the first paint. Nothing moves when it does — same chip, same box — so there
 * is no layout shift, only a chip that fills in.
 */
export function ProductViewer({
  product,
  children,
}: {
  product: ProductDetail;
  /** Delivery, returns, description — server-rendered, slotted under the panel. */
  children: React.ReactNode;
}) {
  const colourways = product.colors;

  // The URL is the initial answer for both; local state takes over the moment
  // the customer chooses. Reading it through useUrlParam keeps this page
  // statically rendered — see that hook for why that matters here.
  const linkedColour = useUrlParam("color");
  const linkedSize = useUrlParam("size");

  const [pickedColour, setColourway] = React.useState<string | null>(null);
  const [pickedSize, setSize] = React.useState<string | null>(null);

  const colourway =
    pickedColour ??
    (linkedColour && colourways.some((c) => c.name === linkedColour)
      ? linkedColour
      : (colourways[0]?.name ?? null));
  const size = pickedSize ?? linkedSize;
  const ctaRef = React.useRef<HTMLDivElement | null>(null);
  const [showSticky, setShowSticky] = React.useState(false);

  const active = colourways.find((c) => c.name === colourway) ?? colourways[0] ?? null;

  // The size run narrows to the chosen colourway when there is one; the card's
  // run is the union across colourways, and this is where that resolves.
  const sizes = active && active.sizes.length > 0 ? active.sizes : product.sizes;
  const images = active && active.images.length > 0 ? active.images : product.images;

  const available = sizes.filter((entry) => entry.available);
  const selected = size ?? (available.length === 1 ? available[0]!.size : null);
  const selectedEntry = selected ? sizes.find((entry) => entry.size === selected) : undefined;
  const inStock = available.length > 0;

  /* --- write it back ------------------------------------------------------ */
  const syncUrl = React.useCallback((next: { color?: string | null; size?: string | null }) => {
    const params = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(next)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`,
    );
  }, []);

  const chooseColour = (name: string) => {
    setColourway(name);
    // A size that does not exist in the new colourway is not a selection.
    const next = colourways.find((c) => c.name === name);
    const keep = next?.sizes.some((entry) => entry.size === size) ? size : null;
    setSize(keep);
    syncUrl({ color: name, size: keep });
  };

  const chooseSize = (value: string) => {
    setSize(value);
    syncUrl({ size: value });
  };

  /*
    The sticky bar appears once the real CTA has been seen and scrolled past —
    not merely because it is off-screen.
   
    Those are different: on a 390px phone the buttons start below the fold, so
    "not visible" is true before the customer has scrolled at all, and a bar
    that slides up over an untouched page is an advert for itself. `seen` is
    what makes it a *return* path to a control they have already met.
  */
  React.useEffect(() => {
    const el = ctaRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    let seen = false;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) seen = true;
        setShowSticky(seen && !entry?.isIntersecting);
      },
      { rootMargin: "-8px 0px 0px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div className="mt-6 grid gap-8 lg:grid-cols-2 lg:gap-16">
        <ProductGallery images={images} productName={product.name} />

        <div>
          {product.brandName ? (
            <p className="text-muted-foreground font-mono text-xs tracking-[0.14em] uppercase">
              {product.brandName}
            </p>
          ) : null}
          <h1 className="font-display mt-2 text-2xl font-bold tracking-[-0.02em] text-balance uppercase sm:text-4xl">
            {product.name}
          </h1>

          <Price
            basePrice={product.basePrice}
            salePrice={product.salePrice}
            size="lg"
            className="mt-4"
          />
          <p className="text-muted-foreground mt-1 text-sm">Inclusive of all taxes</p>

          {colourways.length > 1 ? (
            <div className="mt-8">
              <h2 id="colour-label" className="font-mono text-xs tracking-[0.06em] uppercase">
                Colour · <span className="text-muted-foreground">{active?.name}</span>
              </h2>
              <div
                role="radiogroup"
                aria-labelledby="colour-label"
                className="mt-3 flex flex-wrap gap-2"
              >
                {colourways.map((colour) => {
                  const isActive = colour.name === active?.name;
                  const soldOut = !colour.sizes.some((entry) => entry.available);
                  return (
                    <button
                      key={colour.name}
                      type="button"
                      role="radio"
                      aria-checked={isActive}
                      tabIndex={isActive ? 0 : -1}
                      onClick={() => chooseColour(colour.name)}
                      className={cn(
                        "inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm transition-colors",
                        isActive
                          ? "border-ink font-medium"
                          : "border-border hover:border-foreground",
                      )}
                    >
                      <span
                        aria-hidden
                        className="border-border size-3.5 shrink-0 rounded-full border"
                        style={{
                          backgroundColor:
                            colour.hex ??
                            (colour.family ? COLOR_FAMILY_SWATCH[colour.family] : undefined) ??
                            "transparent",
                        }}
                      />
                      {colour.name}
                      {soldOut ? (
                        <span className="text-dim font-mono text-xs">— sold out</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className="mt-8">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="size-label" className="font-mono text-xs tracking-[0.06em] uppercase">
                Size · UK
              </h2>
              <SizeGuide gender={product.gender} highlight={selected} />
            </div>
            <div className="mt-3">
              <SizeSelector
                sizes={sizes}
                selected={selected}
                onSelect={chooseSize}
                labelledBy="size-label"
              />
            </div>

            {/*
              Stock as language, in steel with a mono numeral — never colour on
              its own. A reserved two lines, so the panel does not jump when the
              sentence changes length.
            */}
            <p className="mt-4 min-h-10 text-sm" aria-live="polite" aria-atomic="true">
              {!inStock ? (
                <span className="text-muted-foreground">
                  Sold out in every size{colourways.length > 1 ? " in this colour" : ""}. The
                  run above is the full run — nothing is hidden.
                </span>
              ) : selectedEntry && !selectedEntry.available ? (
                <span className="text-muted-foreground">
                  <span className="text-foreground font-medium">UK {selectedEntry.size}</span>{" "}
                  is sold out. Sizes without a line through them are on the shelf.
                </span>
              ) : selectedEntry && selectedEntry.stock <= 3 ? (
                <span className="text-muted-foreground">
                  Only{" "}
                  <span className="text-foreground font-mono font-medium tabular-nums">
                    {selectedEntry.stock}
                  </span>{" "}
                  left in UK {selectedEntry.size}
                </span>
              ) : selectedEntry ? (
                <span className="text-muted-foreground">
                  In stock in UK {selectedEntry.size}, ready to ship
                </span>
              ) : (
                <span className="text-muted-foreground">
                  Pick a size to see what is left
                </span>
              )}
            </p>
          </div>

          <div ref={ctaRef} className="mt-6 flex flex-col gap-3 sm:flex-row">
            {/*
              The bag arrives in Phase 4. The buttons are disabled and say so
              rather than being hidden: a product page with no add-to-bag reads
              as broken, and they have to measure exactly as they will when they
              work so nothing shifts when they do.
            */}
            <Button size="lg" className="sm:flex-1" disabled>
              Add to bag
            </Button>
            <Button size="lg" variant="outline" className="sm:flex-1" disabled>
              Save for later
            </Button>
          </div>
          <p className="text-muted-foreground mt-2 font-mono text-xs tracking-[0.06em]">
            The bag opens in the next build stage
          </p>

          {children}
        </div>
      </div>

      {/* --- the sticky bar, once the real one has scrolled away ---------- */}
      <div
        aria-hidden={!showSticky}
        className={cn(
          "bg-background/95 supports-[backdrop-filter]:bg-background/85 fixed inset-x-0 bottom-0 z-40 border-t backdrop-blur transition-transform duration-200 lg:hidden",
          showSticky ? "translate-y-0" : "translate-y-full",
        )}
      >
        <div className="flex items-center gap-3 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{product.name}</p>
            <p className="text-muted-foreground font-mono text-xs tabular-nums">
              {selected ? `UK ${selected}` : "Pick a size"}
            </p>
          </div>
          <Button size="lg" disabled tabIndex={showSticky ? 0 : -1} className="shrink-0">
            Add to bag
          </Button>
        </div>
      </div>
    </>
  );
}
