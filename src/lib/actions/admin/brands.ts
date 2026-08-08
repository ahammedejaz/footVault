"use server";

import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";

import { adminAction, type AdminResult } from "@/lib/admin/guard";
import { CATALOG_CACHE_TAG, CHROME_CACHE_TAG } from "@/lib/queries/cached";

/**
 * The makers the shop stocks.
 *
 * Simpler than categories — brands are a flat list — but the same two rules
 * apply and for the same reasons.
 *
 * **Deleting never un-brands a product.** `products.brand_id` is
 * `on delete set null`, so removing a brand that is in use silently strips the
 * maker off every product carrying it, including the soft-deleted ones that
 * would come back unbranded if they were ever restored. Unlike a category,
 * there is no sensible place to move them to — a Nike shoe is not an Adidas
 * shoe — so this refuses, and points at the thing the owner almost always
 * meant: switching the brand off, which hides it from the shop's filters and
 * leaves every product intact.
 *
 * **A write busts `chrome` as well as `catalog`.** `cachedPopularBrands` feeds
 * the search overlay from the layout, on an hour's revalidate. See
 * `src/lib/actions/admin/categories.ts` for the full note, including why this
 * is `updateTag` and not `revalidateTag`.
 */

const NAME_MAX = 60;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const logoField = z
  .string()
  .trim()
  .max(500, "That address is too long.")
  .nullish()
  .transform((value) => (value ? value : null))
  .refine(
    (value) =>
      value === null || value.startsWith("/") || value.startsWith("https://"),
    "Give a full https:// address, or a path beginning with / for a file in this site.",
  );

const brandSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give it a name.")
    .max(NAME_MAX, `Keep the name under ${NAME_MAX} characters.`),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "A brand needs a web address.")
    .max(NAME_MAX, `Keep the web address under ${NAME_MAX} characters.`)
    .regex(
      SLUG_PATTERN,
      "Lower-case letters, numbers and hyphens only — this is what /shop?brand= uses.",
    ),
  logoUrl: logoField,
  isActive: z.boolean(),
});

const updateBrandSchema = brandSchema.extend({
  id: z.uuid("That is not a brand."),
});

export async function createBrand(
  input: unknown,
): Promise<AdminResult<{ id: string }>> {
  return adminAction<{ id: string }>(
    "createBrand",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = brandSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const { data, error } = await supabase
        .from("brands")
        .insert({
          name: parsed.data.name,
          slug: parsed.data.slug,
          logo_url: parsed.data.logoUrl,
          is_active: parsed.data.isActive,
        })
        .select("id")
        .single();

      if (error) return writeFailure(error, parsed.data.slug);
      bust();
      return { ok: true, id: data.id };
    },
  );
}

export async function updateBrand(
  input: unknown,
): Promise<AdminResult<{ id: string }>> {
  return adminAction<{ id: string }>(
    "updateBrand",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = updateBrandSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const { error } = await supabase
        .from("brands")
        .update({
          name: parsed.data.name,
          slug: parsed.data.slug,
          logo_url: parsed.data.logoUrl,
          is_active: parsed.data.isActive,
        })
        .eq("id", parsed.data.id);

      if (error) return writeFailure(error, parsed.data.slug);
      bust();
      return { ok: true, id: parsed.data.id };
    },
  );
}

const activeSchema = z.object({
  id: z.uuid("That is not a brand."),
  isActive: z.boolean(),
});

export async function setBrandActive(
  input: unknown,
): Promise<AdminResult<{ id: string; isActive: boolean }>> {
  return adminAction<{ id: string; isActive: boolean }>(
    "setBrandActive",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = activeSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const { error } = await supabase
        .from("brands")
        .update({ is_active: parsed.data.isActive })
        .eq("id", parsed.data.id);
      if (error) return writeFailure(error, null);

      bust();
      return { ok: true, id: parsed.data.id, isActive: parsed.data.isActive };
    },
  );
}

const deleteSchema = z.object({ id: z.uuid("That is not a brand.") });

export async function deleteBrand(
  input: unknown,
): Promise<AdminResult<{ id: string }>> {
  return adminAction<{ id: string }>(
    "deleteBrand",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = deleteSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const { data: brand, error: readError } = await supabase
        .from("brands")
        .select("id, name")
        .eq("id", parsed.data.id)
        .maybeSingle();
      if (readError) return writeFailure(readError, null);
      // Already gone is the outcome the caller asked for.
      if (!brand) return { ok: true, id: parsed.data.id };

      const { count, error: countError } = await supabase
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("brand_id", brand.id);
      if (countError) return writeFailure(countError, null);

      if ((count ?? 0) > 0) {
        return {
          ok: false,
          reason: "conflict",
          message:
            `${brand.name} is on ${count} product${count === 1 ? "" : "s"}. Deleting it would leave ` +
            `${count === 1 ? "that product" : "those products"} with no maker at all. Switch it off instead — ` +
            `that takes it out of the shop's filters and keeps every product as it is.`,
        };
      }

      const { error } = await supabase
        .from("brands")
        .delete()
        .eq("id", brand.id);
      if (error) return writeFailure(error, null);

      bust();
      return { ok: true, id: brand.id };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* helpers — not exported, so no browser can reach them                       */
/* -------------------------------------------------------------------------- */

function invalid(error: z.ZodError): AdminResult<never> {
  const issue = error.issues[0];
  return {
    ok: false,
    reason: "invalid",
    message: issue?.message ?? "Check that and try again.",
    field: issue?.path[0] === undefined ? undefined : String(issue.path[0]),
  };
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
        ? `Another brand already uses "${slug}". Pick a different web address.`
        : "Another brand already uses that web address.",
    };
  }
  console.error("[admin] brand write failed:", error.message, error.code);
  return {
    ok: false,
    reason: "error",
    message: "That did not save. Nothing has been changed — please try again.",
  };
}

function bust() {
  updateTag(CATALOG_CACHE_TAG);
  updateTag(CHROME_CACHE_TAG);
  revalidatePath("/admin/brands");
  revalidatePath("/", "layout");
}
