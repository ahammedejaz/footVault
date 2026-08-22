"use server";

import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";

import { adminAction, type AdminResult } from "@/lib/admin/guard";
import { CHROME_CACHE_TAG } from "@/lib/queries/cached";

/**
 * Writing the shop's own pages.
 *
 * ## The one rule that is not obvious
 *
 * **The slug of an existing page is not editable here.** The pages are linked
 * from the footer of every page of the shop, from the checkout's terms
 * acceptance, from Google, and from whatever a customer has bookmarked.
 * Changing `returns` to `returns-policy` does not redirect the old address — it
 * 404s it, silently, from the moment Publish is pressed, and the person who
 * finds out is a customer looking for the returns policy after a parcel arrived
 * damaged.
 *
 * A new page gets to choose its address, once. After that the field is read-only
 * and says why. The category form makes the same decision for the same reason
 * and words it the same way, so an owner learns the rule once.
 *
 * ## Deleting is allowed, and it is guarded by name
 *
 * Not because deleting a page is dangerous in the database — it is one row —
 * but because the seven that exist are the ones the footer links and two of
 * them are the terms a customer agreed to. `confirmSlug` means the destructive
 * action cannot be reached by a mis-tap on a phone, which is where this panel
 * is used.
 */

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TITLE_MAX = 120;
const META_TITLE_MAX = 120;
const META_DESCRIPTION_MAX = 300;
const BODY_MAX = 30_000;

const slugField = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "A page needs a web address.")
  .max(80, "Keep the web address under 80 characters.")
  .regex(
    SLUG_PATTERN,
    "Lower-case letters, numbers and hyphens only — this becomes /page/…",
  );

/** Empty becomes null, so a cleared field is absent rather than an empty string. */
const optional = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, label)
    .nullish()
    .transform((value) => (value ? value : null));

const pageFields = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Give the page a title.")
    .max(TITLE_MAX, `Keep the title under ${TITLE_MAX} characters.`),
  /**
   * The words, in the tiny format `prose.tsx` understands: blank lines separate
   * blocks, a block of `- ` lines is a list, `**bold**` is bold.
   *
   * 30,000 characters is generous for a policy page and finite on purpose —
   * this is a `text` column with no ceiling of its own, and a paste accident
   * should be refused with a sentence rather than stored.
   */
  body: optional(BODY_MAX, `Keep the page under ${BODY_MAX} characters.`),
  metaTitle: optional(
    META_TITLE_MAX,
    `Keep the search title under ${META_TITLE_MAX} characters.`,
  ),
  metaDescription: optional(
    META_DESCRIPTION_MAX,
    `Keep the search description under ${META_DESCRIPTION_MAX} characters.`,
  ),
  isPublished: z.boolean(),
});

const createSchema = pageFields.extend({ slug: slugField });
const updateSchema = pageFields.extend({ id: z.uuid("That is not a page.") });

export async function createPage(
  input: unknown,
): Promise<AdminResult<{ id: string }>> {
  return adminAction<{ id: string }>(
    "createPage",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = createSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);
      const v = parsed.data;

      const { data, error } = await supabase
        .from("pages")
        .insert({
          slug: v.slug,
          title: v.title,
          body: v.body,
          meta_title: v.metaTitle,
          meta_description: v.metaDescription,
          is_published: v.isPublished,
        })
        .select("id")
        .single();

      if (error) return writeFailure(error, v.slug);
      revalidate(v.slug);
      return { ok: true, id: data.id };
    },
  );
}

export async function updatePage(
  input: unknown,
): Promise<AdminResult<{ id: string }>> {
  return adminAction<{ id: string }>(
    "updatePage",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = updateSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);
      const v = parsed.data;

      /*
        The slug is read back rather than accepted, both because it is not
        editable and because the revalidation below needs it. Doing it in one
        round trip with `.select()` on the update means it cannot be the slug of
        some *other* row by the time the cache is expired.
      */
      const { data, error } = await supabase
        .from("pages")
        .update({
          title: v.title,
          body: v.body,
          meta_title: v.metaTitle,
          meta_description: v.metaDescription,
          is_published: v.isPublished,
        })
        .eq("id", v.id)
        .select("slug")
        .maybeSingle();

      if (error) return writeFailure(error, null);
      if (!data) {
        return {
          ok: false,
          reason: "conflict",
          message: "That page no longer exists. Reload and try again.",
        };
      }

      revalidate(data.slug);
      return { ok: true, id: v.id };
    },
  );
}

const deleteSchema = z.object({
  id: z.uuid("That is not a page."),
  /** Typed by the owner, checked against the row. See the module header. */
  confirmSlug: z.string().trim().toLowerCase().min(1),
});

export async function deletePage(
  input: unknown,
): Promise<AdminResult<object>> {
  return adminAction<object>("deletePage", "adminMutation", async ({ supabase }) => {
    const parsed = deleteSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);

    const { data: row, error: readError } = await supabase
      .from("pages")
      .select("slug")
      .eq("id", parsed.data.id)
      .maybeSingle();

    if (readError) {
      console.error("[admin] deletePage read failed:", readError.message);
      return { ok: false, reason: "error", message: "That page could not be read." };
    }
    if (!row) {
      return {
        ok: false,
        reason: "conflict",
        message: "That page has already gone.",
      };
    }
    if (row.slug !== parsed.data.confirmSlug) {
      return {
        ok: false,
        reason: "invalid",
        field: "confirmSlug",
        message: `Type ${row.slug} exactly to delete this page.`,
      };
    }

    const { error } = await supabase.from("pages").delete().eq("id", parsed.data.id);
    if (error) {
      console.error("[admin] deletePage failed:", error.message);
      return { ok: false, reason: "error", message: "That page could not be deleted." };
    }

    revalidate(row.slug);
    return { ok: true };
  });
}

/**
 * Expire everything that could be showing this page.
 *
 * Three things, and each one has bitten this codebase before:
 *
 *   - `CHROME_CACHE_TAG` — the footer's Help column is built from the list of
 *     published pages, so publishing one has to change the footer of every page
 *     on the site, not just the page itself.
 *   - the page's own path, because `/page/[slug]` is statically rendered.
 *   - the sitemap, which enumerates published pages.
 *
 * `updateTag` rather than `revalidateTag`: called inside a Server Action it
 * gives read-your-own-writes, so the owner sees the change on the very next
 * render instead of after the one-hour window lapses. Getting that wrong is
 * invisible in development and reads as "my edit did nothing" in production.
 */
function revalidate(slug: string): void {
  updateTag(CHROME_CACHE_TAG);
  revalidatePath(`/page/${slug}`);
  revalidatePath("/sitemap.xml");
}

function writeFailure(
  error: { code?: string; message: string },
  slug: string | null,
): AdminResult<never> {
  if (error.code === "23505") {
    return {
      ok: false,
      reason: "conflict",
      message: slug
        ? `There is already a page at /page/${slug}.`
        : "There is already a page at that address.",
    };
  }
  console.error("[admin] page write failed:", error.message);
  return {
    ok: false,
    reason: "error",
    message: "That did not save. Nothing has been changed — please try again.",
  };
}

function invalid(error: z.ZodError): AdminResult<never> {
  const first = error.issues[0];
  return {
    ok: false,
    reason: "invalid",
    message: first?.message ?? "That is not a valid change.",
    field: typeof first?.path[0] === "string" ? first.path[0] : undefined,
  };
}
