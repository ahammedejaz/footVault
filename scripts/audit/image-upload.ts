/**
 * `npm run audit:image-upload` — the owner uploads a crooked photograph and the
 * shop ends up with a catalogue asset.
 *
 *   npm run dev:stage          # a server on :3210, pointed at staging
 *   npm run audit:image-upload
 *
 * ## What this is, and why `audit:images` is not enough
 *
 * `audit:images` proves the *pipeline* — 41 assertions over awkward fixtures,
 * with no network. It would pass in full while the panel that is supposed to
 * call it was broken, unreachable, or simply never wired up. That is exactly
 * the state Batch A was in when it was first reported: pipeline green,
 * `normaliseUpload` guarded and correct, and nothing on any screen calling it.
 *
 * So this drives the real admin page with a real browser, uploads a
 * deliberately awkward file through the actual control, and then asks the
 * database and storage what happened. It is the operate-and-assert rule from §G
 * applied to the one control Batch A adds:
 *
 * > locate the control by its visible label, change it, and assert the stored
 * > value changed.
 *
 * ## What it would look like if this were broken
 *
 * The question worth asking of every check here, and it shaped three of them.
 *
 * Asserting "a `product_images` row appeared" would pass if the panel uploaded
 * the raw original and attached that — the row exists either way. So the URL is
 * asserted to match the **derivative** pattern, and the object is then
 * *fetched* and measured: square, WebP, the canonical edge. A row pointing at a
 * file that does not exist, or exists and is a sideways JPEG, fails.
 *
 * Asserting "the alt text saved" would pass if the field were optional and
 * happened to be filled. So the commit button is asserted **disabled** while
 * the description is empty, which is the property that actually makes it
 * required.
 *
 * Asserting "four widths were written" would pass if they were four copies of
 * the same file. So each one is fetched and its real width read back.
 */

// clients first: this writes into staging and must never reach the live shop.
import "./clients";
import { assertNotProduction, assertServerNotProduction } from "./clients";

assertNotProduction("run image-upload");

import sharp from "sharp";
import { chromium } from "playwright";

import {
  CANONICAL_WIDTHS,
  CANONICAL_EDGE,
  MAX_DECODED_PIXELS,
  MAX_UPLOAD_BYTES,
  PIPELINE_VERSION,
  UPLOAD_EDGE,
} from "../../src/lib/images/constants";
import { inspect } from "../../src/lib/images/pipeline";
import { derivativeLoader, isDerivative } from "../../src/lib/images/srcset";
import { adminClient, createAccount, sessionCookies } from "./fixtures";
import { BASE_URL } from "./routes";
import { scanned } from "./scanned";

const BUCKET = "product-images";

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
 * The long edge of the fixture, deliberately **above** the upload cap.
 *
 * Derived from `UPLOAD_EDGE` rather than typed, so raising the cap raises the
 * fixture with it. A fixture smaller than the cap would be uploaded untouched
 * and section 6's headroom assertion would pass without the panel having
 * resized anything at all — a check that proves the fixture, not the code.
 */
const FIXTURE_LONG_EDGE = UPLOAD_EDGE + 200;
const FIXTURE_SHORT_EDGE = Math.round(FIXTURE_LONG_EDGE * 0.75);

/**
 * A portrait photograph with an unmistakable top-left mark, carrying EXIF
 * orientation 6 — the tag a phone writes when held in portrait.
 *
 * Built the same way `audit:images` builds its fixture, and for the same
 * reason: constructed backwards from the answer so that "the mark came back to
 * the top-left" can only be true if the tag was read and applied.
 */
