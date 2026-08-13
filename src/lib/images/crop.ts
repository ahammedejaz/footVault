/**
 * The crop, as a set of numbers both the browser and the server agree on.
 *
 * ## Why this file has no imports
 *
 * Same reason as `./constants`, one step further. `pipeline.ts` is
 * `server-only` and carries a native module; the panel that lets the owner
 * frame a photograph runs in a browser. Both have to arrive at **the same
 * rectangle**, or the tool lies: the owner nudges a square over a picture,
 * approves what they see, and the shop stores something else.
 *
 * So the arithmetic lives here, alone, and both sides call it. A preview drawn
 * from one calculation and an asset cut from another is not a smaller version
 * of the same feature — it is the feature not working.
 *
 * ## The coordinate system, and why it is fractions rather than pixels
 *
 * Every number below is a fraction of the frame it applies to, never a pixel.
 * Three things follow, and each of them is a bug that does not happen:
 *
 * **The preview is a different size from the source.** The panel draws into
 * whatever space a tablet gives it — 320 CSS pixels, maybe 480 — while the
 * source is 3000. Pixels would need converting at every read; fractions are
 * already the same number on both sides.
 *
 * **A re-crop may not be cropping the same file.** `original_path` is what a
 * re-crop reads, and an original re-uploaded at a different size would make a
 * stored pixel rect mean somewhere else entirely. A fraction means the same
 * framing whatever the resolution.
 *
 * **libvips rounds where it likes.** The rotated frame's exact dimensions are
 * the rotation library's business, not ours. The server measures the frame it
 * actually produced and resolves fractions against that; the browser resolves
 * the same fractions against the frame it actually rendered. Neither has to
 * predict the other, which is the only version of this that stays true.
 *
 * ## `size` is a fraction of the *longer* edge, and that is load-bearing
 *
 * It makes `DEFAULT_CROP` — centred, size 1 — exactly the framing the pipeline
 * has always produced: the whole photograph contained in a square, padded to
 * the sides in the card's colour. So "no crop" and "the default crop" are the
 * same picture, byte for byte, and `audit:images` asserts it. That is what lets
 * this ship without re-cutting the catalogue.
 */

export type Crop = {
  /** Centre of the square, as a fraction of the frame's width and height. */
  cx: number;
  cy: number;
  /**
   * The square's edge, as a fraction of the frame's **longer** side.
   *
   * 1 is the whole photograph contained with padding; 0.5 is a two-times zoom.
   * Bounded below because a crop of a few pixels upscaled to 1600 is not a
   * photograph, and above because past `MAX_SIZE` the result is mostly fog.
   */
  size: number;
  /** Straighten, in degrees. Positive is clockwise. */
  rotation: number;
  /** −100 to 100, 0 being the photograph as taken. */
  brightness: number;
  contrast: number;
};

/** The bounds every stored crop is clamped into, on both sides of the wire. */
export const MIN_SIZE = 0.15;
export const MAX_SIZE = 1.5;
export const MAX_ROTATION = 15;
export const MAX_ADJUSTMENT = 100;

/**
 * The whole photograph, straight, unadjusted — which is what the pipeline did
 * before crops existed.
 *
 * Not merely "a sensible starting point": producing byte-identical output to
 * the no-crop path is a property `audit:images` checks, because it is what
 * makes introducing this column a no-op for every row that has one written
 * with these values.
 */
export const DEFAULT_CROP: Crop = {
  cx: 0.5,
  cy: 0.5,
  size: 1,
  rotation: 0,
  brightness: 0,
  contrast: 0,
};

/** A square in frame pixels. `left`/`top` may fall outside the frame. */
export type CropRect = {
  left: number;
  top: number;
  size: number;
};

/** How much frame has to be invented on each side to satisfy a rect. */
export type CropPadding = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}

/**
 * Every stored crop, forced into range — including the ones that arrive as
 * `null`, a string, or an object with two of the six fields.
 *
 * Returns a whole `Crop` rather than throwing because the callers are a jsonb
 * column and a form post, and neither is a place where a half-written value
 * should take a product page down. An out-of-range number is clamped to
 * something that renders; a missing one falls back to the default, field by
 * field, so a crop written by an older version of the panel keeps whatever it
 * did say.
 */
export function normaliseCrop(value: unknown): Crop {
  if (!value || typeof value !== "object") return { ...DEFAULT_CROP };
  const raw = value as Partial<Record<keyof Crop, unknown>>;
  const num = (key: keyof Crop): number =>
    typeof raw[key] === "number" && Number.isFinite(raw[key])
      ? (raw[key] as number)
      : DEFAULT_CROP[key];

  return {
    cx: clamp(num("cx"), 0, 1),
    cy: clamp(num("cy"), 0, 1),
    size: clamp(num("size"), MIN_SIZE, MAX_SIZE),
    rotation: clamp(num("rotation"), -MAX_ROTATION, MAX_ROTATION),
    brightness: clamp(num("brightness"), -MAX_ADJUSTMENT, MAX_ADJUSTMENT),
    contrast: clamp(num("contrast"), -MAX_ADJUSTMENT, MAX_ADJUSTMENT),
  };
}

