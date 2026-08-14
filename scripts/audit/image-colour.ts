/**
 * `npm run audit:image-colour` — the owner uploads a photograph against one
 * colourway, and a customer looking at that colourway sees it.
 *
 *   npm run build:stage && npm run start:stage   # :3210, a PRODUCTION build
 *   npm run audit:image-colour
 *
 * ## Why this exists, and why `audit:image-upload` did not catch what it missed
 *
 * On 2026-08-14 the owner uploaded a photograph to a live product and it never
 * appeared. Every gate was green. `audit:image-upload` drives the real panel,
 * uploads a real file, measures the stored derivative at four widths and then
 * asserts against **`/shop`** — a route that is uncached and dynamic, and whose
 * card renders the primary image whatever its colour. Its own header says so:
 * asserting on the product page "would fail for a reason that has nothing to do
 * with this pipeline". That was true at the time and it is exactly why the bug
 * survived. The gate was written around the defect.
 *
 * Two properties had no gate at all until this file:
 *
 *   **The colour selects.** The product gallery renders one colourway at a
 *   time. A photograph filed under the wrong colourway — or, until tonight,
 *   under no colourway on a product whose colourways all had seeded artwork —
 *   is invisible on every page a customer can reach. Nothing asserted that an
 *   upload lands where the owner put it, because until tonight nothing wrote
 *   the column at all.
 *
 *   **The product page is fresh after an image write.** `/shop` is dynamic, so
 *   `audit:image-upload` stays green with `revalidateCatalog()` deleted from
 *   the entire image path. The product page's data comes through
 *   `unstable_cache` for an hour. This is the first image gate that reads it,
 *   and it is the reason this harness insists on a production build: under
 *   `next dev` every request re-renders and a freshness assertion proves
 *   nothing at all (the same trap `audit:appearance` documents, where a
 *   deleted `updateTag` passed 18/0 under dev and failed 14/4 under a build).
 *
 * ## What it would look like if this were broken
 *
 * Asserting "the derivative is somewhere in the HTML" would pass on the state
 * that caused the report: the upload appears four times in a production product
 * page today — in JSON-LD, in the RSC payload's `heroImage`, in the RSC
 * payload's product-level `images` — and **zero** times in the gallery a
 * customer looks at. So section 4 reads the gallery list by its accessible
 * name, in a real browser, after hydration, and asks whether that element
 * contains it.
 *
 * Asserting "it is in the chosen colourway's gallery" would pass for a
 * photograph shown on *every* colourway, which is a different thing and is the
 * state a broken write produces. So section 5 selects the *other* colourway and
 * requires it to be absent. That is the check the red control trips.
 */

// clients first: this writes into staging and must never reach the live shop.
import "./clients";
import { assertNotProduction, assertServerNotProduction } from "./clients";

assertNotProduction("run image-colour");

import sharp from "sharp";
import { chromium, type Page } from "playwright";

import { adminClient, createAccount, sessionCookies } from "./fixtures";
import { scanned } from "./scanned";
import { BASE_URL } from "./routes";

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
 * A photograph whose bytes are different on every run, and the reason that
 * matters.
 *
 * The derivative's path is a **content hash**, so a deterministic fixture
 * produces the same path every time — and this harness cleans up by deleting
 * the row with the service client, which revalidates nothing. So run N+1 warmed
 * a cached product page that still carried run N's now-deleted photograph at
 * the identical hash, and "it did not exist before the upload" went red for a
 * reason that had nothing to do with the code under test. Found by the red
 * control on 2026-08-15, which is what a red control is for.
 *
 * The mark's position and tint carry the entropy rather than a noise field: a
 * flat image compresses to a plausible upload, and `audit:images` already
 * proves the pipeline on awkward bytes.
 */
async function photograph(): Promise<Buffer> {
  const seed = crypto.randomUUID().replace(/-/g, "");
  const tint = `#${seed.slice(0, 6)}`;
  const inset = 20 + (parseInt(seed.slice(6, 8), 16) % 200);
  const mark = await sharp({
    create: { width: 240, height: 240, channels: 3, background: tint },
  })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: 2000,
      height: 2000,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite([{ input: mark, top: inset, left: inset }])
    .jpeg({ quality: 92 })
    .toBuffer();
}

