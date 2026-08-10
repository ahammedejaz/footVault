import "server-only";

import { rows } from "@/lib/queries/run";
import { createClient } from "@/lib/supabase/server";

/**
 * What the appearance editor needs on load: every homepage row — hidden ones
 * included, which is the difference from `getHomepageSections` — and the
 * vocabulary the pickers offer.
 *
 * Through the caller's own client, so the `admins manage site content` RLS
 * policy is what actually answers, the same discipline as every admin list
 * query. Hidden sections matter here for the same reason hidden products do on
 * `/admin/products`: "hide" is only a usable control if the hidden thing stays
 * visible to the person who hid it.
 */

export type AdminSectionRow = {
  id: string;
  sectionType: string;
  title: string | null;
  subtitle: string | null;
  payload: Record<string, unknown>;
  sortOrder: number;
  isActive: boolean;
};

export async function listAllSections(): Promise<AdminSectionRow[]> {
  const supabase = await createClient();
  const data = await rows<{
    id: string;
    section_type: string;
    title: string | null;
    subtitle: string | null;
    payload: unknown;
    sort_order: number;
    is_active: boolean;
  }>(
    "listAllSections",
    supabase
      .from("homepage_sections")
      .select("id, section_type, title, subtitle, payload, sort_order, is_active")
      .order("sort_order"),
  );
  return data.map((row) => ({
    id: row.id,
    sectionType: row.section_type,
    title: row.title,
    subtitle: row.subtitle,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    sortOrder: row.sort_order,
    isActive: row.is_active,
  }));
}

/** The slugs the category-grid and product-rail pickers may choose from. */
export type PickerOption = { slug: string; name: string };

export async function listPickerOptions(): Promise<{
  categories: PickerOption[];
  collections: PickerOption[];
}> {
  const supabase = await createClient();
  const [categories, collections] = await Promise.all([
    rows<PickerOption>(
      "appearance categories",
      supabase
        .from("categories")
        .select("slug, name")
        .eq("is_active", true)
        .order("name"),
    ),
    rows<PickerOption>(
      "appearance collections",
      supabase
        .from("collections")
        .select("slug, name")
        .eq("is_active", true)
        .order("name"),
    ),
  ]);
  return { categories, collections };
}
