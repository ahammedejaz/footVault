import type { Metadata } from "next";

import { AppearanceEditor } from "@/components/admin/appearance/appearance-editor";
import { AdminPage, PageHeader } from "@/components/admin/ui";
import { HomeSection } from "@/components/storefront/home-sections";
import { contentTokens } from "@/lib/content-tokens";
import { slotFor, type SiteImageValue } from "@/lib/images/site-image";
import { getSiteImages } from "@/lib/queries/admin/site-images";
import { getBanner } from "@/lib/queries/content";
import type { SectionType } from "@/lib/queries/content";
import {
  listAllSections,
  listPickerOptions,
} from "@/lib/queries/admin/appearance";

export const metadata: Metadata = { title: "Appearance" };
export const dynamic = "force-dynamic";

/**
 * The homepage editor — promised in the very first brief ("admin can edit his
 * entire customer site from the admin panel") and deferred in every phase
 * since. The data model has been ready the whole time: the homepage renders
 * whatever `homepage_sections` says, in its order, so this page is only an
 * interface over rows that already drive the shop.
 *
 * Everything interesting lives in the client editor; this page's job is to
 * load the working material — every section including the hidden ones, and the
 * category/collection vocabulary the pickers offer — through the caller's own
 * RLS-checked client.
 */
export default async function AdminAppearancePage() {
  const [sections, pickers, tokens, heroBanner] = await Promise.all([
    listAllSections(),
    listPickerOptions(),
    contentTokens(),
    /*
      The hero's old still, so the image field can show what the shop is
      actually rendering rather than an empty box next to a homepage that
      visibly has art on it. `home-sections.tsx` reads the payload first and
      falls back to this row; the editor now says so out loud.
    */
    getBanner("home_hero"),
  ]);

  /*
    Every picture in this layout, in one query. Four slots per hero and one per
    banner, and only sections that have been published have slots at all — a
    row the owner has just added has no id to file a picture under.
  */
  const siteImages = Object.fromEntries(
    (
      await getSiteImages(
        sections.flatMap((section) =>
          section.sectionType === "hero"
            ? (["desktop", "mobile", "poster"] as const).map((part) =>
                slotFor.section(section.id, part),
              )
            : section.sectionType === "banner"
              ? [slotFor.section(section.id, "background")]
              : [],
        ),
      )
    ).entries(),
  ) as Record<string, SiteImageValue>;

  return (
    <AdminPage>
      <div className="-mx-4 -mt-5 mb-6 sm:-mx-6">
        <PageHeader
          title="Appearance"
          description="What the homepage shows, in the order it shows it. Changes go live when you publish, and not before."
        />
      </div>
      <AppearanceEditor
        initial={sections}
        categories={pickers.categories}
        collections={pickers.collections}
        siteImages={siteImages}
        heroFallback={{
          desktop: heroBanner?.imageUrl ?? null,
          mobile: heroBanner?.mobileImageUrl ?? heroBanner?.imageUrl ?? null,
        }}
      />

      {/*
        The homepage as customers see it right now, rendered by the storefront's
        own components — the editor above shows rows; this shows the page.

        It also carries a structural duty that must survive any redesign: the
        editor's Preview returns `<HomeSection>` elements across the Server
        Action boundary, and a production build resolves the client components
        in that tree (the rail, the product image, the save-for-later heart)
        against THIS ROUTE's client manifest. The bundler builds that manifest
        from the route's import graph — it cannot trace what an action returns.
        Rendering the live sections here is what puts those modules in the
        graph, through a real render path that cannot be tree-shaken. Measured
        both ways on a production build: without this render the Preview button
        throws "Could not find the module …rail.tsx#Rail in the React Client
        Manifest"; with it, the preview renders. A pure re-export "manifest"
        module was tried first and was shaken out by Turbopack.
      */}
      <section aria-label="The live homepage, as published" className="mt-10">
        <h2 className="font-display text-lg font-bold tracking-[-0.02em] uppercase">
          Live now
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          What the shop is showing at this moment — the last published layout.
        </p>
        {/*
          `inert`: this is a picture of the homepage, not the homepage. The
          sections render real storefront components, so without it every
          wishlist heart and product link inside is a live, focusable control
          — 18 of them clipped by this very container's overflow-hidden on a
          phone (found by the 2026-08-20 sweep), and all of them tab stops
          between the owner and the editor above. A preview is for looking at;
          the storefront is one tab away for operating.
        */}
        <div inert className="border-border mt-3 overflow-hidden rounded-lg border">
          {sections
            .filter((section) => section.isActive)
            .map((section) => (
              <HomeSection
                key={section.id}
                section={{
                  id: section.id,
                  sectionType: section.sectionType as SectionType,
                  title: section.title,
                  subtitle: section.subtitle,
                  payload: section.payload,
                }}
                tokens={tokens}
              />
            ))}
        </div>
      </section>
    </AdminPage>
  );
}