type Admin = ReturnType<typeof adminClient>;

type Candidate = {
  id: string;
  slug: string;
  name: string;
  colourways: string[];
  taggedPerColourway: Record<string, number>;
};

/**
 * A product shaped like the one the report was about.
 *
 * Two or more colourways, **each with photography of its own**. That second
 * condition is the whole of the incident: on a product whose colourways own no
 * images, an untagged upload falls through to them and appears, which is why
 * the Woodland upload worked and the Asics one did not. A gate run against a
 * Woodland-shaped product would be green against a completely broken write
 * path.
 */
async function pickProduct(admin: Admin): Promise<Candidate> {
  const { data, error } = await admin
    .from("products")
    .select(
      "id, slug, name, is_active, deleted_at, product_variants(color, is_active), product_images(color)",
    )
    .eq("is_active", true)
    .is("deleted_at", null);
  if (error) throw new Error(`could not read the catalogue: ${error.message}`);

  const rows = (data ?? []) as unknown as {
    id: string;
    slug: string;
    name: string;
    product_variants: { color: string; is_active: boolean }[];
    product_images: { color: string | null }[];
  }[];

  scanned("active products", rows.length);

  const candidates: Candidate[] = [];
  for (const row of rows) {
    /**
     * Sorted, because PostgREST returns variants in whatever order the planner
     * felt like and the *first* colourway is the one this gate uploads
     * against. Two runs against the same product picked "Navy" and then
     * "Black", which means a failure reported one thing on Tuesday and another
     * on Wednesday for identical code.
     */
    const colourways = [
      ...new Set(row.product_variants.filter((v) => v.is_active).map((v) => v.color)),
    ].sort((a, b) => a.localeCompare(b));
    if (colourways.length < 2) continue;
    const tagged: Record<string, number> = {};
    for (const colour of colourways) {
      tagged[colour] = row.product_images.filter((i) => i.color === colour).length;
    }
    if (colourways.some((colour) => (tagged[colour] ?? 0) === 0)) continue;
    candidates.push({
      id: row.id,
      slug: row.slug,
      name: row.name,
      colourways,
      taggedPerColourway: tagged,
    });
  }

  scanned("products with ≥2 colourways that each own photography", candidates.length);
  // Deterministic rather than "the first one Postgres felt like returning": a
  // gate that examines a different product on every run reports a different
  // failure on every run.
  candidates.sort((a, b) => a.slug.localeCompare(b.slug));
  return candidates[0]!;
}

type ImageRow = {
  id: string;
  url: string;
  color: string | null;
  alt_text: string | null;
  is_primary: boolean;
  sort_order: number;
};

async function listImages(admin: Admin, productId: string): Promise<ImageRow[]> {
  const { data, error } = await admin
    .from("product_images")
    .select("id, url, color, alt_text, is_primary, sort_order")
    .eq("product_id", productId)
    .order("sort_order")
    .overrideTypes<ImageRow[]>();
  if (error) throw new Error(`could not read product_images: ${error.message}`);
  return data ?? [];
}

/**
 * The gallery a customer is looking at, as markup.
 *
 * By its accessible name, because that is the element the customer's eyes and a
 * screen reader both land on, and because reading `page.content()` would sweep
 * up JSON-LD, the RSC payload and the related-products rail — all three of
 * which carry the upload today on a page where the gallery does not.
 */
async function galleryHtml(page: Page, productName: string): Promise<string> {
  const list = page.getByRole("list", { name: `${productName} images` });
  await list.waitFor({ state: "visible", timeout: 20_000 });
  return list.innerHTML();
}

/** Pick a colourway on the storefront by pressing its swatch. */
async function chooseColourway(page: Page, colour: string): Promise<void> {
  await page.getByRole("radio", { name: colour }).first().click();
  // The gallery re-renders from React state; one frame is enough, and waiting
  // for a network idle that never comes would be a timeout, not a wait.
  await page.waitForTimeout(400);
}

