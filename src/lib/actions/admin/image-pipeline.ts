"use server";

import { z } from "zod";

import { adminAction, type AdminResult } from "@/lib/admin/guard";
import {
  CANONICAL_EDGE,
  derivativePath,
  normaliseProductImage,
} from "@/lib/images/pipeline";
import { PRODUCT_IMAGE_BUCKET } from "@/lib/queries/admin/media";

/**
 * Running the normalisation pipeline over an original that is already in
 * Storage.
 *
 * ## Why this is a second step rather than part of the upload
 *
 * The bytes deliberately do not travel through a Server Action —
 * `requestUploadSlot` explains why at length, and the short version is that
 * Next caps an action's body at 1MB and a phone photograph is several times
 * that. So the browser puts the original into Storage with a signed URL, and
 * then calls this to turn it into catalogue assets.
 *
 * Splitting it that way is not a workaround, it is the thing that makes
 * reprocessing possible. The original is retained, and normalisation is a pure
 * function of it, so re-running the pipeline over an image uploaded six months
 * ago is *this same call* with no upload attached. A pipeline welded to the
 * upload could only ever process things arriving now, and the brief asks for
 * bulk reprocessing so real photography can replace the drawn placeholders and
 * so a future change to the frame does not mean re-uploading the catalogue.
 *
 * ## Idempotency
 *
 * Derivative paths are derived from a hash of the *output* plus the pipeline
 * version, so the same original always writes the same bytes to the same paths.
 * `upsert` is therefore safe by construction rather than by hope: it can only
 * ever overwrite a file with one that is byte-identical. Two admins processing
 * the same photograph at the same time cannot corrupt each other.
 */

const schema = z.object({
  /** The original's path inside the bucket, as the media library knows it. */
  path: z
    .string()
    .trim()
    .min(1, "That is not a file.")
    .max(400)
    .refine((value) => !value.includes(".."), "That is not a file."),
});

export type NormalisedUpload = {
  /** What `product_images.url` should point at. The largest variant. */
  canonicalPath: string;
  /**
   * The untouched upload this came from, echoed back so the caller can record
   * it on the row.
   *
   * Returned rather than left for the caller to remember: the caller does know
   * the path it just uploaded, but a second copy of that knowledge is a second
   * place it can be wrong, and the row is useless if it names the wrong file.
   */
  originalPath: string;
  /** Every emitted width, smallest first, for a future direct srcset. */
  widths: { width: number; path: string; bytes: number }[];
  source: { width: number; height: number; format: string };
  /**
   * True when the original was under `MIN_RECOMMENDED_EDGE` on a side. The
   * upload still succeeds — the owner may have one irreplaceable photograph —
   * but the panel says so, because the pipeline upscales to keep the framing
   * consistent and upscaling is what makes a small photograph look soft.
   */
  belowRecommended: boolean;
  /** Widths that came out over budget. Reported, never silently shipped. */
  overBudget: number[];
};

export async function normaliseUpload(
  input: unknown,
): Promise<AdminResult<NormalisedUpload>> {
  return adminAction<NormalisedUpload>(
    "normaliseUpload",
    /**
     * Its own policy. `adminBulk` (20/min) is sized for whole-table writes and
     * would be reached partway through a real photography session — see
     * `RATE_LIMITS.imageProcessing` for why that failure is worse than it
     * sounds.
     */
    "imageProcessing",
    async ({ elevated }) => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          reason: "invalid",
          message: parsed.error.issues[0]?.message ?? "Check that and try again.",
        };
      }

      const supabase = elevated();

      const { data: file, error: downloadError } = await supabase.storage
        .from(PRODUCT_IMAGE_BUCKET)
        .download(parsed.data.path);

      if (downloadError || !file) {
        console.error(
          "[images] could not read the original:",
          downloadError?.message ?? "no body",
        );
        return {
          ok: false,
          reason: "error",
          message:
            "That photograph could not be read back from storage. It may still be uploading — try again in a moment.",
        };
      }

      const original = Buffer.from(await file.arrayBuffer());

      let result;
      try {
        result = await normaliseProductImage(original);
      } catch (error) {
        console.error(
          "[images] normalisation failed:",
          error instanceof Error ? error.message : "unknown",
        );
        return {
          ok: false,
          reason: "invalid",
          message:
            error instanceof Error && error.name === "ImagePipelineError"
              ? error.message
              : "That file could not be processed as a photograph.",
        };
      }

      const stem = stemOf(parsed.data.path);
      const widths: NormalisedUpload["widths"] = [];

      for (const variant of result.variants) {
        const path = derivativePath(stem, result.contentHash, variant.width);
        const { error } = await supabase.storage
          .from(PRODUCT_IMAGE_BUCKET)
          .upload(path, variant.data, {
            contentType: "image/webp",
            // Safe because the path is a function of the content: an overwrite
            // can only ever replace these bytes with the same bytes.
            upsert: true,
            // A year, because the path changes whenever the content does, so a
            // stale cache entry cannot exist.
            cacheControl: "31536000",
          });

        if (error) {
          console.error("[images] could not store a variant:", error.message);
          return {
            ok: false,
            reason: "error",
            message:
              "The photograph was processed but could not be saved. Nothing has been attached to a product.",
          };
        }

        widths.push({ width: variant.width, path, bytes: variant.bytes });
      }

      return {
        ok: true,
        canonicalPath: derivativePath(
          stem,
          result.contentHash,
          CANONICAL_EDGE,
        ),
        originalPath: parsed.data.path,
        widths,
        source: {
          width: result.source.width,
          height: result.source.height,
          format: result.source.format,
        },
        belowRecommended: result.belowRecommended,
        overBudget: result.variants
          .filter((variant) => variant.overBudget)
          .map((variant) => variant.width),
      };
    },
  );
}

/**
 * The recognisable part of a filename, for a human browsing the bucket.
 *
 * It carries no meaning — every path is identified by its hash — so it is
 * aggressively sanitised rather than carefully preserved.
 *
 * Not exported, and nothing else in this file may be either: a `"use server"`
 * module's exports are all treated as callable endpoints, so every one has to
 * be an async function. An exported constant here is a build failure, which is
 * how the first draft of this file ended (it re-exported
 * `MIN_RECOMMENDED_EDGE` for the uploader's convenience). Client code imports
 * that constant from `@/lib/images/pipeline` instead.
 */
function stemOf(path: string): string {
  const base = path.split("/").pop() ?? "image";
  return (
    base
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "image"
  );
}
