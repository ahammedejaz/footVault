"use server";

import { updateTag } from "next/cache";
import { z } from "zod";

import { adminAction, type AdminResult } from "@/lib/admin/guard";
import {
  MAX_ADJUSTMENT,
  MAX_ZOOM,
  MIN_ZOOM,
  normaliseFraming,
  type Framing,
} from "@/lib/images/frame";
import {
  ALLOWED_SOURCE_TYPES,
  IMAGE_FRAMES,
  isFrameKey,
  MAX_SOURCE_BYTES,
  SITE_ASSET_BUCKET,
  type FrameKey,
} from "@/lib/images/site-frames";
import { ImagePipelineError, renderSiteImage } from "@/lib/images/site-pipeline";
import { slotPathSegment } from "@/lib/images/site-image";
import { MISSING_TABLE_MESSAGE } from "@/lib/queries/admin/site-images";
import { CATALOG_CACHE_TAG, CHROME_CACHE_TAG } from "@/lib/queries/cached";

/**
 * Putting a picture into a place on the site, and moving it around inside its
 * frame afterwards.
 *
 * ## Three actions, because there are three different things an owner does
 *
 * `requestSiteImageUpload` mints a one-shot signed URL and the **bytes never
 * touch a Server Action**. This is the same reasoning `media.ts` writes out at
 * length: `serverActions.bodySizeLimit` defaults to 1MB, under a quarter of
 * what this bucket accepts and well under a phone photograph, and the failure
 * when it binds says nothing about size. The authorization decision is still
 * made here — the browser gets a URL scoped to exactly one path and nothing
 * else — and the bucket re-checks type and size on arrival.
 *
 * `saveSiteImage` runs after the original has landed. It fetches those bytes
 * back out of Storage, renders the derivative, and records the row. Fetching
 * back is a round trip that could have been avoided by streaming the file
 * through the server, and the round trip is the cheaper mistake: streaming
 * means holding the upload open across a function that also runs sharp, and a
 * timeout there loses the file the owner is standing there waiting for.
 *
 * `reframeSiteImage` is the one that justifies the table. The original is still
 * in the bucket, so moving the picture inside its frame next month costs an
 * arithmetic change and a re-render — no upload, no hunting for the file, and
 * no loss of quality from re-cutting an already-cut derivative.
 *
 * ## What these actions deliberately do NOT do
 *
 * They do not write the URL into the page. `saveSiteImage` returns it and the
 * form the owner is standing in front of saves it with everything else on that
 * form. Two reasons, and the second is the one that matters: a category's
 * picture and its name should be one Save, because an owner who changes both
 * and then presses Cancel expects both to be discarded; and coupling this to
 * every surface's own write would put a `switch` over surfaces in here, which
 * is how a shared control stops being shared.
 *
 * The cost is honest and small: an owner who uploads a picture and then
 * abandons the form leaves an unreferenced file in the bucket. `/admin/media`
 * can see and delete it. The same trade-off the hero video uploader has made
 * since Phase 10.
 */

/* -------------------------------------------------------------------------- */
/* 1 · the upload slot                                                        */
/* -------------------------------------------------------------------------- */

const frameKey = z.string().refine(isFrameKey, "That is not a place on this site.");

const slotKey = z
  .string()
  .trim()
  .min(1, "That picture has no place to go.")
  .max(160)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, "That is not a slot this panel writes to.");

const uploadSchema = z.object({
  slot: slotKey,
  frame: frameKey,
  fileName: z.string().trim().min(1, "That file has no name.").max(200),
  contentType: z.string().trim().min(1),
  sizeBytes: z
    .number()
    .int()
    .positive("That file is empty.")
    .max(
      MAX_SOURCE_BYTES,
      `Pictures have to be under ${Math.round(MAX_SOURCE_BYTES / (1024 * 1024))}MB. Export it smaller and try again.`,
    ),
});

