import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PackageCheck, RotateCcw, Truck } from "lucide-react";

import { ProductCard } from "@/components/storefront/product-card";
import { ProductGallery } from "@/components/storefront/product-gallery";
import { Price } from "@/components/storefront/price";
import { SizeSelector } from "@/components/storefront/size-selector";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getProduct,
  getRelatedProducts,
  listProductSlugs,
  type ProductDetail,
} from "@/lib/queries/catalog";
import { getSiteSettings, setting, type ShippingSettings } from "@/lib/queries/content";
import { formatPaise } from "@/lib/format";
import { SITE_URL } from "@/lib/env";
import { staticParamsOr } from "@/lib/static-params";
import type { RawSearchParams } from "@/lib/queries/search-params";

export const revalidate = 600;

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
  const product = await getProduct(slug);
  if (!product) return {};

  return {
    title: product.metaTitle ?? product.name,
    description: product.metaDescription ?? product.description ?? undefined,
    alternates: { canonical: `/product/${product.slug}` },
    openGraph: {
      type: "website",
      title: product.metaTitle ?? product.name,
      description: product.metaDescription ?? undefined,
      images: product.heroImage
        ? [{ url: product.heroImage.url, alt: product.heroImage.alt }]
        : undefined,
    },
  };
}

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const [{ slug }, search] = await Promise.all([params, searchParams]);
  const product = await getProduct(slug);
  if (!product) notFound();

  const settings = await getSiteSettings();
  const shipping = setting<ShippingSettings>(settings, "shipping", {
    flat_fee_paise: 9900,
    free_above_paise: 199900,
    currency: "INR",
    regions: ["IN"],
  });
  const returnDays = setting<number>(settings, "return_window_days", 7);

  const requested = Array.isArray(search.size) ? search.size[0] : search.size;
  const available = product.sizes.filter((s) => s.available);
  // One size in stock means there is nothing to choose: preselect it.
  const selected =
    requested && available.some((s) => s.size === requested)
      ? requested
      : available.length === 1
        ? available[0]!.size
        : null;

  const selectedEntry = selected
    ? product.sizes.find((s) => s.size === selected)
    : undefined;
  const price = product.salePrice ?? product.basePrice;

  /**
   * Product JSON-LD. Built from the same numbers the page renders, so the
   * markup cannot claim a price the customer is not being shown.
   */
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    description: product.description ?? undefined,
    sku: product.variants[0]?.sku,
    brand: product.brandName ? { "@type": "Brand", name: product.brandName } : undefined,
    image: product.images.map((image) => new URL(image.url, SITE_URL).toString()),
    offers: {
      "@type": "Offer",
      priceCurrency: "INR",
      price: (price / 100).toFixed(2),
      availability: product.inStock
        ? "https://schema.org/InStock"
        : "https://schema.org/OutOfStock",
      url: new URL(`/product/${product.slug}`, SITE_URL).toString(),
    },
  };

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Shop", item: new URL("/shop", SITE_URL).toString() },
      product.categorySlug
        ? {
            "@type": "ListItem",
            position: 2,
            name: product.categoryName,
            item: new URL(`/shop/${product.categorySlug}`, SITE_URL).toString(),
          }
        : null,
      {
        "@type": "ListItem",
        position: product.categorySlug ? 3 : 2,
        name: product.name,
        item: new URL(`/product/${product.slug}`, SITE_URL).toString(),
      },
    ].filter(Boolean),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }}
      />

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <nav aria-label="Breadcrumb">
          <ol className="text-muted-foreground flex flex-wrap items-center gap-1.5 font-mono text-xs tracking-[0.06em]">
            <li>
              <Link href="/shop" className="hover:text-foreground">
                Shop
              </Link>
            </li>
            {product.categorySlug ? (
              <>
                <li aria-hidden>/</li>
                <li>
                  <Link
                    href={`/shop/${product.categorySlug}`}
                    className="hover:text-foreground"
                  >
                    {product.categoryName}
                  </Link>
                </li>
              </>
            ) : null}
          </ol>
        </nav>

        <div className="mt-6 grid gap-10 lg:grid-cols-2 lg:gap-16">
          <ProductGallery images={product.images} productName={product.name} />

          <div>
            {product.brandName ? (
              <p className="text-muted-foreground font-mono text-xs tracking-[0.14em] uppercase">
                {product.brandName}
              </p>
            ) : null}
            <h1 className="font-display mt-2 text-4xl font-extrabold tracking-[-0.03em] text-balance uppercase">
              {product.name}
            </h1>

            <Price
              basePrice={product.basePrice}
              salePrice={product.salePrice}
              size="lg"
              className="mt-4"
            />
            <p className="text-muted-foreground mt-1 text-sm">
              Inclusive of all taxes
            </p>

            {product.colors.length > 0 ? (
              <div className="mt-8">
                <h2 className="font-mono text-xs tracking-[0.06em] uppercase">
                  Colour
                </h2>
                {/* Read-only until Phase 3 wires a colourway to its own image
                    set — showing a swatch that does nothing would be worse
                    than showing what the shop stocks. */}
                <ul className="mt-3 flex flex-wrap gap-2">
                  {product.colors.map((color) => (
                    <li
                      key={color.name}
                      className="border-border inline-flex min-h-9 items-center gap-2 rounded-lg border px-3 text-sm"
                    >
                      <span
                        aria-hidden
                        className="border-border/70 size-3.5 rounded-full border"
                        style={{ backgroundColor: color.hex ?? "transparent" }}
                      />
                      {color.name}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="mt-8">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-mono text-xs tracking-[0.06em] uppercase">
                  Size · UK
                </h2>
                <Link
                  href="/page/size-guide"
                  className="text-orange-ink text-sm underline underline-offset-4"
                >
                  Size guide
                </Link>
              </div>
              <div className="mt-3">
                <Suspense fallback={<Skeleton className="h-12 w-full" />}>
                  <SizeSelector sizes={product.sizes} selected={selected} />
                </Suspense>
              </div>

              <p className="mt-3 min-h-5 text-sm" aria-live="polite">
                {selectedEntry && selectedEntry.stock > 0 && selectedEntry.stock <= 3 ? (
                  <span className="text-orange-ink font-medium">
                    Only {selectedEntry.stock} left in size {selectedEntry.size}
                  </span>
                ) : !product.inStock ? (
                  <span className="text-muted-foreground">
                    Sold out in every size. The run above is the full run — nothing is hidden.
                  </span>
                ) : selected ? (
                  <span className="text-muted-foreground">
                    In stock in size {selected}
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    Pick a size to see what is left
                  </span>
                )}
              </p>
            </div>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              {/*
                The bag arrives in Phase 4. The button is disabled and says so
                rather than being hidden, because a product page without an
                add-to-bag reads as broken.
              */}
              <Button size="lg" className="sm:flex-1" disabled>
                Add to bag
              </Button>
              <Button size="lg" variant="outline" disabled className="sm:flex-1">
                Save for later
              </Button>
            </div>
            <p className="text-muted-foreground mt-2 font-mono text-xs tracking-[0.06em]">
              The bag opens in the next build stage
            </p>

            <dl className="border-border mt-8 grid gap-4 border-t pt-6 text-sm">
              <div className="flex gap-3">
                <Truck className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
                <div>
                  <dt className="font-medium">Delivery</dt>
                  <dd className="text-muted-foreground">
                    2–4 working days to metros. Free over{" "}
                    {formatPaise(shipping.free_above_paise)}, {formatPaise(shipping.flat_fee_paise)} below.
                  </dd>
                </div>
              </div>
              <div className="flex gap-3">
                <RotateCcw className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
                <div>
                  <dt className="font-medium">Returns</dt>
                  <dd className="text-muted-foreground">
                    Free returns and size exchanges within {returnDays} days, unworn and in the box.
                  </dd>
                </div>
              </div>
              {product.material ? (
                <div className="flex gap-3">
                  <PackageCheck className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
                  <div>
                    <dt className="font-medium">Made of</dt>
                    <dd className="text-muted-foreground">{product.material}</dd>
                  </div>
                </div>
              ) : null}
            </dl>

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
          </div>
        </div>
      </div>

      <RelatedRail product={product} />
    </>
  );
}

async function RelatedRail({ product }: { product: ProductDetail }) {
  const related = await getRelatedProducts(product);
  if (related.length === 0) return null;

  return (
    <section className="mx-auto max-w-7xl px-4 pb-16 sm:px-6">
      <div className="tread-rule mb-10" aria-hidden />
      <h2 className="font-display text-2xl font-bold tracking-[-0.02em] uppercase">
        You may also like
      </h2>
      <ul className="rail mt-8 -mx-4 flex gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0 lg:grid lg:grid-cols-4 lg:overflow-visible">
        {related.map((item) => (
          <li key={item.id} className="reveal w-[62vw] shrink-0 sm:w-[38vw] lg:w-auto">
            <ProductCard product={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}
