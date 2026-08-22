import "server-only";

import { createHash } from "node:crypto";

import sharp, { type Sharp } from "sharp";

import { MAX_DECODED_PIXELS } from "./constants";
import {
  clampFraming,
  frameRect,
  MAX_ADJUSTMENT,
  normaliseFraming,
  type Framing,
} from "./frame";
import { ImagePipelineError, inspect, type SourceInfo } from "./pipeline";
import { aspectOf, IMAGE_FRAMES, type FrameKey } from "./site-frames";

/**
 * Cutting one site picture to one frame.
 *
 * ## What this shares with the product pipeline, and what it deliberately does
 * not
 *
 * It shares the *decode* — `inspect()` and the pixel limit that makes opening
 * an untrusted file safe — because those are properties of "bytes somebody
 * uploaded" rather than of what the picture is for, and a second implementation
 * of the decode limit is a second place for it to be wrong.
 *
 * It does not share the **output**. `normaliseProductImage` produces four
 * canonical widths of a padded square, because a product photograph is drawn at
 * four sizes in a catalogue whose whole value is that they match. A hero is
 * drawn in one place at one shape; four widths of it would be four files nobody
 * requests. So this produces exactly one derivative, at the size the frame says.
 *
 * ## Why the original is kept and the derivative is disposable
 *
 * The derivative is a *function* of (original, frame, framing) and holds no
 * information of its own. That is what makes re-adjusting cheap — the owner
 * moves the picture, this runs again over the same original — and it is what
 * makes a frame that changes shape next year recoverable: every row carrying
 * that frame can be re-rendered from what is already in the bucket, with no
 * upload and no loss.
 *
 * It also means the content hash must cover every input. Two owners uploading
 * the same stock photograph should collapse to one object; the same photograph
 * framed differently must not.
 */

/** How an untrusted buffer is opened. See `SOURCE_DECODE` in pipeline.ts. */
const SOURCE_DECODE = {
  failOn: "none",
  limitInputPixels: MAX_DECODED_PIXELS,
} as const;

/** Fixed, so the output is a function of its inputs and nothing else. */
const WEBP_OPTIONS = { quality: 82, effort: 6 } as const;

/**
 * `compressionLevel: 9` because a favicon is fetched on every cold page load
 * and is a few kilobytes either way; the extra encode time is paid once, here.
 */
const PNG_OPTIONS = { compressionLevel: 9 } as const;

/**
 * Anywhere `contain` leaves room around the artwork, the pixels added are fully
 * transparent — the same decision `pipeline.ts` made in v2, for the same
 * reason: a logo padded to a colour is a logo with a rectangle behind it the
 * moment the header's surface changes.
 */
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 } as const;

export type RenderedSiteImage = {
  data: Buffer;
  width: number;
  height: number;
  bytes: number;
  format: "webp" | "png";
  /** `image/webp` or `image/png`, for the Storage upload. */
  contentType: string;
  /** Identifies the output: bytes in, frame, and every framing number. */
  contentHash: string;
  source: SourceInfo;
  /** The framing actually applied, after clamping. What gets stored. */
  framing: Framing;
};

/**
 * One original in, the one derivative the frame asks for out.
 *
 * Pure — nothing here touches Storage or the database — so a gate can run it
 * over a constructed fixture with no network, which is what
 * `audit:site-images` does.
 */
export async function renderSiteImage(
  input: Buffer,
  frame: FrameKey,
  requested: Framing,
): Promise<RenderedSiteImage> {
  const spec = IMAGE_FRAMES[frame];
  const source = await inspect(input);

  /*
    Orientation first, and before anything measures anything.

    A phone photograph is very often stored landscape with an EXIF tag saying
    "stand this up". `inspect()` already reports the dimensions a human would
    see, so the framing numbers the owner produced in the browser are against
    the *upright* picture — the browser applies the tag when it renders. If the
    extract below ran on the stored pixels it would cut a rectangle rotated 90°
    from the one the owner drew. `.rotate()` with no argument applies the tag
    and drops it, which puts the buffer into the same orientation the browser
    and the owner were both looking at.
  */
  const upright = sharp(input, SOURCE_DECODE).rotate();

  const framing = clampFraming(
    source.width,
    source.height,
    aspectOf(frame),
    normaliseFraming(requested),
  );

  let pipeline: Sharp =
    spec.mode === "cover"
      ? covered(upright, source, frame, framing)
      : contained(upright, spec.width, spec.height);

  pipeline = adjusted(pipeline, framing);

  const data =
    spec.format === "png"
      ? await pipeline.png(PNG_OPTIONS).toBuffer()
      : await pipeline.webp(WEBP_OPTIONS).toBuffer();

  return {
    data,
    width: spec.width,
    height: spec.height,
    bytes: data.byteLength,
    format: spec.format,
    contentType: spec.format === "png" ? "image/png" : "image/webp",
    contentHash: hashOf(input, frame, framing),
    source,
    framing,
  };
}