export type SiteUploadSlot = {
  bucket: string;
  path: string;
  /** Single-use. Spend it with `uploadToSignedUrl` and it is gone. */
  token: string;
};

export async function requestSiteImageUpload(
  input: unknown,
): Promise<AdminResult<SiteUploadSlot>> {
  return adminAction<SiteUploadSlot>(
    "requestSiteImageUpload",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = uploadSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const type = parsed.data.contentType.split(";")[0]?.trim() ?? "";
      if (!(ALLOWED_SOURCE_TYPES as readonly string[]).includes(type)) {
        return {
          ok: false,
          reason: "invalid",
          field: "contentType",
          message:
            "Pictures only — JPEG, PNG, WebP or AVIF. SVG is refused on purpose: it can carry script, and the original stays in a public folder where a browser would render it unsandboxed.",
        };
      }

      /*
        The original keeps its uploaded extension because it is never served to
        a customer — only fetched back by `saveSiteImage` and `reframeSiteImage`
        — and sharp reads the format from the bytes. Naming it by content type
        would be a second claim about the file that could disagree with the
        first.
      */
      const path = `originals/${slotPathSegment(parsed.data.slot)}/${stamp()}.${extensionFor(type)}`;

      const { data, error } = await supabase.storage
        .from(SITE_ASSET_BUCKET)
        .createSignedUploadUrl(path);

      if (error) {
        console.error("[admin] site image signed upload failed:", error.message);
        return {
          ok: false,
          reason: "error",
          message: "The upload could not be started. Try again in a moment.",
        };
      }

      return { ok: true, bucket: SITE_ASSET_BUCKET, path: data.path, token: data.token };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* 2 · rendering it into its frame                                            */
/* -------------------------------------------------------------------------- */

const framingSchema = z.object({
  cx: z.number().min(0).max(1),
  cy: z.number().min(0).max(1),
  zoom: z.number().min(MIN_ZOOM).max(MAX_ZOOM),
  brightness: z.number().min(-MAX_ADJUSTMENT).max(MAX_ADJUSTMENT),
  contrast: z.number().min(-MAX_ADJUSTMENT).max(MAX_ADJUSTMENT),
});

/**
 * Alternative text, and why it is capped rather than required.
 *
 * A picture behind a department tile is decorative — the tile's own words are
 * the link text, and `home-sections.tsx` marks the image `aria-hidden` for
 * exactly that reason. Requiring a sentence there would produce one, and a
 * screen reader would read the department twice. So it is optional everywhere
 * and the fields that genuinely need it (the logo) say so in their own hint.
 */
const altField = z
  .string()
  .trim()
  .max(200, "Keep the description under 200 characters.")
  .nullish()
  .transform((value) => (value ? value : null));

const saveSchema = z.object({
  slot: slotKey,
  frame: frameKey,
  originalPath: z
    .string()
    .trim()
    .min(1)
    .max(300)
    /*
      The browser hands this back after the upload, so it is caller-supplied and
      must be pinned to the prefix this action minted. Without it a hostile
      admin — or a bug — could name any object in the bucket, and the row would
      claim an original it does not own.
    */
    .refine(
      (value) => value.startsWith("originals/") && !value.includes(".."),
      "That is not a file this panel uploaded.",
    ),
  framing: framingSchema,
  alt: altField,
});

export type SavedSiteImage = {
  url: string;
  width: number;
  height: number;
  framing: Framing;
  /**
   * Where the untouched upload landed, and how big it is.
   *
   * Handed back so the field can offer **Adjust** the instant the first save
   * returns, without a round trip to re-read the row it just wrote. Framing
   * needs the original and its dimensions; a field that could only offer the
   * control after a page reload would teach the owner that adjusting is a
   * separate errand rather than part of putting a picture in place.
   */
  originalPath: string;
  sourceWidth: number;
  sourceHeight: number;
  /** True when the picture was smaller than the frame it had to fill. */
  upscaled: boolean;
};

export async function saveSiteImage(
  input: unknown,
): Promise<AdminResult<SavedSiteImage>> {
  return adminAction<SavedSiteImage>(
    "saveSiteImage",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = saveSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);
      const { slot, frame, originalPath, framing, alt } = parsed.data;

      return renderAndRecord(supabase, {
        slot,
        frame: frame as FrameKey,
        originalPath,
        framing,
        alt,
      });
    },
  );
}

