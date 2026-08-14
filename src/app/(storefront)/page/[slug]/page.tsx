import type * as React from "react";

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Breadcrumbs } from "@/components/storefront/breadcrumbs";
import { ContactDetails } from "@/components/storefront/contact-details";
import { ProseBlocks } from "@/components/storefront/prose";
import { ShopMap } from "@/components/storefront/shop-map";
import { contentTokens, fillTokens } from "@/lib/content-tokens";
import { cachedPage } from "@/lib/queries/cached";
import { listPageSlugs } from "@/lib/queries/content";
import { staticParamsOr } from "@/lib/static-params";

export const revalidate = 3600;

export async function generateStaticParams() {
  return staticParamsOr("pages", async () =>
    (await listPageSlugs()).map((slug) => ({ slug })),
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = await cachedPage(slug);
  if (!page) return {};

  /**
   * Tokens are filled here too, and the omission was load-bearing.
   *
   * `/page/returns` served `<meta name="description" content="Foot Vault's 7 day
   * free return and size exchange policy.">` while the body of the same page
   * said replacement only, no refunds, no size exchange, within 24 hours — the
   * single worst sentence on the shop, and it was in a snippet Google shows
   * before anybody reads the page.
   *
   * `audit:literals` now forbids a typed day count in `meta_description`, which
   * leaves a token as the only way to state a policy figure there. So the
   * metadata path has to fill them, or the fix for one defect would have
   * printed `{{return_window}}` into a search result.
   */
  const tokens = await contentTokens();
  const description = page.metaDescription
    ? fillTokens(page.metaDescription, tokens)
    : undefined;

  return {
    title: fillTokens(page.metaTitle ?? page.title, tokens),
    description,
    alternates: { canonical: `/page/${page.slug}` },
  };
}

/**
 * CMS pages — About, Contact, the policies.
 *
 * The body is stored as plain text with blank lines between paragraphs. The
 * owner writes `**emphasis**` and `- ` bullet lines in it — the returns policy
 * has since day one — and both used to render literally: a customer-facing
 * policy page showing raw asterisks.
 *
 * `Block` and `emphasise` used to live here. They moved to
 * `components/storefront/prose.tsx` when the `rich_text` homepage section needed
 * the same two conventions, because the alternative was a second copy of them
 * drifting from this one. This page's behaviour is unchanged.
 */
export default async function CmsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const page = await cachedPage(slug);
  if (!page) notFound();

  /**
   * Policy numbers are substituted here rather than typed into the body.
   *
   * `/page/shipping` used to say "free on orders of ₹2,499 or more" while
   * `site_settings.shipping.free_above_paise` said ₹6,499 — a promise on the
   * storefront the till does not keep, and the customer is the one who is
   * right. The owner writes the sentence; the number comes from the setting
   * they change in `/admin/settings`. See `src/lib/content-tokens.ts`.
   */
  const tokens = await contentTokens();
  const body = fillTokens(page.body ?? "", tokens);

  return (
    <article className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:py-12">
      <Breadcrumbs
        className="mb-8"
        crumbs={[{ label: "Home", href: "/" }, { label: page.title }]}
      />
      <h1 className="font-display text-4xl font-extrabold tracking-[-0.03em] text-balance uppercase">
        {page.title}
      </h1>
      <div className="tread-rule mt-6 w-24" aria-hidden />
      <ProseBlocks text={body} className="mt-8 space-y-5" />

      {/*
        The contact page gets the real, clickable details underneath its prose.

        A slug check in a generic CMS route is the kind of thing that rots, and
        it is still the right shape here: `prose.tsx` builds React elements out
        of split strings and deliberately has no link syntax, so a `wa.me` href
        cannot come out of a page body — and this is the one page where the
        details have to be operable rather than merely written down. It is also
        the page `LocalBusiness` and the local pack are judged against.

        The values come from the tokens already read above rather than from a
        second settings query, so the block and the prose around it cannot
        disagree about the shop's own phone number.
      */}
      {page.slug === "contact" ? (
        <div className="mt-10 border-t pt-8">
          <h2 className="font-mono text-xs tracking-[0.06em] uppercase">
            How to reach us
          </h2>
          <div className="mt-4">
            <ContactDetails
              variant="page"
              hours={tokens.business_hours ?? null}
              contact={{
                phone: tokens.contact_phone ?? "",
                whatsapp: tokens.contact_whatsapp ?? "",
                email: tokens.contact_email ?? "",
                address: tokens.contact_address ?? "",
              }}
            />
          </div>

          {/*
            The map sits under the details rather than above them, because a
            customer who has come this far wants the number first and the route
            second — and because it is the one element on the page that reaches
            a third party. See shop-map.tsx for what that costs and where it is
            disclosed.
          */}
          <div className="mt-6">
            <ShopMap />
          </div>
        </div>
      ) : null}

      <p className="text-muted-foreground mt-12 font-mono text-xs tracking-[0.06em]">
        Last updated{" "}
        {new Date(page.updatedAt).toLocaleDateString("en-IN", {
          day: "numeric",
          month: "long",
          year: "numeric",
        })}
      </p>
    </article>
  );
}
