import Image from "next/image";
import Link from "next/link";

import { Price } from "@/components/storefront/price";
import { SizeRun } from "@/components/storefront/size-run";
import type { ProductSummary } from "@/lib/catalog-types";
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
 */
export function ProductCard({
  product,
  priority = false,
  className,
}: {
  product: ProductSummary;
  /** Set on the first row so the LCP image is not lazy. */
  priority?: boolean;
  className?: string;
}) {
  const soldOut = !product.inStock;

  return (
    <article className={cn("product-card group relative", className)}>
      <div className="card-media bg-fog relative aspect-4/5 overflow-hidden rounded-lg">
        {product.heroImage ? (
          <Image
            src={product.heroImage.url}
            alt={product.heroImage.alt}
            fill
            priority={priority}
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
            className="card-hero object-cover"
          />
        ) : null}
        {product.soleImage ? (
          <Image
            src={product.soleImage.url}
            // Decorative: the hero image above already names the product, and a
            // screen reader announcing both would read every card twice.
            alt=""
            aria-hidden
            fill
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
            className="card-sole object-cover"
          />
        ) : null}

        {soldOut ? (
          <p className="bg-ink/85 text-paper absolute top-3 left-3 rounded-lg px-2 py-1 font-mono text-xs tracking-[0.06em]">
            SOLD OUT
          </p>
        ) : product.salePrice ? (
          <p className="bg-orange text-ink absolute top-3 left-3 rounded-lg px-2 py-1 font-mono text-xs font-medium tracking-[0.06em]">
            SALE
          </p>
        ) : null}
      </div>

      <div className="mt-3">
        {product.brandName ? (
          <p className="text-muted-foreground font-mono text-xs tracking-[0.06em] uppercase">
            {product.brandName}
          </p>
        ) : null}
        <h3 className="mt-1 text-base leading-snug font-medium">
          <Link
            href={`/product/${product.slug}`}
            className="rounded-sm after:absolute after:inset-0 after:content-['']"
          >
            {product.name}
          </Link>
        </h3>
        <span className="card-rule mt-1 w-full" aria-hidden="true" />
        <Price
          basePrice={product.basePrice}
          salePrice={product.salePrice}
          className="mt-2"
        />
        <SizeRun sizes={product.sizes} compact className="mt-3" />
      </div>
    </article>
  );
}

export function ProductGrid({
  products,
  className,
}: {
  products: ProductSummary[];
  className?: string;
}) {
  return (
    <ul
      className={cn(
        "grid grid-cols-2 gap-x-4 gap-y-10 sm:gap-x-6 lg:grid-cols-4",
        className,
      )}
    >
      {products.map((product, index) => (
        <li key={product.id} className="reveal">
          <ProductCard product={product} priority={index < 4} />
        </li>
      ))}
    </ul>
  );
}