/**
 * The photograph, cut to the frame's rectangle and scaled to its size.
 *
 * `frameRect` is imported rather than recomputed, and that is the whole
 * correctness argument for this module: the browser previewed the rectangle
 * this function is about to cut. A second implementation here would let the
 * owner approve a picture the shop is not about to store.
 */
function covered(
  pipeline: Sharp,
  source: SourceInfo,
  frame: FrameKey,
  framing: Framing,
): Sharp {
  const spec = IMAGE_FRAMES[frame];
  const rect = frameRect(
    source.width,
    source.height,
    aspectOf(frame),
    framing,
  );

  return pipeline
    .extract({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    })
    /*
      `fit: "fill"` and not `"cover"`. The extract already has the frame's
      aspect to within the one pixel `frameRect` rounds by, so "cover" would
      re-crop that pixel away and "fill" scales it. Between losing a pixel row
      and stretching by 1/900th, the stretch is invisible and the crop is a
      second, unaccounted framing decision.
    */
    .resize(spec.width, spec.height, { fit: "fill" });
}

/**
 * The whole artwork inside the box, on transparency, never enlarged.
 *
 * `withoutEnlargement` matters for a logo: an owner who uploads a 200px-wide
 * mark and gets it upscaled to 540 sees a blurry header and no explanation.
 * Left at its own size inside a larger transparent canvas, it renders crisply
 * and simply occupies less of the box — which is a thing they can see and fix
 * by uploading better artwork.
 */
function contained(pipeline: Sharp, width: number, height: number): Sharp {
  return pipeline.resize(width, height, {
    fit: "contain",
    withoutEnlargement: true,
    background: TRANSPARENT,
  });
}

/**
 * Brightness and contrast, on the same curve the product crop tool uses.
 *
 * Deliberately the same arithmetic as `pipeline.ts`'s `adjusted()` — an owner
 * who has learned what "+20 brightness" does to a shoe should get the same
 * change out of it on a hero. Contrast pivots on mid-grey rather than black,
 * so reaching for contrast does not also brighten.
 */
function adjusted(pipeline: Sharp, framing: Framing): Sharp {
  let out = pipeline;
  if (framing.brightness !== 0) {
    out = out.modulate({
      brightness: 1 + clampAdjustment(framing.brightness) / (MAX_ADJUSTMENT * 2.5),
    });
  }
  if (framing.contrast !== 0) {
    const slope = 1 + clampAdjustment(framing.contrast) / (MAX_ADJUSTMENT * 2.5);
    out = out.linear(slope, 128 * (1 - slope));
  }
  return out;
}

function clampAdjustment(value: number): number {
  return Math.min(MAX_ADJUSTMENT, Math.max(-MAX_ADJUSTMENT, value));
}

/**
 * Identifies the output rather than the input.
 *
 * Every number that shapes the result is in the hash, so re-framing produces a
 * new path and the old URL keeps serving the old bytes until nothing points at
 * it. That is what makes the derivative safe to cache for a year: a given URL's
 * pixels can never change.
 */
function hashOf(input: Buffer, frame: FrameKey, framing: Framing): string {
  return createHash("sha256")
    .update(input)
    .update(frame)
    .update(
      [
        framing.cx,
        framing.cy,
        framing.zoom,
        framing.brightness,
        framing.contrast,
      ].join(":"),
    )
    .digest("hex")
    .slice(0, 16);
}

export { ImagePipelineError };
