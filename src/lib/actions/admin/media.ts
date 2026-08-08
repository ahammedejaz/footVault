"use server";

import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";

import { adminAction, type AdminResult } from "@/lib/admin/guard";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_UPLOAD_BYTES,
  mediaUsage,
  PRODUCT_IMAGE_BUCKET,
} from "@/lib/queries/admin/media";
import { CATALOG_CACHE_TAG } from "@/lib/queries/cached";

/**
 * Uploading to, and deleting from, the product photograph bucket.
 *
 * **The bytes do not travel through the Server Action, and that is deliberate.**
 * A Server Action's request body is capped by `serverActions.bodySizeLimit`,
 * which Next defaults to 1MB — under half of what a phone camera produces and
 * a fifth of what this bucket accepts. Posting a 3MB photograph would fail with
 * an error that says nothing about size. So the action does the part only the
 * server can do — check that the caller is an admin, check the name, the type
 * and the size, and mint a single-use signed upload URL scoped to one path —
 * and the browser sends the file straight to Storage. The authorization
 * decision is still made here, by `adminAction`, and the bucket's own
 * `allowed_mime_types` and `file_size_limit` re-check the upload on arrival.
 *
 * **Deleting a file takes its `product_images` rows with it.** Removing the
 * object alone would leave the product page pointing at a 404 — the storefront
 * would keep rendering an image element for a photograph that no longer exists.
 * The rows go first: if the storage delete then fails, the product has one
 * fewer photograph, which is recoverable. The other order leaves a broken shop.
 */

/** Long enough to stay recognisable, short enough to keep the path sane. */
const STEM_MAX = 60;

const uploadSchema = z.object({
  fileName: z.string().trim().min(1, "That file has no name.").max(200),
  contentType: z.string().trim().min(1),
  sizeBytes: z
    .number()
    .int()
    .positive("That file is empty.")
    .max(
      MAX_UPLOAD_BYTES,
      `Images have to be under ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))}MB. Save it smaller and try again.`,
    ),
  /** The folder being browsed, so an upload lands where the owner is looking. */
  prefix: z
    .string()
    .trim()
    .max(120)
    .nullish()
    .transform((value) => value ?? "")
    .refine(
      (value) =>
        value === "" ||
        (/^[a-z0-9][a-z0-9/-]*$/.test(value) && !value.includes("..")),
      "That folder name is not one this screen can write to.",
    ),
});

export type UploadSlot = {
  bucket: string;
  path: string;
  /** Single-use. Spend it with `uploadToSignedUrl` and it is gone. */
  token: string;
};

export async function requestUploadSlot(
  input: unknown,
): Promise<AdminResult<UploadSlot>> {
  return adminAction<UploadSlot>(
    "requestUploadSlot",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = uploadSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const type = parsed.data.contentType.split(";")[0]?.trim() ?? "";
      if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(type)) {
        return {
          ok: false,
          reason: "invalid",
          message:
            "Photographs only — JPEG, PNG, WebP or AVIF. SVG is refused on purpose: it can carry script, and the shop renders these images without sandboxing them.",
          field: "contentType",
        };
      }

      const path = buildPath(parsed.data.fileName, type, parsed.data.prefix);

      const { data, error } = await supabase.storage
        .from(PRODUCT_IMAGE_BUCKET)
        .createSignedUploadUrl(path);

      if (error) {
        console.error("[admin] createSignedUploadUrl failed:", error.message);
        return {
          ok: false,
          reason: "error",
          message: "The upload could not be started. Try again in a moment.",
        };
      }

      return {
        ok: true,
        bucket: PRODUCT_IMAGE_BUCKET,
        path: data.path,
        token: data.token,
      };
    },
  );
}

const deleteSchema = z.object({
  path: z
    .string()
    .trim()
    .min(1, "That is not a file.")
    .max(400)
    .refine((value) => !value.includes(".."), "That is not a file."),
  /**
   * Set only when the owner has read a confirmation that named the products
   * using the file. The server re-checks rather than trusting it.
   */
  acknowledgeUsage: z
    .boolean()
    .nullish()
    .transform((value) => value ?? false),
});

export async function deleteMedia(
  input: unknown,
): Promise<AdminResult<{ path: string; detachedFrom: number }>> {
  return adminAction<{ path: string; detachedFrom: number }>(
    "deleteMedia",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = deleteSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const usage = await mediaUsage(parsed.data.path);

      if (usage.length > 0 && !parsed.data.acknowledgeUsage) {
        const names = [...new Set(usage.map((row) => row.productName))];
        return {
          ok: false,
          reason: "conflict",
          message: `That photograph is being used by ${listOut(names)}. Reload the page — the confirmation will tell you what removing it does.`,
        };
      }

      if (usage.length > 0) {
        const { error } = await supabase
          .from("product_images")
          .delete()
          .in(
            "id",
            usage.map((row) => row.imageRowId),
          );
        if (error) {
          console.error(
            "[admin] deleteMedia could not detach images:",
            error.message,
          );
          return {
            ok: false,
            reason: "error",
            message:
              "The photograph is still attached to a product, so nothing has been deleted.",
          };
        }
      }

      const { error } = await supabase.storage
        .from(PRODUCT_IMAGE_BUCKET)
        .remove([parsed.data.path]);

      if (error) {
        console.error("[admin] storage remove failed:", error.message);
        bustIfDetached(usage.length);
        return {
          ok: false,
          reason: "error",
          message:
            usage.length > 0
              ? "The file is still in storage, but it has been taken off the product it was on. Try deleting it again."
              : "That file could not be deleted. Try again in a moment.",
        };
      }

      if (usage.length > 0) updateTag(CATALOG_CACHE_TAG);
      revalidatePath("/admin/media");
      if (usage.length > 0) revalidatePath("/", "layout");

      return { ok: true, path: parsed.data.path, detachedFrom: usage.length };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* helpers — not exported, so no browser can reach them                       */
/* -------------------------------------------------------------------------- */

const EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};

/**
 * A safe path built from the name the owner recognises.
 *
 * The extension comes from the checked content type rather than from the
 * uploaded name, so `hero.jpg.svg` cannot arrive as an SVG. The random suffix
 * is what makes a second upload of "IMG_2481.jpg" a second file instead of
 * silently replacing the first — `createSignedUploadUrl` does not upsert, so
 * without it the second upload would simply fail.
 */
function buildPath(
  fileName: string,
  contentType: string,
  prefix: string,
): string {
  const stem = fileName.replace(/\.[^.]+$/, "");
  const slug =
    stem
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, STEM_MAX) || "image";
  const suffix = crypto.randomUUID().slice(0, 8);
  const extension = EXTENSION[contentType] ?? "jpg";
  const name = `${slug}-${suffix}.${extension}`;
  return prefix ? `${prefix}/${name}` : name;
}

/** "the Air Max 90", "the Air Max 90 and the Samba", "three products". */
function listOut(names: string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

/** The rows are gone even though the file is not, so the shop has changed. */
function bustIfDetached(count: number) {
  if (count === 0) return;
  updateTag(CATALOG_CACHE_TAG);
  revalidatePath("/admin/media");
  revalidatePath("/", "layout");
}

function invalid(error: z.ZodError): AdminResult<never> {
  const issue = error.issues[0];
  return {
    ok: false,
    reason: "invalid",
    message: issue?.message ?? "Check that and try again.",
    field: issue?.path[0] === undefined ? undefined : String(issue.path[0]),
  };
}