const reframeSchema = z.object({
  slot: slotKey,
  framing: framingSchema,
  alt: altField,
});

/**
 * Move the picture inside its frame, from the original already in the bucket.
 *
 * The frame and the original path are read from the row rather than accepted
 * from the caller — the caller is adjusting a picture that exists, and letting
 * it also say *which* picture and *what shape* would make this a second, weaker
 * copy of `saveSiteImage`.
 */
export async function reframeSiteImage(
  input: unknown,
): Promise<AdminResult<SavedSiteImage>> {
  return adminAction<SavedSiteImage>(
    "reframeSiteImage",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = reframeSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const { data: row, error } = await supabase
        .from("site_images")
        .select("frame, original_path")
        .eq("slot", parsed.data.slot)
        .maybeSingle();

      if (error) {
        console.error("[admin] reframe read failed:", error.message);
        return { ok: false, reason: "error", message: "That picture could not be read." };
      }
      if (!row || !isFrameKey(row.frame)) {
        return {
          ok: false,
          reason: "conflict",
          message:
            "There is no picture here to adjust any more. Upload one and it will be framed fresh.",
        };
      }

      return renderAndRecord(supabase, {
        slot: parsed.data.slot,
        frame: row.frame,
        originalPath: row.original_path,
        framing: parsed.data.framing,
        alt: parsed.data.alt,
      });
    },
  );
}

/**
 * The shared half: fetch the original, render it, store it, record it.
 *
 * `upsert` on the slot rather than insert-or-update, so re-uploading into a
 * place replaces what is there. The previous derivative is deliberately **not**
 * deleted: the URL of it may still be sitting in a `categories.image_url` the
 * owner has not saved yet, and in a CDN, and in a page a customer has open. A
 * few kilobytes is a much cheaper mistake than a broken picture on a live shop,
 * and `/admin/media` can sweep the bucket.
 */
