/**
 * Framing a photograph into a rectangle of a given shape.
 *
 * ## Why this is not `crop.ts`
 *
 * `crop.ts` frames a product photograph, and a product photograph is always a
 * **square** with the shoe contained inside it and fog padded around the edges.
 * Every decision in that module follows from those two facts: `size` is a
 * fraction of the longer side, the rect is square by construction, and a rect
 * that reaches past the edge of the source is not an error but the padding the
 * catalogue has always had.
 *
 * None of that is true here. A hero is 16:9 and a category tile is 4:3; the
 * picture must *cover* the box with no padding at all, because a band of fog
 * down the side of a full-bleed hero is a visible defect rather than a
 * convention. Generalising `crop.ts` to carry an aspect would have meant every
 * caller in the catalogue — the pipeline, the crop stage, `audit:images` —
 * growing a parameter that is `1` at every one of its existing call sites, in
 * order to serve a use that shares none of its rules. Two small modules that
 * each state their own rule are cheaper to be right about than one that
 * branches on which kind of image it was handed.
 *
 * What they *do* share is the property that matters: **one function computes
 * the rectangle, and both sides of the wire import it.** The browser previews
 * `frameRect()` and the server extracts `frameRect()`. If this file computed a
 * different rectangle from the one sharp cuts, the owner would be approving a
 * picture the shop is not about to store — which is the single failure a
 * framing tool is not allowed to have.
 *
 * ## The coordinate system
 *
 * `cx`/`cy` are the point of the **source** that lands at the centre of the
 * output, as a fraction of the source's own width and height. `zoom` is 1 at
 * "the largest rectangle of this shape that fits inside the source", and larger
 * zooms in. So `{cx: .5, cy: .5, zoom: 1}` is the plain centred cover crop
 * every CSS `object-fit: cover` produces, which makes it the right default: an
 * owner who uploads and saves without touching anything gets exactly what they
 * would have got from a naive implementation, and everything else is opt-in.
 *
 * ## The rectangle never leaves the source
 *
 * `frameRect` clamps the centre so the extract stays inside the photograph.
 * That is the difference from `crop.ts`, and it is what removes a whole
 * category of question — there is no padding colour to choose, no alpha to
 * preserve at the edge, no "what happens past the corner". A drag that would
 * pull the frame off the picture stops at the edge instead, in the preview and
 * on the server identically, because it is this same clamp doing it.
 */

export type Framing = {
  /** The source point at the centre of the output, as a fraction. */
  cx: number;
  cy: number;
  /** 1 is the plain cover crop. Above 1 zooms in. */
  zoom: number;
  /** −100 to 100, 0 being the photograph as uploaded. */
  brightness: number;
  contrast: number;
};

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export const MAX_ADJUSTMENT = 100;

/**
 * ## Why there is no straighten here, when the product crop tool has one
 *
 * A product photograph is padded into a square, so rotating it uncovers corners
 * that are filled with transparency the page's own surface shows through — the
 * tilt is free because there is already padding around the shoe.
 *
 * A hero is full-bleed. There is no padding, by definition: the whole point of
 * `cover` is that the picture reaches every edge. Rotate it and the uncovered
 * corners are *visible holes* in the homepage. The obvious repair — enlarge the
 * extract before rotating, then re-crop — only works when the framing is zoomed
 * in far enough to have that much picture in hand, so straighten would be a
 * control that silently works at some zooms and not others. A control whose
 * availability the owner has to infer is worse than a control that is not there.
 *
 * Every phone gallery can straighten a photograph before it is uploaded, and it
 * can do it against the whole frame rather than against what survives a crop.
 * That is the better place for it, so this tool does not pretend to offer it.
 */

/**
 * The plain centred cover crop.
 *
 * Not merely "a sensible starting point". An owner who uploads a picture and
 * presses save without touching a control must get the same result a naive
 * `object-fit: cover` would have given them, because that is what they expect
 * from having seen it in every other tool. Every control on the stage moves
 * away from this; none of them is required to reach a reasonable answer.
 */
export const DEFAULT_FRAMING: Framing = {
  cx: 0.5,
  cy: 0.5,
  zoom: 1,
  brightness: 0,
  contrast: 0,
};

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}

