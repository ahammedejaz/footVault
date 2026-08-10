"use server";

import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";

import { FOOTWEAR_TYPES, GENDERS } from "@/components/admin/products/types";
import { adminAction, type AdminResult } from "@/lib/admin/guard";
import { isDerivative } from "@/lib/images/srcset";
import { CATALOG_CACHE_TAG } from "@/lib/queries/cached";
import type { createClient } from "@/lib/supabase/server";

/**
 * Every write /admin/products makes.
 *
 * Three rules hold across all of them, and each one is here because breaking it
 * has a specific, unpleasant consequence:
 *
 *  1. **`adminAction` wraps everything.** A Server Action compiles to a POST
 *     endpoint whose id ships in the browser bundle, so an unguarded export
 *     here is a public endpoint that reads like private code. The middleware
 *     404 protects navigation to /admin and has nothing to say about it.
 *     `footvault/admin-actions-must-guard` fails the build if one forgets.
 *
 *  2. **Every catalog write revalidates.** Homepage and product data is cached
 *     for an hour (`src/lib/queries/cached.ts`) and `/product/[slug]` is
 *     statically rendered on top of that. Without the purge below the owner
 *     saves a price, reloads the shop, and sees the old one — twice, because
 *     the page cache and the data cache would both have to expire.
 *
 *  3. **Stock is never written here.** A newly created size carries its
 *     opening balance into the INSERT, where `product_variants_record_opening`
 *     writes the ledger row for it. Every later change goes through
 *     `adjust_variant_stock()`, which sets the `app.inventory_*` GUCs inside
 *     the same transaction as the update so the movement is attributable. An
 *     UPDATE from here would land in the ledger as `unspecified`, which is the
 *     shape `reconcile_inventory()` reports as a bug.
 */

type Supabase = Awaited<ReturnType<typeof createClient>>;

const IMAGE_BUCKET = "product-images";

/* -------------------------------------------------------------------------- */
/* shared                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Purge everything a catalog change can be seen through.
 *
 * `updateTag` clears the hour-long `unstable_cache` entries behind the homepage
 * and the product page. It is `updateTag` rather than `revalidateTag` on
 * purpose: Next 16 gives `revalidateTag` stale-while-revalidate semantics, so
 * the owner would save a price, reload, and still be served the old figure
 * while the new one built in the background. `updateTag` expires immediately
 * and is built for read-your-own-writes — which is the entire requirement here
 * — at the cost of being callable only from inside a Server Action, which
 * every caller below is.
 *
 * The tag is not enough on its own: `/product/[slug]` also has
 * `export const revalidate = 3600`, so the *rendered page* is cached separately
 * from the data inside it, and its own doc comment promises this call.
 * `revalidatePath("/", "layout")` is the blunt half that covers the rendered
 * routes, and the per-slug call is the precise one — passed for both the old
 * and the new slug when a rename moves the page.
 */
function revalidateCatalog(slugs: readonly string[] = []): void {
  updateTag(CATALOG_CACHE_TAG);
  revalidatePath("/", "layout");
  for (const slug of slugs) {
    if (slug) revalidatePath(`/product/${slug}`);
  }
}

function revalidateAdmin(productId?: string): void {
  revalidatePath("/admin/products");
  revalidatePath("/admin/inventory");
  if (productId) revalidatePath(`/admin/products/${productId}`);
}

/** The first issue, in the owner's words. */
function invalid(error: z.ZodError): AdminResult<never> {
  const issue = error.issues[0];
  return {
    ok: false,
    reason: "invalid",
    message: issue?.message ?? "Check that and try again.",
    field: issue?.path[0] === undefined ? undefined : String(issue.path[0]),
  };
}

/** Rupees in the form, integer paise in the database. */
function toPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

/* -------------------------------------------------------------------------- */
/* the product                                                                */
/* -------------------------------------------------------------------------- */

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A price in rupees. Bounded, because a stray zero is the commonest typo. */
const priceRupees = z
  .number()
  .finite("That is not a price.")
  .positive("A price has to be more than zero.")
  .max(10_000_000, "That is more than ₹1,00,00,000 — check the number.");

const optionalId = z
  .union([z.uuid(), z.literal("")])
  .optional()
  .transform((value) => (value ? value : null));

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `Keep ${label} under ${max} characters.`)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null));

