import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PackageCheck, RotateCcw, Truck } from "lucide-react";

import { Breadcrumbs } from "@/components/storefront/breadcrumbs";
import { ProductCard } from "@/components/storefront/product-card";
import { ProductViewer } from "@/components/storefront/product-viewer";
import { Rail } from "@/components/storefront/rail";
import { ReviewsSection } from "@/components/storefront/reviews/reviews-section";
import { liveReviewAggregate } from "@/lib/queries/reviews";
import { listProductSlugs, type ProductDetail } from "@/lib/queries/catalog";
import {
  cachedProduct,
  cachedRelatedProducts,
  cachedSiteSettings,
} from "@/lib/queries/cached";
import { getSavedProductIds } from "@/lib/queries/wishlist";
import { publicShippingSettings } from "@/lib/queries/content";
import { DeliveryCheck } from "@/components/storefront/delivery-check";
import { formatPaise } from "@/lib/format";
import { SITE_URL } from "@/lib/env";
import { staticParamsOr } from "@/lib/static-params";

/**
 * Statically rendered, revalidated hourly, and revalidated on demand when the
 * owner saves a product in Phase 6.
 *
 * This page deliberately does not read `searchParams`. The size and colourway a
 * customer picks live in the URL, but they are read and written on the client
 * (see product-viewer.tsx) — reading them here would make the route dynamic,
 * which puts a database round trip in front of the LCP image on the page that
 * matters most.
 */
export const revalidate = 3600;

