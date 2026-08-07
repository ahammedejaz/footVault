import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { ProductCard } from "@/components/storefront/product-card";
import { Button } from "@/components/ui/button";
import {
  getCategoryTiles,
  getCollection,
  getFeaturedProducts,
} from "@/lib/queries/catalog";
import type { HomepageSection } from "@/lib/queries/content";

/**
 * The homepage is whatever `homepage_sections` says it is, in that order.
 *
 * Each renderer below takes the row's jsonb payload and fetches only what that
 * section needs, so adding a section in /admin/appearance in Phase 7 costs one
 * row and no deploy. An unrecognised section_type renders nothing rather than
 * throwing — a homepage must not 500 because a payload is half-written.
 */

function payloadString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function payloadStringArray(
  payload: Record<string, unknown>,
  key: string,
): string[] {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/* -------------------------------------------------------------------------- */
/* hero                                                                       */
/* -------------------------------------------------------------------------- */

async function Hero({ section }: { section: HomepageSection }) {
  const featured = await getFeaturedProducts(3);
  const eyebrow = payloadString(section.payload, "eyebrow") ?? "Foot Vault";
  const ctaLabel = payloadString(section.payload, "cta_label") ?? "Shop all footwear";
  const ctaHref = payloadString(section.payload, "cta_href") ?? "/shop";
  const secondaryLabel = payloadString(section.payload, "secondary_cta_label");
  const secondaryHref = payloadString(section.payload, "secondary_cta_href");

  return (
    <section
      data-surface="ink"
      className="relative isolate overflow-hidden"
      aria-labelledby="hero-heading"
    >
      <div
        className="tread-texture pointer-events-none absolute inset-0"
        aria-hidden="true"
      />
      <div className="relative mx-auto grid max-w-7xl gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:gap-16 lg:py-24">
        <div className="hero-sequence">
          <p className="text-orange font-mono text-xs tracking-[0.14em] uppercase">
            {eyebrow}
          </p>
          <h1
            id="hero-heading"
            className="font-display mt-5 text-4xl font-extrabold tracking-[-0.03em] text-balance uppercase lg:text-6xl"
          >
            {section.title}
          </h1>
          {section.subtitle ? (
            <p className="text-muted-foreground mt-5 max-w-md text-base text-pretty">
              {section.subtitle}
            </p>
          ) : null}
          <div className="mt-8 flex flex-wrap gap-3">
            <Button size="lg" asChild>
              <Link href={ctaHref}>{ctaLabel}</Link>
            </Button>
            {secondaryLabel && secondaryHref ? (
              <Button size="lg" variant="outline" asChild>
                <Link href={secondaryHref}>{secondaryLabel}</Link>
              </Button>
            ) : null}
          </div>
        </div>

        {/*
          Three real products rather than a stock photograph: the hero is the
          catalog, so it cannot go stale, and the tallest tile doubles as the
          LCP image. Hidden below `sm` — at 390px it would push the CTA under
          the fold, and the fold is where the CTA has to be.
        */}
        {featured.length >= 3 ? (
          <div className="hidden grid-cols-2 gap-4 sm:grid">
            <Link
              href={`/product/${featured[0]!.slug}`}
              className="border-border/40 group relative col-span-2 aspect-16/10 overflow-hidden rounded-lg border sm:aspect-3/2"
            >
              <Image
                src={featured[0]!.heroImage?.url ?? ""}
                alt={featured[0]!.heroImage?.alt ?? featured[0]!.name}
                fill
                priority
                sizes="(max-width: 1024px) 100vw, 45vw"
                className="object-cover transition-transform duration-700 group-hover:scale-[1.03]"
              />
              <span className="bg-ink/75 text-paper absolute bottom-3 left-3 rounded-lg px-3 py-1.5 font-mono text-xs tracking-[0.06em]">
                {featured[0]!.brandName} · {featured[0]!.name}
              </span>
            </Link>
            {featured.slice(1, 3).map((product) => (
              <Link
                key={product.id}
                href={`/product/${product.slug}`}
                className="border-border/40 group relative aspect-square overflow-hidden rounded-lg border"
              >
                <Image
                  src={product.heroImage?.url ?? ""}
                  alt={product.heroImage?.alt ?? product.name}
                  fill
                  sizes="(max-width: 1024px) 50vw, 22vw"
                  className="object-cover transition-transform duration-700 group-hover:scale-[1.03]"
                />
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* category_grid                                                              */
/* -------------------------------------------------------------------------- */

async function CategoryGrid({ section }: { section: HomepageSection }) {
  const slugs = payloadStringArray(section.payload, "category_slugs");
  if (slugs.length === 0) return null;
  const tiles = await getCategoryTiles(slugs);
  if (tiles.length === 0) return null;

  return (
    <SectionShell title={section.title} subtitle={section.subtitle}>
      <ul className="grid gap-4 sm:grid-cols-3">
        {tiles.map((tile) => (
          <li key={tile.slug} className="reveal">
            <Link
              href={`/shop/${tile.slug}`}
              className="group relative flex aspect-4/3 flex-col justify-end overflow-hidden rounded-lg"
            >
              {tile.imageUrl ? (
                <Image
                  src={tile.imageUrl}
                  alt=""
                  aria-hidden
                  fill
                  sizes="(max-width: 640px) 100vw, 33vw"
                  className="object-cover transition-transform duration-700 group-hover:scale-[1.04]"
                />
              ) : (
                <span className="bg-fog absolute inset-0" aria-hidden />
              )}
              {/* The scrim is what keeps the label legible over a light or a
                  dark shoe without knowing which it is. */}
              <span
                className="from-ink/85 absolute inset-0 bg-gradient-to-t via-transparent to-transparent"
                aria-hidden
              />
              <span className="relative p-5">
                <span className="font-display text-paper block text-2xl font-bold tracking-[-0.02em] uppercase">
                  {tile.name}
                </span>
                <span className="text-paper/80 mt-1 block font-mono text-xs tracking-[0.06em]">
                  {tile.productCount} {tile.productCount === 1 ? "style" : "styles"}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}

/* -------------------------------------------------------------------------- */
/* product_rail                                                               */
/* -------------------------------------------------------------------------- */

async function ProductRail({ section }: { section: HomepageSection }) {
  const slug = payloadString(section.payload, "collection_slug");
  if (!slug) return null;
  const collection = await getCollection(slug);
  if (!collection || collection.products.length === 0) return null;

  const ctaHref = payloadString(section.payload, "cta_href") ?? `/collection/${slug}`;

  return (
    <SectionShell
      title={section.title ?? collection.name}
      subtitle={section.subtitle ?? collection.description}
      action={{ href: ctaHref, label: "See all" }}
    >
      {/*
        A rail, not a grid: on a phone these scroll sideways with snap, which
        keeps the section three cards tall instead of twelve. The list is the
        same markup at every width — only the overflow changes.
      */}
      <ul className="rail -mx-4 flex snap-x gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0 lg:grid lg:grid-cols-4 lg:overflow-visible">
        {collection.products.slice(0, 8).map((product) => (
          <li key={product.id} className="reveal w-[62vw] shrink-0 sm:w-[38vw] lg:w-auto">
            <ProductCard product={product} />
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}

/* -------------------------------------------------------------------------- */
/* promo_strip                                                                */
/* -------------------------------------------------------------------------- */

type PromoItem = { label: string; detail?: string };

function PromoStrip({ section }: { section: HomepageSection }) {
  const raw = section.payload.items;
  const items: PromoItem[] = Array.isArray(raw)
    ? raw.filter(
        (item): item is PromoItem =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as PromoItem).label === "string",
      )
    : [];
  if (items.length === 0) return null;

  return (
    <section className="bg-fog border-border border-y">
      <ul className="mx-auto grid max-w-7xl gap-x-8 gap-y-6 px-4 py-10 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
        {items.map((item) => (
          <li key={item.label} className="reveal">
            <p className="font-mono text-xs tracking-[0.06em] uppercase">
              {item.label}
            </p>
            {item.detail ? (
              <p className="text-muted-foreground mt-1.5 text-sm">{item.detail}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* banner                                                                     */
/* -------------------------------------------------------------------------- */

function Banner({ section }: { section: HomepageSection }) {
  const ctaLabel = payloadString(section.payload, "cta_label");
  const ctaHref = payloadString(section.payload, "cta_href");

  return (
    <section className="mx-auto max-w-7xl px-4 py-14 sm:px-6">
      <div
        data-surface="ink"
        className="reveal relative isolate overflow-hidden rounded-lg px-6 py-12 sm:px-10 sm:py-14"
      >
        <div className="tread-texture pointer-events-none absolute inset-0" aria-hidden />
        <div className="relative flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="font-display text-2xl font-bold tracking-[-0.02em] uppercase sm:text-4xl">
              {section.title}
            </h2>
            {section.subtitle ? (
              <p className="text-muted-foreground mt-3 max-w-lg text-base">
                {section.subtitle}
              </p>
            ) : null}
          </div>
          {ctaLabel && ctaHref ? (
            <Button size="lg" asChild className="shrink-0">
              <Link href={ctaHref}>{ctaLabel}</Link>
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */

function SectionShell({
  title,
  subtitle,
  action,
  children,
}: {
  title: string | null;
  subtitle?: string | null;
  action?: { href: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <section className="mx-auto max-w-7xl px-4 py-14 sm:px-6">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          {title ? (
            <h2 className="font-display text-2xl font-bold tracking-[-0.02em] uppercase sm:text-4xl">
              {title}
            </h2>
          ) : null}
          {subtitle ? (
            <p className="text-muted-foreground mt-2 max-w-xl text-base">{subtitle}</p>
          ) : null}
        </div>
        {action ? (
          <Link
            href={action.href}
            className="hover:text-orange-ink inline-flex min-h-11 items-center gap-1.5 rounded-lg font-mono text-xs tracking-[0.06em] uppercase transition-colors"
          >
            {action.label}
            <ArrowRight className="size-3.5" />
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function HomeSection({ section }: { section: HomepageSection }) {
  switch (section.sectionType) {
    case "hero":
      return <Hero section={section} />;
    case "category_grid":
      return <CategoryGrid section={section} />;
    case "product_rail":
      return <ProductRail section={section} />;
    case "promo_strip":
      return <PromoStrip section={section} />;
    case "banner":
      return <Banner section={section} />;
    default:
      // testimonials and rich_text arrive with the homepage builder in Phase 7.
      return null;
  }
}