/** A dimension. Null is a legitimate answer — it means "use the shop default". */
const optionalDimension = (max: number, label: string) =>
  z
    .number()
    .finite(`${label} is not a number.`)
    .positive(`${label} has to be more than zero, or left blank.`)
    .max(max, `${label} looks wrong — the largest allowed is ${max}.`)
    .nullable()
    .optional()
    .transform((value) => value ?? null);

const productSchema = z
  .object({
    id: z.uuid("That is not a product.").optional(),
    name: z
      .string()
      .trim()
      .min(2, "Give the product a name.")
      .max(120, "Keep the name under 120 characters."),
    slug: z
      .string()
      .trim()
      .min(2, "The web address is too short.")
      .max(140, "Keep the web address under 140 characters.")
      .regex(
        SLUG_PATTERN,
        "The web address may only use lowercase letters, numbers and hyphens.",
      ),
    description: optionalText(4000, "the description"),
    brandId: optionalId,
    categoryId: optionalId,
    gender: z.enum(GENDERS),
    footwearType: z.enum(FOOTWEAR_TYPES),
    material: optionalText(120, "the material"),
    basePriceRupees: priceRupees,
    salePriceRupees: priceRupees.nullable().optional(),
    isActive: z.boolean(),
    isFeatured: z.boolean(),
    metaTitle: optionalText(70, "the search title"),
    metaDescription: optionalText(200, "the search description"),
    weightGrams: z
      .number()
      .int("Whole grams only.")
      .positive("The weight has to be more than zero, or left blank.")
      .max(50_000, "That is over 50kg — check the number.")
      .nullable()
      .optional()
      .transform((value) => value ?? null),
    lengthCm: optionalDimension(300, "The length"),
    breadthCm: optionalDimension(300, "The breadth"),
    heightCm: optionalDimension(300, "The height"),
    searchKeywords: z
      .array(z.string().trim().min(1).max(40))
      .max(20, "Twenty search words is plenty.")
      .optional()
      .transform((value) => value ?? []),
  })
  .refine(
    (value) =>
      value.salePriceRupees === null ||
      value.salePriceRupees === undefined ||
      value.salePriceRupees < value.basePriceRupees,
    {
      // `products_sale_below_base` enforces this in the database too. Catching
      // it here is what turns "violates check constraint" into a sentence.
      path: ["salePriceRupees"],
      message: "The sale price has to be below the usual price.",
    },
  );

/**
 * Create or update a product.
 *
 * One action rather than two, because the two differ by a single `id` and
 * splitting them duplicates twenty fields of validation — which is how the two
 * halves of a form end up disagreeing about what a valid product is.
 */
export async function saveProduct(
  input: unknown,
): Promise<AdminResult<{ id: string; slug: string; created: boolean }>> {
  return adminAction<{ id: string; slug: string; created: boolean }>(
    "saveProduct",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = productSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);
      const values = parsed.data;

      const record = {
        name: values.name,
        slug: values.slug,
        description: values.description,
        brand_id: values.brandId,
        category_id: values.categoryId,
        gender: values.gender,
        footwear_type: values.footwearType,
        material: values.material,
        base_price: toPaise(values.basePriceRupees),
        sale_price:
          values.salePriceRupees === null ||
          values.salePriceRupees === undefined
            ? null
            : toPaise(values.salePriceRupees),
        is_active: values.isActive,
        is_featured: values.isFeatured,
        meta_title: values.metaTitle,
        meta_description: values.metaDescription,
        weight_grams: values.weightGrams,
        length_cm: values.lengthCm,
        breadth_cm: values.breadthCm,
        height_cm: values.heightCm,
        search_keywords: values.searchKeywords,
      };

      if (values.id) {
        // The old slug has to be revalidated as well as the new one: renaming a
        // product leaves a statically rendered page at the previous address,
        // and without this it keeps serving the product's former self.
        const { data: existing, error: readError } = await supabase
          .from("products")
          .select("slug")
          .eq("id", values.id)
          .maybeSingle();
        if (readError) {
          console.error("[admin] saveProduct read failed:", readError.message);
          return {
            ok: false,
            reason: "error",
            message: "Could not read that product. Nothing has been changed.",
          };
        }
        if (!existing) {
          return {
            ok: false,
            reason: "invalid",
            message: "That product no longer exists.",
          };
        }

        const { error } = await supabase
          .from("products")
          .update(record)
          .eq("id", values.id);
        if (error) return writeFailure(error, "product");

        revalidateCatalog([existing.slug, values.slug]);
        revalidateAdmin(values.id);
        return { ok: true, id: values.id, slug: values.slug, created: false };
      }

      const { data, error } = await supabase
        .from("products")
        .insert(record)
        .select("id")
        .single();
      if (error) return writeFailure(error, "product");
      if (!data) {
        return {
          ok: false,
          reason: "error",
          message: "The product did not save. Please try again.",
        };
      }

      revalidateCatalog([values.slug]);
      revalidateAdmin(data.id);
      return { ok: true, id: data.id, slug: values.slug, created: true };
    },
  );
}

