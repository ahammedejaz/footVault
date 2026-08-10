import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import type { ContentTokens } from "@/lib/content-tokens";
import { fillSectionTokens } from "@/lib/content/homepage-sections";
import { imageSourceProps, type SharedImageProps } from "@/lib/image-layout";

import { ProseBlocks, hasProse } from "@/components/storefront/prose";
import { ProductCard } from "@/components/storefront/product-card";
import { Rail } from "@/components/storefront/rail";
import { Button } from "@/components/ui/button";
import {
  cachedBanner,
  cachedCategoryTiles,
  cachedCollection,
  cachedCollectionProducts,
} from "@/lib/queries/cached";
import { getSavedProductIds } from "@/lib/queries/wishlist";
import type { HomepageSection } from "@/lib/queries/content";

/**
 * The homepage is whatever `homepage_sections` says it is, in that order.
 *
 * Each renderer takes the row's jsonb payload and fetches only what that
 * section needs, so adding a section from /admin/appearance in Phase 7 costs
 * one row and no deploy. An unrecognised `section_type` renders nothing rather
 * than throwing — a homepage must not 500 because a payload is half-written,
 * and a section that has not been built yet is not an error, it is a section
 * that has not been built yet.
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
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/* -------------------------------------------------------------------------- */
/* hero                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The hero.
 *
 * The image is the LCP element on the busiest page on the site, so it is
 * `priority`, eagerly loaded, and served through `<picture>` with two genuinely
 * different crops rather than one image squeezed twice — a 16:9 hero cropped to
 * a 390px phone loses the shoe, and a phone-shaped hero stretched across a
 * desktop loses the point.
 *
 * `getImageProps` rather than two `<Image>` elements: two elements means the
 * browser downloads both and discards one, which on a 4G phone is the entire
 * budget spent twice. `<source media>` lets it choose before it fetches.
 */
