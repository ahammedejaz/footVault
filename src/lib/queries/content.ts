import "server-only";

import { createStaticClient } from "@/lib/supabase/static";
import { maybeRow, rows } from "@/lib/queries/run";
import type { Database } from "@/lib/database.types";

type SectionType = Database["public"]["Enums"]["section_type"];

/** Public content, like the catalog, reads through the cookieless client. */
const db = () => createStaticClient();

export type HomepageSection = {
  id: string;
  sectionType: SectionType;
  title: string | null;
  subtitle: string | null;
  payload: Record<string, unknown>;
};

/**
 * The homepage, as rows.
 *
 * Order comes entirely from the table, so /admin/appearance reordering sections
 * in Phase 7 changes the live page with no deploy. Nothing about the order is
 * encoded in the React tree.
 */
export async function getHomepageSections(): Promise<HomepageSection[]> {
  const data = await rows<{
    id: string;
    section_type: SectionType;
    title: string | null;
    subtitle: string | null;
    payload: unknown;
  }>(
    "getHomepageSections",
    db()
      .from("homepage_sections")
      .select("id, section_type, title, subtitle, payload")
      .eq("is_active", true)
      .order("sort_order"),
  );

  return data.map((row) => ({
    id: row.id,
    sectionType: row.section_type,
    title: row.title,
    subtitle: row.subtitle,
    payload: (row.payload ?? {}) as Record<string, unknown>,
  }));
}

export type Banner = {
  imageUrl: string | null;
  mobileImageUrl: string | null;
  headline: string | null;
  subtext: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
};

/**
 * The banner for a placement, if one is live right now.
 *
 * The window is checked here rather than left to the caller: a banner with an
 * `ends_at` in the past is not a banner, and a homepage that keeps showing last
 * month's sale is the kind of thing an owner notices before we do.
 */
export async function getBanner(placement: string): Promise<Banner | null> {
  const now = new Date().toISOString();
  const row = await maybeRow<{
    image_url: string | null;
    mobile_image_url: string | null;
    headline: string | null;
    subtext: string | null;
    cta_label: string | null;
    cta_href: string | null;
  }>(
    `getBanner(${placement})`,
    db()
      .from("banners")
      .select(
        "image_url, mobile_image_url, headline, subtext, cta_label, cta_href",
      )
      .eq("placement", placement)
      .eq("is_active", true)
      .or(`starts_at.is.null,starts_at.lte.${now}`)
      .or(`ends_at.is.null,ends_at.gte.${now}`)
      .order("sort_order")
      .limit(1)
      .maybeSingle(),
  );

  if (!row) return null;
  return {
    imageUrl: row.image_url,
    mobileImageUrl: row.mobile_image_url,
    headline: row.headline,
    subtext: row.subtext,
    ctaLabel: row.cta_label,
    ctaHref: row.cta_href,
  };
}

export type CmsPage = {
  slug: string;
  title: string;
  body: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  updatedAt: string;
};

export async function getPage(slug: string): Promise<CmsPage | null> {
  // A query error must not be mistaken for a missing page: one is a bug worth
  // seeing, the other is a legitimate 404. maybeRow() keeps them apart.
  const data = await maybeRow<{
    slug: string;
    title: string;
    body: string | null;
    meta_title: string | null;
    meta_description: string | null;
    updated_at: string;
  }>(
    `getPage(${slug})`,
    db()
      .from("pages")
      .select("slug, title, body, meta_title, meta_description, updated_at")
      .eq("slug", slug)
      .eq("is_published", true)
      .maybeSingle(),
  );

  if (!data) return null;
  return {
    slug: data.slug,
    title: data.title,
    body: data.body,
    metaTitle: data.meta_title,
    metaDescription: data.meta_description,
    updatedAt: data.updated_at,
  };
}

export type PageLink = { slug: string; title: string };

export async function listPages(): Promise<PageLink[]> {
  return rows<PageLink>(
    "listPages",
    db()
      .from("pages")
      .select("slug, title")
      .eq("is_published", true)
      .order("title"),
  );
}

export async function listPageSlugs(): Promise<string[]> {
  return (await listPages()).map((page) => page.slug);
}

/**
 * Store settings, keyed.
 *
 * Every consumer states the shape it expects and a fallback, because a setting
 * the owner has not filled in yet must render as the default rather than as
 * `undefined` in the middle of the footer.
 */
export type SiteSettings = Record<string, unknown>;

export async function getSiteSettings(): Promise<SiteSettings> {
  const data = await rows<{ key: string; value: unknown }>(
    "getSiteSettings",
    db().from("site_settings").select("key, value").eq("is_public", true),
  );
  return Object.fromEntries(data.map((row) => [row.key, row.value]));
}

export function setting<T>(
  settings: SiteSettings,
  key: string,
  fallback: T,
): T {
  const value = settings[key];
  return value === undefined || value === null ? fallback : (value as T);
}

export type ContactSettings = {
  email: string;
  phone: string;
  whatsapp: string;
  address: string;
};

export type SocialSettings = Record<string, string>;

export type ShippingSettings = {
  /**
   * The prepaid free-delivery threshold. There is deliberately no flat fee
   * alongside it — rates come from Shiprocket, per destination. See
   * `src/lib/shipping/settings.ts` for the full, server-side shape.
   */
  free_above_paise: number;
  currency: string;
  regions: string[];
};

export type AnnouncementSettings = {
  text: string;
  href: string | null;
  is_active: boolean;
};
