import "server-only";

import { createHash } from "node:crypto";

import sharp, { type Sharp } from "sharp";

import {
  CANONICAL_EDGE,
  CANONICAL_WIDTHS,
  CARD_SURFACE,
  MAX_DECODED_PIXELS,
  MIN_RECOMMENDED_EDGE,
  PIPELINE_VERSION,
  VARIANT_BUDGET_BYTES,
} from "./constants";
import {
  MAX_ADJUSTMENT,
  paddingFor,
  resolveCrop,
  type Crop,
} from "./crop";

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
 * `bg-photo`, so nothing is ever cropped by the card and the letterboxing is
 * the well's own colour. What the card cannot do is make two differently-shaped
 * photographs occupy the *same proportion* of that frame.
 *
 * So the canonical asset is **square**, with the shoe contained inside it and
 * the remainder padded — and since v2 (2026-08-20) **the pad is transparent
 * and the alpha channel is preserved**, loudly and on purpose. v1 flattened
 * everything onto `CARD_SURFACE`, which burnt the frame into the pixels: a
 * transparent product PNG became a white rectangle forever, and every surface
 * that was not white showed the rectangle. Now the asset carries only the
 * photograph; the surface behind it is paint, applied by the page (`bg-photo`
 * on every well, enforced by `audit:images`), and changing that surface is a
 * CSS edit rather than a reprocess of the catalogue.
 *
 * The brief asked for "the card's aspect ratio" in one sentence and for a
 * square asset in its gate. Square is the one that produces the consistency
 * both sentences are after.
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

/**
 * The pad, since v2: no colour at all.
 *
 * Anywhere the frame is larger than the photograph — contain-padding, the
 * overhang of a crop, the corners a straighten uncovers — the pixels added are
 * fully transparent, and the surface behind the photograph is painted by the
 * page (`bg-photo`, held equal to `CARD_SURFACE` by `audit:images`). The RGB
 * under a zero alpha is irrelevant; black is sharp's convention.
 */
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 } as const;

/**
 * How an **untrusted** buffer is opened.
 *
 * `failOn: "none"` is the long-standing half: a photograph with a truncated
 * final scan line, or a slightly malformed EXIF block, still decodes rather
 * than throwing — a phone or a messaging app produced most of the files this
 * shop is handed, and refusing one because it is imperfect refuses a sale.
 *
 * `limitInputPixels` is the other half and it is the one that is a security
 * control. See `MAX_DECODED_PIXELS`: the 5MB upload ceiling bounds bytes on the
 * wire, not pixels in memory, and the ratio between them is chosen by whoever
 * made the file. Without this, a few hundred kilobytes of flat-colour PNG
 * decodes to gigabytes and takes the function with it — inside `inspect()`,
 * before any dimension check this file performs has run.
 *
 * Used for the three calls that take the caller's bytes. Everything downstream
 * operates on buffers sharp produced under these limits and is bounded already.
 */
const SOURCE_DECODE = {
  failOn: "none",
  limitInputPixels: MAX_DECODED_PIXELS,
} as const;

/**
 * Run a decode and turn the one refusal that is *ours* into a sayable error.
 *
 * `limitInputPixels` throws sharp's own `Input image exceeds pixel limit`,
 * which reaches the admin as "That file could not be processed as a
 * photograph." — the same sentence a genuinely corrupt file produces. Those are
 * different problems with different fixes, and the owner is standing in the
 * shop holding the file: "it is broken" sends them looking for another
 * photograph, when the answer is that this one is enormous.
 *
 * The limit is deliberately not named in the message. Fifty megapixels is not a
 * number anybody has about a file they are holding; pixels-per-side is.
 */
