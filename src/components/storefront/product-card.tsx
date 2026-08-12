import { ProductImage } from "@/components/storefront/product-image";
import Link from "next/link";

import { Price } from "@/components/storefront/price";
import { Stars } from "@/components/storefront/reviews/stars";
import { SaveForLater } from "@/components/storefront/save-for-later";
import { SizeRun } from "@/components/storefront/size-run";
import type { ProductColor, ProductSummary } from "@/lib/catalog-types";
import { cn } from "@/lib/utils";

/**
 * The product card.
 *
 * Three things carry it, and all three come from the subject rather than from a
 * template:
 *
 *   1. The size run, printed in full. A customer scanning a grid on a phone
 *      finds their own size without opening anything.
 *   2. The outsole on hover. Footwear photography always includes a tread shot
 *      and nobody uses it; the crossfade is defined in globals.css.
 *   3. One orange rule drawing in under the name. That is the whole hover
 *      vocabulary — no lift, no shadow, no scale on the card itself.
 *
 * The whole card is one link. The `after:absolute inset-0` on the title
 * stretches the hit area over the media without nesting an anchor inside a
 * heading, so the accessible name stays the product name.
 *
 * **Nothing is layered over the media.** It used to carry three overlays: the
 * wishlist heart, a status chip, and — baked into the seed artwork itself — a
 * caption row of brand and view. The heart sat on the caption and ate the first
 * two characters of every brand, so ADIDAS rendered as IDAS and WOODLAND as
 * ODLAND. Moving the heart is not the fix on its own, because the next overlay
 * put in that corner collides all over again; the rule is that the frame holds
 * the image and only the image, and every label the card needs is a sibling in
 * the flow beneath it, where the layout can see it and give it room.
 */
export function ProductCard({
  product,
  priority = false,
  headingLevel = 3,
  sizes = "(max-width: 640px) 46vw, (max-width: 1280px) 31vw, 288px",
  saved = false,
  className,
}: {
  product: ProductSummary;
  /**
   * Whether this customer has saved it. A prop rather than something the card
   * fetches: the product itself comes from a cross-request cache, and a
   * per-customer fact folded into that would show one person's saved items to
   * the next.
   */
  saved?: boolean;
  /** Set on the first row so the LCP image is not lazy. */
  priority?: boolean;
  /** Cards sit under a section heading on the home page and under the page
      heading on a listing; the level has to follow, or the outline breaks. */
  headingLevel?: 2 | 3;
  sizes?: string;
  className?: string;
}) {
  const soldOut = !product.inStock;
  const Heading = `h${headingLevel}` as "h2" | "h3";
  const colourway = colourwayCaption(product.colors);

  return (
    <article className={cn("product-card group relative", className)}>
      {/*
        `object-contain`, not cover: the image is constrained by whichever of
        its dimensions binds first, so a source that is not 4:5 is letterboxed
        rather than cropped. The seed art is 4:5 and the two are identical for
        it — this is what stops the first real photograph the owner uploads from
        losing its toe.

        No CSS padding on the image. The breathing room lives inside the asset,
        where it is a percentage of the frame and therefore the same on a 156px
        card and a 296px one; 8px of CSS padding would be 5% of one and 13% of
        the other, which is the inconsistency this frame exists to remove.
      */}
      <div className="card-media bg-fog relative aspect-4/5 overflow-hidden rounded-lg">
        {product.heroImage ? (
          <ProductImage
            src={product.heroImage.url}
            alt={product.heroImage.alt}
            fill
            priority={priority}
            // Above the fold the browser must not wait for layout to decide
            // this matters; below it, it must not fetch until it does.
            loading={priority ? "eager" : "lazy"}
            fetchPriority={priority ? "high" : "auto"}
            sizes={sizes}
            className="card-hero object-contain"
          />
        ) : null}
        {product.soleImage ? (
          <ProductImage
            src={product.soleImage.url}
            // Decorative: the hero image above already names the product, and a
            // screen reader announcing both would read every card twice.
            alt=""
            aria-hidden
            fill
            loading="lazy"
            sizes={sizes}
            className="card-sole object-contain"
          />
        ) : null}
      </div>

      {/*
        The label row: brand on the left, the heart as its sibling on the right.

        A flex line rather than a layer, so the button takes real width out of
        the row and the brand can be shortened by the layout but never covered
        by a control. `items-center` is what aligns the two — the heart's 36px
        box and the label's 16px line share an optical centre instead of a
        top edge, and the 44px touch target comes from `.hit-44`'s invisible
        ::before rather than from making the box itself 44px and pushing the
        product name down a row.
      */}
      <div className="mt-3 flex items-center justify-between gap-2">
        <p
          data-card-brand
          className="text-muted-foreground min-w-0 truncate font-mono text-xs tracking-[0.06em] uppercase"
        >
          {product.brandName ?? ""}
        </p>
        <SaveForLater
          productId={product.id}
          productName={product.name}
          saved={saved}
          variant="icon"
          // `relative inset-auto` un-sticks the icon variant's card-corner
          // placement — tailwind-merge drops `absolute top-2 right-2` for it —
          // while `relative` is still what `.hit-44`'s ::before needs to anchor
          // to. The translucent pill went with the overlay: on a card it now
          // sits on the page ground, not on an image.
          className="relative inset-auto shrink-0 bg-transparent backdrop-blur-none hover:bg-fog"
        />
      </div>

      <Heading className="text-base leading-snug font-medium">
        <Link
          href={`/product/${product.slug}`}
          className="rounded-sm after:absolute after:inset-0 after:content-['']"
        >
          {product.name}
        </Link>
      </Heading>
      <span className="card-rule mt-1 w-full" aria-hidden="true" />
      {/*
        The colourway, as a caption in the flow.

        Phase 5 removed this along with the text that was baked into the seed
        artwork, on the judgement that "Peacoat Navy" under a thumbnail is
        glossary noise. That was wrong in one specific way: a colourway is not a
        decoration of a shoe, it is which shoe it is. Two cards in the same grid
        can be the same model, the same brand and the same price, and the
        colourway is the only thing on the card that tells them apart.

        It is restored as a sibling under the name rather than as anything
        layered over the image — the frame holds the image and only the image,
        which is the rule the original removal was in service of. `truncate`
        rather than wrap, so a long name can never push the price and the size
        run out of alignment across a row of cards.
      */}
      {colourway ? (
        <p className="text-muted-foreground mt-1.5 truncate text-sm">
          {colourway}
        </p>
      ) : null}
      {/*
        Stars only once real reviews exist — a card with none says nothing,
        which on a shop whose entry condition is a delivered parcel is the
        state at launch and for a while after. Five grey stars would be a
        promise; silence is the truth. (Phase 11, same rule as the JSON-LD.)
      */}
      {product.reviewCount > 0 ? (
        <p className="mt-1.5 flex items-center gap-1.5">
          <Stars average={product.ratingSum / product.reviewCount} />
          <span className="text-muted-foreground font-mono text-xs tabular-nums">
            {(product.ratingSum / product.reviewCount).toFixed(1)} (
            {product.reviewCount})
          </span>
        </p>
      ) : null}
      <Price
        basePrice={product.basePrice}
        salePrice={product.salePrice}
        className="mt-2"
      />
      {/*
        Sold out is stated once, here, above a size run in which every size is
        struck through. The SALE chip that used to sit in the opposite corner is
        gone outright: `Price` already prints the old price struck through and
        the percentage off, so the chip was a third rendering of a fact the row
        below it was already carrying — and it was carrying it in a layer.
      */}
      {soldOut ? (
        <p className="bg-ink text-paper mt-2 inline-block rounded-lg px-2 py-1 font-mono text-xs tracking-[0.06em]">
          SOLD OUT
        </p>
      ) : null}
      <SizeRun sizes={product.sizes} className="mt-3" />
    </article>
  );
}