const bulkSchema = z.object({
  ids: z
    .array(z.uuid())
    .min(1, "Pick at least one product.")
    .max(100, "A hundred at a time is the limit."),
  isActive: z.boolean(),
});

/**
 * Turn a selection on or off.
 *
 * `adminBulk` rather than `adminMutation`: this is one request that changes a
 * hundred rows, and the limit that suits a busy owner clicking single buttons
 * is the wrong shape for it.
 */
export async function setProductsActive(
  input: unknown,
): Promise<AdminResult<{ updated: number }>> {
  return adminAction<{ updated: number }>(
    "setProductsActive",
    "adminBulk",
    async ({ supabase }) => {
      const parsed = bulkSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const { data, error } = await supabase
        .from("products")
        .update({ is_active: parsed.data.isActive })
        .in("id", parsed.data.ids)
        // A soft-deleted product must not be publishable by a bulk tick. Putting
        // one back is its own decision, made on its own page.
        .is("deleted_at", null)
        .select("slug");
      if (error) return writeFailure(error, "product");

      const slugs = (data ?? []).map((row) => row.slug);
      revalidateCatalog(slugs);
      revalidateAdmin();
      return { ok: true, updated: slugs.length };
    },
  );
}

const idSchema = z.object({ id: z.uuid("That is not a product.") });

/**
 * Delete a product — or hide it, which is the database's decision, not ours.
 *
 * `admin_delete_product()` counts the order lines against the product and picks:
 * never ordered is removed outright, ever ordered is soft-deleted so the order
 * keeps its link back and "what did we sell of this" stays answerable. The
 * choice belongs where the data is, so this action does not offer one.
 */
export async function deleteProduct(
  input: unknown,
): Promise<AdminResult<{ outcome: "deleted" | "soft_deleted" }>> {
  return adminAction<{ outcome: "deleted" | "soft_deleted" }>(
    "deleteProduct",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = idSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const { data: existing, error: readError } = await supabase
        .from("products")
        .select("slug")
        .eq("id", parsed.data.id)
        .maybeSingle();
      if (readError) {
        console.error("[admin] deleteProduct read failed:", readError.message);
        return {
          ok: false,
          reason: "error",
          message: "Could not read that product. Nothing has been changed.",
        };
      }

      const { data, error } = await supabase.rpc("admin_delete_product", {
        p_product_id: parsed.data.id,
      });

      if (error) {
        if (error.code === "FVADM") {
          return {
            ok: false,
            reason: "forbidden",
            message: "That is not available.",
          };
        }
        console.error(
          "[admin] admin_delete_product failed:",
          error.message,
          error.code,
        );
        return {
          ok: false,
          reason: "error",
          message: "The product is still there. Nothing has been changed.",
        };
      }

      if (data === "not_found") {
        return {
          ok: false,
          reason: "invalid",
          message: "That product has already gone.",
        };
      }

      revalidateCatalog(existing ? [existing.slug] : []);
      revalidateAdmin(parsed.data.id);
      return {
        ok: true,
        outcome: data === "deleted" ? "deleted" : "soft_deleted",
      };
    },
  );
}

/**
 * Put a hidden product back on the shelf — as a draft.
 *
 * `is_active` is deliberately left alone. A product was hidden because it had
 * been ordered and then deleted; restoring it straight to the shop would
 * republish something the owner may only be recovering in order to read.
 */
