/**
 * `npm run audit:site-images` — the pictures the owner can change, and whether
 * the controls for changing them are on screen and operable.
 *
 *   npm run dev:stage          # a server on :3210, pointed at staging
 *   npm run audit:site-images
 *
 * ## The three things this proves, and why each is separate
 *
 * **1 · The arithmetic.** `frameRect` is imported by both the browser stage and
 * the server renderer, and everything about this feature rests on the two
 * agreeing. Section 1 checks its properties directly — the rectangle never
 * leaves the photograph, it keeps the frame's shape, and the default framing is
 * the plain centred cover crop every owner expects. No network, no browser.
 *
 * **2 · The pipeline.** Section 2 renders a constructed fixture through every
 * frame preset and reads pixels back out. This is where "the owner approved a
 * picture the shop did not store" would show up: the fixture is painted in four
 * distinguishable quadrants, so a framing that selects the top-left must
 * produce a top-left-coloured output, and an extract that silently ignored the
 * framing would come back the average colour and fail.
 *
 * **3 · Reachability.** Section 3 is the one this codebase has learned to
 * insist on. From `docs/staging.md` and the settings-controls gate's own
 * header: *for two phases the shop reported a delivery-mode selector as "Built ·
 * proved" while the owner could not find it, because every gate asserted on
 * page text.* Two toggles hid behind that for two phases.
 *
 * So this drives a real browser **at 390px**, signs in as an admin, and for
 * every surface that owns a picture asserts the control is present, has a
 * non-zero on-screen box inside the viewport, and is not disabled. A field
 * rendered off-screen, clipped to nothing by an overflow, or behind a collapsed
 * section fails here rather than in the owner's hands.
 *
 * ## What it does NOT cover, named so it never reads as coverage
 *
 * It does not upload through every surface — one real end-to-end upload is
 * driven (section 4) and the rest are proved reachable. Uploading five files
 * per run into a bucket to re-prove one code path would cost minutes and prove
 * the same thing five times.
 *
 * It does not check that a chosen picture *looks* good. That is the owner's
 * decision and the whole reason the framing stage exists.
 */

// clients first: this signs in, uploads and writes rows, and must never reach
// the live shop.
import "./clients";
import { assertNotProduction, assertServerNotProduction } from "./clients";

assertNotProduction("run site-images");

import sharp from "sharp";
import { chromium, type BrowserContext, type Page } from "playwright";

import {
  clampFraming,
  DEFAULT_FRAMING,
  frameRect,
  MAX_ZOOM,
  normaliseFraming,
} from "../../src/lib/images/frame";
import {
  aspectOf,
  IMAGE_FRAMES,
  type FrameKey,
} from "../../src/lib/images/site-frames";
import { renderSiteImage } from "../../src/lib/images/site-pipeline";
import { adminClient, createAccount, sessionCookies } from "./fixtures";
import { BASE_URL } from "./routes";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed += 1;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/* ========================================================================== */
/* 1 · the arithmetic                                                         */
/* ========================================================================== */

/**
 * Sources chosen to exercise both branches of the cover calculation: one wider
 * than every frame, one taller, and one already square.
 */
const SOURCES = [
  { label: "landscape 3000x2000", width: 3000, height: 2000 },
  { label: "portrait 1200x1800", width: 1200, height: 1800 },
  { label: "square 1400x1400", width: 1400, height: 1400 },
] as const;