async function decoding<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/exceeds pixel limit/i.test(message)) {
      throw new ImagePipelineError(
        "That image is far too large to open — more than about 7000 pixels on " +
          "each side once unpacked. Export it smaller and try again.",
      );
    }
    throw error;
  }
}

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
  const meta = await decoding(() => sharp(input, SOURCE_DECODE).metadata());

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
  /**
   * The owner's framing, or null for "the whole photograph" — which is what
   * every row written before this existed means, and what the untouched branch
   * below reproduces **byte for byte**.
   *
   * Null rather than `DEFAULT_CROP` as the default parameter, deliberately. The
   * derivative path is a hash of the output, so a null crop recomputes the
   * paths a row already points at and a reprocess stays the no-op it has always
   * been. Routing the existing catalogue through new arithmetic to arrive at
   * "probably the same pixels" would rewrite every path in the shop to prove a
   * point about tidiness.
   */
  crop: Crop | null = null,
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
   * **There is no `flatten` here, and that is the load-bearing change of v2.**
   * v1 flattened everything onto `CARD_SURFACE` before resizing, which burnt
   * the pad — and any transparency the source carried — into white pixels
   * forever. From v2 (2026-08-20) the alpha channel is **preserved**: WebP
   * carries alpha natively, the contain-padding is `TRANSPARENT`, and a
   * transparent source PNG stays transparent all the way to the customer. The
   * surface behind the photograph is the well the page paints — `bg-photo` on
   * every catalogue surface, held there by the gate's well tripwire.
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
  const square = crop
    ? await croppedSquare(input, crop)
    : await decoding(() =>
        sharp(input, SOURCE_DECODE)
          .rotate()
          .resize(CANONICAL_EDGE, CANONICAL_EDGE, {
            fit: "contain",
            background: TRANSPARENT,
          })
          .png()
          .toBuffer(),
      );

  const variants: Variant[] = [];
  for (const width of CANONICAL_WIDTHS) {
    const data = await sharp(square)
      .resize(width, width, { fit: "contain", background: TRANSPARENT })
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
  // "alpha" where v1 wrote the pad colour: the pad no longer has one, and a
  // hash input that named a colour would imply the pixels depend on it.
  hash.update(`v${PIPELINE_VERSION}:alpha:${CANONICAL_EDGE}`);
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
 * The owner's framing, applied — orientation, straighten, crop, adjustments.
 *
 * ## Measured, never predicted
 *
 * The crop is a set of fractions, and fractions need a frame to be fractions
 * *of*. That frame is the photograph after its EXIF orientation and after any
 * straightening, and its exact dimensions are libvips' business: a 3000x2250
 * picture rotated 4 degrees comes out some particular size that depends on how
 * the rotation library rounds its bounding box.
 *
 * So this renders the frame first and **asks it how big it is**, rather than
 * computing what it ought to be. The browser does the same thing with the frame
 * it rendered. Neither side has to model the other's rounding, which is the
 * only arrangement where the preview and the asset cannot drift.
 *
 * ## The overhang is the padding
 *
 * A crop square is allowed to reach past the edge of the photograph, and at
 * `size: 1` on anything not already square it always does. That overhang is
 * exactly the padding this pipeline has always added — extended in
 * `TRANSPARENT` since v2, so the default crop is the same picture the
 * untouched branch produces rather than a near miss, and the surface behind
 * it stays the page's business.
 *
 * ## Two decodes
 *
 * `rotate()` for the EXIF tag and `rotate(angle)` for the straighten are
 * separate passes over separate buffers rather than two calls on one pipeline.
 * sharp applies one rotation per pipeline, and which of the two would win is
 * exactly the kind of thing that works in a test and silently drops the EXIF
 * correction on the one photograph somebody took in portrait. The cost is a
 * decode, once per upload, on an operation the owner is already waiting on.
 */
async function croppedSquare(input: Buffer, crop: Crop): Promise<Buffer> {
  const framed = await frameFor(input, crop.rotation, "store");

  const rect = resolveCrop(framed.width, framed.height, crop);
  const pad = paddingFor(framed.width, framed.height, rect);

  /**
   * The padding is its own pass, and it has to be.
   *
   * sharp runs a **fixed** pipeline order regardless of the order the calls are
   * written in, and `extract` comes before `extend` in it. Chaining
   * `.extend().extract()` therefore extracts from the *unpadded* frame and
   * fails with "bad extract area" the moment a crop reaches past an edge —
   * which, at the default size on any non-square photograph, is always. Two
   * buffers is the cost of not depending on an ordering that is not ours.
   */
  const padded =
    pad.left || pad.top || pad.right || pad.bottom
      ? await sharp(framed.data)
          .extend({ ...pad, background: TRANSPARENT })
          .png()
          .toBuffer()
      : framed.data;

  const pipeline = sharp(padded).extract({
    left: rect.left + pad.left,
    top: rect.top + pad.top,
    width: rect.size,
    height: rect.size,
  });

  return adjusted(pipeline, crop)
    .resize(CANONICAL_EDGE, CANONICAL_EDGE, {
      fit: "contain",
      background: TRANSPARENT,
    })
    .png()
    .toBuffer();
}

/**
 * Brightness and contrast, and nothing else — the two the brief allows.
 *
 * The ranges are deliberately conservative: the ends of both sliders are ±40%,
 * not ±100%. **Colour accuracy beats looking good here.** A customer who
 * receives a shoe darker than the photograph has a "not as described" claim,
 * and this shop replaces rather than refunds, so an over-flattering picture is
 * a physical parcel going back and forth at the shop's expense.
 *
 * Contrast pivots on mid-grey (`128`) rather than on black, because scaling
 * from zero brightens as it stretches and the owner reaching for contrast is
 * not asking for that.
 */
function adjusted(pipeline: Sharp, crop: Crop): Sharp {
  let out: Sharp = pipeline;
  if (crop.brightness !== 0) {
    out = out.modulate({
      brightness: 1 + clampAdjustment(crop.brightness) / (MAX_ADJUSTMENT * 2.5),
    });
  }
  if (crop.contrast !== 0) {
    const slope =
      1 + clampAdjustment(crop.contrast) / (MAX_ADJUSTMENT * 2.5);
    out = out.linear(slope, 128 * (1 - slope));
  }
  return out;
}

function clampAdjustment(value: number): number {
  return Math.min(MAX_ADJUSTMENT, Math.max(-MAX_ADJUSTMENT, value));
}

/**
 * The thresholds auto-frame tries, in order.
 *
 * Measured 2026-08-13 against constructed fixtures, and the order is the
 * finding rather than a guess. There is **no single threshold that works**:
 *
 *   - 20 and above is needed for a photograph with uneven light across the
 *     table — a soft gradient reads as "not background" below it, and the trim
 *     comes back holding half the frame.
 *   - 8 and above **loses a white shoe on a fog background**, where the
 *     subject differs from what it stands on by about eight levels per
 *     channel. That case is real: it is the shop's own product on the shop's
 *     own colour.
 *
 * So the ladder starts at a value that handles ordinary light, widens for
 * difficult light, and finally tries a tight one for a low-contrast subject.
 * The first plausible answer wins.
 */
const TRIM_THRESHOLDS = [10, 20, 30, 5] as const;

/**
 * A box this close to the whole frame means the trim found nothing — the
 * background was too busy to tell from the subject, or the subject runs into
 * the corner the background colour is sampled from.
 */
const SUBJECT_MAX = 0.92;

/** And this small means it found a speck: a highlight, a sensor mark, dust. */
const SUBJECT_MIN = 0.08;

export type Subject = {
  /** Fractions of the frame, so they mean the same thing to the browser. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Which rung of the ladder found it. Reported, not decorative. */
  threshold: number;
};

/**
 * Where the shoe is, or null when the photograph does not say.
 *
 * ## What this is, honestly
 *
 * `sharp`'s trim, walked over a ladder of thresholds. It is not object
 * detection and it does not know what a shoe is: it finds the largest region
 * that differs from **the colour in the frame's top-left corner**. On the case
 * this shop actually has — one shoe on a plain table — that is the same answer,
 * for a fraction of the cost of a computer-vision dependency.
 *
 * ## What it fails on, stated rather than implied
 *
 * All four are measured, not imagined:
 *
 *  1. **A busy background** — bedspread, wood grain, patterned floor. Every
 *     threshold returns the whole frame.
 *  2. **A subject touching the top-left corner.** The corner *is* the shoe, so
 *     the colour being trimmed away is the shoe's own. Returns the whole frame.
 *  3. **A white shoe on a white table.** Under about eight levels of
 *     separation the boundary is not in the pixels at all, and no threshold
 *     invents it.
 *  4. **Two shoes photographed apart** — returns a box spanning both, which is
 *     arguably right and is at least visibly what happened.
 *
 * The first three come back as null, and the panel says "couldn't find the shoe
 * — centred instead" rather than presenting a confident wrong crop. That
 * distinction is the whole design: a wrong crop looks deliberate and gets
 * approved, a stated fallback invites the owner to fix it.
 *
 * **Trimming against a named background is the version that does not work.**
 * `trim({ background: CARD_SURFACE })` reads as the obvious implementation —
 * our pad colour is fog, so trim the fog — and it finds nothing whatsoever
 * unless the photograph was taken on a `#eef1f5` surface. A warm wooden table
 * returns the whole frame at every threshold. Inferring the background from the
 * corner is what makes this work on a real table.
 */
export async function findSubject(frame: Buffer): Promise<Subject | null> {
  const meta = await sharp(frame).metadata();
  if (!meta.width || !meta.height) return null;

  for (const threshold of TRIM_THRESHOLDS) {
    let info;
    try {
      ({ info } = await sharp(frame)
        .trim({ threshold })
        .toBuffer({ resolveWithObject: true }));
    } catch {
      // sharp throws rather than returning the whole frame when a trim would
      // leave nothing at all — a photograph of one flat colour. That is a
      // "cannot tell", same as the rest.
      continue;
    }

    const width = info.width / meta.width;
    const height = info.height / meta.height;

    const plausible =
      (width <= SUBJECT_MAX || height <= SUBJECT_MAX) &&
      width >= SUBJECT_MIN &&
      height >= SUBJECT_MIN;

    if (plausible) {
      return {
        x: -(info.trimOffsetLeft ?? 0) / meta.width,
        y: -(info.trimOffsetTop ?? 0) / meta.height,
        width,
        height,
        threshold,
      };
    }
  }

  return null;
}

/**
 * The frame a crop is measured against: oriented, optionally straightened —
 * and its dimensions, read back rather than predicted.
 *
 * Shared by `findSubject`'s caller and by `croppedSquare` so that a bounding
 * box found at one moment and a crop applied at another are talking about the
 * same rectangle. The `pad` mode decides whether transparency is composited
 * away (measuring) or preserved (storing); it never changes the geometry.
 */
export async function frameFor(
  input: Buffer,
  rotation = 0,
  /**
   * What the frame is *for*, which decides what happens to transparency and
   * what colour a rotation's uncovered corners take.
   *
   * - **`"measure"`** (the default): flattened onto `CARD_SURFACE`, rotation
   *   corners padded in `CARD_SURFACE`. `findSubject`'s trim needs a composited
   *   image — a transparent corner has no colour to trim against — and
   *   flattening changes no geometry, so fractions resolved against a measured
   *   frame hold against a stored one.
   * - **`"measure-own-corner"`**: as above, but rotation corners take the
   *   photograph's **own** corner colour. `findSubject` infers the background
   *   from the top-left pixel, and padding a warm wooden table with white makes
   *   the corner white, the table "not background", and the detector correctly
   *   reports that it cannot find anything. Straightening would therefore
   *   switch auto-frame off, silently, which is exactly what it did until
   *   `audit:image-editor` caught it.
   * - **`"store"`**: what `croppedSquare` feeds the stored asset. No flatten —
   *   since v2 the alpha channel is preserved end to end — and rotation
   *   corners are `TRANSPARENT`, because stored padding no longer has a colour.
   *
   * All three come out the same *size*, so a crop measured against one frame
   * applies exactly to another.
   */
  pad: "measure" | "measure-own-corner" | "store" = "measure",
): Promise<{ data: Buffer; width: number; height: number }> {
  const oriented = await decoding(() => {
    const base = sharp(input, SOURCE_DECODE).rotate();
    return (pad === "store" ? base : base.flatten({ background: CARD_SURFACE }))
      .png()
      .toBuffer();
  });

  const data =
    rotation === 0
      ? oriented
      : await sharp(oriented)
          .rotate(rotation, {
            background:
              pad === "store"
                ? TRANSPARENT
                : pad === "measure-own-corner"
                  ? await cornerColour(oriented)
                  : CARD_SURFACE,
          })
          .png()
          .toBuffer();

  const meta = await sharp(data).metadata();
  if (!meta.width || !meta.height) {
    throw new ImagePipelineError("That photograph could not be measured.");
  }
  return { data, width: meta.width, height: meta.height };
}

/**
 * The colour in the frame's top-left pixel — the same one `trim` treats as
 * background, read the same way.
 */
async function cornerColour(image: Buffer): Promise<string> {
  const { data } = await sharp(image)
    .extract({ left: 0, top: 0, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const hex = (value: number) => value.toString(16).padStart(2, "0");
  return `#${hex(data[0] ?? 238)}${hex(data[1] ?? 241)}${hex(data[2] ?? 245)}`;
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
