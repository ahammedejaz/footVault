import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Breadcrumbs } from "@/components/storefront/breadcrumbs";
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
  return {
    title: page.metaTitle ?? page.title,
    description: page.metaDescription ?? undefined,
    alternates: { canonical: `/page/${page.slug}` },
  };
}

/**
 * CMS pages — About, Contact, the policies.
 *
 * The body is stored as plain text with blank lines between paragraphs, so it
 * is rendered as paragraphs rather than through `dangerouslySetInnerHTML`.
 * When the rich-text editor lands in Phase 7 this becomes a sanitised render;
 * until then there is no HTML path from the database into the page at all.
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
  const paragraphs = fillTokens(page.body ?? "", await contentTokens())
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

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
      <div className="mt-8 space-y-5">
        {paragraphs.map((paragraph, index) => (
          <p key={index} className="text-base text-pretty">
            {paragraph}
          </p>
        ))}
      </div>
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
