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
import { assertNotProduction } from "./clients";

assertNotProduction("run image-upload");

import sharp from "sharp";
import { chromium } from "playwright";

import { CANONICAL_WIDTHS, CANONICAL_EDGE } from "../../src/lib/images/constants";
import { derivativeLoader, isDerivative } from "../../src/lib/images/srcset";
import { adminClient, createAccount, sessionCookies } from "./fixtures";
import { BASE_URL } from "./routes";

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
 * A portrait photograph with an unmistakable top-left mark, carrying EXIF
 * orientation 6 — the tag a phone writes when held in portrait.
 *
 * Built the same way `audit:images` builds its fixture, and for the same
 * reason: constructed backwards from the answer so that "the mark came back to
 * the top-left" can only be true if the tag was read and applied.
 */
async function crookedPhotograph(): Promise<Buffer> {
  const mark = await sharp({
    create: { width: 150, height: 200, channels: 3, background: "#d81e05" },
  })
    .png()
    .toBuffer();

  const upright = await sharp({
    create: { width: 1200, height: 1600, channels: 3, background: "#ffffff" },
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

async function main() {
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

    check(
      "the preview is drawn in the card's own frame",
      await page.locator(".bg-fog.aspect-4\\/5").first().isVisible(),
      "aspect-4/5 over bg-fog — the same three the storefront card uses",
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
    check(
      "and enabled once it is filled in",
      await commit.isEnabled(),
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

    console.log("\n\x1b[1m6 · the original was kept\x1b[0m");

    const { data: originals, error: listError } = await admin.storage
      .from(BUCKET)
      .list(`originals/${product.id}`, { limit: 100 });

    check(
      "the untouched upload is still in originals/",
      !listError && (originals ?? []).length > 0,
      `${(originals ?? []).length} file(s) — this is what makes a reprocess possible`,
    );

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
      html.includes("derived/v1/") && !derivativeGoesThroughOptimiser(html),
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

async function listImages(
  admin: ReturnType<typeof adminClient>,
  productId: string,
): Promise<{ id: string; url: string; alt_text: string | null }[]> {
  const { data, error } = await admin
    .from("product_images")
    .select("id, url, alt_text")
    .eq("product_id", productId)
    .order("sort_order")
    .overrideTypes<{ id: string; url: string; alt_text: string | null }[]>();
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
