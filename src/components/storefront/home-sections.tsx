import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import type { ContentTokens } from "@/lib/content-tokens";
import { fillSectionTokens } from "@/lib/content/homepage-sections";
import { imageSourceProps, type SharedImageProps } from "@/lib/image-layout";

import { HeroVideo } from "@/components/storefront/hero-video";
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

  /**
   * Imagery is payload-first, and the payload owns it **wholesale** once it
   * speaks. Before Phase 10 the hero's copy lived in this section's payload
   * while its images lived in a separate `banners` row, so "edit the hero"
   * meant two rows in two tables — the editor could not honestly claim the
   * section. Now `/admin/appearance` writes the image URLs into the payload,
   * and the banner remains only the fallback that keeps every pre-editor
   * homepage rendering exactly as it did.
   *
   * All-or-nothing on purpose: a payload desktop image combined with the
   * banner's mobile crop would be two unrelated photographs presented as one
   * art-directed pair, which is worse than either alone.
   */
  const payloadDesktop = payloadString(section.payload, "desktop_image_url");
  const payloadMobile = payloadString(section.payload, "mobile_image_url");
  const payloadOwnsImagery = payloadDesktop !== null || payloadMobile !== null;
  const desktop = payloadOwnsImagery
    ? (payloadDesktop ?? payloadMobile)
    : (banner?.imageUrl ?? null);
  const mobile = payloadOwnsImagery
    ? (payloadMobile ?? payloadDesktop)
    : (banner?.mobileImageUrl ?? desktop);

  /**
   * Motion, and the still it plays over.
   *
   * Absent a `video_url` nothing below this line does anything, which is the
   * property that matters: every homepage that existed before this feature
   * renders the identical markup it rendered before, down to the byte.
   *
   * The poster replaces **both** crops rather than joining them as a third.
   * Art direction answers "what is the best framing of this subject for this
   * screen", and a poster is not answering that question — it is answering "what
   * is the video's first frame", and there is only one of those. Two crops of it
   * would guarantee that at least one breakpoint visibly jumps the moment
   * playback starts. When no poster is given the art-directed pair stands in,
   * which is the honest second-best: a hero that changes when the video begins,
   * rather than a hero that is empty until it does.
   */
  /*
    Which of the two the owner has chosen, from /admin/appearance.

    `poster` resolves `video` to null, and that single line is the whole
    feature: nothing downstream is conditional, `<HeroVideo>` is never
    constructed, no `<video>` element exists, and no byte of the file is
    requested. It is the identical path a customer already gets under
    `prefers-reduced-motion` or `Save-Data` — the one `audit:hero-media`
    asserts creates no element and fetches nothing — so the owner's switch
    inherits that proof rather than needing a parallel one.

    Hiding a playing video with CSS would have been the other way to write
    this, and it would have downloaded 2.5MB to show nobody.

    Absent means `video`: heroes written before this field must keep playing.
  */
  const posterOnly =
    payloadString(section.payload, "media_mode") === "poster";
  const video = posterOnly
    ? null
    : payloadString(section.payload, "video_url");
  const poster = payloadString(section.payload, "poster_url");
  const desktopStill = poster ?? desktop;
  const mobileStill = poster ?? mobile;

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
  const desktopProps = desktopStill
    ? imageSourceProps(common, desktopStill, { width: 1920, height: 1000 })
    : null;
  const mobileProps = mobileStill
    ? imageSourceProps(common, mobileStill, { width: 900, height: 720 })
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
      {/*
        The 1600px cap is the quality ceiling expressed as a width.

        `object-cover` on a band far wider than 16:9 always scales by width, so
        above 1280px of viewport the source is being stretched, and at 2560 it
        was stretched 2.00x with 39% of the frame left on screen. Making the
        hero taller cannot help — it changes how much of the frame is visible
        and not the scale. Only the rendered width or a bigger file can, and a
        bigger file costs every phone on the site 5MB to fix a wide-monitor
        problem (the measurements are in phase-10-c4-live.md §5).

        So: 1600px, which is 1.25x on a 1280-wide source — exactly the ceiling
        `audit:hero-media` enforces, and therefore the widest band the quality
        rule allows. Below 1600px of viewport it does nothing at all, which is
        every phone and every laptop; above it, the section's own ink shows at
        either side and the hero is framed rather than full-bleed.

        Scoped to `md` only for legibility. The mobile band is `w-full` under a
        768px breakpoint, so a 1600px cap could never bind there anyway.
      */}
      <div className="relative aspect-5/4 w-full sm:aspect-video md:absolute md:inset-0 md:mx-auto md:aspect-auto md:h-full md:max-w-[1600px]">
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

        {/*
          Between the still and the scrim, deliberately.

          Under the scrim because a headline over *moving* footage is harder to
          read than the same headline over a photograph, and the gradient that
          makes one legible is the gradient that makes the other legible. Over
          the still because that is the whole trick: the image below never goes
          away, so a video that cannot play is not a failure state anybody has
          to handle.

          It renders nothing at all on the server and nothing on the client
          until the page has loaded and gone idle. See hero-video.tsx.
        */}
        {video ? <HeroVideo src={video} /> : null}

        {/*
          Mobile: a short fade into the copy below, so the seam is not a line.
          Desktop: the contrast floor under the copy, and nothing more than that.

          ## Every position is stated, because one of them used not to be

          The desktop gradient used to inherit the mobile `to-40%` while adding
          `md:via-55%`, which computed to `ink 0%, ink/70 55%, transparent 40%`
          — a stop *behind* its predecessor. CSS clamps such a stop up to the
          one before it, so transparency began at 55% too, the fade had zero
          width, and the browser drew a hard vertical line down the hero at
          every viewport from `md` up. It had been there since the hero was
          written; flat placeholder art hid it and footage did not.

          `md:to-100%` is the fix. It is also why all three desktop positions
          are now written out even though 0% and 100% are the defaults: the
          defect was an *unstated* position inheriting the wrong value, and a
          position nobody wrote is a position nobody can see is wrong.

          ## Why the shade is much lighter, and where the floor actually is

          The owner asked for the dark blue wash to go. It cannot go entirely:
          the video is owner-editable from /admin/appearance, so legibility
          would otherwise depend on whichever clip is uploaded next, and no
          gate can assert the contrast of footage that does not exist yet.

          So it is a floor rather than a wash — ink/55 to ink/45, against ink
          and ink/70 before, which is roughly 45% of the ink gone.

          The numbers are measured rather than modelled. The clip was scanned
          frame by frame for the one where the headline's own box is brightest
          (t=2.292s, a white shoe crossing the copy); the page was screenshotted
          twice at that frame with the scrim removed, once with the copy shown
          and once hidden; the pixels that differ are the glyphs, and the
          candidate gradients were composited over the *hidden* shot inside that
          mask. Bounding boxes were not used — a box is mostly not text, and one
          bright patch in its empty right-hand side reads as a failure no letter
          is anywhere near. Under the glyphs, at 1440 and 2560:

            headline  #fbfcfd  7.2-7.7:1 mean, 5.0:1 p95   (needs 3:1)
            paragraph #fbfcfd  7.4-7.6:1 mean, 5.8:1 p95   (needs 4.5:1)
            eyebrow   #fe9301  8.0-8.1:1 mean, 8.0:1 p95   (needs 4.5:1)

          The paragraph is that colour *because* of this scrim; see the note on
          it below. At the muted #a8b4c6 it was the one run that failed, at
          3.6:1, and it was the constraint that decided how light this could go.

          ## The via sits at 70%, not at 55%

          55% is where the copy ends at `lg` and wider, so the old gradient was
          fully transparent across the last fifth of the copy column at `md`
          itself, where it runs to ~70% of the band. That never showed as a
          contrast failure on this clip — the frame is dark out there — but it
          meant the scrim's coverage depended on the footage rather than on the
          layout. Turning at 70% and terminating at 100% covers the copy at
          every breakpoint instead of only the widest ones.
        */}
        <div
          className="from-ink absolute inset-0 bg-gradient-to-t to-transparent to-40% md:from-ink/55 md:via-ink/45 md:bg-gradient-to-r md:from-0% md:via-70% md:to-transparent md:to-100%"
          aria-hidden
        />

        {/*
          The band's own edges, dissolved into the ink beside them. Paints
          nothing at all until the 1600px cap actually leaves a margin — see
          `.hero-band-edge` in globals.css, where the arithmetic lives.

          After the scrim in the DOM so it covers it: at the left edge the
          result is pure ink either way, which is the darkest the copy's
          background can be, so this can only help the contrast floor.

          Before the pause control in paint order, though, and that is not an
          accident of source order — the button carries `z-10` and this does
          not, so a control never fades out. Source order alone would not have
          done it: the button is rendered inside HeroVideo, which sits *above*
          both of these.
        */}
        <div className="hero-band-edge pointer-events-none absolute inset-0" aria-hidden />
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
            /*
              `text-paper`, not `text-muted-foreground`, and this is the change
              that let the scrim get lighter.

              `--muted-foreground` on an ink surface is #a8b4c6. That is a token
              for secondary text on a *flat navy panel*, where it measures well
              against one known colour. This paragraph is not on a panel — it is
              on footage, and on the frame where a white shoe crosses the copy it
              measured 3.6:1 under a scrim light enough to be worth having. The
              scrim heavy enough to rescue #a8b4c6 is the wash that was being
              removed, so the choice was the colour or the wash.

              At #fbfcfd the same pixels measure 7.4:1 mean and 5.8:1 at the 95th
              percentile, against a 4.5:1 floor — and it is the only variant that
              survives a brighter clip than this one, which matters because the
              video is owner-editable.

              The hierarchy it gives up is tonal. Size and weight keep it: 16px
              regular under a 36-60px extrabold display line.
            */
            <p className="text-paper mt-5 max-w-md text-base text-pretty">
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
              className="bg-photo group relative flex aspect-4/3 flex-col justify-end overflow-hidden rounded-lg"
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
