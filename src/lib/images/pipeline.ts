import "server-only";

import { createHash } from "node:crypto";

import sharp from "sharp";

import {
  CANONICAL_EDGE,
  CANONICAL_WIDTHS,
  CARD_SURFACE,
  MIN_RECOMMENDED_EDGE,
  PIPELINE_VERSION,
  VARIANT_BUDGET_BYTES,
} from "./constants";

/**
 * Turning whatever the owner photographed into an asset the catalogue can use.
 *
 * The problem this solves is not file size and it is not format. It is that a
 * grid of shoes photographed by one person on one phone over several weeks does
 * not look like a catalogue unless something makes it. One shoe fills its card
 * edge to edge, the next floats in the middle of a bedspread, a third arrives
 * on its side because the phone was held in portrait. The card frame cannot fix
 * that — it is the same frame for all three.
 *
 * ## The frame, and why the output is square
 *
 * `ProductCard` renders into `aspect-4/5` with `object-contain` over
 * `bg-fog`, so nothing is ever cropped by the card and the letterboxing is
 * already fog-coloured. What the card cannot do is make two differently-shaped
 * photographs occupy the *same proportion* of that frame.
 *
 * So the canonical asset is **square**, with the shoe contained inside it and
 * the remainder padded in the card's own surface colour. A square dropped into
 * a 4:5 frame with `object-contain` letterboxes top and bottom — in fog, over
 * fog, so the seam does not exist — and every product now presents at an
 * identical scale regardless of how it was shot.
 *
 * The brief asked for "the card's aspect ratio" in one sentence and for a
 * square asset in its gate. Square is the one that produces the consistency
 * both sentences are after, and because the pad colour and the frame colour are
 * the same value it is indistinguishable from the alternative.
 *
 * ## Never crop
 *
 * `fit: "contain"`. A shoe is the subject and the subject is the whole object —
 * `cover` would take the toe off a low-cut sandal to satisfy a ratio. Padding
 * is free and a cropped product photograph is a reshoot.
 *
 * ## Orientation before stripping
 *
 * `.rotate()` with no argument applies the EXIF orientation tag and then, since
 * nothing here calls `withMetadata()`, sharp writes no EXIF at all. Order
 * matters and is the whole trick: strip first and a portrait phone photograph
 * is permanently sideways, because the only record of which way was up has been
 * deleted. Rotate first and the pixels are correct without needing the tag, so
 * dropping it costs nothing.
 *
 * Stripping is not only hygiene. A phone photograph carries GPS coordinates,
 * and the coordinates of the room the shoes were photographed in are the
 * owner's home address.
 *
 * ## Determinism
 *
 * The same bytes in produce the same bytes out, because every parameter below
 * is fixed and none of them is derived from the clock, a random source or the
 * file's name. That is what makes reprocessing safe to run repeatedly: paths
 * are derived from the content hash and the pipeline version, so a second run
 * over an unchanged original writes the identical object to the identical path
 * and the catalogue does not so much as flicker.
 */

/**
 * Every tunable lives in `./constants`, which has no imports and is therefore
 * readable from the browser too. See that file for why they are not declared
 * here: the admin panel has to state the same recommendation this module
 * enforces, and one truth typed twice is the mistake this codebase keeps
 * paying for.
 */
export {
  CARD_SURFACE,
  CANONICAL_WIDTHS,
  CANONICAL_EDGE,
  PIPELINE_VERSION,
  MIN_RECOMMENDED_EDGE,
  RECOMMENDED_EDGE,
  VARIANT_BUDGET_BYTES,
} from "./constants";

/**
 * Fixed, because determinism is a property of this object staying constant.
 *
 * `effort: 6` is slower than the default and smaller; this runs once per image
 * on an upload the owner is already waiting on, not per request.
 */
const WEBP_OPTIONS = { quality: 82, effort: 6 } as const;

export type SourceInfo = {
  width: number;
  height: number;
  format: string;
  /** What the EXIF tag said before it was applied and dropped. 1 means upright. */
  orientation: number;
  bytes: number;
};

export type Variant = {
  width: number;
  height: number;
  bytes: number;
  data: Buffer;
  /** Over `VARIANT_BUDGET_BYTES`. Reported, never silently dropped. */
  overBudget: boolean;
};

export type NormalisedImage = {
  source: SourceInfo;
  variants: Variant[];
  /**
   * Identifies the *output*, so it is a function of the bytes and of every
   * parameter that shaped them. Two uploads of the same photograph collapse to
   * one set of objects; a pipeline change gives every image a new identity.
   */
  contentHash: string;
  /** True when the source was smaller than `MIN_RECOMMENDED_EDGE` on a side. */
  belowRecommended: boolean;
};

/**
 * Read what the file claims to be, without processing it.
 *
 * Split out because the admin needs the dimensions to warn about a small
 * photograph *before* committing to a several-second normalisation, and because
 * a file that sharp cannot parse should fail here with something sayable rather
 * than midway through a resize.
 */