function arithmetic() {
  section("1 · frameRect — the rectangle both sides compute");

  let insideAlways = true;
  let aspectAlways = true;
  let insideDetail = "";
  let aspectDetail = "";

  for (const source of SOURCES) {
    for (const key of Object.keys(IMAGE_FRAMES) as FrameKey[]) {
      const aspect = aspectOf(key);
      for (const zoom of [1, 1.5, 2.75, MAX_ZOOM]) {
        // Corners and centre, including values that ask to leave the frame.
        for (const [cx, cy] of [
          [0.5, 0.5],
          [0, 0],
          [1, 1],
          [-3, 4],
        ] as const) {
          const rect = frameRect(source.width, source.height, aspect, {
            ...DEFAULT_FRAMING,
            cx,
            cy,
            zoom,
          });

          const inside =
            rect.left >= 0 &&
            rect.top >= 0 &&
            rect.left + rect.width <= source.width &&
            rect.top + rect.height <= source.height;
          if (!inside && insideAlways) {
            insideAlways = false;
            insideDetail = `${source.label} / ${key} / zoom ${zoom} / (${cx},${cy}) → ${JSON.stringify(rect)}`;
          }

          /*
            Within one pixel, because `frameRect` rounds the width first and
            derives the height from it. Demanding exactness here would fail on
            arithmetic that is deliberately correct — see the module.
          */
          const drift = Math.abs(rect.width / rect.height - aspect);
          const tolerance = aspect / Math.min(rect.width, rect.height);
          if (drift > tolerance && aspectAlways) {
            aspectAlways = false;
            aspectDetail = `${source.label} / ${key} → ${rect.width}x${rect.height}, wanted ${aspect.toFixed(4)}`;
          }
        }
      }
    }
  }

  check(
    "the selected rectangle never leaves the photograph",
    insideAlways,
    insideDetail,
  );
  check("the selected rectangle keeps the frame's shape", aspectAlways, aspectDetail);

  /*
    The default is the plain centred cover crop — the thing `object-fit: cover`
    produces. An owner who uploads and saves without touching a control must get
    that, because it is what every other tool they have used gives them.
  */
  const cover = frameRect(3000, 2000, 16 / 9, DEFAULT_FRAMING);
  check(
    "the default framing is the plain centred cover crop",
    cover.width === 3000 &&
      cover.left === 0 &&
      Math.abs(cover.top - (2000 - 3000 / (16 / 9)) / 2) <= 1,
    JSON.stringify(cover),
  );

  /* A framing dragged past the edge must clamp to the same place on both
     sides of the wire, which is what `clampFraming` exists to guarantee. */
  const pulled = clampFraming(1200, 1800, 1, {
    ...DEFAULT_FRAMING,
    cx: 0.99,
    zoom: 1,
  });
  check(
    "a drag past the edge stops at the edge rather than off the picture",
    pulled.cx === 0.5,
    `cx came back ${pulled.cx}`,
  );

  /* A half-written jsonb value must render, not throw. It arrives from a
     column a human can edit. */
  const salvaged = normaliseFraming({ cx: "nonsense", zoom: 99 });
  check(
    "a half-written framing is salvaged rather than thrown on",
    salvaged.cx === DEFAULT_FRAMING.cx && salvaged.zoom === MAX_ZOOM,
    JSON.stringify(salvaged),
  );
}

/* ========================================================================== */
/* 2 · the pipeline                                                           */
/* ========================================================================== */