async function crookedPhotograph(): Promise<Buffer> {
  const mark = await sharp({
    create: {
      width: Math.round(FIXTURE_SHORT_EDGE / 8),
      height: Math.round(FIXTURE_LONG_EDGE / 8),
      channels: 3,
      background: "#d81e05",
    },
  })
    .png()
    .toBuffer();

  const upright = await sharp({
    create: {
      width: FIXTURE_SHORT_EDGE,
      height: FIXTURE_LONG_EDGE,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite([{ input: mark, top: 0, left: 0 }])
    .jpeg({ quality: 92 })
    .toBuffer();

  return sharp(upright)
    .rotate(-90)
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 92 })
    .toBuffer();
}

/**
 * The folder a derivative lands in, **derived rather than typed**.
 *
 * This was the literal `derived/v1/` and went red the day `PIPELINE_VERSION`
 * moved to 2 — the run uploads a fresh photograph, which comes back under
 * `derived/v2/`, so the assertion was looking for a path the shop had stopped
 * producing. `scripts/audit/images.ts` had already taken this exact lesson and
 * says so in its own comment; this file and `image-colour.ts` were the two
 * copies nobody went back for.
 *
 * A copy of a derivable value is an assertion about the past.
 */
const DERIVED_PREFIX = `derived/v${PIPELINE_VERSION}/`;

async function main() {
  /*
    The browser writes wherever BASE_URL points, which the credential guard
    cannot see. See clients.ts — this is the half that let production pick up
    two guest carts on 2026-08-14.
  */
  await assertServerNotProduction(BASE_URL, "run audit:image-upload");

  const admin = adminClient();

  /**
   * The product is chosen **from the shop page**, not from the database.
   *
   * Section 7 has to assert that a card fetches the derivative directly, and a
   * card only exists for a product the listing actually renders. Picking "the
   * first active product" out of Postgres gave one that sits on page two, so
   * the assertion failed reporting "the loader is not wired" while the loader
   * was working — the second time in this gate that a check failed for a reason
   * unrelated to the thing it names.
   *
   * Harvesting the slug from the page removes the coupling: whatever the
   * listing shows first is, by construction, a product with a card on it.
   */
  const bootBrowser = await chromium.launch();
  const bootPage = await bootBrowser.newPage();
  await bootPage.goto(`${BASE_URL}/shop`, { waitUntil: "load" });
  const slug = await bootPage
    .locator('a[href^="/product/"]')
    .first()
    .getAttribute("href");
  await bootBrowser.close();

  const chosenSlug = slug?.replace("/product/", "").split(/[?#]/)[0] ?? "";
  if (!chosenSlug) {
    console.error("No product card on /shop to work with.");
    process.exit(1);
  }

  const { data: product, error: productError } = await admin
    .from("products")
    .select("id, name, slug")
    .eq("slug", chosenSlug)
    .single();

  if (productError || !product) {
    console.error(`Could not load ${chosenSlug}: ${productError?.message}`);
    process.exit(1);
  }
  console.log(`  using ${product.name} (${product.slug}), taken from /shop`);

  const account = await createAccount("imgupload");
  {
    const { error } = await admin
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", account.userId);
    if (error) throw new Error(`could not promote the probe: ${error.message}`);
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
  });
  await context.addCookies(await sessionCookies(account.session));
  const page = await context.newPage();

  /** Rows this run creates, removed in the finally whatever happens. */
  const createdImageIds: string[] = [];

  try {
    console.log("\n\x1b[1m1 · the control is on screen and operable\x1b[0m");

    await page.goto(`${BASE_URL}/admin/products/${product.id}`, {
      waitUntil: "load",
    });

    const chooser = page.getByRole("button", {
      name: /choose a photograph/i,
    });
    check(
      "a photograph control is findable by its visible name",
      await chooser.isVisible(),
      "getByRole, not a selector — a control a screen reader cannot name fails here",
    );

    check(
      "the recommendation is stated before a file is chosen",
      (await page.locator("body").innerText()).includes("2000 × 2000"),
    );

    const bodyText = await page.locator("body").innerText();
    check(
      "the two-shot guidance is on screen",
      /outsole/i.test(bodyText),
      "the card crossfades to it; a product with one photograph is a broken interaction",
    );

    console.log(
      "\n\x1b[1m2 · choosing a crooked photograph shows the real frame\x1b[0m",
    );

    const fixture = await crookedPhotograph();
    await page.setInputFiles("#product-photograph", {
      name: "IMG_9001.jpg",
      mimeType: "image/jpeg",
      buffer: fixture,
    });

    const commit = page.getByRole("button", { name: /add this photograph/i });
    await commit.waitFor({ state: "visible", timeout: 20_000 });

    /**
     * **This check used to assert the wrong thing, and then passed for the
     * wrong reason.**
     *
     * It looked for `.bg-fog.aspect-4/5` — the old 4:5 preview, which the crop
     * step replaced with a square framing stage. It kept passing anyway,
     * because the contact sheet further down the same page renders its tiles in
     * exactly those classes. A check that matches something else on the page is
     * worse than a red one: it reports coverage of a control that no longer
     * exists.
     *
     * What matters now is that the owner is shown the square the pipeline will
     * receive, so that is what is asserted, by the accessible name a person and
     * a screen reader both get.
     */
    const stage = page.getByRole("group", { name: /Framing/i });
    await stage.waitFor({ state: "visible", timeout: 30_000 });
    check(
      "the framing square is what the owner is shown",
      await stage.isVisible(),
      "the square is the crop the pipeline receives — audit:image-editor operates it",
    );

    /**
     * The property that makes the description *required*. Asserting that the
     * saved row has alt text would pass even if the field were optional and
     * simply filled in; this is the check that fails if the requirement is
     * removed.
     */
    check(
      "the commit button is disabled while the description is empty",
      await commit.isDisabled(),
      "this, not the saved value, is what makes alt text required",
    );

    const description = page.getByLabel(/describe this photograph/i);
    await description.fill(`${product.name}, three-quarter view`);

    /**
     * A description is no longer sufficient on its own: the original now
     * uploads while the owner frames, and committing before it lands would
     * process a file that is not there yet. So the button waits for the upload
     * *and* the description, and this waits with it rather than asserting
     * against a race it would win about half the time.
     */
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !(await commit.isEnabled())) {
      await page.waitForTimeout(500);
    }
    check(
      "and enabled once it is filled in and the original has landed",
      await commit.isEnabled(),
      "the upload runs behind the framing, so both have to be done",
    );

    console.log("\n\x1b[1m3 · committing produces a catalogue asset\x1b[0m");

    const before = await countImages(admin, product.id);
    await commit.click();

    // Processing is several seconds of CPU on the server; the panel says so.
    await page
      .getByRole("button", { name: /choose a photograph/i })
      .waitFor({ state: "visible", timeout: 90_000 });

    const rows = await listImages(admin, product.id);
    check(
      "a product_images row was written",
      rows.length === before + 1,
      `${before} → ${rows.length}`,
    );

    const newest = rows[rows.length - 1]!;
    createdImageIds.push(newest.id);

    check(
      "the description the owner typed is what was stored",
      newest.alt_text === `${product.name}, three-quarter view`,
      newest.alt_text ?? "(null)",
    );

    check(
      "the row points at a pipeline derivative, not at the raw upload",
      isDerivative(newest.url),
      newest.url.split("/").slice(-3).join("/"),
    );

    console.log("\n\x1b[1m4 · the stored asset is what was promised\x1b[0m");

    const canonical = await fetch(newest.url);
    check(
      "the canonical asset is actually fetchable",
      canonical.ok,
      `HTTP ${canonical.status}`,
    );

    if (canonical.ok) {
      const bytes = Buffer.from(await canonical.arrayBuffer());
      const meta = await sharp(bytes).metadata();

      check(
        "it is square at the canonical edge",
        meta.width === CANONICAL_EDGE && meta.height === CANONICAL_EDGE,
        `${meta.width}×${meta.height}`,
      );
      check("it is WebP", meta.format === "webp", String(meta.format));
      check(
        "no EXIF survived the round trip",
        meta.exif === undefined,
        "a phone photograph's EXIF carries the GPS of the room it was taken in",
      );

      const centre = await redCentroid(bytes);
      check(
        "the portrait photograph came back upright",
        centre !== null && centre.x < 0.5 && centre.y < 0.5,
        centre
          ? `mark at (${centre.x.toFixed(2)}, ${centre.y.toFixed(2)}) — ignoring the EXIF tag would put it bottom-left`
          : "no mark found",
      );
    }

    console.log("\n\x1b[1m5 · every width the loader can ask for exists\x1b[0m");

    /**
     * The list is imported, so an empty one would make this section print
     * nothing and count as a pass — the loop is the only thing that asserts a
     * width exists at all.
     */
    scanned("widths the loader can ask for", CANONICAL_WIDTHS.length, 2);

    for (const width of CANONICAL_WIDTHS) {
      const url = derivativeLoader({ src: newest.url, width });
      const response = await fetch(url);
      if (!response.ok) {
        check(`${width}px variant`, false, `HTTP ${response.status} — ${url}`);
        continue;
      }
      const meta = await sharp(
        Buffer.from(await response.arrayBuffer()),
      ).metadata();
      check(
        `${width}px variant is really ${width}px`,
        meta.width === width && meta.height === width,
        `${meta.width}×${meta.height}, ${((meta.size ?? 0) / 1024).toFixed(0)}KB`,
      );
    }

    console.log(
      "\n\x1b[1m6 · the original was kept, with room to crop into\x1b[0m",
    );

    const { data: originals, error: listError } = await admin.storage
      .from(BUCKET)
      .list(`originals/${product.id}`, { limit: 100 });

    check(
      "the untouched upload is still in originals/",
      !listError && (originals ?? []).length > 0,
      `${(originals ?? []).length} file(s) — this is what makes a reprocess possible`,
    );

    /**
     * The row has to *name* its original, not merely coexist with one.
     *
     * `originals/` accumulates: a failed normalisation leaves a file behind on
     * purpose. So "there is a file in the folder" would stay true after the
     * column stopped being written, and re-crop — which reads the column, not
     * the folder — would have nothing to work from.
     */
    check(
      "the row names the original it came from",
      typeof newest.original_path === "string" &&
        newest.original_path.startsWith(`originals/${product.id}/`),
      newest.original_path ?? "(null)",
    );

    /**
     * **The headroom check.** A crop is a zoom, and it can only zoom into
     * pixels that were uploaded.
     *
     * Until 2026-08-13 the panel shrank every upload to `CANONICAL_EDGE`, so
     * `originals/` held a 1600px copy and a crop to the target fill fed roughly
     * 750px into a 1600px canvas. Nothing failed — the pipeline upscales by
     * design — it simply looked soft, which is the failure this whole area
     * exists to prevent and the one no other assertion here would notice.
     *
     * The fixture is `UPLOAD_EDGE + 200` on its long edge, so this is a real
     * measurement of where the panel capped it, not of what it was handed. It
     * fails loudly if the cap is ever lowered back.
     */
    if (typeof newest.original_path === "string") {
      const { data: originalFile, error: originalError } = await admin.storage
        .from(BUCKET)
        .download(newest.original_path);

      if (originalError || !originalFile) {
        check(
          "the stored original can be read back",
          false,
          originalError?.message ?? "no body",
        );
      } else {
        const meta = await sharp(
          Buffer.from(await originalFile.arrayBuffer()),
        ).metadata();
        const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);

        check(
          "the stored original keeps the full upload edge",
          longEdge === UPLOAD_EDGE,
          `${meta.width}×${meta.height} from a ${FIXTURE_SHORT_EDGE}×${FIXTURE_LONG_EDGE} source — the cap is ${UPLOAD_EDGE}px`,
        );
        check(
          "which is more than the canonical edge, so a crop has room to zoom",
          longEdge > CANONICAL_EDGE,
          `${longEdge} > ${CANONICAL_EDGE} — at parity a crop to the target fill would upscale about 2x`,
        );
      }
    }

    console.log(
      "\n\x1b[1m7 · promoted to main, the storefront serves it directly\x1b[0m",
    );

    /**
     * The gallery on a product page renders only the images belonging to the
     * colourway currently selected, and a freshly uploaded photograph has no
     * colour set — so asserting on that page would fail for a reason that has
     * nothing to do with this pipeline. The first version of this gate did
     * exactly that and reported "the loader is not wired" while the loader was
     * working perfectly.
     *
     * The card is the honest surface: it always renders the primary image,
     * whatever its colour. Getting there means operating one more owner-facing
     * control — "Make main" — which needs the operate-and-assert treatment
     * anyway, so the detour is the coverage.
     */
    const makeMain = page
      .getByRole("button", { name: /make main/i })
      .last();
    await makeMain.click();
    await page.waitForTimeout(1500);

    const afterPromote = await listImages(admin, product.id);
    const promoted = afterPromote.find((row) => row.id === newest.id);
    check(
      "Make main moved the new photograph to the front",
      promoted !== undefined && afterPromote[0]?.id === newest.id,
      "operated by its visible label, asserted against the stored row",
    );

    const shop = await page.goto(`${BASE_URL}/shop`, { waitUntil: "load" });
    check("the shop still renders", shop?.ok() === true);

    const card = page.locator(`a[href^="/product/${product.slug}"]`).first();
    check(
      "the product's own card is on the page we are asserting about",
      await card.count() > 0,
      "the slug was harvested from this listing, so this cannot drift",
    );

    const html = await page.content();
    check(
      "the card fetches the derivative directly, not through the optimiser",
      html.includes(DERIVED_PREFIX) && !derivativeGoesThroughOptimiser(html),
      "srcset carries storage URLs with width descriptors; no /_next/image round trip",
    );

  } finally {
    for (const id of createdImageIds) {
      const { error: cleanupError } = await admin
        .from("product_images")
        .delete()
        .eq("id", id);
      // Reported rather than swallowed: a fixture row left on a product is a
      // photograph the next run counts and a human eventually finds on staging.
      if (cleanupError) {
        console.error(`  ! could not clean up image ${id}: ${cleanupError.message}`);
      }
    }
    await admin.auth.admin.deleteUser(account.userId).catch(() => {});
    await browser.close();
  }

  /* ═══ the decode ceiling ═════════════════════════════════════════════════ */
  /*
    A byte limit is not a pixel limit, and this is where that gap gets tested.

    `MAX_UPLOAD_BYTES` (5MB) bounds what crosses the wire. It says nothing about
    what the bytes expand to once decoded, and the compression ratio belongs to
    whoever made the file: a flat-colour PNG at 8000 × 8000 is 64 megapixels
    unpacked and well under 200KB on disk. It is a real PNG with correct magic
    bytes that passes every check the upload path has, and without an explicit
    `limitInputPixels` it takes the function down inside `inspect()` — before a
    single one of the pipeline's own dimension checks has run.

    Asserted here rather than trusted from the source, because the control is a
    library option and options get dropped in refactors without anything
    noticing. This section is the thing that notices.
  */
  {
    const side = 8_000;
    const bomb = await sharp({
      create: { width: side, height: side, channels: 3, background: "#ffffff" },
      limitInputPixels: false,
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    check(
      "the bomb is a legitimate-looking upload — under the byte ceiling",
      bomb.length < MAX_UPLOAD_BYTES,
      `${(bomb.length / 1024).toFixed(0)}KB, ${((bomb.length / MAX_UPLOAD_BYTES) * 100).toFixed(1)}% of the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit`,
    );
    check(
      "and it is over the decode ceiling — so the two limits genuinely differ",
      side * side > MAX_DECODED_PIXELS,
      `${((side * side) / 1e6).toFixed(0)}MP decoded vs a ${(MAX_DECODED_PIXELS / 1e6).toFixed(0)}MP ceiling`,
    );

    let refusal: Error | null = null;
    try {
      await inspect(bomb);
    } catch (error) {
      refusal = error instanceof Error ? error : new Error(String(error));
    }
    check(
      "inspect() refuses it rather than decoding it",
      refusal !== null,
      refusal ? refusal.message : "NOT REFUSED — the pixel limit is not in force",
    );
    check(
      "and the refusal is sayable, not a raw sharp error",
      refusal?.name === "ImagePipelineError",
      `${refusal?.name ?? "none"}: ${refusal?.message ?? ""}`,
    );

    // The other half: the ceiling must not be so low it refuses real work.
    const realistic = await sharp({
      create: { width: UPLOAD_EDGE, height: UPLOAD_EDGE, channels: 3, background: "#cccccc" },
    })
      .jpeg()
      .toBuffer();
    let realInfo: { width: number; height: number } | null = null;
    try {
      realInfo = await inspect(realistic);
    } catch {
      realInfo = null;
    }
    check(
      `a real ${UPLOAD_EDGE}×${UPLOAD_EDGE} upload still inspects`,
      realInfo?.width === UPLOAD_EDGE,
      realInfo ? `${realInfo.width}×${realInfo.height}` : "REFUSED — the ceiling is too low",
    );
  }

  console.log(
    failed === 0
      ? `\n\x1b[1m\x1b[32mimage-upload: ${passed} checks, all green.\x1b[0m\n`
      : `\n\x1b[1m\x1b[31mimage-upload: ${failed} of ${passed + failed} checks failed.\x1b[0m\n`,
  );
  if (failed > 0) process.exit(1);
}

async function countImages(
  admin: ReturnType<typeof adminClient>,
  productId: string,
): Promise<number> {
  return (await listImages(admin, productId)).length;
}

type ImageRow = {
  id: string;
  url: string;
  alt_text: string | null;
  original_path: string | null;
};

async function listImages(
  admin: ReturnType<typeof adminClient>,
  productId: string,
): Promise<ImageRow[]> {
  const { data, error } = await admin
    .from("product_images")
    .select("id, url, alt_text, original_path")
    .eq("product_id", productId)
    .order("sort_order")
    .overrideTypes<ImageRow[]>();
  // Throwing rather than returning []: an unreadable table would otherwise make
  // "a row was written" fail with a count of 0, which reads as a broken upload
  // and sends the next person to the wrong place entirely.
  if (error) throw new Error(`could not read product_images: ${error.message}`);
  return data ?? [];
}

/**
 * True when a derivative URL has been handed to the Next optimiser after all.
 *
 * The failure this distinguishes: `/_next/image?url=…derived/…` contains the
 * string "derived/v1/" too, so a naive `includes` would call the optimiser path
 * a success. Asking whether any optimiser URL wraps a derivative is the
 * question that actually separates the two.
 */
function derivativeGoesThroughOptimiser(html: string): boolean {
  return /_next\/image\?url=[^"']*derived(%2F|\/)v1/.test(html);
}

/** See `audit:images` — a centroid, not a sampled pixel, so padding cannot fool it. */
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
    if (data[offset]! > 150 && data[offset + 1]! < 100 && data[offset + 2]! < 100) {
      sumX += i % info.width;
      sumY += Math.floor(i / info.width);
      count += 1;
    }
  }
  if (count === 0) return null;
  return { x: sumX / count / info.width, y: sumY / count / info.height };
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
