/**
 * `npm run audit:images` — the awkward photograph comes out looking like the
 * rest of the catalogue.
 *
 * The brief named the test: *"Upload a deliberately awkward image — portrait,
 * 4:3, EXIF-rotated, huge — and assert the stored asset is square, correctly
 * oriented, within budget, and renders in the card without shifting layout."*
 * Each of those four is a section below.
 *
 * It builds its fixtures rather than shipping them. A checked-in JPEG is a file
 * nobody can read the intent of a year later — "why is this one 4:3?" — whereas
 * a generated one states its awkwardness in the code that makes it. It also
 * means the EXIF-rotated case can be *constructed* with a known tag, which is
 * the only way to assert the rotation was applied rather than that the picture
 * happens to look upright.
 *
 * No browser and no network. This is a property of the pipeline, and a gate
 * that needed a deployment to prove it would not be run.
 */

import { readFileSync } from "node:fs";

import sharp from "sharp";

import {
  CANONICAL_EDGE,
  CANONICAL_WIDTHS,
  CARD_SURFACE,
  MIN_RECOMMENDED_EDGE,
  VARIANT_BUDGET_BYTES,
  derivativePath,
  findSubject,
  frameFor,
  inspect,
  normaliseProductImage,
} from "../../src/lib/images/pipeline";
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_EDGE,
  UPLOAD_EDGE_LADDER,
} from "../../src/lib/images/constants";
import {
  DEFAULT_CROP,
  MAX_ROTATION,
  MAX_SIZE,
  MIN_SIZE,
  fillOf,
  frameSubject,
  normaliseCrop,
  paddingFor,
  resolveCrop,
} from "../../src/lib/images/crop";
import { isDerivative, snapWidth } from "../../src/lib/images/srcset";

let failed = 0;
let passed = 0;

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * A picture with an unmistakable top and left, so orientation can be *asserted*
 * rather than eyeballed.
 *
 * A flat colour would survive any rotation unchanged and prove nothing. This
 * puts a red block in the top-left eighth of an otherwise white field: after a
 * correct pipeline run the red is still top-left, and after a missed rotation
 * it is somewhere else. That is a test; "the image looks fine" is not.
 */
async function markedImage(width: number, height: number): Promise<Buffer> {
  const markW = Math.max(1, Math.round(width / 8));
  const markH = Math.max(1, Math.round(height / 8));
  const mark = await sharp({
    create: { width: markW, height: markH, channels: 3, background: "#d81e05" },
  })
    .png()
    .toBuffer();

  return sharp({
    create: { width, height, channels: 3, background: "#ffffff" },
  })
    .composite([{ input: mark, top: 0, left: 0 }])
    .jpeg({ quality: 92 })
    .toBuffer();
}

/**
 * Where the red mark's centre of mass sits, as a fraction of the image.
 *
 * A centroid rather than a sampled pixel, because the mark's exact position
 * depends on how a given source letterboxes inside the square — a portrait
 * source pads left and right, a landscape one top and bottom — and hard-coding
 * sample points for each case produces a test that fails when the padding maths
 * is right and the arithmetic in the test is wrong. Asking "which quadrant did
 * the red end up in" is the question the assertion actually cares about.
 *
 * Returns null when there is no red at all, which is itself a failure worth
 * distinguishing from "red in the wrong place".
 */
async function redCentroid(
  image: Buffer,
): Promise<{ x: number; y: number } | null> {
  const { data, info } = await sharp(image)
    .raw()
    .toBuffer({ resolveWithObject: true });

  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let i = 0; i < info.width * info.height; i += 1) {
    const offset = i * info.channels;
    const r = data[offset]!;
    const g = data[offset + 1]!;
    const b = data[offset + 2]!;
    if (r > 150 && g < 100 && b < 100) {
      sumX += i % info.width;
      sumY += Math.floor(i / info.width);
      count += 1;
    }
  }

  if (count === 0) return null;
  return { x: sumX / count / info.width, y: sumY / count / info.height };
}

