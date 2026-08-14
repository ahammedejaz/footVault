/**
 * `npm run audit:image-editor` — the owner frames a photograph and the shop
 * stores what they framed.
 *
 *   npm run build:stage && npm run start:stage    # a production build on :3210
 *   npm run audit:image-editor
 *
 * ## What this proves that nothing else does
 *
 * `audit:images` proves the pipeline and the crop arithmetic with no browser at
 * all — 74 assertions, including what auto-frame fails on. `audit:image-upload`
 * proves a photograph can be uploaded through the real panel. Neither of them
 * touches the thing this feature actually is: **a human moving a square over a
 * picture**.
 *
 * So every control here is located by its visible label, operated, and then
 * checked against what the database and Storage hold afterwards. The rule this
 * codebase learned the hard way — twice, with a delivery selector and a
 * Pay-on-Delivery switch that were "built · proved" while the owner could not
 * find them — is that asserting on page text proves nothing about whether a
 * control exists, and asserting on a stored value proves nothing about whether
 * a human could have caused it.
 *
 * ## And what it deliberately does not claim
 *
 * **`audit:reachability` is not evidence for any of this.** It derives its page
 * list from `src/app/(storefront)` and plays a customer clicking around the
 * shop; it has nothing whatsoever to say about whether the crop step can be
 * found in the admin. Keeping it green is a regression check on the storefront
 * and is reported as exactly that.
 *
 * The screenshots at the end are not assertions either. They exist because the
 * last defect in this area was a mispositioned button that every predicate
 * passed and a human eye caught, and they are written for a human to look at.
 */

// clients first: this writes into staging and must never reach the live shop.
import "./clients";
import { assertNotProduction, assertServerNotProduction } from "./clients";

assertNotProduction("run image-editor");

import { mkdirSync } from "node:fs";

import sharp from "sharp";
import { chromium, type Locator, type Page } from "playwright";

import { CANONICAL_EDGE } from "../../src/lib/images/constants";
import { normaliseCrop } from "../../src/lib/images/crop";
import { isDerivative } from "../../src/lib/images/srcset";
import { adminClient, createAccount, sessionCookies } from "./fixtures";
import { BASE_URL } from "./routes";
import { scanned } from "./scanned";

const SHOT_WIDTHS = [390, 768, 1024, 1440] as const;

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

/* ------------------------------------------------------------ fixtures ---- */

/**
 * The awkward source the brief names: portrait, off-centre, EXIF-rotated, dim.
 *
 * Every one of those is a property something downstream has to survive, and the
 * subject is a known rectangle at a known place so "it came out at the right
 * fill, the right way up" can be *measured* rather than eyeballed.
 */
async function awkwardPhotograph(background = "#e8e2d6"): Promise<Buffer> {
  const width = 2400;
  const height = 3200;

  const shoe = await sharp({
    create: { width: 900, height: 420, channels: 3, background: "#2b2b33" },
  })
    .png()
    .toBuffer();

  /**
   * **There is deliberately no second object in this frame.**
   *
   * The first version put a red orientation mark near the top-left, and the
   * gate then failed reporting "85% shown, 32% stored" — correctly. Auto-frame
   * finds everything that is not background, so it returned the box spanning
   * the mark *and* the shoe (the documented two-shoes behaviour), the panel
   * honestly reported that box filling 85% of the frame, and the check
   * measured only the dark shoe inside it. Two right answers to two different
   * questions.
   *
   * Orientation is proved without a mark: the shoe is 900x420, so it is a
   * landscape subject. Ignore the EXIF tag and it comes back 420x900. The
   * assertion is that the stored subject is wider than it is tall, which only a
   * correctly rotated pipeline produces.
   */
  const upright = await sharp({
    create: { width, height, channels: 3, background },
  })
    // Off-centre and low, the way a shoe on a table sits in the frame.
    .composite([{ input: shoe, top: 2100, left: 300 }])
    // Dim, because a shop photograph taken indoors is.
    .modulate({ brightness: 0.72 })
    .jpeg({ quality: 92 })
    .toBuffer();

  // Stored sideways with the tag that says to stand it up: what a phone writes.
  return sharp(upright)
    .rotate(-90)
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 92 })
    .toBuffer();
}