/** Four flat quadrants, so which part of the picture survived is readable. */
async function quadrantFixture(width: number, height: number): Promise<Buffer> {
  const half = { w: Math.floor(width / 2), h: Math.floor(height / 2) };
  const block = (r: number, g: number, b: number) =>
    sharp({
      create: {
        width: half.w,
        height: half.h,
        channels: 4,
        background: { r, g, b, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

  const [tl, tr, bl, br] = await Promise.all([
    block(255, 0, 0),
    block(0, 255, 0),
    block(0, 0, 255),
    block(255, 255, 0),
  ]);

  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .composite([
      { input: tl, left: 0, top: 0 },
      { input: tr, left: half.w, top: 0 },
      { input: bl, left: 0, top: half.h },
      { input: br, left: half.w, top: half.h },
    ])
    .png()
    .toBuffer();
}

/** The colour at a fractional position in a rendered buffer. */
async function pixelAt(
  data: Buffer,
  fx: number,
  fy: number,
): Promise<{ r: number; g: number; b: number; a: number }> {
  const image = sharp(data);
  const meta = await image.metadata();
  const width = meta.width ?? 1;
  const height = meta.height ?? 1;
  const left = Math.min(width - 1, Math.max(0, Math.round(fx * width)));
  const top = Math.min(height - 1, Math.max(0, Math.round(fy * height)));
  const raw = await image
    .ensureAlpha()
    .extract({ left, top, width: 1, height: 1 })
    .raw()
    .toBuffer();
  return { r: raw[0], g: raw[1], b: raw[2], a: raw[3] };
}

async function pipeline() {
  section("2 · renderSiteImage — what the shop actually stores");

  const source = await quadrantFixture(2000, 2000);

  for (const key of Object.keys(IMAGE_FRAMES) as FrameKey[]) {
    const spec = IMAGE_FRAMES[key];
    const rendered = await renderSiteImage(source, key, DEFAULT_FRAMING);
    const meta = await sharp(rendered.data).metadata();

    check(
      `${key}: comes out ${spec.width}x${spec.height} as ${spec.format}`,
      meta.width === spec.width &&
        meta.height === spec.height &&
        meta.format === spec.format,
      `got ${meta.width}x${meta.height} ${meta.format}`,
    );
  }

  /*
    The load-bearing one. Zoomed in on the top-left corner, the output must be
    the top-left colour — an extract that ignored the framing would come back
    holding all four quadrants, and the centre pixel would not be red.
  */
  const cornered = await renderSiteImage(source, "category_tile", {
    ...DEFAULT_FRAMING,
    cx: 0.12,
    cy: 0.12,
    zoom: 3,
  });
  const centre = await pixelAt(cornered.data, 0.5, 0.5);
  check(
    "a framing on the top-left corner produces the top-left of the photograph",
    centre.r > 200 && centre.g < 60 && centre.b < 60,
    `centre pixel rgb(${centre.r},${centre.g},${centre.b})`,
  );

  /* Framing changes the bytes. If it did not, every re-frame would be a no-op
     that looked like a save. */
  const plain = await renderSiteImage(source, "category_tile", DEFAULT_FRAMING);
  check(
    "re-framing produces a different file, and therefore a different address",
    plain.contentHash !== cornered.contentHash,
    `both hashed ${plain.contentHash}`,
  );

  /*
    A logo is contained on transparency, never cropped and never stretched. The
    corner of a `contain` render of a picture whose shape does not match the box
    must be fully transparent — a coloured corner would mean the artwork had
    been cut or padded onto a colour.
  */
  const tall = await quadrantFixture(400, 1200);
  const logo = await renderSiteImage(tall, "logo", DEFAULT_FRAMING);
  const corner = await pixelAt(logo.data, 0.02, 0.5);
  check(
    "a logo is fitted whole onto transparency rather than cropped",
    corner.a === 0,
    `corner alpha ${corner.a}`,
  );

  /* An upload smaller than its frame is reported rather than silently blown up. */
  const small = await quadrantFixture(300, 200);
  const upscaled = await renderSiteImage(small, "hero_desktop", DEFAULT_FRAMING);
  check(
    "a photograph smaller than its frame is measured, so the panel can say so",
    upscaled.source.width === 300 && upscaled.source.height === 200,
    `${upscaled.source.width}x${upscaled.source.height}`,
  );
}

/* ========================================================================== */
/* 3 · reachability                                                           */
/* ========================================================================== */

/**
 * Every surface that owns a picture, and how to get to its control on a phone.
 *
 * `open` is what a shopkeeper would do — press the thing that says Edit — and
 * not a selector reaching into a closed dialog. If opening the row is what is
 * broken, this must fail.
 */
type Surface = {
  id: string;
  path: string;
  /** Reveal the field, the way the owner would. */
  open: (page: Page) => Promise<void>;
  /** The accessible name of the control that puts a picture there. */
  control: RegExp;
};

const SURFACES: Surface[] = [
  {
    id: "branding-logo",
    path: "/admin/settings",
    open: async () => {},
    control: /Choose picture|Replace picture/,
  },
  {
    id: "category-tile",
    path: "/admin/categories",
    open: async (page) => {
      await page.getByRole("button", { name: /^Edit / }).first().click();
      await page.getByRole("dialog").waitFor({ state: "visible" });
    },
    control: /Choose picture|Replace picture/,
  },
  {
    id: "brand-logo",
    path: "/admin/brands",
    open: async (page) => {
      await page.getByRole("button", { name: /^Edit / }).first().click();
      await page.getByRole("dialog").waitFor({ state: "visible" });
    },
    control: /Choose picture|Replace picture/,
  },
  {
    id: "hero",
    path: "/admin/appearance",
    open: async (page) => {
      /*
        The hero's fields live inside a collapsed row, and the control that
        opens it is named `Edit <the section's title>` — the same shape the
        category and brand rows use, which is why all three are matched with
        `/^Edit /` rather than by the section's own words. Matching on the title
        alone resolved to the *disabled* "Move … up" arrow beside it, because
        that carries the title in its aria-label too. A selector that finds a
        disabled sibling is a selector that reports the page is broken when it
        is not, so it is pinned to the verb.

        Opening it the way a shopkeeper would is the point: a section that
        cannot be expanded on a phone is a section whose contents do not exist,
        whatever the markup says.
      */
      await page.getByRole("button", { name: /^Edit / }).first().click();
    },
    control: /Choose picture|Replace picture/,
  },
];

/**
 * A control that is present, named, enabled, and big enough to hit.
 *
 * ## Why the accessible control and the touch target are measured separately
 *
 * "Choose picture" is a styled `<label>` in front of a visually hidden
 * `<input type="file">` — the standard pattern, because a native file input
 * cannot be styled and a button that clicks a hidden input is a button a
 * keyboard reaches and a screen reader does not name.
 *
 * That splits the control in two. The **accessible** control is the input: the
 * label names it, so `getByRole("button", { name })` resolves to it and a
 * screen reader announces it. The **touchable** control is the label: it is
 * what a finger lands on, and the input it fronts is one pixel square.
 *
 * The first version of this measured the box of whatever the role query
 * returned and reported `1x1 — under a touch target` on all four surfaces. The
 * controls were fine; the measurement was pointed at the wrong half. So both
 * are checked, against the thing each claim is actually about — which is also
 * the only version that would catch the real failure, a label styled to nothing
 * in front of an input nobody can see.
 */
async function operable(
  page: Page,
  name: RegExp,
): Promise<{ ok: boolean; detail: string }> {
  const control = page.getByRole("button", { name }).first();
  if ((await page.getByRole("button", { name }).count()) === 0) {
    return { ok: false, detail: "nothing carries that accessible name" };
  }
  if (await control.isDisabled()) return { ok: false, detail: "disabled" };

  /*
    The visible hit area. `getByText` finds the label's own words rather than
    the input's accessible name, so this is measuring the rectangle a thumb
    lands on. If the two ever stop being the same control, the accessible check
    above still holds and this one reports the size honestly.
  */
  const hit = page.getByText(name).first();
  if ((await page.getByText(name).count()) === 0) {
    return { ok: false, detail: "named for a screen reader but nothing visible says it" };
  }
  await hit.scrollIntoViewIfNeeded();
  const box = await hit.boundingBox();
  if (!box) return { ok: false, detail: "no layout box — clipped or hidden" };

  /*
    44px is the smallest reliable touch target and the number the admin mobile
    sweep settled on. Height is allowed a little under it because the button's
    padding is measured on the text node rather than the control; the width is
    not, because a control narrower than a thumb is the failure this is for.
  */
  if (box.width < 44 || box.height < 16) {
    return {
      ok: false,
      detail: `${Math.round(box.width)}x${Math.round(box.height)} — under a touch target`,
    };
  }

  const viewport = page.viewportSize();
  if (viewport && (box.x < -1 || box.x + box.width > viewport.width + 1)) {
    return {
      ok: false,
      detail: `x ${Math.round(box.x)}\u2013${Math.round(box.x + box.width)} outside a ${viewport.width}px screen`,
    };
  }

  return {
    ok: true,
    detail: `hit area ${Math.round(box.width)}x${Math.round(box.height)}`,
  };
}

/* ========================================================================== */
/* 4 · the round trip                                                         */
/* ========================================================================== */

/**
 * One picture, through every link in the chain, on the surface where the shop's
 * placeholder art actually shows: a department tile.
 *
 * The chain is longer than it looks and no single unit test spans it — the
 * action authorises and mints a one-shot signed URL, the *browser* sends the
 * bytes straight to Storage (they never cross a Server Action, which caps a
 * body at 1MB), a second action fetches them back, renders the derivative,
 * stores it and records the row, and the field writes the returned address into
 * the form. Section 2 proves the renderer in isolation; this proves the parts
 * either side of it are wired to each other.
 *
 * It is driven **once**, on one surface, deliberately. The other three are
 * proved reachable in section 3 and run the identical component against the
 * identical actions; uploading through each of them would spend a minute and a
 * bucket object to re-prove the same code path four times.
 */
async function roundTrip(
  context: BrowserContext,
  admin: ReturnType<typeof adminClient>,
): Promise<void> {
  const page = await context.newPage();
  /** Filled once the row is found, so the finally can put the shop back. */
  let plantedSlot: string | null = null;

  /**
   * What every department's picture was before this ran.
   *
   * The first version of this cleanup set `image_url` to **null**, which is not
   * the same as putting it back: three of the seeded departments carry drawn
   * placeholder art, and two runs of this gate quietly erased two of them on
   * staging. Nulling a column is a restore only when the column was null, and
   * "a gate proof must restore data, not just structure" is a rule this
   * codebase has already had to learn once.
   */
  const { data: before, error: beforeError } = await admin
    .from("categories")
    .select("id, image_url");
  if (beforeError) {
    check("the departments can be read before the run", false, beforeError.message);
    await page.close();
    return;
  }
  const wasSet = new Map(before.map((row) => [row.id, row.image_url]));

  try {
    await page.goto(`${BASE_URL}/admin/categories`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: /^Edit / }).first().click();
    await page.getByRole("dialog").waitFor({ state: "visible" });

    /*
      A real photograph-shaped file rather than a 1x1 pixel: the pipeline
      measures the source and reports whether it was smaller than the frame, and
      a fixture that is always "too small" would leave that branch unexercised
      on the one path that runs it for real.
    */
    const fixture = await sharp(await quadrantFixture(1600, 1200))
      .jpeg({ quality: 80 })
      .toBuffer();

    await page.locator('input[type="file"]').first().setInputFiles({
      name: "gate-department.jpg",
      mimeType: "image/jpeg",
      buffer: fixture,
    });

    /*
      The preview showing a storage address is the observable end of the chain
      — it means the action returned a URL and the field accepted it. Waiting
      for the element rather than for a toast, because a toast is a message
      about the outcome and this is the outcome.
    */
    const preview = page.locator(
      'img[src*="/storage/v1/object/public/site-assets/rendered/"]',
    );
    await preview.first().waitFor({ state: "attached", timeout: 60_000 });
    const shown = await preview.first().getAttribute("src");
    check("the uploaded picture comes back framed and on screen", shown !== null);

    /* Adjust must be offered immediately, not after a reload — that is what the
       action's `originalPath` and source dimensions are handed back for. */
    check(
      "the framing tool is offered as soon as the picture lands",
      (await page.getByRole("button", { name: "Adjust" }).count()) > 0,
      "no Adjust control appeared",
    );

    /*
      The row is found **by the address the page was shown**, not by guessing
      which department the dialog was editing.

      The first version of this read `categories` with `limit(1)` and assumed
      the browser had opened that one. It had not — the list renders in tree
      order and an unordered `limit(1)` is whatever Postgres hands back — so the
      row lookup came back empty and reported the write as broken when it had
      worked. Matching on the URL ties the two halves together by the one value
      that can only exist if the whole chain ran.
    */
    const { data: row, error: rowError } = await admin
      .from("site_images")
      .select("slot, frame, original_path, original_width, original_height")
      .eq("rendered_url", shown ?? "")
      .maybeSingle();
    if (rowError) {
      check("the framing record can be read back", false, rowError.message);
      return;
    }
    plantedSlot = row?.slot ?? null;

    check(
      "the address on screen is recorded against a slot, with its original",
      row !== null &&
        row.frame === "category_tile" &&
        row.slot.startsWith("category.") &&
        row.original_path.startsWith("originals/") &&
        row.original_width === 1600 &&
        row.original_height === 1200,
      row ? JSON.stringify(row) : "no row carries that address",
    );
  } catch (thrown) {
    check(
      "one real upload completes end to end",
      false,
      thrown instanceof Error ? thrown.message : String(thrown),
    );
  } finally {
    await page.close();
    /*
      Put the department back. The gate's job is to prove the path, not to leave
      a fixture photograph on a department tile — this codebase's own rule, from
      the day a gate proof restored the DDL and left the data it had written.
    */
    if (plantedSlot) {
      const categoryId = plantedSlot.slice("category.".length);
      const { error: rowGone } = await admin
        .from("site_images")
        .delete()
        .eq("slot", plantedSlot);
      const { error: fieldRestored } = await admin
        .from("categories")
        .update({ image_url: wasSet.get(categoryId) ?? null })
        .eq("id", categoryId);
      if (rowGone || fieldRestored) {
        check(
          "the department is put back as it was",
          false,
          rowGone?.message ?? fieldRestored?.message ?? "",
        );
      }
    }
  }
}

/* ========================================================================== */

async function main() {
  /*
    Before an account is created or a byte is uploaded. The credential guard at
    module scope covers what this process writes; this covers what the
    *browser* writes, which is a different database whenever AUDIT_BASE_URL says
    so. See clients.ts.
  */
  await assertServerNotProduction(BASE_URL, "run site-images");

  arithmetic();
  await pipeline();

  const admin = adminClient();
  const account = await createAccount("siteimg");
  {
    const { error } = await admin
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", account.userId);
    if (error) throw new Error(`could not promote the probe: ${error.message}`);
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({
    // 390x844 — the phone the owner runs the shop from, and the width at which
    // the admin drawer was found unreachable in August.
    viewport: { width: 390, height: 844 },
  });
  await context.addCookies(await sessionCookies(account.session));

  try {
    section("3 · the controls are on screen and operable, at 390px");

    for (const surface of SURFACES) {
      const page = await context.newPage();
      try {
        await page.goto(`${BASE_URL}${surface.path}`, {
          waitUntil: "domcontentloaded",
        });
        await surface.open(page);
        const result = await operable(page, surface.control);
        check(
          `${surface.id} (${surface.path}): a picture can be chosen`,
          result.ok,
          result.detail,
        );
      } catch (error) {
        check(
          `${surface.id} (${surface.path}): a picture can be chosen`,
          false,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        await page.close();
      }
    }

    section("4 · one real upload, end to end");

    await roundTrip(context, admin);

    section("5 · the pages editor is reachable and writes");

    const page = await context.newPage();
    try {
      await page.goto(`${BASE_URL}/admin/pages`, {
        waitUntil: "domcontentloaded",
      });

      const rows = await page.getByRole("button", { name: /\/page\// }).count();
      check(
        "every page the shop serves is listed for editing",
        rows > 0,
        `${rows} rows`,
      );

      await page.getByRole("button", { name: /\/page\// }).first().click();
      const body = page.getByLabel("The words");
      check(
        "the words of a page can be edited",
        await body.isVisible(),
        "the body field did not appear",
      );

      /*
        The preview is the storefront's own renderer. Asserting it draws is the
        difference between "there is a preview button" and "the owner can see
        what they are about to publish".
      */
      await page.getByRole("button", { name: "Preview" }).click();
      const previewText = await page
        .getByRole("button", { name: "Back to editing" })
        .count();
      check(
        "the preview shows the page as customers will read it",
        previewText === 1,
        "the preview did not open",
      );
    } catch (error) {
      check(
        "the pages editor is reachable",
        false,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
  }

  section("summary");
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\n\x1b[31mFailures\x1b[0m");
    for (const failure of failures) console.log(`  · ${failure}`);
  }
  console.log(
    "\n\x1b[90mNot covered: whether a chosen picture looks good — that is the\n" +
      "owner's decision, and the reason the framing stage exists.\x1b[0m",
  );
  process.exit(failed > 0 ? 1 : 0);
}

void main();