async function pixelAt(image: Buffer, fx: number, fy: number) {
  const meta = await sharp(image).metadata();
  const x = Math.min((meta.width ?? 1) - 1, Math.round((meta.width ?? 1) * fx));
  const y = Math.min(
    (meta.height ?? 1) - 1,
    Math.round((meta.height ?? 1) * fy),
  );
  const { data } = await sharp(image)
    .extract({ left: x, top: y, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { r: data[0]!, g: data[1]!, b: data[2]! };
}

function hexToRgb(hex: string) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

async function main() {
  /* ------------------------------------------------- 1 · the pad colour --- */

  console.log(
    "\n\x1b[1m1 · the baked pad colour still matches the card frame\x1b[0m",
  );

  /**
   * The one thing in this pipeline that can rot silently.
   *
   * `CARD_SURFACE` is burnt into every stored asset at upload time. If someone
   * restyles `--fv-fog` and nothing checks, the frame repaints and every
   * previously processed photograph keeps its old padding — a visible square
   * inside every card, on a catalogue that is expensive to reprocess. The two
   * values have to be asserted equal somewhere, and this is cheaper than
   * discovering it on the shop.
   */
  const css = readFileSync("src/app/globals.css", "utf8");
  const fog = /--fv-fog:\s*(#[0-9a-fA-F]{6})/.exec(css)?.[1]?.toLowerCase();
  check(
    "CARD_SURFACE equals --fv-fog in globals.css",
    fog === CARD_SURFACE.toLowerCase(),
    `pipeline ${CARD_SURFACE}, css ${fog ?? "not found"}`,
  );

  const cardTsx = readFileSync(
    "src/components/storefront/product-card.tsx",
    "utf8",
  );
  check(
    "the card frame still pads with bg-fog and contains rather than crops",
    cardTsx.includes("bg-fog") && cardTsx.includes("object-contain"),
    "a switch to object-cover would crop the padded square",
  );

  /* ------------------------------------------------ 2 · awkward sources --- */

  console.log("\n\x1b[1m2 · the awkward photographs the brief named\x1b[0m");

  const cases: { label: string; width: number; height: number }[] = [
    { label: "portrait 3000×4000", width: 3000, height: 4000 },
    { label: "4:3 landscape 2048×1536", width: 2048, height: 1536 },
    { label: "huge 5000×5000", width: 5000, height: 5000 },
    { label: "square 2000×2000 (the recommendation)", width: 2000, height: 2000 },
    { label: "small 400×400 (below the warning)", width: 400, height: 400 },
    { label: "extreme panorama 4000×600", width: 4000, height: 600 },
  ];

  for (const testCase of cases) {
    const source = await markedImage(testCase.width, testCase.height);
    const result = await normaliseProductImage(source);

    const allSquare = result.variants.every((v) => v.width === v.height);
    const widthsMatch =
      result.variants.map((v) => v.width).join(",") ===
      CANONICAL_WIDTHS.join(",");

    check(
      `${testCase.label}: every variant square`,
      allSquare,
      result.variants.map((v) => `${v.width}×${v.height}`).join(" "),
    );
    check(`${testCase.label}: all ${CANONICAL_WIDTHS.length} widths emitted`, widthsMatch);

    const overBudget = result.variants.filter((v) => v.overBudget);
    check(
      `${testCase.label}: within byte budget`,
      overBudget.length === 0,
      result.variants
        .map((v) => `${v.width}:${(v.bytes / 1024).toFixed(0)}KB`)
        .join(" "),
    );

    // The corners of a contained image are padding by construction, and the
    // padding is the thing that has to be the card's colour.
    const expected = hexToRgb(CARD_SURFACE);
    const largest = result.variants.at(-1)!;
    const corner = await pixelAt(largest.data, 0.01, 0.99);
    const near =
      Math.abs(corner.r - expected.r) <= 4 &&
      Math.abs(corner.g - expected.g) <= 4 &&
      Math.abs(corner.b - expected.b) <= 4;
    check(
      `${testCase.label}: padded with the card surface`,
      near || testCase.width === testCase.height,
      `corner rgb(${corner.r},${corner.g},${corner.b})`,
    );
  }

  const small = await normaliseProductImage(await markedImage(400, 400));
  check(
    "a source below the recommended edge is flagged for the admin warning",
    small.belowRecommended,
    `< ${MIN_RECOMMENDED_EDGE}px`,
  );
  const big = await normaliseProductImage(await markedImage(2000, 2000));
  check("a source at the recommendation is not flagged", !big.belowRecommended);

  /* --------------------------------------------------- 3 · orientation --- */

  console.log("\n\x1b[1m3 · EXIF orientation is applied, then stripped\x1b[0m");

  /**
   * The fixture has to be built backwards from the answer, or it proves
   * nothing.
   *
   * EXIF orientation 6 means *"rotate the stored pixels 90° clockwise to
   * display them upright"* — what a phone writes when it is held in portrait
   * but its sensor reads out landscape. So to construct a genuine case: take
   * the upright portrait the owner meant to take, rotate it 90°
   * **anticlockwise** to get the bytes the phone would have stored, and tag
   * that 6.
   *
   * Then the only way the mark returns to the top-left is if `.rotate()` read
   * the tag and undid it.
   *
   * The tag is written with `withMetadata({ orientation })`. `withExifMerge`
   * with an `IFD0.Orientation` string looks like it should work, silently does
   * not, and the first version of this gate used it — which made the assertion
   * vacuous: the image carried no tag at all, so "the pipeline handled the tag
   * correctly" was being tested against a file that had nothing to handle. The
   * `orientation === 6` check below exists so a fixture that stops carrying the
   * tag fails loudly instead of passing quietly.
   */
  const uprightPortrait = await markedImage(900, 1200);
  const rotatedStored = await sharp(uprightPortrait)
    .rotate(-90)
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 92 })
    .toBuffer();

  const storedMeta = await sharp(rotatedStored).metadata();
  check(
    "the fixture really carries EXIF orientation 6",
    storedMeta.orientation === 6 &&
      storedMeta.width === 1200 &&
      storedMeta.height === 900,
    `stored ${storedMeta.width}×${storedMeta.height}, orientation ${String(storedMeta.orientation)}`,
  );

  const beforeInfo = await inspect(rotatedStored);
  check(
    "inspect() reports the upright dimensions, not the stored ones",
    beforeInfo.width === 900 && beforeInfo.height === 1200,
    `${beforeInfo.width}×${beforeInfo.height} upright, from ${storedMeta.width}×${storedMeta.height} stored`,
  );

  const rotatedResult = await normaliseProductImage(rotatedStored);
  const out = rotatedResult.variants.at(-1)!.data;
  const centre = await redCentroid(out);

  check("the mark survives processing at all", centre !== null);
  check(
    "the mark is back in the top-left quadrant",
    centre !== null && centre.x < 0.5 && centre.y < 0.5,
    centre
      ? `centroid (${centre.x.toFixed(2)}, ${centre.y.toFixed(2)}) — ignoring the tag would put it bottom-left`
      : "no red found",
  );

  /**
   * The counter-case, and the one that makes the check above mean something.
   *
   * Feed the *same stored pixels* with the tag removed and the mark must land
   * somewhere else — bottom-left, where 90° anticlockwise put it. If both
   * agreed, the assertion above would be satisfied by a pipeline that ignores
   * orientation entirely.
   */
  const untagged = await sharp(rotatedStored)
    .withMetadata({ orientation: 1 })
    .jpeg({ quality: 92 })
    .toBuffer();
  const untaggedCentre = await redCentroid(
    (await normaliseProductImage(untagged)).variants.at(-1)!.data,
  );
  check(
    "the same pixels without the tag land somewhere else",
    untaggedCentre !== null &&
      centre !== null &&
      Math.hypot(untaggedCentre.x - centre.x, untaggedCentre.y - centre.y) >
        0.2,
    untaggedCentre
      ? `untagged centroid (${untaggedCentre.x.toFixed(2)}, ${untaggedCentre.y.toFixed(2)})`
      : "no red found",
  );

  const outMeta = await sharp(out).metadata();
  check(
    "no EXIF survives into the stored asset",
    outMeta.exif === undefined,
    "a phone photograph's EXIF carries the GPS of the room it was taken in",
  );
  check(
    "no orientation tag survives either",
    outMeta.orientation === undefined || outMeta.orientation === 1,
    `orientation ${String(outMeta.orientation)}`,
  );

  /* -------------------------------------------------- 4 · determinism ---- */

  console.log("\n\x1b[1m4 · reprocessing is idempotent\x1b[0m");

  const twice = await markedImage(2400, 1800);
  const runA = await normaliseProductImage(twice);
  const runB = await normaliseProductImage(twice);

  check(
    "the same original produces the same content hash",
    runA.contentHash === runB.contentHash,
    runA.contentHash,
  );
  check(
    "the same original produces byte-identical variants",
    runA.variants.every((v, i) => v.data.equals(runB.variants[i]!.data)),
    "so a reprocess overwrites with what is already there",
  );
  check(
    "the same original produces the same derivative paths",
    derivativePath("shoe", runA.contentHash, CANONICAL_EDGE) ===
      derivativePath("shoe", runB.contentHash, CANONICAL_EDGE),
    derivativePath("shoe", runA.contentHash, CANONICAL_EDGE),
  );

  const different = await normaliseProductImage(await markedImage(2400, 1801));
  check(
    "a different original produces a different hash",
    different.contentHash !== runA.contentHash,
  );

  /* ------------------------------------- 5 · only outputs may be attached -- */

  console.log(
    "\n\x1b[1m5 · the rule that keeps unprocessed photographs off products\x1b[0m",
  );

  /**
   * `addProductImage` refuses any URL that is not a pipeline output (or a
   * first-party `/seed/` placeholder). That is the enforcement point for the
   * whole consistency guarantee, and it is in the **action** rather than in the
   * upload panel on purpose: a rule that lives in one screen holds only for
   * people who used that screen, and the media library uploads raw originals.
   *
   * What is asserted here is the predicate the action refines on. The action
   * itself needs a request context and an admin session, so driving it from a
   * plain script would test the harness rather than the rule; `audit:image-upload`
   * covers the live path end to end.
   *
   * The database has **no** such constraint, deliberately — the seed writes
   * `product_images` in raw SQL and a check constraint would have to encode the
   * URL shape of a storage bucket. So the guarantee is exactly as strong as
   * "every application write goes through addProductImage", and that sentence
   * belongs in the report rather than being implied by a green tick.
   */
  const derivedUrl =
    "https://x.supabase.co/storage/v1/object/public/product-images/derived/v1/abc123/shoe-1600.webp";
  const originalUrl =
    "https://x.supabase.co/storage/v1/object/public/product-images/originals/p1/raw.jpg";

  check("a derivative URL is recognised", isDerivative(derivedUrl));
  check(
    "an untouched original is not",
    !isDerivative(originalUrl),
    "this is what stops a raw phone photograph reaching a product",
  );
  check(
    "an arbitrary URL is not",
    !isDerivative("https://example.com/shoe.jpg"),
  );
  check(
    "a derivative wrapped in the Next optimiser is not mistaken for one",
    !isDerivative("/_next/image?url=%2Fderived%2Fv1%2Fabc%2Fshoe-1600.webp&w=800"),
    "the optimiser path contains the same substring",
  );

  const snapped = [1, 399, 400, 401, 900, 1600, 3840].map((w) => snapWidth(w));
  check(
    "every requested width snaps up to a real variant",
    snapped.every((w) => (CANONICAL_WIDTHS as readonly number[]).includes(w)),
    snapped.join(", "),
  );
  check(
    "and never snaps down, which would serve a blurry photograph",
    snapWidth(401) === 800 && snapWidth(1201) === 1600,
    "401 → 800, 1201 → 1600",
  );

  /* ------------------------------------------------------- 6 · layout ---- */

  console.log("\n\x1b[1m6 · the card cannot shift when these render\x1b[0m");

  /**
   * Layout stability here is structural rather than measured. The frame is
   * `aspect-4/5` with `fill`, so the box exists before the bytes do and no
   * image can move it — but only while every asset really is square, because a
   * non-square one would letterbox differently and change what the eye reads as
   * the product's size. Section 2 is what actually guards that; this asserts
   * the frame the guarantee depends on.
   */
  check(
    "the frame reserves its box before the image loads",
    cardTsx.includes("aspect-4/5") && cardTsx.includes("fill"),
    "aspect-ratio plus fill means zero CLS regardless of asset",
  );

  const budgets = CANONICAL_WIDTHS.every(
    (w) => typeof VARIANT_BUDGET_BYTES[w] === "number",
  );
  check("every emitted width has a byte budget", budgets);

  /* ------------------------------------------------- 7 · upload cap ------ */

  console.log(
    "\n\x1b[1m7 · what reaches originals/ can still be cropped\x1b[0m",
  );

  /**
   * These four assertions are cheap and they guard a decision that is
   * **irreversible per photograph**: whatever the panel stores in `originals/`
   * is what every future re-crop and every `PIPELINE_VERSION` bump has to work
   * from. A cap quietly lowered back to the canonical edge would not fail
   * anything else in this file — the pipeline would keep producing perfect
   * 1600px squares out of a source with nothing left to crop into.
   */
  check(
    "the upload cap leaves headroom above the canonical edge",
    UPLOAD_EDGE > CANONICAL_EDGE,
    `${UPLOAD_EDGE} > ${CANONICAL_EDGE} — a crop to the target fill keeps roughly half the frame`,
  );
  check(
    "the ladder descends",
    UPLOAD_EDGE_LADDER.every(
      (edge, i) => i === 0 || edge < UPLOAD_EDGE_LADDER[i - 1]!,
    ),
    UPLOAD_EDGE_LADDER.join(" → "),
  );
  check(
    "and bottoms out no lower than the canonical edge",
    UPLOAD_EDGE_LADDER[UPLOAD_EDGE_LADDER.length - 1]! >= CANONICAL_EDGE,
    "below it the pipeline would upscale even an uncropped photograph",
  );

  /**
   * The client-side ceiling and the bucket's own must agree.
   *
   * They are two systems' opinions about one number: `MAX_UPLOAD_BYTES` decides
   * what the panel offers to upload, and `file_size_limit` on the bucket
   * decides what Storage accepts. A panel believing in the larger of the two
   * produces the worst version of this failure — the owner waits out a full
   * upload and is refused at the end by a layer with no message worth reading.
   */
  const storageSql = readFileSync(
    "supabase/migrations/20260807120600_storage.sql",
    "utf8",
  );
  check(
    "the panel's ceiling equals the bucket's file_size_limit",
    storageSql.includes(String(MAX_UPLOAD_BYTES)),
    `${MAX_UPLOAD_BYTES} bytes, stated in the storage migration`,
  );

  /* ------------------------------------------------------ 8 · the crop --- */

  console.log(
    "\n\x1b[1m8 · the framing the owner chose is what gets stored\x1b[0m",
  );

  /* ---- the arithmetic, which both sides of the wire depend on ---- */

  check(
    "junk in the crop column resolves to the whole photograph",
    JSON.stringify(normaliseCrop(null)) === JSON.stringify(DEFAULT_CROP) &&
      JSON.stringify(normaliseCrop("a crop")) === JSON.stringify(DEFAULT_CROP),
    "a half-written jsonb value must not take a product page down",
  );
  check(
    "out-of-range values are clamped rather than refused",
    normaliseCrop({ size: 99 }).size === MAX_SIZE &&
      normaliseCrop({ size: -4 }).size === MIN_SIZE &&
      normaliseCrop({ rotation: 90 }).rotation === MAX_ROTATION,
    `size → [${MIN_SIZE}, ${MAX_SIZE}], rotation → ±${MAX_ROTATION}°`,
  );
  check(
    "a partial crop keeps what it does say",
    normaliseCrop({ cx: 0.25 }).cx === 0.25 &&
      normaliseCrop({ cx: 0.25 }).size === DEFAULT_CROP.size,
    "a crop written by an older panel is not discarded wholesale",
  );

  /**
   * The rect is square by construction, not by luck. A 1599x1600 extract is not
   * a rounding detail to the resize that follows — it is one shoe a pixel
   * taller than the next, in a catalogue whose whole purpose is that they
   * match.
   */
  const rects = [
    resolveCrop(2401, 1801, DEFAULT_CROP),
    resolveCrop(3000, 2251, { ...DEFAULT_CROP, size: 0.37, cx: 0.31 }),
    resolveCrop(999, 1777, { ...DEFAULT_CROP, size: 0.611, cy: 0.09 }),
  ];
  check(
    "every resolved crop is exactly square, on odd frames too",
    rects.every((rect) => Number.isInteger(rect.size) && rect.size > 0),
    rects.map((r) => `${r.size}px at (${r.left},${r.top})`).join("; "),
  );

  const wide = resolveCrop(2400, 1800, DEFAULT_CROP);
  const widePad = paddingFor(2400, 1800, wide);
  check(
    "the default crop's overhang is the fog padding, top and bottom only",
    widePad.left === 0 &&
      widePad.right === 0 &&
      widePad.top > 0 &&
      widePad.bottom > 0,
    `${widePad.top}px above, ${widePad.bottom}px below — the letterboxing the pipeline has always added`,
  );

  /* ---- the pipeline, with a crop actually applied ---- */

  /** A wide, low, off-centre subject on a plain table. A shoe, in other words. */
  const SCENE_W = 2400;
  const SCENE_H = 1800;
  const SUBJECT = { left: 200, top: 1100, width: 900, height: 420 };
  const scene = await sharp({
    create: {
      width: SCENE_W,
      height: SCENE_H,
      channels: 3,
      background: "#eef1f5",
    },
  })
    .composite([
      {
        input: await sharp({
          create: {
            width: SUBJECT.width,
            height: SUBJECT.height,
            channels: 3,
            background: "#2b2b33",
          },
        })
          .png()
          .toBuffer(),
        top: SUBJECT.top,
        left: SUBJECT.left,
      },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();

  const untouched = await normaliseProductImage(scene);
  const asDefault = await normaliseProductImage(scene, DEFAULT_CROP);

  /**
   * **Stated rather than implied: these are not byte-identical, and that is
   * why the untouched branch exists.**
   *
   * Contain-resizing a 2400x1800 photograph and extending it to 2400x2400
   * before resizing produce the same *framing* and slightly different
   * resampling at the edges — measured here at about 1.5% of subpixels, none of
   * them anywhere a human would look. Close enough that the crop path is
   * correct; not close enough to route the existing catalogue through it, which
   * would rewrite every content hash and therefore every derivative path in the
   * shop. So a null crop takes the old branch, and this check is what keeps
   * that decision honest rather than forgotten.
   */
  const defaultBounds = await subjectBounds(asDefault.variants[3]!.data);
  const untouchedBounds = await subjectBounds(untouched.variants[3]!.data);
  check(
    "an explicit default crop frames the picture where the untouched branch does",
    defaultBounds !== null &&
      untouchedBounds !== null &&
      Math.abs(defaultBounds.x - untouchedBounds.x) < 0.01 &&
      Math.abs(defaultBounds.width - untouchedBounds.width) < 0.01,
    untouchedBounds && defaultBounds
      ? `subject at ${(untouchedBounds.x * 100).toFixed(1)}% vs ${(defaultBounds.x * 100).toFixed(1)}%, same width to within 1%`
      : "subject not found",
  );
  /**
   * How closely the two paths agree, measured rather than assumed — and the
   * answer is "exactly, until something has to blend at the seam".
   *
   * On this fixture they are byte-identical: the photograph's own background is
   * already `CARD_SURFACE`, so the extended border is the same colour as the
   * pixels beside it and the resize filter has nothing to blend. Give the same
   * crop a photograph shot on white and the two disagree along the seam by a
   * few levels, because contain-padding and extend-then-resize sample that
   * boundary differently.
   *
   * Neither is wrong. It is the reason a null crop keeps the untouched branch
   * anyway: "almost always identical" would still rewrite the content hash —
   * and therefore the derivative path — of every photograph in the shop whose
   * background is not fog, to arrive at the same picture.
   */
  /**
   * Content **against the edge**, which is the only thing that makes the two
   * paths disagree.
   *
   * The first version of this fixture was a flat white field, and it came back
   * "0.00% of bytes, max delta 0" — the check passed while demonstrating
   * nothing, because with nothing varying at the border there is no seam to
   * blend and both paths trivially agree. A block running into the top-left
   * corner is what actually exercises the difference.
   */
  const onWhite = await sharp({
    create: { width: SCENE_W, height: SCENE_H, channels: 3, background: "#ffffff" },
  })
    .composite([
      {
        input: await sharp({
          create: {
            width: Math.round(SCENE_W / 3),
            height: Math.round(SCENE_H / 3),
            channels: 3,
            background: "#d81e05",
          },
        })
          .png()
          .toBuffer(),
        top: 0,
        left: 0,
      },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();
  const whiteUntouched = await normaliseProductImage(onWhite);
  const whiteDefault = await normaliseProductImage(onWhite, DEFAULT_CROP);
  const seam = await comparePixels(
    whiteUntouched.variants[3]!.data,
    whiteDefault.variants[3]!.data,
  );

  check(
    "the two paths agree exactly when the photograph's own edge is the pad colour",
    untouched.variants[3]!.data.equals(asDefault.variants[3]!.data),
    "nothing to blend at the seam, so contain-padding and extend-then-resize land on the same bytes",
  );
  check(
    "and differ only along the seam when it is not — which is why null keeps the old branch",
    seam.differing > 0 && seam.differing < 0.05 && seam.maxDelta <= 64,
    `${(seam.differing * 100).toFixed(2)}% of bytes, max delta ${seam.maxDelta} — enough to change a content hash, which would repath the whole catalogue`,
  );

  /* ---- auto-frame's arithmetic, end to end ---- */

  const TARGET_FILL = 0.85;
  const bbox = {
    x: SUBJECT.left / SCENE_W,
    y: SUBJECT.top / SCENE_H,
    width: SUBJECT.width / SCENE_W,
    height: SUBJECT.height / SCENE_H,
  };
  const proposed = frameSubject(bbox, TARGET_FILL, SCENE_W, SCENE_H);

  check(
    "the fill before framing is what the panel would report",
    Math.abs(fillOf(bbox, DEFAULT_CROP, SCENE_W, SCENE_H) - 0.375) < 0.001,
    `${(fillOf(bbox, DEFAULT_CROP, SCENE_W, SCENE_H) * 100).toFixed(1)}% — a shoe adrift in a table`,
  );
  check(
    "and the proposed crop puts it at the target",
    Math.abs(fillOf(bbox, proposed, SCENE_W, SCENE_H) - TARGET_FILL) < 0.005,
    `${(fillOf(bbox, proposed, SCENE_W, SCENE_H) * 100).toFixed(1)}% predicted`,
  );

  /**
   * The claim the arithmetic is making, checked against the pixels it produced.
   *
   * Measured from the subject's own colour rather than by trimming from a
   * corner: a crop that reaches past the photograph is padded in `CARD_SURFACE`,
   * so on any background that is not already fog the corner and the pad differ
   * and a trim measures nothing at all. That confound cost an hour; it is
   * written down here so it does not cost a second one.
   */
  const framed = await normaliseProductImage(scene, proposed);
  const framedBounds = await subjectBounds(framed.variants[3]!.data);
  const achieved = framedBounds
    ? Math.max(framedBounds.width, framedBounds.height)
    : 0;
  check(
    "the stored asset really is filled to the target, within 2%",
    Math.abs(achieved - TARGET_FILL) < 0.02,
    `${(achieved * 100).toFixed(1)}% measured against a ${(TARGET_FILL * 100).toFixed(0)}% target`,
  );

  const framedMeta = await sharp(framed.variants[3]!.data).metadata();
  check(
    "and it is still square at the canonical edge",
    framedMeta.width === CANONICAL_EDGE && framedMeta.height === CANONICAL_EDGE,
    `${framedMeta.width}×${framedMeta.height}`,
  );

  /* ---- reproducibility, which is what makes re-crop and reprocess safe ---- */

  const tilted = { ...DEFAULT_CROP, rotation: -7, size: 0.7, brightness: 15 };
  const once = await normaliseProductImage(scene, tilted);
  const repeated = await normaliseProductImage(scene, tilted);
  check(
    "the same crop run twice is byte-identical",
    once.contentHash === repeated.contentHash &&
      once.variants[3]!.data.equals(repeated.variants[3]!.data),
    `${once.contentHash} — a reprocess overwrites with what is already there`,
  );

  const nudged = await normaliseProductImage(scene, { ...tilted, cx: 0.55 });
  check(
    "a different crop is a different asset, at a different path",
    nudged.contentHash !== once.contentHash,
    "so a re-crop cannot overwrite the photograph it is replacing",
  );

  const tiltedMeta = await sharp(once.variants[3]!.data).metadata();
  check(
    "straightening keeps the asset square",
    tiltedMeta.width === CANONICAL_EDGE && tiltedMeta.height === CANONICAL_EDGE,
    `${tiltedMeta.width}×${tiltedMeta.height} at -7°`,
  );

  /**
   * A crop dragged hard against a corner is padded, not refused. This is the
   * case that threw `extract_area: bad extract area` until the padding became
   * its own pass — sharp runs extract before extend whatever order they are
   * written in.
   */
  const cornered = await normaliseProductImage(scene, {
    ...DEFAULT_CROP,
    cx: 0.02,
    cy: 0.98,
    size: 0.5,
  });
  const corneredPixel = await sharp(cornered.variants[3]!.data)
    .extract({ left: 0, top: 0, width: 4, height: 4 })
    .raw()
    .toBuffer();
  /**
   * Within two levels per channel rather than exactly: the variant is WebP at
   * quality 82, and a lossy encoder is entitled to move a flat field by a level
   * or two. Asserting the exact bytes here would be asserting a property of the
   * encoder, and it would go red on the day that encoder is upgraded — for a
   * reason having nothing to do with whether the padding is the right colour.
   */
  const padOff = Math.max(
    Math.abs(corneredPixel[0]! - 0xee),
    Math.abs(corneredPixel[1]! - 0xf1),
    Math.abs(corneredPixel[2]! - 0xf5),
  );
  check(
    "a crop that runs off the edge is padded in the card's colour",
    padOff <= 2,
    `#${corneredPixel.subarray(0, 3).toString("hex")} against #eef1f5, off by ${padOff} — CARD_SURFACE within the encoder's tolerance, so the seam does not exist`,
  );

  /* ------------------------------------------------- 9 · auto-frame ------- */

  console.log(
    "\n\x1b[1m9 · auto-frame finds the shoe, and says so when it cannot\x1b[0m",
  );

  /**
   * Every case below is a photograph the owner could plausibly take, and the
   * four that fail are as important as the three that work — **more**
   * important, because a detector that quietly returns a confident wrong box
   * produces a catalogue of confidently wrong crops.
   */
  const SUB = { left: 200, top: 1100, width: 900, height: 420 };
  const shoe = async (colour: string) =>
    sharp({
      create: {
        width: SUB.width,
        height: SUB.height,
        channels: 3,
        background: colour,
      },
    })
      .png()
      .toBuffer();

  const on = async (
    background: string,
    colour = "#2b2b33",
    at: { top: number; left: number } = { top: SUB.top, left: SUB.left },
  ) =>
    sharp({
      create: {
        width: SCENE_W,
        height: SCENE_H,
        channels: 3,
        background,
      },
    })
      .composite([{ input: await shoe(colour), ...at }])
      .jpeg({ quality: 92 })
      .toBuffer();

  const found = async (image: Buffer) =>
    findSubject((await frameFor(image)).data);

  const onFog = await found(await on("#eef1f5"));
  check(
    "a dark shoe on the shop's own fog is found",
    onFog !== null &&
      Math.abs(onFog.width - SUB.width / SCENE_W) < 0.02 &&
      Math.abs(onFog.x - SUB.left / SCENE_W) < 0.02,
    onFog
      ? `${(onFog.width * 100).toFixed(0)}% × ${(onFog.height * 100).toFixed(0)}% at threshold ${onFog.threshold}`
      : "not found",
  );

  const onWarmTable = await found(await on("#e8e2d6"));
  check(
    "and on a warm wooden table, which is what a shop actually has",
    onWarmTable !== null &&
      Math.abs(onWarmTable.width - SUB.width / SCENE_W) < 0.02,
    onWarmTable
      ? `threshold ${onWarmTable.threshold} — trimming against CARD_SURFACE instead of the corner finds nothing at all here`
      : "not found — the named-background implementation is back",
  );

  const lowContrast = await found(await on("#eef1f5", "#f6f6f6"));
  check(
    "a white shoe on fog is still found, by the tight rung of the ladder",
    lowContrast !== null,
    lowContrast
      ? `threshold ${lowContrast.threshold} — about eight levels of separation; anything above ~8 loses it`
      : "not found",
  );

  const busy = await found(
    await sharp({
      create: {
        width: SCENE_W,
        height: SCENE_H,
        channels: 3,
        // Ignored where noise is given, and required by the type.
        background: "#808080",
        noise: { type: "gaussian", mean: 150, sigma: 40 },
      },
    })
      .composite([{ input: await shoe("#2b2b33"), top: SUB.top, left: SUB.left }])
      .jpeg({ quality: 92 })
      .toBuffer(),
  );
  check(
    "a busy background reports nothing rather than the whole frame",
    busy === null,
    "the panel says 'couldn't find the shoe — centred instead'; a wrong crop would look deliberate",
  );

  const inTheCorner = await found(
    await on("#eef1f5", "#2b2b33", { top: 0, left: 0 }),
  );
  check(
    "a subject running into the top-left corner reports nothing",
    inTheCorner === null,
    "the corner is where the background colour is sampled — so the colour being trimmed is the shoe's own",
  );

  const whiteOnWhite = await found(await on("#ffffff", "#fcfcfc"));
  check(
    "a white shoe on a white table reports nothing",
    whiteOnWhite === null,
    "under a few levels of separation the boundary is not in the pixels, and no threshold invents it",
  );

  /**
   * Two shoes is the case that is *not* a failure, and it is checked so nobody
   * later "fixes" it into one: a box spanning both is what the owner asked for
   * by photographing both.
   */
  const pair = await found(
    await sharp({
      create: {
        width: SCENE_W,
        height: SCENE_H,
        channels: 3,
        background: "#eef1f5",
      },
    })
      .composite([
        { input: await shoe("#2b2b33"), top: 300, left: 120 },
        { input: await shoe("#2b2b33"), top: 1100, left: 1300 },
      ])
      .jpeg({ quality: 92 })
      .toBuffer(),
  );
  check(
    "two shoes photographed apart come back as one box spanning both",
    pair !== null && pair.width > 0.8 && pair.height > 0.6,
    pair
      ? `${(pair.width * 100).toFixed(0)}% × ${(pair.height * 100).toFixed(0)}% — deliberate, not a miss`
      : "not found",
  );

  /**
   * Straightening must not switch the detector off.
   *
   * Rotating fills the new corners with a pad colour, and the corner is where
   * the background is inferred from. Padding a warm table with fog therefore
   * made every pixel of the photograph "not background" and auto-frame reported
   * nothing — so the owner nudging the straighten slider silently lost the
   * feature. Caught by audit:image-editor operating the real slider; asserted
   * here too, because this is the layer that can be checked in a second rather
   * than in a browser.
   */
  const straightScene = await on("#e8e2d6");
  const beforeTilt = await found(straightScene);
  const afterTilt = await findSubject((await frameFor(straightScene, 6, true)).data);
  check(
    "the subject is still found after a straighten",
    beforeTilt !== null && afterTilt !== null,
    afterTilt
      ? `found at ${(afterTilt.width * 100).toFixed(0)}% wide, threshold ${afterTilt.threshold}`
      : "lost once the photograph was rotated",
  );
  const fogPadded = await findSubject((await frameFor(straightScene, 6)).data);
  check(
    "and padding that rotation with fog instead is what used to break it",
    fogPadded === null,
    "kept as a check because the failure is invisible: a working detector that quietly stops",
  );

  /* --------------------------------------------------------- report ------ */

  console.log(
    failed === 0
      ? `\n\x1b[1m\x1b[32mimages: ${passed} checks, all green.\x1b[0m\n`
      : `\n\x1b[1m\x1b[31mimages: ${failed} of ${passed + failed} checks failed.\x1b[0m\n`,
  );
  if (failed > 0) process.exit(1);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

/**
 * The bounding box of the dark subject, as fractions of the image.
 *
 * By colour rather than by trimming from a corner, for the reason section 8
 * gives: a padded crop has a different colour in its corner from its
 * background, and trim then measures the padding rather than the shoe.
 */
async function subjectBounds(
  image: Buffer,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const { data, info } = await sharp(image)
    .raw()
    .toBuffer({ resolveWithObject: true });

  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;

  for (let i = 0; i < info.width * info.height; i += 1) {
    const offset = i * info.channels;
    // Anything markedly darker than the fog surface is subject.
    if (data[offset]! < 120 && data[offset + 1]! < 120 && data[offset + 2]! < 120) {
      const x = i % info.width;
      const y = Math.floor(i / info.width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) return null;
  return {
    x: minX / info.width,
    y: minY / info.height,
    width: (maxX - minX + 1) / info.width,
    height: (maxY - minY + 1) / info.height,
  };
}

/**
 * How far apart two variants are, **per decoded subpixel**.
 *
 * Decoded, not compressed. Two WebP files that draw a near-identical picture
 * differ in length, and a byte-wise diff of compressed data reports 100% at
 * delta 255 — which is what the first version of this said, and it is not a
 * fact about the pictures at all.
 */
async function comparePixels(
  first: Buffer,
  second: Buffer,
): Promise<{ differing: number; maxDelta: number }> {
  const a = await sharp(first).raw().toBuffer();
  const b = await sharp(second).raw().toBuffer();
  if (a.length !== b.length) return { differing: 1, maxDelta: 255 };
  let differing = 0;
  let maxDelta = 0;
  for (let i = 0; i < a.length; i += 1) {
    const delta = Math.abs(a[i]! - b[i]!);
    if (delta > 0) {
      differing += 1;
      if (delta > maxDelta) maxDelta = delta;
    }
  }
  return { differing: differing / a.length, maxDelta };
}