export async function generateStaticParams() {
  return staticParamsOr("products", async () =>
    (await listProductSlugs()).map((slug) => ({ slug })),
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const product = await cachedProduct(slug);
  if (!product) return { title: "No longer stocked" };

  const title = product.metaTitle ?? product.name;
  const description =
    product.metaDescription ??
    product.description?.split(". ")[0]?.concat(".") ??
    `${product.name} at Foot Vault.`;

  return {
    title,
    description,
    alternates: { canonical: `/product/${product.slug}` },
    // No `images` here on purpose: opengraph-image.tsx in this folder generates
    // the card. Naming the hero SVG would override it with a file no social
    // platform will render.
    openGraph: { type: "website", title, description },
  };
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const product = await cachedProduct(slug);
  if (!product) notFound();

  // Read alongside the cached product, never into it: this one is per-customer.
  const [settings, savedIds] = await Promise.all([
    cachedSiteSettings(),
    getSavedProductIds(),
  ]);
  const saved = savedIds.has(product.id);
  const shipping = publicShippingSettings(settings);
  const price = product.salePrice ?? product.basePrice;

  /**
   * Live, not from `cachedProduct`: review writes call `revalidatePath` on
   * this page, which regenerates it without dropping the hour-old
   * `unstable_cache` entry — so the cached copy of these two numbers can lag
   * a fresh review by an hour on the page it was just written about.
   */
  const reviewAggregate = await liveReviewAggregate(product.id);

  /**
   * Product JSON-LD, built from the same numbers the page renders so the markup
   * cannot claim a price or an availability the customer is not being shown.
   *
   * One offer per variant rather than a single aggregate: a shoe sold out in
   * UK 6 and in stock in UK 9 is two different answers to "can I buy this", and
   * an `AggregateOffer` that says InStock hides the half that is not.
   */
  const productUrl = new URL(`/product/${product.slug}`, SITE_URL).toString();
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    description: product.description ?? undefined,
    sku: product.variants[0]?.sku,
    brand: product.brandName
      ? { "@type": "Brand", name: product.brandName }
      : undefined,
    category: product.categoryName ?? undefined,
    material: product.material ?? undefined,
    image: product.images.map((image) =>
      new URL(image.url, SITE_URL).toString(),
    ),
    /**
     * Only once real reviews exist — never emitted at zero, never fabricated
     * (the brief's rule, and Google's: an AggregateRating over nothing is a
     * penalty waiting to be noticed). Built from the same live aggregate the
     * page renders, so the markup cannot claim stars the customer is not
     * being shown.
     */
    aggregateRating:
      reviewAggregate.reviewCount > 0
        ? {
            "@type": "AggregateRating",
            ratingValue: (
              reviewAggregate.ratingSum / reviewAggregate.reviewCount
            ).toFixed(1),
            reviewCount: reviewAggregate.reviewCount,
            bestRating: 5,
            worstRating: 1,
          }
        : undefined,
    offers: {
      "@type": "AggregateOffer",
      priceCurrency: "INR",
      lowPrice: (price / 100).toFixed(2),
      highPrice: (price / 100).toFixed(2),
      offerCount: product.variants.length,
      offers: product.variants.map((variant) => ({
        "@type": "Offer",
        sku: variant.sku,
        priceCurrency: "INR",
        price: (price / 100).toFixed(2),
        availability:
          variant.stock > 0
            ? "https://schema.org/InStock"
            : "https://schema.org/OutOfStock",
        itemCondition: "https://schema.org/NewCondition",
        url: `${productUrl}?size=${encodeURIComponent(variant.size)}&color=${encodeURIComponent(variant.color)}`,
      })),
    },
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <Breadcrumbs
          crumbs={[
            { label: "Home", href: "/" },
            { label: "Shop", href: "/shop" },
            ...(product.categorySlug && product.categoryName
              ? [
                  {
                    label: product.categoryName,
                    href: `/shop/${product.categorySlug}`,
                  },
                ]
              : []),
            { label: product.name },
          ]}
        />

        <ProductViewer product={product} saved={saved}>
          <dl className="border-border mt-8 grid gap-4 border-t pt-6 text-sm">
            {/*
              A `<dl>` may contain `<dt>`, `<dd>`, `<div>`, `<script>` and
              `<template>` and nothing else, and a `<dt>` must be a child of the
              `<dl>` or of a `<div>` that is. An icon-plus-text layout naturally
              produces `div > div > dt`, which is neither — so the icon sits in
              the same grid as the pair it labels, spanning both rows, rather
              than in a wrapper of its own.
            */}
            <div className="grid grid-cols-[1rem_1fr] gap-x-3">
              <Truck
                className="text-muted-foreground row-span-2 mt-1 size-4 shrink-0"
                aria-hidden
              />
              <dt className="font-medium">Delivery</dt>
              <dd className="text-muted-foreground col-start-2">
                Free over {formatPaise(shipping.free_above_paise)}. Below that,
                the courier&rsquo;s own rate to your pin code, shown at
                checkout.
              </dd>
            </div>
            <div className="grid grid-cols-[1rem_1fr] gap-x-3">
              <RotateCcw
                className="text-muted-foreground row-span-2 mt-1 size-4 shrink-0"
                aria-hidden
              />
              <dt className="font-medium">Damage on arrival</dt>
              <dd className="text-muted-foreground col-start-2">
                Tell us within 24 hours and we replace it. We do not offer
                refunds or size exchanges — check the size guide before you
                order, and ask us if you are unsure.
              </dd>
            </div>
            {product.material ? (
              <div className="grid grid-cols-[1rem_1fr] gap-x-3">
                <PackageCheck
                  className="text-muted-foreground row-span-2 mt-1 size-4 shrink-0"
                  aria-hidden
                />
                <dt className="font-medium">Made of</dt>
                <dd className="text-muted-foreground col-start-2">
                  {product.material}
                </dd>
              </div>
            ) : null}
          </dl>

          {/*
            Outside the <dl>, deliberately. A definition list may contain only
            dt/dd groups (optionally wrapped in a div), and axe is right to
            reject a <form> smuggled in as one — I put it there first and the
            audit caught it. Availability is not a term-and-definition anyway.
          */}
          <div className="mt-6">
            <DeliveryCheck />
          </div>

          {product.description ? (
            <div className="border-border mt-8 border-t pt-6">
              <h2 className="font-mono text-xs tracking-[0.06em] uppercase">
                Details
              </h2>
              <p className="text-muted-foreground mt-3 text-base whitespace-pre-line">
                {product.description}
              </p>
            </div>
          ) : null}
        </ProductViewer>

        <ReviewsSection productId={product.id} />
      </div>

      <RelatedRail product={product} />
    </>
  );
}

async function RelatedRail({ product }: { product: ProductDetail }) {
  // The rail is cached; who saved what is not. Read side by side, never merged.
  const [related, savedIds] = await Promise.all([
    cachedRelatedProducts(product),
    getSavedProductIds(),
  ]);
  if (related.length === 0) return null;

  const label = product.categoryName
    ? `More ${product.categoryName.toLowerCase()}`
    : "You may also like";

  return (
    <section
      // Space for the sticky bar, so the last rail is not sat on by it.
      className="mx-auto max-w-7xl px-4 pb-24 sm:px-6 lg:pb-16"
      aria-labelledby="related-heading"
    >
      <div className="tread-rule mb-10" aria-hidden />
      <h2
        id="related-heading"
        className="font-display text-2xl font-bold tracking-[-0.02em] uppercase"
      >
        {label}
      </h2>
      <div className="mt-8">
        <Rail label={label}>
          {related.map((item) => (
            <li
              key={item.id}
              className="w-[62vw] shrink-0 sm:w-[38vw] lg:w-[calc((100%-3rem)/4)]"
            >
              <ProductCard
                product={item}
                saved={savedIds.has(item.id)}
                sizes="(max-width: 640px) 62vw, (max-width: 1024px) 38vw, 288px"
              />
            </li>
          ))}
        </Rail>
      </div>
    </section>
  );
}