/**
 * Every stored framing, forced into range — including the ones that arrive as
 * `null`, a string, or an object with two of the six fields.
 *
 * Returns a whole `Framing` rather than throwing, for the same reason
 * `normaliseCrop` does: the callers are a jsonb column and a form post, and
 * neither is a place where a half-written value should take a page down. A
 * missing field falls back field-by-field, so a row written by an older version
 * of the panel keeps whatever it did say.
 */
export function normaliseFraming(value: unknown): Framing {
  if (!value || typeof value !== "object") return { ...DEFAULT_FRAMING };
  const raw = value as Partial<Record<keyof Framing, unknown>>;
  const num = (key: keyof Framing): number =>
    typeof raw[key] === "number" && Number.isFinite(raw[key])
      ? (raw[key] as number)
      : DEFAULT_FRAMING[key];

  return {
    cx: clamp(num("cx"), 0, 1),
    cy: clamp(num("cy"), 0, 1),
    zoom: clamp(num("zoom"), MIN_ZOOM, MAX_ZOOM),
    brightness: clamp(num("brightness"), -MAX_ADJUSTMENT, MAX_ADJUSTMENT),
    contrast: clamp(num("contrast"), -MAX_ADJUSTMENT, MAX_ADJUSTMENT),
  };
}

/** True when this framing asks for the plain centred cover crop. */
export function isDefaultFraming(framing: Framing): boolean {
  return (
    framing.cx === DEFAULT_FRAMING.cx &&
    framing.cy === DEFAULT_FRAMING.cy &&
    framing.zoom === DEFAULT_FRAMING.zoom &&
    framing.brightness === DEFAULT_FRAMING.brightness &&
    framing.contrast === DEFAULT_FRAMING.contrast
  );
}

/** A rectangle in source pixels. Always wholly inside the source. */
export type FrameRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * The rectangle this framing selects, in the pixels of the source.
 *
 * Width is rounded **first** and height derived from it, rather than rounding
 * both independently — the same rule `resolveCrop` follows, for the same
 * reason. Two independently rounded edges produce a rectangle whose aspect is
 * occasionally a pixel off the one requested, and a category tile a pixel
 * taller than the one beside it is a visible seam in a grid whose whole job is
 * that they line up.
 *
 * The centre is clamped after the size is known, so a picture zoomed out to its
 * full extent has no freedom to pan and one zoomed in has exactly as much as
 * the overhang allows. Doing it in the other order lets a drag near the edge
 * change the size, which feels like the tool fighting the hand.
 */
export function frameRect(
  sourceWidth: number,
  sourceHeight: number,
  aspect: number,
  framing: Framing,
): FrameRect {
  const zoom = clamp(framing.zoom, MIN_ZOOM, MAX_ZOOM);

  // The largest rectangle of this shape that fits inside the source, then
  // divided by the zoom. Which dimension binds depends on whether the source is
  // wider or narrower than the output.
  const coverWidth =
    sourceWidth / sourceHeight > aspect ? sourceHeight * aspect : sourceWidth;

  const width = Math.max(1, Math.min(sourceWidth, Math.round(coverWidth / zoom)));
  const height = Math.max(1, Math.min(sourceHeight, Math.round(width / aspect)));

  // Half the rectangle is how far the centre must stay from each edge.
  const halfW = width / 2;
  const halfH = height / 2;
  const cx = clamp(
    clamp(framing.cx, 0, 1) * sourceWidth,
    halfW,
    sourceWidth - halfW,
  );
  const cy = clamp(
    clamp(framing.cy, 0, 1) * sourceHeight,
    halfH,
    sourceHeight - halfH,
  );

  return {
    left: Math.round(cx - halfW),
    top: Math.round(cy - halfH),
    width,
    height,
  };
}

/**
 * The centre, clamped for a given zoom, back in fractional coordinates.
 *
 * The stage needs this to keep its own state honest: a drag that would pull the
 * frame off the picture must *stop*, and the number it stops at has to be the
 * number the server would have clamped to anyway. Deriving it from `frameRect`
 * rather than re-implementing the arithmetic is what guarantees they agree.
 */
export function clampFraming(
  sourceWidth: number,
  sourceHeight: number,
  aspect: number,
  framing: Framing,
): Framing {
  const rect = frameRect(sourceWidth, sourceHeight, aspect, framing);
  return {
    ...normaliseFraming(framing),
    cx: (rect.left + rect.width / 2) / sourceWidth,
    cy: (rect.top + rect.height / 2) / sourceHeight,
  };
}