/** A photograph auto-frame cannot read: the subject on a noisy background. */
async function busyPhotograph(): Promise<Buffer> {
  const shoe = await sharp({
    create: { width: 900, height: 420, channels: 3, background: "#2b2b33" },
  })
    .png()
    .toBuffer();

  return sharp({
    create: {
      width: 2400,
      height: 1800,
      channels: 3,
      background: "#808080",
      noise: { type: "gaussian", mean: 150, sigma: 40 },
    },
  })
    .composite([{ input: shoe, top: 1100, left: 300 }])
    .jpeg({ quality: 92 })
    .toBuffer();
}

/* ----------------------------------------------------------- measuring ---- */

/** The dark subject's box, as fractions of the asset. */
async function subjectBounds(image: Buffer) {
  const { data, info } = await sharp(image)
    .raw()
    .toBuffer({ resolveWithObject: true });

  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < info.width * info.height; i += 1) {
    const at = i * info.channels;
    if (data[at]! < 120 && data[at + 1]! < 120 && data[at + 2]! < 120) {
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

/** The percentage the panel is currently claiming, or null when it says it cannot tell. */
async function readFill(page: Page): Promise<number | null> {
  const text = await page.getByText(/fills \d+% of the frame/).first().textContent()
    .catch(() => null);
  if (!text) return null;
  const match = /(\d+)%/.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * Move a range input the way a person does.
 *
 * `fill()` on a range works in Chromium but says nothing about whether the
 * control is reachable; the keyboard path proves it is focusable, labelled and
 * operable without a mouse — which on this panel is the same question as
 * "does it work for the harness *and* for a screen reader".
 */
/** Wait until a control is genuinely operable, not merely painted. */
async function expectEnabled(locator: Locator, timeout: number) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await locator.isEnabled()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function nudgeSlider(slider: Locator, presses: number, key = "ArrowRight") {
  await slider.focus();
  for (let i = 0; i < presses; i += 1) await slider.press(key);
}

/* ---------------------------------------------------------------- main ---- */

async function main() {
  /*
    The browser writes wherever BASE_URL points, which the credential guard
    cannot see. See clients.ts — this is the half that let production pick up
    two guest carts on 2026-08-14.
  */
  await assertServerNotProduction(BASE_URL, "run audit:image-editor");

  const admin = adminClient();

  const boot = await chromium.launch();
  const bootPage = await boot.newPage();
  await bootPage.goto(`${BASE_URL}/shop`, { waitUntil: "load" });
  const href = await bootPage
    .locator('a[href^="/product/"]')
    .first()
    .getAttribute("href");
  await boot.close();

  const slug = href?.replace("/product/", "").split(/[?#]/)[0] ?? "";
  if (!slug) {
    console.error("No product card on /shop to work with.");
    process.exit(1);
  }

  const { data: product, error: productError } = await admin
    .from("products")
    .select("id, name, slug")
    .eq("slug", slug)
    .single();
  if (productError || !product) {
    console.error(`Could not load ${slug}: ${productError?.message}`);
    process.exit(1);
  }
  console.log(`  using ${product.name} (${product.slug}), taken from /shop`);

  const account = await createAccount("imgeditor");
  {
    const { error } = await admin
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", account.userId);
    if (error) throw new Error(`could not promote the probe: ${error.message}`);
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1100 },
    hasTouch: true,
  });
  await context.addCookies(await sessionCookies(account.session));
  const page = await context.newPage();

  const created: string[] = [];

  try {
    /* ═══ 1 · the crop step is on screen and operable ═══════════════════ */

    console.log("\n\x1b[1m1 · the crop step exists where the owner works\x1b[0m");

    await page.goto(`${BASE_URL}/admin/products/${product.id}`, {
      waitUntil: "load",
    });

    await page.setInputFiles("#product-photograph", {
      name: "IMG_9042.jpg",
      mimeType: "image/jpeg",
      buffer: await awkwardPhotograph(),
    });

    const stage = page.getByRole("group", { name: /Framing/i });
    await stage.waitFor({ state: "visible", timeout: 30_000 });
    check(
      "a framing square appears, named for what it does",
      await stage.isVisible(),
      "getByRole with an accessible name — a square a screen reader cannot name is not a control",
    );

    // The proposal arrives from the server; the readout is how we know it did.
    await page
      .getByText(/fills \d+% of the frame|Couldn.t find the shoe/)
      .first()
      .waitFor({ state: "visible", timeout: 60_000 });

    const autoFill = await readFill(page);
    check(
      "auto-frame reports a fill for a plain-background photograph",
      autoFill !== null,
      autoFill === null ? "said it could not find the shoe" : `${autoFill}%`,
    );

    /**
     * The gate reads the owner's target from the database rather than assuming
     * 85, so that changing the setting changes what this asserts. The fallback
     * is the same suggested default the reader uses when the row is absent —
     * and a read error is reported, because "no row" and "could not read"
     * would otherwise be the same silent 85.
     */
    const { data: settingsRow, error: settingsError } = await admin
      .from("site_settings")
      .select("value")
      .eq("key", "images")
      .maybeSingle();
    if (settingsError) {
      console.log(
        `  \x1b[33m!\x1b[0m could not read the images settings row: ${settingsError.message}`,
      );
    }
    const targetPercent =
      settingsRow &&
      typeof settingsRow.value === "object" &&
      settingsRow.value !== null &&
      typeof (settingsRow.value as { target_fill_percent?: unknown })
        .target_fill_percent === "number"
        ? ((settingsRow.value as { target_fill_percent: number })
            .target_fill_percent)
        : 85;

    check(
      "and it proposes the owner's target, not a hardcoded one",
      autoFill !== null && Math.abs(autoFill - targetPercent) <= 2,
      `${autoFill}% against a ${targetPercent}% setting`,
    );

    /**
     * **The square must actually contain the photograph.**
     *
     * Everything else in this gate was green while the crop stage rendered an
     * empty fog rectangle: the readout said 85%, the stored asset was correct,
     * the crop was correct. The picture was translated out of the frame by a
     * transform bug, and only a human looking at a screenshot noticed.
     *
     * So the stage is screenshotted and its pixels counted. A frame that is
     * uniformly the card surface is a frame with no photograph in it, whatever
     * the rest of the panel claims.
     */
    const stageShot = await stage.screenshot();
    const stagePixels = await sharp(stageShot).stats();
    const flat = stagePixels.channels.every((channel) => channel.stdev < 3);
    check(
      "the photograph is actually visible inside the square",
      !flat,
      flat
        ? "the stage is a flat colour — the picture is not in the frame"
        : `pixel spread ${stagePixels.channels.map((c) => c.stdev.toFixed(0)).join("/")} — not an empty rectangle`,
    );

    /* ═══ 2 · every control moves something ═════════════════════════════ */

    console.log("\n\x1b[1m2 · each control, by its visible label\x1b[0m");

    for (const [label, pattern] of [
      ["Zoom", /Zoom/],
      ["Straighten", /Straighten/],
      ["Brightness", /Brightness/],
      ["Contrast", /Contrast/],
    ] as const) {
      const control = page.getByLabel(pattern).first();
      check(
        `${label} is findable by its visible label`,
        (await control.count()) > 0 && (await control.isVisible()),
      );
    }

    const zoom = page.getByLabel(/Zoom/).first();
    const beforeZoom = await readFill(page);
    await nudgeSlider(zoom, 12);
    await page.waitForTimeout(300);
    const afterZoom = await readFill(page);
    check(
      "zooming changes the fill the panel reports",
      beforeZoom !== null && afterZoom !== null && afterZoom > beforeZoom,
      `${beforeZoom}% → ${afterZoom}% by keyboard alone`,
    );

    const straighten = page.getByLabel(/Straighten/).first();
    await nudgeSlider(straighten, 6);
    await page.waitForTimeout(1500);
    check(
      "straighten moves off zero and the panel survives re-measuring",
      Number(await straighten.inputValue()) > 0,
      `${await straighten.inputValue()}° — the frame is measured again server-side`,
    );

    await nudgeSlider(page.getByLabel(/Brightness/).first(), 8);
    check(
      "brightness moves",
      Number(await page.getByLabel(/Brightness/).first().inputValue()) > 0,
    );
    await nudgeSlider(page.getByLabel(/Contrast/).first(), 5);
    check(
      "contrast moves",
      Number(await page.getByLabel(/Contrast/).first().inputValue()) > 0,
    );

    /* ═══ 3 · dragging the square is a real interaction ═════════════════ */

    console.log("\n\x1b[1m3 · the picture moves under the square\x1b[0m");

    const box = await stage.boundingBox();
    const fillBeforeDrag = await readFill(page);
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2, {
        steps: 12,
      });
      await page.mouse.up();
      await page.waitForTimeout(200);
    }
    check(
      "a pointer drag is accepted without breaking the readout",
      box !== null && (await readFill(page)) !== null,
      `still reporting ${await readFill(page)}% after a 60px drag`,
    );
    check(
      "and dragging does not change the zoom the owner set",
      fillBeforeDrag === (await readFill(page)),
      "panning moves the crop, it does not resize it",
    );

    // Back to the proposal, so what is committed is a framing the owner could
    // plausibly have accepted rather than the harness's own wandering.
    await page.getByRole("button", { name: /Frame it for me/i }).click();
    await page.waitForTimeout(2500);

    /* ═══ 4 · what is committed is what was framed ══════════════════════ */

    console.log("\n\x1b[1m4 · the stored asset is the square on screen\x1b[0m");

    const commit = page.getByRole("button", { name: /Add this photograph/i });
    check(
      "the commit button is disabled while the description is empty",
      await commit.isDisabled(),
      "this, not the saved value, is what makes alt text required",
    );

    await page
      .getByLabel(/describe this photograph/i)
      .fill(`${product.name}, framed by the gate`);

    const framedFill = await readFill(page);
    await commit.click();
    await page
      .getByRole("button", { name: /choose a photograph/i })
      .waitFor({ state: "visible", timeout: 120_000 });

    const rows = await listImages(admin, product.id);
    const newest = rows[rows.length - 1]!;
    created.push(newest.id);

    check(
      "a row was written pointing at a derivative",
      isDerivative(newest.url),
      newest.url.split("/").slice(-2).join("/"),
    );
    check(
      "the framing was recorded on the row",
      newest.crop !== null && typeof newest.crop === "object",
      newest.crop ? JSON.stringify(normaliseCrop(newest.crop)) : "(null)",
    );
    check(
      "and the original it was cut from is named",
      typeof newest.original_path === "string",
      newest.original_path ?? "(null)",
    );

    const stored = await fetch(newest.url);
    check("the asset is fetchable", stored.ok, `HTTP ${stored.status}`);

    if (stored.ok) {
      const bytes = Buffer.from(await stored.arrayBuffer());
      const meta = await sharp(bytes).metadata();
      check(
        "it is square at the canonical edge",
        meta.width === CANONICAL_EDGE && meta.height === CANONICAL_EDGE,
        `${meta.width}×${meta.height}`,
      );
      check("no EXIF survived", meta.exif === undefined);

      const bounds = await subjectBounds(bytes);
      const achieved = bounds ? Math.max(bounds.width, bounds.height) : 0;
      check(
        "the shoe fills the frame to the target the panel promised",
        bounds !== null &&
          framedFill !== null &&
          Math.abs(achieved * 100 - framedFill) <= 4,
        `${(achieved * 100).toFixed(0)}% stored against ${framedFill}% shown`,
      );

      /**
       * Orientation, on a cropped asset. The red mark is in the source's true
       * top-left; a crop centred on the shoe may exclude it entirely, so the
       * check is that the *shoe* came back wider than it is tall — it is a
       * landscape subject, and only a correctly-rotated pipeline produces that.
       */
      check(
        "the EXIF-rotated portrait source came back the right way up",
        bounds !== null && bounds.width > bounds.height,
        bounds
          ? `subject ${(bounds.width * 100).toFixed(0)}% wide × ${(bounds.height * 100).toFixed(0)}% tall`
          : "no subject found",
      );
    }

    /* ═══ 5 · auto-frame says so when it cannot tell ════════════════════ */

    console.log("\n\x1b[1m5 · the honest fallback, through the real panel\x1b[0m");

    await page.setInputFiles("#product-photograph", {
      name: "IMG_9043.jpg",
      mimeType: "image/jpeg",
      buffer: await busyPhotograph(),
    });
    await page
      .getByText(/fills \d+% of the frame|Couldn.t find the shoe/)
      .first()
      .waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForTimeout(1500);

    const fallbackText = await page.locator("body").innerText();
    check(
      "a busy background is reported, not guessed at",
      /Couldn.t find the shoe/i.test(fallbackText),
      "a stated fallback invites a correction; a confident wrong crop gets approved",
    );
    check(
      "and the square is still operable so the owner can fix it",
      await page.getByLabel(/Zoom/).first().isEnabled(),
    );

    await page.getByRole("button", { name: /Choose a different one/i }).click();

    /* ═══ 6 · re-framing an image already on the product ════════════════ */

    console.log("\n\x1b[1m6 · re-framing, without re-uploading\x1b[0m");

    await page.reload({ waitUntil: "load" });

    const reframe = page.getByRole("button", { name: /^Re-frame$/i }).last();
    check(
      "a Re-frame control is on the photograph",
      (await reframe.count()) > 0 && (await reframe.isVisible()),
    );

    await reframe.click();

    /**
     * Waiting for *enabled*, not merely visible.
     *
     * The panel appears immediately and its controls stay disabled until the
     * server has measured the original's frame — so a harness that waits for
     * visibility nudges a dead slider, clicks a dead button, and then reports
     * that re-framing does not work. It did; the first run of this gate failed
     * here for exactly that reason.
     */
    const reZoom = page.getByLabel(/Zoom/).last();
    await reZoom.waitFor({ state: "visible", timeout: 60_000 });
    await expectEnabled(reZoom, 60_000);
    await nudgeSlider(reZoom, 15);

    const urlBefore = newest.url;
    const saveFraming = page.getByRole("button", { name: /Save this framing/i });
    await expectEnabled(saveFraming, 30_000);
    await saveFraming.click();
    await page.waitForTimeout(6000);

    const after = await listImages(admin, product.id);
    const reframed = after.find((row) => row.id === newest.id);

    check(
      "the row now points at a different derivative",
      reframed !== undefined && reframed.url !== urlBefore,
      `${urlBefore.split("/").slice(-2, -1)} → ${reframed?.url.split("/").slice(-2, -1)}`,
    );
    check(
      "and the new framing was recorded",
      reframed?.crop !== null &&
        JSON.stringify(reframed?.crop) !== JSON.stringify(newest.crop),
      "the six numbers changed with the picture",
    );

    if (reframed) {
      const refetched = await fetch(reframed.url);
      check("the re-framed asset is fetchable", refetched.ok, `HTTP ${refetched.status}`);
      if (refetched.ok) {
        const bytes = Buffer.from(await refetched.arrayBuffer());
        const meta = await sharp(bytes).metadata();
        check(
          "still square at the canonical edge",
          meta.width === CANONICAL_EDGE && meta.height === CANONICAL_EDGE,
          `${meta.width}×${meta.height}`,
        );
      }
    }

    /* ═══ 7 · the contact sheet ═════════════════════════════════════════ */

    console.log("\n\x1b[1m7 · the catalogue, side by side\x1b[0m");

    await page.reload({ waitUntil: "load" });
    const sheet = page.getByRole("heading", {
      name: /The catalogue, side by side/i,
    });
    check(
      "the contact sheet is on the product's own screen",
      (await sheet.count()) > 0,
      "one well-framed photograph is not the point; thirty consistent ones are",
    );

    const tiles = page.locator('a[href^="/admin/products/"] img');
    check(
      "it renders the catalogue's photographs at card size",
      (await tiles.count()) > 1,
      `${await tiles.count()} tiles`,
    );

    /* ═══ 8 · screenshots, for a human ══════════════════════════════════ */

    console.log("\n\x1b[1m8 · screenshots at the four widths\x1b[0m");

    mkdirSync("screenshots", { recursive: true });
    scanned("viewport widths screenshotted", SHOT_WIDTHS.length, 2);

    for (const width of SHOT_WIDTHS) {
      const shotContext = await browser.newContext({
        viewport: { width, height: 1000 },
        hasTouch: true,
        isMobile: width < 768,
        reducedMotion: "reduce",
      });
      await shotContext.addCookies(await sessionCookies(account.session));
      const shotPage = await shotContext.newPage();
      await shotPage.goto(`${BASE_URL}/admin/products/${product.id}`, {
        waitUntil: "load",
      });
      await shotPage.setInputFiles("#product-photograph", {
        name: "IMG_9044.jpg",
        mimeType: "image/jpeg",
        buffer: await awkwardPhotograph("#eef1f5"),
      });
      await shotPage
        .getByText(/fills \d+% of the frame|Couldn.t find the shoe/)
        .first()
        .waitFor({ state: "visible", timeout: 60_000 })
        .catch(() => {});
      /**
       * Scroll the page before capturing it. `fullPage` stitches the document
       * without triggering lazy loading, so the first version of these
       * screenshots showed the contact sheet as sixty empty grey boxes — a
       * picture of a bug that does not exist, which is worse than no picture.
       */
      await shotPage.evaluate(() =>
        window.scrollTo(0, document.body.scrollHeight),
      );
      await shotPage.waitForTimeout(1200);
      await shotPage.evaluate(() => window.scrollTo(0, 0));
      await shotPage.waitForTimeout(400);

      await shotPage.screenshot({
        path: `screenshots/image-editor-${width}.png`,
        fullPage: true,
      });
      await shotContext.close();
      console.log(`  wrote screenshots/image-editor-${width}.png`);
    }
    console.log(
      "  \x1b[90m(not assertions — the last defect here was a mispositioned button\n" +
        "   that every predicate passed and an eye caught)\x1b[0m",
    );
  } finally {
    for (const id of created) {
      const { error } = await admin.from("product_images").delete().eq("id", id);
      if (error) console.error(`  ! could not clean up image ${id}: ${error.message}`);
    }
    await admin.auth.admin.deleteUser(account.userId).catch(() => {});
    await browser.close();
  }

  console.log(
    failed === 0
      ? `\n\x1b[1m\x1b[32mimage-editor: ${passed} checks, all green.\x1b[0m\n`
      : `\n\x1b[1m\x1b[31mimage-editor: ${failed} of ${passed + failed} checks failed.\x1b[0m\n`,
  );
  console.log(
    "\x1b[90m  audit:reachability walks src/app/(storefront) only. It says nothing\n" +
      "  about whether this crop step can be found in the admin; the checks above\n" +
      "  are the only evidence of that.\x1b[0m\n",
  );
  if (failed > 0) process.exit(1);
}

type ImageRow = {
  id: string;
  url: string;
  alt_text: string | null;
  original_path: string | null;
  crop: unknown;
};

async function listImages(
  admin: ReturnType<typeof adminClient>,
  productId: string,
): Promise<ImageRow[]> {
  const { data, error } = await admin
    .from("product_images")
    .select("id, url, alt_text, original_path, crop")
    .eq("product_id", productId)
    .order("sort_order")
    .overrideTypes<ImageRow[]>();
  if (error) throw new Error(`could not read product_images: ${error.message}`);
  return data ?? [];
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