/**
 * What the caption says when a product comes in more than one colourway.
 *
 * The card shows one photograph, so naming only the first colour would be a
 * quiet lie about a product that comes in three. The count is appended rather
 * than the names listed: two names is already wider than a 156px card, and a
 * truncated "Peacoat Navy, Collegiate Gr…" is worse than no second name at all.
 *
 * Returns null rather than an empty string for a product with no variants, so
 * the caller drops the element instead of rendering an empty line that still
 * takes its margin.
 */
function colourwayCaption(colors: ProductColor[]): string | null {
  const first = colors[0]?.name;
  if (!first) return null;
  return colors.length > 1 ? `${first} · ${colors.length} colours` : first;
}

export function ProductGrid({
  products,
  headingLevel = 3,
  savedIds,
  className,
}: {
  products: ProductSummary[];
  /** Which of these this customer has saved. Empty when signed out. */
  savedIds?: Set<string>;
  headingLevel?: 2 | 3;
  className?: string;
}) {
  return (
    <ul
      className={cn(
        // Two across on a phone, three from `md` — at 768 a two-column grid
        // gives each card 350px, which is a lot of shoe and very little list.
        // Three again at `lg`, where the filter rail takes 240px back, and four
        // at `xl` where there is room for it.
        "grid grid-cols-2 gap-x-4 gap-y-10 sm:gap-x-6 md:grid-cols-3 xl:grid-cols-4",
        className,
      )}
    >
      {products.map((product, index) => (
        <li key={product.id}>
          {/*
            The first four are eager. On a 390px phone the grid is two across,
            so two cards are above the fold and the third is a scroll away —
            four covers the fold at every width the site supports without
            racing the whole grid for bandwidth.
          */}
          <ProductCard
            product={product}
            priority={index < 4}
            headingLevel={headingLevel}
            saved={savedIds?.has(product.id) ?? false}
          />
        </li>
      ))}
    </ul>
  );
}