export async function inspect(input: Buffer): Promise<SourceInfo> {
  const meta = await sharp(input, { failOn: "none" }).metadata();

  if (!meta.width || !meta.height) {
    throw new ImagePipelineError(
      "That file could not be read as an image. If it came from a messaging " +
        "app, try the original from the camera roll instead.",
    );
  }

  /**
   * EXIF orientations 5–8 are the transposed ones: the stored pixels are
   * landscape and the tag says to stand them up, or the reverse. `meta.width`
   * is the *stored* width, so for those four values the dimensions a human
   * would report are the other way round. Reporting the stored pair would tell
   * the owner their 3000×4000 portrait photograph is 4000×3000.
   */
  const swapped = (meta.orientation ?? 1) >= 5;

  return {
    width: swapped ? meta.height : meta.width,
    height: swapped ? meta.width : meta.height,
    format: meta.format ?? "unknown",
    orientation: meta.orientation ?? 1,
    bytes: input.byteLength,
  };
}

/**
 * The pipeline. One original in, the full set of canonical variants out.
 *
 * Nothing here touches Storage or the database — it is a pure function of the
 * bytes, which is what lets the gate run it over awkward fixtures without a
 * network, and what lets the reprocessor run it over an original it fetched.
 */
export async function normaliseProductImage(
  input: Buffer,
): Promise<NormalisedImage> {
  const source = await inspect(input);

  /**
   * One decoded, oriented, flattened square, reused for every width.
   *
   * Built once rather than per variant for a reason beyond speed: resizing the
   * *original* four times would let each output round the contain-padding
   * independently, so the shoe could sit a pixel off-centre at one width and
   * not another. Downscaling a single square keeps every variant the same
   * picture.
   *
   * `flatten` before `resize` because a PNG with a transparent background would
   * otherwise composite against the pad colour only where the pad is, leaving
   * the subject's own transparency to become black in a format that has no
   * alpha channel to put it in.
   */
  /**
   * **Enlargement is allowed, deliberately.**
   *
   * `withoutEnlargement: true` is the instinctive setting and it defeats the
   * purpose of the whole module. It caps the *subject* at its original size
   * while `contain` still pads the canvas out to 1600, so a 900px photograph
   * becomes a small shoe adrift in a large fog square — which is precisely the
   * "one shoe fills its card, the next floats in the middle" inconsistency this
   * pipeline exists to remove, reintroduced by the pipeline itself.
   *
   * So a small source is scaled up to fill the frame like every other one. What
   * that costs is sharpness, and the honest place to pay it is at the point of
   * choosing the file: `belowRecommended` drives a warning under
   * `MIN_RECOMMENDED_EDGE` in the admin, before the owner commits.
   */
  const square = await sharp(input, { failOn: "none" })
    .rotate()
    .flatten({ background: CARD_SURFACE })
    .resize(CANONICAL_EDGE, CANONICAL_EDGE, {
      fit: "contain",
      background: CARD_SURFACE,
    })
    .png()
    .toBuffer();

  const variants: Variant[] = [];
  for (const width of CANONICAL_WIDTHS) {
    const data = await sharp(square)
      .resize(width, width, { fit: "contain", background: CARD_SURFACE })
      .webp(WEBP_OPTIONS)
      .toBuffer();

    const budget = VARIANT_BUDGET_BYTES[width] ?? Number.POSITIVE_INFINITY;
    variants.push({
      width,
      height: width,
      bytes: data.byteLength,
      data,
      overBudget: data.byteLength > budget,
    });
  }

  const hash = createHash("sha256");
  hash.update(`v${PIPELINE_VERSION}:${CARD_SURFACE}:${CANONICAL_EDGE}`);
  for (const variant of variants) hash.update(variant.data);

  return {
    source,
    variants,
    contentHash: hash.digest("hex").slice(0, 16),
    belowRecommended:
      source.width < MIN_RECOMMENDED_EDGE ||
      source.height < MIN_RECOMMENDED_EDGE,
  };
}

/**
 * Where a variant lives, derived rather than stored.
 *
 * Deriving it means a reprocess does not need to remember anything: given the
 * same original it recomputes the same hash and therefore the same paths, so
 * re-running is a no-op rather than a duplicate. `stem` is carried through only
 * so a human browsing the bucket can tell what they are looking at.
 */
export function derivativePath(
  stem: string,
  contentHash: string,
  width: number,
): string {
  return `derived/v${PIPELINE_VERSION}/${contentHash}/${stem}-${width}.webp`;
}

/** Where the untouched upload is kept, so the pipeline can be re-run over it. */
export function originalPath(stem: string, uploadId: string, extension: string) {
  return `originals/${uploadId}-${stem}.${extension}`;
}

export class ImagePipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImagePipelineError";
  }
}