export async function restoreProduct(
  input: unknown,
): Promise<AdminResult<object>> {
  return adminAction<object>(
    "restoreProduct",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = idSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const { data, error } = await supabase
        .from("products")
        .update({ deleted_at: null, is_active: false })
        .eq("id", parsed.data.id)
        .select("slug")
        .maybeSingle();
      if (error) return writeFailure(error, "product");
      if (!data) {
        return {
          ok: false,
          reason: "invalid",
          message: "That product no longer exists.",
        };
      }

      revalidateCatalog([data.slug]);
      revalidateAdmin(parsed.data.id);
      return { ok: true };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* sizes                                                                      */
/* -------------------------------------------------------------------------- */

const variantSchema = z.object({
  id: z.uuid("That is not a size.").optional(),
  productId: z.uuid("That is not a product."),
  size: z
    .string()
    .trim()
    .min(1, "Give the size a name — UK 8, or 42.")
    .max(20, "Keep the size under 20 characters."),
  color: z
    .string()
    .trim()
    .min(1, "Give the colourway a name.")
    .max(60, "Keep the colour under 60 characters."),
  colorHex: z
    .union([
      z
        .string()
        .trim()
        .regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #1B1B1B."),
      z.literal(""),
    ])
    .optional()
    .transform((value) => (value ? value.toLowerCase() : null)),
  sku: z
    .string()
    .trim()
    .min(3, "A SKU needs at least three characters.")
    .max(64, "Keep the SKU under 64 characters."),
  priceOverrideRupees: priceRupees.nullable().optional(),
  isActive: z.boolean(),
  openingStock: z
    .number()
    .int("Whole pairs only.")
    .min(0, "A count cannot be negative.")
    .max(9999, "That is more than 9,999 — check the number."),
});

/**
 * Add a size, or correct one that exists.
 *
 * On create, `openingStock` is written as part of the INSERT and
 * `product_variants_record_opening` turns it into an `opening_balance` ledger
 * row automatically. On update it is ignored: changing an existing count means
 * a note, a reason and an actor, which is what the count control on this page
 * and `adjust_variant_stock()` exist to collect. Letting this action move stock
 * would put a movement in the ledger that nobody can be asked about.
 */
export async function saveVariant(
  input: unknown,
): Promise<AdminResult<{ id: string; created: boolean }>> {
  return adminAction<{ id: string; created: boolean }>(
    "saveVariant",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = variantSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);
      const values = parsed.data;

      const slug = await productSlug(supabase, values.productId);

      const shared = {
        size: values.size,
        color: values.color,
        color_hex: values.colorHex,
        sku: values.sku,
        price_override:
          values.priceOverrideRupees === null ||
          values.priceOverrideRupees === undefined
            ? null
            : toPaise(values.priceOverrideRupees),
        is_active: values.isActive,
      };

      if (values.id) {
        const { error } = await supabase
          .from("product_variants")
          .update(shared)
          .eq("id", values.id);
        if (error) return writeFailure(error, "size");

        revalidateCatalog(slug ? [slug] : []);
        revalidateAdmin(values.productId);
        return { ok: true, id: values.id, created: false };
      }

      const { data, error } = await supabase
        .from("product_variants")
        .insert({
          ...shared,
          product_id: values.productId,
          stock_quantity: values.openingStock,
        })
        .select("id")
        .single();
      if (error) return writeFailure(error, "size");
      if (!data) {
        return {
          ok: false,
          reason: "error",
          message: "The size did not save. Please try again.",
        };
      }

      revalidateCatalog(slug ? [slug] : []);
      revalidateAdmin(values.productId);
      return { ok: true, id: data.id, created: true };
    },
  );
}

const variantIdSchema = z.object({ id: z.uuid("That is not a size.") });

/**
 * Remove a size that was never sold.
 *
 * A size that has been ordered is refused rather than deleted, and the reason
 * is the foreign keys: `order_items.variant_id` is ON DELETE SET NULL and
 * `cart_items.variant_id` is ON DELETE CASCADE, so a hard delete would sever
 * the order line's link to what was actually sold and silently empty a
 * customer's live bag. The same argument `admin_delete_product` makes about
 * products, applied one level down — the owner is offered "turn it off"
 * instead, which is what they meant.
 */