async function main() {
  await assertServerNotProduction(BASE_URL, "run audit:image-colour");

  const admin = adminClient();

  console.log("\n\x1b[1m0 · what this run is scanning\x1b[0m");
  const product = await pickProduct(admin);
  const [colourA, colourB] = product.colourways;
  console.log(
    `  using ${product.name} (${product.slug})\n` +
      `    colourways: ${product.colourways
        .map((c) => `${c} (${product.taggedPerColourway[c]} tagged)`)
        .join(", ")}\n` +
      `    uploading against "${colourA}", asserting absence on "${colourB}"`,
  );

  const before = await listImages(admin, product.id);
  scanned("existing photographs on this product", before.length);

  const account = await createAccount("imgcolour");
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
  const shopper = await (await browser.newContext({
    viewport: { width: 1400, height: 1000 },
  })).newPage();

  const createdImageIds: string[] = [];
  let renamedBack = true;

  try {
    /* ── 1 ───────────────────────────────────────────────────────────────── */
    console.log(
      "\n\x1b[1m1 · the product page is warm before anything is written\x1b[0m",
    );

    /**
     * Two fetches, and the second one is the point.
     *
     * Under `build:stage` the product page's data sits in `unstable_cache`
     * behind the `catalog` tag for an hour. Reading it twice here is what puts
     * it there, so that section 3's freshness assertion is a claim about a
     * cache that is genuinely populated rather than about a page that was going
     * to re-render anyway. Under `next dev` this is a no-op and the whole gate
     * is theatre — hence the build the header insists on.
     */
    const warm1 = await fetch(`${BASE_URL}/product/${product.slug}`);
    const warm2 = await fetch(`${BASE_URL}/product/${product.slug}`);
    const warmHtml = await warm2.text();
    check(
      "the product page serves",
      warm1.ok && warm2.ok,
      `HTTP ${warm1.status} then ${warm2.status}`,
    );

    await shopper.goto(`${BASE_URL}/product/${product.slug}`, {
      waitUntil: "load",
    });
    const galleryBefore = await galleryHtml(shopper, product.name);
    scanned(
      "images in the gallery before the upload",
      (galleryBefore.match(/<img/g) ?? []).length,
    );

    /* ── 2 ───────────────────────────────────────────────────────────────── */
    console.log(
      "\n\x1b[1m2 · the colourway control is on screen and offers real colours\x1b[0m",
    );

    await page.goto(`${BASE_URL}/admin/products/${product.id}`, {
      waitUntil: "load",
    });

    const picker = page.getByLabel(/which colourway is this/i);
    await page
      .getByRole("button", { name: /choose a photograph/i })
      .waitFor({ state: "visible", timeout: 30_000 });

    const fixture = await photograph();
    await page.setInputFiles("#product-photograph", {
      name: "COLOUR_9001.jpg",
      mimeType: "image/jpeg",
      buffer: fixture,
    });

    const commit = page.getByRole("button", { name: /add this photograph/i });
    await commit.waitFor({ state: "visible", timeout: 30_000 });

    check(
      "a colourway control is findable by its visible name",
      await picker.isVisible(),
      "getByLabel, not a selector — a control a screen reader cannot name fails here",
    );

    const offered = await picker.locator("option").allTextContents();
    scanned("options in the colourway picker", offered.length, 2);
    check(
      "it offers this product's real colourways",
      product.colourways.every((c) => offered.includes(c)),
      offered.join(" / "),
    );
    check(
      'and "every colourway", which is the default',
      offered[0]?.toLowerCase().includes("every colourway") === true &&
        (await picker.inputValue()) === "",
      `first option "${offered[0]}", selected value "${await picker.inputValue()}"`,
    );

    /* ── 3 ───────────────────────────────────────────────────────────────── */
    console.log(
      `\n\x1b[1m3 · committing against "${colourA}" stores that colour\x1b[0m`,
    );

    await page.getByLabel(/describe this photograph/i).fill(
      `${product.name}, ${colourA}, colour gate`,
    );
    await picker.selectOption(colourA!);

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !(await commit.isEnabled())) {
      await page.waitForTimeout(500);
    }
    check("the commit button is ready", await commit.isEnabled());

    await commit.click();
    await page
      .getByRole("button", { name: /choose a photograph/i })
      .waitFor({ state: "visible", timeout: 120_000 });

    const after = await listImages(admin, product.id);
    scanned("photographs on this product after the upload", after.length);
    check(
      "a photograph was added",
      after.length === before.length + 1,
      `${before.length} → ${after.length}`,
    );

    const seen = new Set(before.map((row) => row.id));
    const added = after.find((row) => !seen.has(row.id));
    if (!added) throw new Error("the upload did not produce a row to assert on");
    createdImageIds.push(added.id);

    check(
      "the row carries the colourway the owner chose",
      added.color === colourA,
      `stored "${added.color ?? "(null)"}", chose "${colourA}"`,
    );

    /* ── 4 ───────────────────────────────────────────────────────────────── */
    console.log(
      "\n\x1b[1m4 · the CACHED product page is fresh, and the gallery has it\x1b[0m",
    );

    /**
     * The derivative's own path segment. Matching on the whole URL would be
     * defeated by any re-encoding between here and the srcset; matching on
     * `derived/v1/` alone would be satisfied by every other photograph on the
     * page.
     */
    const fingerprint = added.url.split("/derived/v1/")[1]?.split("/")[0] ?? "";
    check(
      "the new photograph has a content hash to match on",
      fingerprint.length > 0,
      fingerprint || added.url,
    );
    check(
      "and it did not exist on the page before the upload",
      !warmHtml.includes(fingerprint),
      "so a hit below cannot be something that was already there",
    );

    const fresh = await fetch(`${BASE_URL}/product/${product.slug}`);
    const freshHtml = await fresh.text();
    check(
      "the cached product page serves the new photograph",
      freshHtml.includes(fingerprint),
      "revalidateCatalog() cleared the catalog tag — delete it and this goes red under a build",
    );

    await shopper.goto(`${BASE_URL}/product/${product.slug}`, {
      waitUntil: "load",
    });
    await chooseColourway(shopper, colourA!);
    const galleryA = await galleryHtml(shopper, product.name);
    scanned("images in the gallery on " + colourA, (galleryA.match(/<img/g) ?? []).length);
    check(
      `the gallery on "${colourA}" renders it`,
      galleryA.includes(fingerprint),
      "read from the labelled gallery list, not from page.content() — JSON-LD carries it either way",
    );

    /* ── 5 ───────────────────────────────────────────────────────────────── */
    console.log(
      `\n\x1b[1m5 · and the other colourway does not\x1b[0m`,
    );

    await chooseColourway(shopper, colourB!);
    const galleryB = await galleryHtml(shopper, product.name);
    scanned("images in the gallery on " + colourB, (galleryB.match(/<img/g) ?? []).length);
    check(
      `the gallery on "${colourB}" does not render it`,
      !galleryB.includes(fingerprint),
      "this is the check a write that drops the colour trips: an untagged photograph shows on every colourway",
    );

    /* ── 6 ───────────────────────────────────────────────────────────────── */
    console.log(
      "\n\x1b[1m6 · retagging to every colourway puts it on both\x1b[0m",
    );

    await page.reload({ waitUntil: "load" });
    const rowSelect = page.locator(`#colour-${added.id}`);
    await rowSelect.waitFor({ state: "visible", timeout: 20_000 });
    check(
      "the image manager offers a colourway control for this photograph",
      await rowSelect.isVisible(),
      "the admin can retag a row without re-uploading it — the only fix for the four already in the shop",
    );
    check(
      "and it shows the colour the row actually holds",
      (await rowSelect.inputValue()) === colourA,
      await rowSelect.inputValue(),
    );

    await rowSelect.selectOption("");
    await page.waitForTimeout(2500);

    const retagged = (await listImages(admin, product.id)).find(
      (row) => row.id === added.id,
    );
    check(
      "retagging wrote null",
      retagged?.color === null,
      `stored "${retagged?.color ?? "(null)"}"`,
    );

    const managerText = await page.locator("body").innerText();
    check(
      "the admin says, in words, that it is now shown everywhere",
      /shown on every colourway/i.test(managerText),
      "an untagged photograph used to render as blank space, which reads as normal",
    );

    await shopper.goto(`${BASE_URL}/product/${product.slug}`, {
      waitUntil: "load",
    });
    await chooseColourway(shopper, colourA!);
    const bothA = await galleryHtml(shopper, product.name);
    await chooseColourway(shopper, colourB!);
    const bothB = await galleryHtml(shopper, product.name);
    check(
      "untagged means every colourway, not a fallback",
      bothA.includes(fingerprint) && bothB.includes(fingerprint),
      `${colourA}: ${bothA.includes(fingerprint)}, ${colourB}: ${bothB.includes(fingerprint)}`,
    );

    /* ── 7 ───────────────────────────────────────────────────────────────── */
    console.log(
      "\n\x1b[1m7 · renaming a colourway takes its photographs with it\x1b[0m",
    );

    /**
     * Asserted at the database, because the guarantee is a database one: the
     * cascade is a trigger on `product_variants`, not a step inside
     * `saveVariant`, precisely so it holds for the seed and for a SQL fix-up
     * and for whatever writes variants next year. Driving the variant editor
     * would test one caller of a rule that has no callers.
     */
    const { data: sizes, error: sizeError } = await admin
      .from("product_variants")
      .select("id")
      .eq("product_id", product.id)
      .eq("color", colourA!);
    if (sizeError) throw new Error(`could not read sizes: ${sizeError.message}`);
    scanned(`sizes carrying "${colourA}"`, (sizes ?? []).length);

    const taggedA = (await listImages(admin, product.id)).filter(
      (row) => row.color === colourA,
    );
    scanned(`photographs tagged "${colourA}"`, taggedA.length);

    const renamed = `${colourA} Renamed`;
    renamedBack = false;

    /**
     * Errors are read on every one of these three renames, not swallowed.
     *
     * A rename that silently failed would leave the old colour in place and
     * make "renaming the last one moves them all" go red — reporting a broken
     * trigger when the trigger never fired. The eslint rule that insists on
     * this exists for exactly that shape of misattribution.
     */
    const rename = async (id: string, colour: string) => {
      const { error } = await admin
        .from("product_variants")
        .update({ color: colour })
        .eq("id", id);
      if (error) throw new Error(`could not rename a size: ${error.message}`);
    };

    // One size only: a split, which must move nothing.
    await rename(sizes![0]!.id, renamed);
    const afterSplit = (await listImages(admin, product.id)).filter(
      (row) => row.color === renamed,
    );
    check(
      "renaming one size out of several moves no photographs",
      afterSplit.length === 0,
      `${afterSplit.length} moved — a split leaves the old colourway alive and its pictures with it`,
    );

    // The rest: a real rename, which must move all of them.
    for (const size of sizes!.slice(1)) await rename(size.id, renamed);
    const afterRename = (await listImages(admin, product.id)).filter(
      (row) => row.color === renamed,
    );
    check(
      "renaming the last one moves them all",
      afterRename.length === taggedA.length,
      `${afterRename.length} of ${taggedA.length} followed the rename`,
    );

    for (const size of sizes!) await rename(size.id, colourA!);
    renamedBack = true;
    const restored = (await listImages(admin, product.id)).filter(
      (row) => row.color === colourA,
    );
    check(
      "and renaming back restores them",
      restored.length === taggedA.length,
      `${restored.length} of ${taggedA.length}`,
    );
  } finally {
    if (!renamedBack) {
      console.error(
        "  ! the colourway rename was not undone — check product_variants by hand",
      );
    }
    for (const id of createdImageIds) {
      const { error } = await admin
        .from("product_images")
        .delete()
        .eq("id", id);
      if (error) {
        console.error(`  ! could not clean up image ${id}: ${error.message}`);
      }
    }
    await admin.auth.admin.deleteUser(account.userId).catch(() => {});
    await browser.close();
  }

  console.log(
    failed === 0
      ? `\n\x1b[1m\x1b[32mimage-colour: ${passed} checks, all green.\x1b[0m\n`
      : `\n\x1b[1m\x1b[31mimage-colour: ${failed} of ${passed + failed} checks failed.\x1b[0m\n`,
  );
  if (failed > 0) process.exit(1);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
