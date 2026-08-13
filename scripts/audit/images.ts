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
  inspect,
  normaliseProductImage,
} from "../../src/lib/images/pipeline";
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_EDGE,
  UPLOAD_EDGE_LADDER,
} from "../../src/lib/images/constants";
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
