import "server-only";

import { createClient } from "@/lib/supabase/server";
import { createStaticClient } from "@/lib/supabase/static";
import type { Database } from "@/lib/database.types";

type SectionType = Database["public"]["Enums"]["section_type"];

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
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("homepage_sections")
    .select("id, section_type, title, subtitle, payload")
    .eq("is_active", true)
    .order("sort_order");

  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    sectionType: row.section_type,
    title: row.title,
    subtitle: row.subtitle,
    payload: (row.payload ?? {}) as Record<string, unknown>,
  }));
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
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("pages")
    .select("slug, title, body, meta_title, meta_description, updated_at")
    .eq("slug", slug)
    .eq("is_published", true)
    .maybeSingle();

  // A query error must not be mistaken for a missing page: one is a bug worth
  // seeing, the other is a legitimate 404.
  if (error) throw new Error(`getPage(${slug}): ${error.message}`);
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

export async function listPageSlugs(): Promise<string[]> {
  const supabase = createStaticClient();
  const { data } = await supabase.from("pages").select("slug").eq("is_published", true);
  return (data ?? []).map((row) => row.slug);
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
  const supabase = await createClient();
  const { data } = await supabase.from("site_settings").select("key, value").eq("is_public", true);
  return Object.fromEntries((data ?? []).map((row) => [row.key, row.value]));
}

export function setting<T>(settings: SiteSettings, key: string, fallback: T): T {
  const value = settings[key];
  return value === undefined || value === null ? fallback : (value as T);
}

export type ContactSettings = {
  email: string;
  phone: string;
  whatsapp: string;
  address: string;
};

export type ShippingSettings = {
  flat_fee_paise: number;
  free_above_paise: number;
  currency: string;
  regions: string[];
};

export type AnnouncementSettings = {
  text: string;
  href: string | null;
  is_active: boolean;
};
