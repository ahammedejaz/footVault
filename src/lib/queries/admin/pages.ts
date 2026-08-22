import "server-only";

import { rows } from "@/lib/queries/run";
import { createClient } from "@/lib/supabase/server";

/**
 * The shop's own pages, as the owner needs to see them.
 *
 * ## Why this file did not exist until now
 *
 * The `pages` table has been in the schema since the first migration, the
 * storefront has rendered from it since Phase 3, the footer builds its Help
 * column out of it, and `/admin/settings` carries a paragraph explaining that
 * "a half-built editor for them would be worse than a link" — so it linked to
 * the pages instead.
 *
 * The result was seven pages of policy the shop owner could read and not
 * change: About, Contact, Shipping, Returns, Size guide, Privacy, Terms. Two of
 * them are the legal terms customers agree to at checkout. One of them
 * (`/page/returns`) shipped a meta description promising a seven-day free
 * return against a body saying replacement only within 24 hours, and that
 * survived a launch audit — because nobody could fix it without a developer,
 * so nobody looked.
 *
 * ## Unpublished pages are included here and nowhere else
 *
 * `getPage` in `queries/content.ts` filters on `is_published` because a draft
 * is not a page. This reads through the caller's own RLS-checked client, where
 * the `admins manage pages` policy applies, so the panel can see a draft and an
 * anonymous request still cannot.
 */

export type AdminPageRow = {
  id: string;
  slug: string;
  title: string;
  body: string;
  metaTitle: string;
  metaDescription: string;
  isPublished: boolean;
  updatedAt: string;
};

export async function listAdminPages(): Promise<AdminPageRow[]> {
  const supabase = await createClient();
  const data = await rows<{
    id: string;
    slug: string;
    title: string;
    body: string | null;
    meta_title: string | null;
    meta_description: string | null;
    is_published: boolean;
    updated_at: string;
  }>(
    "listAdminPages",
    supabase
      .from("pages")
      .select(
        "id, slug, title, body, meta_title, meta_description, is_published, updated_at",
      )
      /*
        Drafts first, then alphabetical. An unpublished page is either
        half-written or forgotten, and both are things the owner wants at the
        top rather than buried between Privacy and Returns.
      */
      .order("is_published", { ascending: true })
      .order("title"),
  );

  return data.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    // Empty string rather than null throughout: these feed controlled inputs,
    // and a controlled input handed null switches to uncontrolled and warns.
    body: row.body ?? "",
    metaTitle: row.meta_title ?? "",
    metaDescription: row.meta_description ?? "",
    isPublished: row.is_published,
    updatedAt: row.updated_at,
  }));
}