export async function deleteVariant(
  input: unknown,
): Promise<AdminResult<object>> {
  return adminAction<object>(
    "deleteVariant",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = variantIdSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const { data: variant, error: readError } = await supabase
        .from("product_variants")
        .select("product_id")
        .eq("id", parsed.data.id)
        .maybeSingle();
      if (readError) {
        console.error("[admin] deleteVariant read failed:", readError.message);
        return {
          ok: false,
          reason: "error",
          message: "Could not read that size. Nothing has been changed.",
        };
      }
      if (!variant) {
        return {
          ok: false,
          reason: "invalid",
          message: "That size has already gone.",
        };
      }

      const { count, error: countError } = await supabase
        .from("order_items")
        .select("id", { count: "exact", head: true })
        .eq("variant_id", parsed.data.id);
      if (countError) {
        console.error(
          "[admin] deleteVariant order count failed:",
          countError.message,
        );
        return {
          ok: false,
          reason: "error",
          message: "Could not check that size's orders. Nothing was deleted.",
        };
      }
      if ((count ?? 0) > 0) {
        return {
          ok: false,
          reason: "conflict",
          message:
            "This size is on past orders, so deleting it would break them. Turn it off instead — it disappears from the shop and the orders keep their history.",
        };
      }

      const { error } = await supabase
        .from("product_variants")
        .delete()
        .eq("id", parsed.data.id);
      if (error) return writeFailure(error, "size");

      const slug = await productSlug(supabase, variant.product_id);
      revalidateCatalog(slug ? [slug] : []);
      revalidateAdmin(variant.product_id);
      return { ok: true };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* photographs                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The gallery is a list, and the top of the list is the primary.
 *
 * Every mutation below ends in `resequence()`, which rewrites `sort_order` as
 * 0…n-1 and sets `is_primary` on the first row and no other. That makes the
 * order the owner sees on this page the order the storefront renders — which
 * sorts primary-first — instead of two orderings that agree until they do not.
 *
 * **The comment that used to sit here was the bug.** It said "exactly one
 * primary is not enforced by a constraint, so it has to be enforced by
 * construction", and on that basis `resequence()` wrote the whole gallery back
 * as a single multi-row upsert. It *is* enforced by a constraint, and has been
 * since Phase 1: `product_images_one_primary_idx`, `unique (product_id) where
 * is_primary`. Postgres checks a unique index per row as it is written, so the
 * instant the new primary landed before the old one had been cleared there were
 * two rows with `is_primary` and the whole write was rejected 23505. That is
 * why "Make main" reported no change and why up/down errored. Reproduced
 * against the live database:
 *
 * ```
 * set new primary, then clear old  -> BLOCKED 23505 product_images_one_primary_idx
 * clear all, then set new primary  -> succeeded
 * ```
 *
 * The order is now written by `public.reorder_product_images()`, which clears
 * every primary and then writes the new positions **in one transaction**. It
 * has to be a function rather than two PostgREST calls: in between, the gallery
 * has no primary at all, and a failure in that gap would leave a product whose
 * card on `/shop` has no photograph to lead with.
 */
type ImageRow = {
  id: string;
  product_id: string;
  url: string;
  sort_order: number;
  is_primary: boolean;
  created_at: string;
};

const GALLERY_COLUMNS =
  "id, product_id, url, sort_order, is_primary, created_at";

/** The gallery in the order the storefront would render it. */
function galleryOrder(images: ImageRow[]): ImageRow[] {
  return [...images].sort(
    (a, b) =>
      Number(b.is_primary) - Number(a.is_primary) ||
      a.sort_order - b.sort_order ||
      a.created_at.localeCompare(b.created_at),
  );
}

/**
 * Write positions back. One upsert, not one update per row — a ten-photograph
 * product would otherwise be ten round trips for a single press of "Up".
 *
 * Only the four columns listed are sent, so alt text and colour are untouched
 * by a reorder.
 */
async function resequence(
  supabase: Supabase,
  ordered: ImageRow[],
): Promise<string | null> {
  if (ordered.length === 0) return null;

  const { error } = await supabase.rpc("reorder_product_images", {
    p_product_id: ordered[0]!.product_id,
    p_ids: ordered.map((image) => image.id),
  });

  if (error) {
    console.error("[admin] image resequence failed:", error.message, error.code);
    // `GLRYM` means the list we sent did not match the gallery — almost always
    // two admins editing the same product, or a photograph deleted in another
    // tab. Worth its own sentence, because "try again" is genuinely the fix and
    // "nothing has been changed" is genuinely true.
    return error.code === "GLRYM"
      ? "These photographs changed while you were arranging them. Reload the page and try again — nothing has been changed."
      : "The photographs did not reorder. Nothing has been changed.";
  }
  return null;
}

async function readGallery(
  supabase: Supabase,
  productId: string,
): Promise<{ images: ImageRow[] } | { message: string }> {
  const { data, error } = await supabase
    .from("product_images")
    .select(GALLERY_COLUMNS)
    .eq("product_id", productId);
  if (error) {
    console.error("[admin] image read failed:", error.message);
    return { message: "Could not read the photographs for this product." };
  }
  return { images: galleryOrder(data ?? []) };
}

const addImageSchema = z.object({
  productId: z.uuid("That is not a product."),
  /**
   * The public URL of an object the browser has already put in the bucket.
   *
   * The upload itself does not come through this action: a Server Action body
   * is a single POST that Next caps at 1MB by default, and a photograph from a
   * phone is several times that. The browser uploads straight to Supabase
   * Storage, where the `admins upload storefront assets` policy re-checks
   * `is_admin()` — so the write is authorized by the database either way, and
   * this action records the row rather than carrying the bytes.
   */
  url: z
    .url("That is not a web address.")
    .max(1000)
    /**
     * **Only an output of the pipeline may be attached to a product.**
     *
     * This is the enforcement point for the consistency guarantee, and it is
     * here rather than in the upload panel on purpose: a rule that lives in one
     * screen holds only for people who used that screen. The media library
     * uploads unprocessed originals, and a photograph attached to a product
     * from there — today by hand, tomorrow by a feature nobody has written yet
     * — would be a raw phone photograph in a grid of squared, padded ones. The
     * whole point of Batch A is that the catalogue looks like a catalogue no
     * matter which door the photograph came through.
     *
     * `/seed/` is allowed because the drawn placeholders are first-party assets
     * that predate the pipeline and are not in the bucket at all; the
     * reprocessor reports and skips them for the same reason.
     */
    .refine(
      (value) => isDerivative(value) || value.includes("/seed/"),
      "That photograph has not been through the image pipeline. Upload it from the product's own Photographs panel, which squares it up and makes the sizes the shop needs.",
    ),
  /**
   * Where the untouched upload lives, so a `PIPELINE_VERSION` bump can rebuild
   * this image later. A path inside the bucket, never a URL — see the migration.
   */
  originalPath: z.string().trim().max(400).optional().nullable(),
  altText: z
    .string()
    .trim()
    .max(200, "Keep the description under 200 characters.")
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
});

export async function addProductImage(
  input: unknown,
): Promise<AdminResult<{ id: string }>> {
  return adminAction<{ id: string }>(
    "addProductImage",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = addImageSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const gallery = await readGallery(supabase, parsed.data.productId);
      if ("message" in gallery) {
        return { ok: false, reason: "error", message: gallery.message };
      }

      const { data, error } = await supabase
        .from("product_images")
        .insert({
          product_id: parsed.data.productId,
          url: parsed.data.url,
          original_path: parsed.data.originalPath ?? null,
          alt_text: parsed.data.altText,
          sort_order: gallery.images.length,
          is_primary: gallery.images.length === 0,
        })
        .select(GALLERY_COLUMNS)
        .single();
      if (error) return writeFailure(error, "photograph");
      if (!data) {
        return {
          ok: false,
          reason: "error",
          message: "The photograph did not save. Please try again.",
        };
      }

      const failure = await resequence(supabase, [...gallery.images, data]);
      if (failure) return { ok: false, reason: "error", message: failure };

      const slug = await productSlug(supabase, parsed.data.productId);
      revalidateCatalog(slug ? [slug] : []);
      revalidateAdmin(parsed.data.productId);
      return { ok: true, id: data.id };
    },
  );
}

const altSchema = z.object({
  id: z.uuid("That is not a photograph."),
  altText: z
    .string()
    .trim()
    .max(200, "Keep the description under 200 characters."),
});

/**
 * Alt text.
 *
 * Stored as null when empty rather than as `""`, because the storefront falls
 * back to the product name for a null and would render an empty `alt` for the
 * other — which is the one value that tells a screen reader the image is
 * decorative, and a product photograph is not.
 */
export async function setImageAlt(
  input: unknown,
): Promise<AdminResult<object>> {
  return adminAction<object>(
    "setImageAlt",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = altSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const { data, error } = await supabase
        .from("product_images")
        .update({ alt_text: parsed.data.altText || null })
        .eq("id", parsed.data.id)
        .select("product_id")
        .maybeSingle();
      if (error) return writeFailure(error, "photograph");
      if (!data) {
        return {
          ok: false,
          reason: "invalid",
          message: "That photograph has already gone.",
        };
      }

      const slug = await productSlug(supabase, data.product_id);
      revalidateCatalog(slug ? [slug] : []);
      revalidateAdmin(data.product_id);
      return { ok: true };
    },
  );
}