async function renderAndRecord(
  supabase: Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>,
  input: {
    slot: string;
    frame: FrameKey;
    originalPath: string;
    framing: Framing;
    alt: string | null;
  },
): Promise<AdminResult<SavedSiteImage>> {
  const { data: file, error: downloadError } = await supabase.storage
    .from(SITE_ASSET_BUCKET)
    .download(input.originalPath);

  if (downloadError || !file) {
    console.error(
      "[admin] site image original unreadable:",
      downloadError?.message ?? "no body",
    );
    return {
      ok: false,
      reason: "error",
      message:
        "The uploaded file could not be read back. Try uploading it again — nothing has been changed.",
    };
  }

  const source = Buffer.from(await file.arrayBuffer());

  let rendered;
  try {
    rendered = await renderSiteImage(source, input.frame, normaliseFraming(input.framing));
  } catch (thrown) {
    if (thrown instanceof ImagePipelineError) {
      return { ok: false, reason: "invalid", message: thrown.message, field: "file" };
    }
    throw thrown;
  }

  const spec = IMAGE_FRAMES[input.frame];
  const renderedPath =
    `rendered/${slotPathSegment(input.slot)}/${rendered.contentHash}.${spec.format}`;

  const { error: uploadError } = await supabase.storage
    .from(SITE_ASSET_BUCKET)
    .upload(renderedPath, rendered.data, {
      contentType: rendered.contentType,
      /*
        A year, immutable — the same decision the video bucket documents. The
        path carries a hash of the bytes *and* of every framing number, so a
        given URL's pixels can never change. Re-framing produces a different
        path, which is what makes this safe rather than merely fast.
      */
      cacheControl: "31536000",
      upsert: true,
    });

  if (uploadError) {
    console.error("[admin] site image store failed:", uploadError.message);
    return {
      ok: false,
      reason: "error",
      message: "The framed picture could not be stored. Try again in a moment.",
    };
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from(SITE_ASSET_BUCKET).getPublicUrl(renderedPath);

  const { error: writeError } = await supabase.from("site_images").upsert(
    {
      slot: input.slot,
      frame: input.frame,
      original_path: input.originalPath,
      original_width: rendered.source.width,
      original_height: rendered.source.height,
      framing: rendered.framing,
      rendered_path: renderedPath,
      rendered_url: publicUrl,
      rendered_width: rendered.width,
      rendered_height: rendered.height,
      alt: input.alt,
    },
    { onConflict: "slot" },
  );

  if (writeError) {
    console.error("[admin] site image row failed:", writeError.message);
    /*
      The one failure the owner can act on, told apart from the ones they
      cannot. In the window between this code deploying and its migration being
      applied, every upload lands here — and "try again" is advice that cannot
      possibly work, which is the worst kind of error message: it sends somebody
      to repeat a thing that will fail identically.
    */
    if (
      writeError.code === "PGRST205" ||
      /could not find the table/i.test(writeError.message)
    ) {
      return { ok: false, reason: "error", message: MISSING_TABLE_MESSAGE };
    }
    return {
      ok: false,
      reason: "error",
      message:
        "The picture was stored but not recorded, so adjusting it later would not work. Try again.",
    };
  }

  /*
    Both tags, because a site image can be either kind of thing and this action
    does not know which. The logo is chrome; a department tile is catalog. Two
    tag expiries on an action the owner runs a handful of times a week is not a
    cost worth reasoning about, and guessing wrong means the owner uploads a
    picture, reloads, and sees the old one — the exact failure that makes people
    stop trusting an admin panel.
  */
  updateTag(CHROME_CACHE_TAG);
  updateTag(CATALOG_CACHE_TAG);

  return {
    ok: true,
    url: publicUrl,
    width: rendered.width,
    height: rendered.height,
    framing: rendered.framing,
    originalPath: input.originalPath,
    sourceWidth: rendered.source.width,
    sourceHeight: rendered.source.height,
    upscaled:
      rendered.source.width < spec.width || rendered.source.height < spec.height,
  };
}

/* -------------------------------------------------------------------------- */
/* 3 · taking it away                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Forget the framing for a slot.
 *
 * The *field* is cleared by the form that owns it — this only drops the record
 * that made re-adjusting possible, so a slot the owner has emptied does not
 * come back with last month's crop the next time they upload.
 *
 * The files stay in the bucket. See `renderAndRecord` for why: a URL that is
 * still referenced somewhere the owner has not saved yet must keep resolving.
 */
export async function clearSiteImage(
  input: unknown,
): Promise<AdminResult<object>> {
  return adminAction<object>(
    "clearSiteImage",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = z.object({ slot: slotKey }).safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const { error } = await supabase
        .from("site_images")
        .delete()
        .eq("slot", parsed.data.slot);

      if (error) {
        console.error("[admin] clearSiteImage failed:", error.message);
        return { ok: false, reason: "error", message: "That could not be removed." };
      }

      updateTag(CHROME_CACHE_TAG);
      updateTag(CATALOG_CACHE_TAG);
      return { ok: true };
    },
  );
}

/* -------------------------------------------------------------------------- */

function extensionFor(contentType: string): string {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/png") return "png";
  if (contentType === "image/avif") return "avif";
  return "webp";
}

/**
 * A collision-proof name that is not a timestamp.
 *
 * Two uploads into the same slot in the same millisecond is not the case worth
 * defending against — an owner replacing a picture twice in a row is, and a
 * name that sorts by time tells the next person which original is current
 * without opening them.
 */
function stamp(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