/** True when this crop asks for exactly what the pipeline did before crops. */
export function isDefaultCrop(crop: Crop): boolean {
  return (
    crop.cx === DEFAULT_CROP.cx &&
    crop.cy === DEFAULT_CROP.cy &&
    crop.size === DEFAULT_CROP.size &&
    crop.rotation === DEFAULT_CROP.rotation &&
    crop.brightness === DEFAULT_CROP.brightness &&
    crop.contrast === DEFAULT_CROP.contrast
  );
}

/**
 * The square this crop selects, in the pixels of the frame it is measured
 * against.
 *
 * `size` is rounded **first** and the corner derived from it, rather than
 * rounding all three independently. Rounding a left edge and a right edge
 * separately produces a rectangle that is occasionally 1px off square, and a
 * 1599×1600 extract is not a rounding error to the resize that follows — it is
 * a shoe a pixel taller than the one beside it, in a catalogue whose entire
 * purpose is that they match.
 */
export function resolveCrop(
  frameWidth: number,
  frameHeight: number,
  crop: Crop,
): CropRect {
  const longer = Math.max(frameWidth, frameHeight);
  const size = Math.max(1, Math.round(clamp(crop.size, MIN_SIZE, MAX_SIZE) * longer));
  return {
    size,
    left: Math.round(clamp(crop.cx, 0, 1) * frameWidth - size / 2),
    top: Math.round(clamp(crop.cy, 0, 1) * frameHeight - size / 2),
  };
}

/**
 * The frame that has to exist before that square can be cut out of it.
 *
 * A crop is allowed to reach past the edge of the photograph, and at `size: 1`
 * on anything that is not already square it always does — that overhang is
 * exactly the fog padding the pipeline has always added. Treating it as
 * padding rather than as an error is what makes the default crop and the
 * no-crop path the same picture.
 */
export function paddingFor(
  frameWidth: number,
  frameHeight: number,
  rect: CropRect,
): CropPadding {
  return {
    left: Math.max(0, -rect.left),
    top: Math.max(0, -rect.top),
    right: Math.max(0, rect.left + rect.size - frameWidth),
    bottom: Math.max(0, rect.top + rect.size - frameHeight),
  };
}

/**
 * How much of the crop the subject fills — the number the owner is shown, and
 * the one the target percentage is measured in.
 *
 * **Longest side, not area.** "The product fills 85% of the frame" is the
 * marketplaces' rule and it is ambiguous in exactly one way that matters here:
 * a shoe is a wide, low subject, so 85% *by area* is not merely hard, it is
 * unreachable — a shoe silhouette filling 85% of its own bounding box would
 * have to be a rectangle. Measured along the longer side, 85% is the framing
 * those listings actually show. The settings screen says which one this is,
 * because somebody will otherwise assume the other.
 *
 * `bbox` is in the same fractional coordinates as the crop: the subject's
 * bounding box as a fraction of the frame.
 */
export function fillOf(
  bbox: { width: number; height: number },
  crop: Crop,
  frameWidth: number,
  frameHeight: number,
): number {
  const longer = Math.max(frameWidth, frameHeight);
  const cropPx = clamp(crop.size, MIN_SIZE, MAX_SIZE) * longer;
  if (cropPx <= 0) return 0;
  const subjectPx = Math.max(bbox.width * frameWidth, bbox.height * frameHeight);
  return subjectPx / cropPx;
}

/**
 * The crop that puts a subject at the target fill, centred on it.
 *
 * This is auto-frame's whole output: the bounding box comes from the server's
 * trim pass, and the framing decision — how much room to leave around it — is
 * this one line of arithmetic, so it is testable without an image.
 *
 * The result is clamped, which is the case worth stating: a subject that
 * already fills more of the frame than the target cannot be given breathing
 * room that is not in the photograph, so it comes back at `MAX_SIZE` and the
 * fill readout honestly reports the shortfall rather than the tool pretending.
 */
export function frameSubject(
  bbox: { x: number; y: number; width: number; height: number },
  targetFill: number,
  frameWidth: number,
  frameHeight: number,
  base: Crop = DEFAULT_CROP,
): Crop {
  const longer = Math.max(frameWidth, frameHeight);
  const subjectPx = Math.max(bbox.width * frameWidth, bbox.height * frameHeight);
  const wanted = targetFill > 0 ? subjectPx / targetFill / longer : 1;

  return {
    ...base,
    cx: clamp(bbox.x + bbox.width / 2, 0, 1),
    cy: clamp(bbox.y + bbox.height / 2, 0, 1),
    size: clamp(wanted, MIN_SIZE, MAX_SIZE),
  };
}