const moveSchema = z.object({
  id: z.uuid("That is not a photograph."),
  /** `top` is "make this the primary", which is the same move as "to the front". */
  direction: z.enum(["up", "down", "top"]),
});

/**
 * Reorder, with buttons rather than with a drag.
 *
 * Explicit Up and Down are keyboard-operable and announce themselves; a
 * drag-and-drop list is neither unless a second, hidden keyboard interface is
 * built alongside it. On a tablet held in one hand a 44px button is also a more
 * reliable target than a drag across a scrolling page.
 *
 * Moving to the top *is* making primary, because the primary is defined as the
 * first photograph — see `resequence`.
 */
export async function moveProductImage(
  input: unknown,
): Promise<AdminResult<object>> {
  return adminAction<object>(
    "moveProductImage",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = moveSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const { data: image, error: readError } = await supabase
        .from("product_images")
        .select("product_id")
        .eq("id", parsed.data.id)
        .maybeSingle();
      if (readError) {
        console.error(
          "[admin] moveProductImage read failed:",
          readError.message,
        );
        return {
          ok: false,
          reason: "error",
          message: "Could not read that photograph.",
        };
      }
      if (!image) {
        return {
          ok: false,
          reason: "invalid",
          message: "That photograph has already gone.",
        };
      }

      const gallery = await readGallery(supabase, image.product_id);
      if ("message" in gallery) {
        return { ok: false, reason: "error", message: gallery.message };
      }

      const ordered = gallery.images;
      const from = ordered.findIndex((row) => row.id === parsed.data.id);
      if (from === -1) {
        return {
          ok: false,
          reason: "invalid",
          message: "That photograph has already gone.",
        };
      }

      const to =
        parsed.data.direction === "top"
          ? 0
          : parsed.data.direction === "up"
            ? from - 1
            : from + 1;
      // Already at the end it was asked to move towards. Not an error — the
      // button is disabled there anyway, and a second tap on a slow connection
      // should be a no-op rather than a red toast.
      if (to < 0 || to >= ordered.length || to === from) return { ok: true };

      const next = [...ordered];
      const [moved] = next.splice(from, 1);
      if (moved) next.splice(to, 0, moved);

      const failure = await resequence(supabase, next);
      if (failure) return { ok: false, reason: "error", message: failure };

      const slug = await productSlug(supabase, image.product_id);
      revalidateCatalog(slug ? [slug] : []);
      revalidateAdmin(image.product_id);
      return { ok: true };
    },
  );
}