async function Hero({ section }: { section: HomepageSection }) {
  const banner = await cachedBanner("home_hero");

  const title = section.title ?? banner?.headline ?? "Every step counts";
  const subtitle = section.subtitle ?? banner?.subtext;
  const eyebrow = payloadString(section.payload, "eyebrow") ?? "Foot Vault";
  const ctaLabel =
    payloadString(section.payload, "cta_label") ??
    banner?.ctaLabel ??
    "Shop all footwear";
  const ctaHref =
    payloadString(section.payload, "cta_href") ?? banner?.ctaHref ?? "/shop";
  const secondaryLabel = payloadString(section.payload, "secondary_cta_label");
  const secondaryHref = payloadString(section.payload, "secondary_cta_href");

  const desktop = banner?.imageUrl ?? null;
  const mobile = banner?.mobileImageUrl ?? desktop;

  // What both crops genuinely agree on — and nothing else. `SharedImageProps`
  // forbids a layout key here: the two crops have deliberately different boxes,
  // which is the whole point of art-directing them, so a layout is not
  // something they can share. Writing `fill` into this object is now the
  // compile error rather than the 500.
  const common: SharedImageProps = {
    alt: "",
    priority: true,
    // The hero occupies the full width at every breakpoint. Stating that lets
    // the browser pick a candidate from the srcset before layout, which is the
    // difference between an LCP that starts at 200ms and one that starts once
    // the stylesheet has landed.
    sizes: "100vw",
    quality: 82,
  };

  // Sized rather than filled: these render as a bare <img> that the parent
  // positions with CSS (`absolute inset-0 size-full object-cover`), so the box
  // is already owned. What next/image still needs from us is each crop's
  // intrinsic size, because that is what the srcset candidates are built from.
  const desktopProps = desktop
    ? imageSourceProps(common, desktop, { width: 1920, height: 1000 })
    : null;
  const mobileProps = mobile
    ? imageSourceProps(common, mobile, { width: 900, height: 720 })
    : null;

  return (
    <section
      data-surface="ink"
      className="relative isolate overflow-hidden md:min-h-[34rem]"
      aria-labelledby="hero-heading"
    >
      {/*
        Below `md` the image is a band above the copy, not a backdrop behind it.
        A 40px display headline over a photograph on a 390px screen is a
        headline over a photograph however dark the scrim is, and the scrim dark
        enough to fix it is a scrim that hides the photograph. Above `md` there
        is room to put them side by side, and the overlay is worth having.
      */}
      <div className="relative aspect-5/4 w-full sm:aspect-video md:absolute md:inset-0 md:aspect-auto md:h-full">
        {mobileProps && desktopProps ? (
          <picture>
            <source
              media="(min-width: 768px)"
              srcSet={desktopProps.srcSet}
              sizes="100vw"
            />
            {/* A bare <img> on purpose: getImageProps is the documented way to
                art-direct next/image. <Image> cannot emit a <source media>, and
                two <Image> elements make the browser fetch both crops. */}
            <img
              {...mobileProps}
              alt=""
              aria-hidden
              className="absolute inset-0 size-full object-cover"
            />
          </picture>
        ) : (
          <div
            className="tread-texture pointer-events-none absolute inset-0"
            aria-hidden
          />
        )}

        {/* Mobile: a short fade into the copy below, so the seam is not a line.
            Desktop: the scrim that keeps the headline legible over the art. */}
        <div
          className="from-ink absolute inset-0 bg-gradient-to-t to-transparent to-40% md:via-ink/70 md:bg-gradient-to-r md:via-55% md:to-transparent"
          aria-hidden
        />
      </div>

      <div className="relative mx-auto max-w-7xl px-4 pt-6 pb-14 sm:px-6 md:flex md:min-h-[34rem] md:items-center md:py-24">
        <div className="hero-sequence max-w-lg lg:max-w-2xl">
          <p className="text-orange font-mono text-xs tracking-[0.14em] uppercase">
            {eyebrow}
          </p>
          <h1
            id="hero-heading"
            className="font-display mt-4 text-4xl font-extrabold tracking-[-0.03em] text-balance uppercase lg:text-6xl"
          >
            {title}
          </h1>
          {subtitle ? (
            <p className="text-muted-foreground mt-5 max-w-md text-base text-pretty">
              {subtitle}
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
  const tiles = await cachedCategoryTiles(slugs);
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
                  loading="lazy"
                  sizes="(max-width: 640px) 100vw, 33vw"
                  className="object-cover transition-transform duration-700 group-hover:scale-[1.04]"
                />
              ) : (
                <span className="bg-ink absolute inset-0" aria-hidden />
              )}
              <span
                className="from-ink/85 absolute inset-0 bg-gradient-to-t via-transparent to-transparent"
                aria-hidden
              />
              <span className="relative p-5">
                <span className="font-display text-paper block text-2xl font-bold tracking-[-0.02em] uppercase">
                  {tile.name}
                </span>
                <span className="text-paper/85 mt-1 block font-mono text-xs tracking-[0.06em]">
                  {tile.productCount}{" "}
                  {tile.productCount === 1 ? "style" : "styles"}
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

  const [collection, page, savedIds] = await Promise.all([
    cachedCollection(slug),
    cachedCollectionProducts(slug, 8),
    // Outside the cached pair on purpose — this one is per-customer.
    getSavedProductIds(),
  ]);
  if (!collection || page.products.length === 0) return null;

  const ctaHref =
    payloadString(section.payload, "cta_href") ?? `/collection/${slug}`;
  const title = section.title ?? collection.name;

  return (
    <SectionShell
      title={title}
      subtitle={section.subtitle ?? collection.description}
      action={{ href: ctaHref, label: "See all" }}
    >
      <Rail label={title}>
        {page.products.map((product) => (
          <li
            key={product.id}
            className="w-[62vw] shrink-0 sm:w-[38vw] lg:w-[calc((100%-3rem)/4)]"
          >
            <ProductCard
              product={product}
              saved={savedIds.has(product.id)}
              sizes="(max-width: 640px) 62vw, (max-width: 1024px) 38vw, 288px"
            />
          </li>
        ))}
      </Rail>
    </SectionShell>
  );
}

/* -------------------------------------------------------------------------- */
/* promo_strip                                                                */
/* -------------------------------------------------------------------------- */

type PromoItem = { label: string; detail?: string };

/**
 * The strip is a list of promises, so every number in it has to be the number
 * the till keeps.
 *
 * This carried "Free shipping over ₹2,499" on the homepage of the live shop
 * while `site_settings.shipping.free_above_paise` said ₹6,499 — the same drift
 * Phase 7 found in the announcement bar and on `/page/shipping`, in a third
 * place, and it survived the sweep that fixed those two because it lives in
 * `homepage_sections.payload` rather than in prose the gate was looking at.
 *
 * Substitution no longer happens here. It happens once in `HomeSection` for the
 * whole section, which is what stopped this being the *only* place on the
 * homepage where a token worked.
 */
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
    <section
      className="bg-fog border-border border-y"
      aria-label="What we promise"
    >
      <ul className="mx-auto grid max-w-7xl gap-x-8 gap-y-6 px-4 py-10 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
        {items.map((item, index) => (
          /*
            Keyed by position, which is a change worth explaining. This used to
            key on the raw label *specifically* so that nudging the
            free-delivery threshold could not remount a row whose identity had
            not changed — the filled text moves, the token does not.

            Now that the section arrives already substituted there is no raw
            label to reach for, and position gives the same guarantee more
            directly: changing the threshold changes neither an item's index nor
            the length of the list, so nothing remounts. These rows hold no
            state, so the usual cost of index keys does not apply.
          */
          <li key={index} className="reveal">
            <p className="font-mono text-xs tracking-[0.06em] uppercase">
              {item.label}
            </p>
            {item.detail ? (
              <p className="text-muted-foreground mt-1.5 text-sm">
                {item.detail}
              </p>
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
        className="relative isolate overflow-hidden rounded-lg px-6 py-12 sm:px-10 sm:py-14"
      >
        <div
          className="tread-texture pointer-events-none absolute inset-0"
          aria-hidden
        />
        <div className="relative flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="font-display text-2xl font-bold tracking-[-0.02em] uppercase sm:text-4xl">
              {section.title}
            </h2>
            {section.subtitle ? (
              <p className="text-muted-foreground mt-3 max-w-lg text-base text-pretty">
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
/* rich_text                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A block of owner-written prose on the homepage.
 *
 * `rich_text` has been in the `section_type` enum since the first migration and
 * has never had a renderer, so a shopkeeper could create the row and get a blank
 * gap. This is that renderer, and it is deliberately the *least* capable section
 * on the page.
 *
 * It reuses `ProseBlocks`, the same renderer `pages.body` uses, rather than
 * introducing a second dialect of owner-typed text — the conventions the returns
 * policy already relies on (`- ` bullets, `**emphasis**`, blank lines between
 * blocks) work here for free, and there is still no HTML path from the database
 * into the page.
 *
 * Narrower than the other sections on purpose: prose set to the full 80rem grid
 * is unreadable, so it sits in the same measure as a policy page.
 *
 * An emptied body renders **nothing at all**, heading included. A section
 * reduced to a floating title over blank space reads as a page that failed to
 * load rather than as a section the owner cleared.
 */
function RichText({ section }: { section: HomepageSection }) {
  const body = payloadString(section.payload, "body");
  if (!hasProse(body)) return null;

  return (
    <section className="mx-auto max-w-2xl px-4 py-14 sm:px-6">
      {section.title ? (
        <h2 className="font-display text-2xl font-bold tracking-[-0.02em] text-balance uppercase sm:text-3xl">
          {section.title}
        </h2>
      ) : null}
      {section.subtitle ? (
        <p className="text-muted-foreground mt-2 text-base text-pretty">
          {section.subtitle}
        </p>
      ) : null}
      <ProseBlocks
        text={body}
        className={section.title || section.subtitle ? "mt-6 space-y-5" : "space-y-5"}
      />
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
            <h2 className="font-display text-2xl font-bold tracking-[-0.02em] text-balance uppercase sm:text-4xl">
              {title}
            </h2>
          ) : null}
          {subtitle ? (
            <p className="text-muted-foreground mt-2 max-w-xl text-base text-pretty">
              {subtitle}
            </p>
          ) : null}
        </div>
        {action ? (
          <Link
            href={action.href}
            className="hover:text-orange-ink inline-flex min-h-11 items-center gap-1.5 rounded-lg font-mono text-xs tracking-[0.06em] uppercase transition-colors"
          >
            {action.label}
            {title ? <span className="sr-only"> of {title}</span> : null}
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/**
 * One section, with its owner-typed copy already resolved.
 *
 * `tokens` is a required prop rather than something this function reads for
 * itself, and that is the point of the signature. Resolving tokens needs a
 * database read, and there are two callers — the homepage and the admin preview
 * — which must agree exactly or the preview lies about what will publish.
 * Making it a parameter means the type checker asks the question instead of a
 * reviewer remembering to.
 *
 * Substitution happens here, once, before dispatch: see
 * `fillSectionTokens` for why it is not done inside each renderer.
 */
export function HomeSection({
  section: raw,
  tokens,
}: {
  section: HomepageSection;
  tokens: ContentTokens;
}) {
  const section = fillSectionTokens(raw, tokens);

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
    case "rich_text":
      return <RichText section={section} />;
    default:
      // `testimonials` is the only type left without a renderer. Rendering
      // nothing is the right failure: the rest of the page still works, and the
      // owner sees the gap where the section they configured would be rather
      // than a 500.
      return null;
  }
}
