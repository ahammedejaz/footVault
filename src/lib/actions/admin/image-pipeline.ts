"use server";

import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";

import { adminAction, type AdminResult } from "@/lib/admin/guard";
import {
  CANONICAL_EDGE,
  derivativePath,
  findSubject,
  frameFor,
  normaliseProductImage,
  type Subject,
} from "@/lib/images/pipeline";
import {
  DEFAULT_CROP,
  fillOf,
  frameSubject,
  normaliseCrop,
  type Crop,
} from "@/lib/images/crop";
import { readTargetFill } from "@/lib/images/target-fill";
import { PRODUCT_IMAGE_BUCKET } from "@/lib/queries/admin/media";
import { CATALOG_CACHE_TAG } from "@/lib/queries/cached";

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
  /**
   * The owner's framing, or absent for "the whole photograph".
   *
   * Typed as unknown on purpose: the validator is `normaliseCrop`, which
   * clamps every field into range and fills in the missing ones rather than
   * refusing. A zod shape here would give the same six numbers a *second*
   * opinion about what is acceptable, and the browser calls `normaliseCrop`
   * too — so a crop the panel considered fine could be rejected by a rule only
   * this file knows, which is the drift this codebase keeps paying for.
   */
  crop: z.unknown().optional(),
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
  /**
   * The framing that was actually applied, normalised, or null for the whole
   * photograph.
   *
   * Echoed back for the same reason `originalPath` is: the caller thinks it
   * knows what it sent, and a second copy of that belief is a second place it
   * can be wrong. The row must record the crop the stored asset was cut with,
   * not the one the panel had in a state variable when it posted.
   */
  crop: Crop | null;
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

      const crop =
        parsed.data.crop == null ? null : normaliseCrop(parsed.data.crop);

      let result;
      try {
        result = await normaliseProductImage(original, crop);
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
        crop,
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

/* ------------------------------------------------------- auto-frame ------- */

const frameSchema = z.object({
  path: z
    .string()
    .trim()
    .min(1, "That is not a file.")
    .max(400)
    .refine((value) => !value.includes(".."), "That is not a file."),
  /**
   * The straighten angle already applied in the panel, so the box comes back
   * measured against the frame the owner is actually looking at. A subject
   * found on the unrotated frame would be a few percent out the moment the
   * slider moved, and the fill readout would be quietly wrong.
   */
  rotation: z.number().min(-45).max(45).optional(),
});

export type FramingProposal = {
  /** The frame the fractions below are fractions of. */
  frame: { width: number; height: number };
  /**
   * Where the shoe is, or **null when the photograph does not say**.
   *
   * Null is not an error and the panel must not present it as one — nor may it
   * hide it. Roughly a third of real photographs land here: a busy background,
   * a subject running into the top-left corner, a white shoe on a white table.
   * The panel says "couldn't find the shoe — centred instead", which invites a
   * correction, where a confident wrong crop would simply be approved.
   */
  subject: Subject | null;
  /** Where to start: framed to the target, or the whole photograph. */
  crop: Crop;
  /** What that crop achieves, so the readout has something true to say. */
  fill: number | null;
  /** The owner's target, so the panel draws its guide from the same number. */
  targetFill: number;
};

/**
 * Propose a framing for a photograph already in Storage.
 *
 * Server-side because the detection is `sharp`'s, and because the target fill
 * is a settings row — putting either in the browser would mean shipping a
 * second opinion about both.
 */
export async function proposeFrame(
  input: unknown,
): Promise<AdminResult<FramingProposal>> {
  return adminAction<FramingProposal>(
    "proposeFrame",
    "imageProcessing",
    async ({ elevated }) => {
      const parsed = frameSchema.safeParse(input);
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
        return {
          ok: false,
          reason: "error",
          message:
            "That photograph could not be read back from storage. It may still be uploading — try again in a moment.",
        };
      }

      const targetFill = await readTargetFill(supabase);

      let frame;
      let subject: Subject | null;
      try {
        frame = await frameFor(
          Buffer.from(await file.arrayBuffer()),
          parsed.data.rotation ?? 0,
          // Measuring, so the rotation is padded with the photograph's own
          // corner rather than with fog — see frameFor.
          true,
        );
        subject = await findSubject(frame.data);
      } catch (error) {
        console.error(
          "[images] could not frame:",
          error instanceof Error ? error.message : "unknown",
        );
        return {
          ok: false,
          reason: "invalid",
          message: "That file could not be read as a photograph.",
        };
      }

      const base = {
        ...DEFAULT_CROP,
        rotation: parsed.data.rotation ?? 0,
      };

      /**
       * The fallback is the **whole photograph**, not a guessed zoom.
       *
       * A centred crop at some plausible size would be inventing the one number
       * the detection just failed to supply, and it would look exactly like a
       * successful auto-frame. The whole frame is what the pipeline has always
       * produced, it is obviously not a decision, and it leaves the owner
       * somewhere honest to start dragging from.
       */
      if (!subject) {
        return {
          ok: true,
          frame: { width: frame.width, height: frame.height },
          subject: null,
          crop: base,
          fill: null,
          targetFill,
        };
      }

      const crop = frameSubject(
        subject,
        targetFill,
        frame.width,
        frame.height,
        base,
      );

      return {
        ok: true,
        frame: { width: frame.width, height: frame.height },
        subject,
        crop,
        fill: fillOf(subject, crop, frame.width, frame.height),
        targetFill,
      };
    },
  );
}

/* --------------------------------------------------------- re-crop ------- */

const recropSchema = z.object({
  imageId: z.string().uuid("That is not a photograph."),
  crop: z.unknown().optional(),
});