const imageIdSchema = z.object({ id: z.uuid("That is not a photograph.") });

/**
 * Delete a photograph, and the file behind it.
 *
 * The row goes first. If the storage delete then fails the shop is still
 * correct — an orphaned object in a bucket costs a few kilobytes, whereas a row
 * pointing at a file that no longer exists is a broken image on the product
 * page. So a storage failure is logged and swallowed rather than rolled back.
 *
 * A URL that is not in our bucket (the seeded `/seed/*.svg` artwork) has no
 * object to remove, and that is expected rather than an error.
 */
export async function deleteProductImage(
  input: unknown,
): Promise<AdminResult<object>> {
  return adminAction<object>(
    "deleteProductImage",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = imageIdSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const { data: image, error: readError } = await supabase
        .from("product_images")
        .select("product_id, url")
        .eq("id", parsed.data.id)
        .maybeSingle();
      if (readError) {
        console.error(
          "[admin] deleteProductImage read failed:",
          readError.message,
        );
        return {
          ok: false,
          reason: "error",
          message: "Could not read that photograph.",
        };
      }
      if (!image) {
        return {
          ok: false,
          reason: "invalid",
          message: "That photograph has already gone.",
        };
      }

      const { error } = await supabase
        .from("product_images")
        .delete()
        .eq("id", parsed.data.id);
      if (error) return writeFailure(error, "photograph");

      const path = storagePath(image.url);
      if (path) {
        const { error: storageError } = await supabase.storage
          .from(IMAGE_BUCKET)
          .remove([path]);
        if (storageError) {
          console.warn(
            "[admin] photograph row deleted but the file remains:",
            path,
            storageError.message,
          );
        }
      }

      const gallery = await readGallery(supabase, image.product_id);
      if (!("message" in gallery)) {
        const failure = await resequence(supabase, gallery.images);
        if (failure) return { ok: false, reason: "error", message: failure };
      }

      const slug = await productSlug(supabase, image.product_id);
      revalidateCatalog(slug ? [slug] : []);
      revalidateAdmin(image.product_id);
      return { ok: true };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* plumbing                                                                   */
/* -------------------------------------------------------------------------- */

/** The object key inside the bucket, or null for a URL we did not upload. */
function storagePath(url: string): string | null {
  const marker = `/storage/v1/object/public/${IMAGE_BUCKET}/`;
  const at = url.indexOf(marker);
  if (at === -1) return null;
  const path = url.slice(at + marker.length).split("?")[0];
  if (!path) return null;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * The slug of the product a write touched, for the page-cache purge.
 *
 * A failure here is logged and returns null rather than failing the action: the
 * write has already succeeded, and refusing to report success because a
 * revalidation hint could not be looked up would tell the owner their change
 * did not save when it did.
 */
async function productSlug(
  supabase: Supabase,
  productId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("products")
    .select("slug")
    .eq("id", productId)
    .maybeSingle();
  if (error) {
    console.warn("[admin] could not read slug to revalidate:", error.message);
    return null;
  }
  return data?.slug ?? null;
}

/**
 * A PostgREST error, in the owner's language.
 *
 * The three codes below are the ones a valid-looking form can still produce,
 * and each has a specific cause the owner can act on. "duplicate key value
 * violates unique constraint" is not a sentence to put in front of a shop
 * owner, and neither is a bare "something went wrong" when the actual problem
 * is that they typed a SKU twice.
 */
function writeFailure(
  error: { code?: string; message: string },
  subject: "product" | "size" | "photograph",
): AdminResult<never> {
  /**
   * A unique violation is reported as `invalid` with a field rather than as
   * `conflict`, and the distinction is not pedantry: only the `invalid` variant
   * of `AdminFailure` carries `field`, and `field` is what puts the message
   * under the box the owner has to change and moves focus there. `conflict` is
   * for "you cannot do that to this row" — a size with orders against it — where
   * there is no box to fix.
   */
  if (error.code === "23505") {
    if (error.message.includes("sku")) {
      return {
        ok: false,
        reason: "invalid",
        message: "That SKU is already on another size. Every SKU is unique.",
        field: "sku",
      };
    }
    if (error.message.includes("unique_combo")) {
      return {
        ok: false,
        reason: "invalid",
        message: "This product already has that size in that colour.",
        field: "size",
      };
    }
    return {
      ok: false,
      reason: "invalid",
      message: "That web address is already used by another product.",
      field: "slug",
    };
  }

  if (error.code === "23514") {
    return {
      ok: false,
      reason: "invalid",
      message:
        "The database refused those numbers — a price or a measurement is out of range. Nothing has been changed.",
    };
  }

  if (error.code === "42501" || error.code === "FVADM") {
    return {
      ok: false,
      reason: "forbidden",
      message: "That is not available.",
    };
  }

  console.error(`[admin] ${subject} write failed:`, error.message, error.code);
  return {
    ok: false,
    reason: "error",
    message: `The ${subject} did not save. Nothing has been changed — please try again.`,
  };
}