/**
 * Re-frame a photograph that is already on a product, from the original.
 *
 * ## Why this is possible at all
 *
 * `original_path` and `crop` between them mean the stored derivative is not the
 * only copy of anything: the untouched upload is still in the bucket, and the
 * six numbers say what was done to it. So re-framing is running the pipeline
 * again with different numbers — not a re-upload, and not an edit of a
 * previously edited picture, which would compound the compression every time.
 *
 * **A framing decision is therefore never permanent**, which is the point. The
 * owner can photograph thirty products at speed, see them side by side on the
 * contact sheet, and fix the two that sit wrong without going back to the shelf.
 *
 * ## What happens to the old derivative
 *
 * It stays in the bucket, unreferenced. Derivative paths are a hash of the
 * output, so a new crop writes four new objects and the row is repointed at
 * them; the previous four become unused files, which the media screen already
 * counts and reports.
 *
 * Deleting them here was considered and rejected on the owner's decision: a
 * delete path whose failure mode is removing a live product photograph is not
 * worth building to reclaim a few hundred kilobytes. The unused count is the
 * honest ledger, and a sweep can be written later when there is something to
 * sweep.
 */
export async function recropImage(
  input: unknown,
): Promise<AdminResult<{ url: string }>> {
  return adminAction<{ url: string }>(
    "recropImage",
    "imageProcessing",
    async ({ supabase, elevated }) => {
      const parsed = recropSchema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          reason: "invalid",
          message: parsed.error.issues[0]?.message ?? "Check that and try again.",
        };
      }

      const { data: row, error: readError } = await supabase
        .from("product_images")
        .select("id, product_id, original_path")
        .eq("id", parsed.data.imageId)
        .single();

      if (readError || !row) {
        return {
          ok: false,
          reason: "invalid",
          message: "That photograph is no longer on this product.",
        };
      }

      /**
       * The one honest refusal. A row with no original is a photograph whose
       * only copy is already cropped — a seed placeholder, or an upload from
       * before the pipeline kept originals — and re-cropping the derivative
       * would crop a crop.
       */
      if (!row.original_path) {
        return {
          ok: false,
          reason: "invalid",
          message:
            "This one has no original kept, so it cannot be re-framed. Upload the photograph again and it will be framed from the start.",
        };
      }

      const elevatedClient = elevated();
      const { data: file, error: downloadError } = await elevatedClient.storage
        .from(PRODUCT_IMAGE_BUCKET)
        .download(row.original_path);

      if (downloadError || !file) {
        return {
          ok: false,
          reason: "error",
          message: "The original could not be read back from storage.",
        };
      }

      const crop =
        parsed.data.crop == null ? null : normaliseCrop(parsed.data.crop);

      let result;
      try {
        result = await normaliseProductImage(
          Buffer.from(await file.arrayBuffer()),
          crop,
        );
      } catch (error) {
        console.error(
          "[images] re-crop failed:",
          error instanceof Error ? error.message : "unknown",
        );
        return {
          ok: false,
          reason: "invalid",
          message: "That original could not be processed as a photograph.",
        };
      }

      const stem = stemOf(row.original_path);
      for (const variant of result.variants) {
        const path = derivativePath(stem, result.contentHash, variant.width);
        const { error } = await elevatedClient.storage
          .from(PRODUCT_IMAGE_BUCKET)
          .upload(path, variant.data, {
            contentType: "image/webp",
            upsert: true,
            cacheControl: "31536000",
          });
        if (error) {
          return {
            ok: false,
            reason: "error",
            message:
              "The photograph was re-framed but could not be saved. Nothing on the product has changed.",
          };
        }
      }

      const { data: publicUrl } = elevatedClient.storage
        .from(PRODUCT_IMAGE_BUCKET)
        .getPublicUrl(
          derivativePath(stem, result.contentHash, CANONICAL_EDGE),
        );

      /**
       * The row is repointed **after** every variant is stored, so a failure
       * midway leaves the product showing the framing it had. The alternative
       * ordering trades a stray unused file for a product page pointing at an
       * object that does not exist.
       */
      const { error: updateError } = await supabase
        .from("product_images")
        .update({ url: publicUrl.publicUrl, crop })
        .eq("id", row.id);

      if (updateError) {
        return {
          ok: false,
          reason: "error",
          message: "The photograph was re-framed but the product was not updated.",
        };
      }

      /**
       * The slug is only needed to revalidate one extra path, so a failure here
       * is worth reporting and not worth failing on: the re-crop has already
       * landed, and the blunt `revalidatePath("/", "layout")` below still
       * clears the rendered pages. Swallowing the error entirely is what the
       * lint rule exists to stop — a read that silently returns nothing looks
       * exactly like a product with no slug.
       */
      const { data: product, error: slugError } = await supabase
        .from("products")
        .select("slug")
        .eq("id", row.product_id)
        .single();

      if (slugError) {
        console.error(
          "[images] re-crop could not read the slug to revalidate:",
          slugError.message,
        );
      }

      /**
       * The same pair `addProductImage` makes, and for the same reasons its
       * own comment gives at length: `updateTag` for read-your-own-writes on
       * the cached data, and `revalidatePath` because `/product/[slug]` caches
       * the rendered page separately from the data inside it. A re-crop changes
       * the URL on the row, so a stale render would keep serving the old
       * framing from a path that still resolves.
       *
       * Written out here rather than imported: `products.ts` is a `"use
       * server"` module, so every one of its exports is a callable endpoint and
       * a shared helper cannot be exported from it.
       */
      updateTag(CATALOG_CACHE_TAG);
      revalidatePath("/", "layout");
      if (product?.slug) revalidatePath(`/product/${product.slug}`);
      revalidatePath("/admin/products");
      revalidatePath(`/admin/products/${row.product_id}`);

      return { ok: true, url: publicUrl.publicUrl };
    },
  );
}
