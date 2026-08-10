/**
 * `npm run audit:hero-media` — the hero's picture, at four widths, measured.
 *
 *   npm run build:stage && npm run start:stage    # a production build on :3210
 *   npm run audit:hero-media
 *
 * ## Why this exists
 *
 * Two defects shipped to the live homepage and **every gate stayed green**,
 * because nothing in the suite looked at the hero's picture. They were found by
 * the owner opening the site and looking at it, which is the same way the pause
 * button's position was found. That is twice now, so this is the gate.
 *
 *   1. A hard vertical brightness edge at 55% of the width, at every viewport
 *      from `md` up. The scrim's class list carries `to-40%` unconditionally
 *      and adds `md:via-55%` without ever overriding the `to` position, so the
 *      computed gradient reads `ink 0%, ink/70 55%, transparent 40%` — a stop
 *      that goes *backwards*. CSS clamps it up to the preceding stop, which
 *      collapses the fade to zero width and draws a line.
 *
 *   2. A 1280x720 source stretched across a 2560px band: 2.00x upscale, with
 *      only 39% of the frame still on screen after `object-cover`.
 *
 * ## What each assertion can actually catch
 *
 * Stated per check, because "we have a gate for the hero now" is the kind of
 * sentence that stops people looking.
 *
 *   - **Gradient stop order** would have caught defect 1 exactly. It reads the
 *     *computed* `background-image`, so it sees what the browser resolved
 *     rather than what the class list intended, and it is a general rule: a
 *     colour stop may never sit behind the one before it.
 *   - **Upscale factor** would have caught defect 2 exactly, and reports the
 *     number rather than only a verdict.
 *   - **Poster and video share one box** would **not** have caught either.
 *     Both were already pixel-identical at all four widths. It is here because
 *     it is the assertion everyone assumes exists — a video that drifts out of
 *     its poster's rectangle would show a seam — and an assumed check that does
 *     not exist is worse than a check that has never fired.
 *   - **Poster renders** and **video stays deferred** are the two properties
 *     the whole LCP design rests on, and neither was asserted anywhere.
 *
 * ## The screenshots are the point as much as the assertions
 *
 * Both defects were visible instantly and invisible to every predicate anyone
 * had thought to write. So this writes `screenshots/hero-<width>.png` on every
 * run whether it passes or fails, because the next defect will be one nobody
 * has a predicate for either.
 */
import "./clients";
import { assertNotProduction } from "./clients";

assertNotProduction("run the hero media audit");

import { mkdirSync } from "node:fs";

import { chromium, type Browser } from "playwright";

import { BASE_URL } from "./routes";

/** Wide enough to cover a phone, a tablet, a laptop and a desktop monitor. */
const WIDTHS = [390, 768, 1440, 2560] as const;

/**
 * How far a source may be stretched before it is visibly soft.
 *
 * 1.25 rather than 1.0 because a small upscale is invisible on a photographic
 * source and demanding native resolution at every viewport would mean shipping
 * a 4K file to a phone. 2.00x — what the live site does at 2560px — is not a
 * borderline case; it is the case this number exists to name.
 */
const MAX_UPSCALE = 1.25;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
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

type Geometry = {
  error?: string;
  heroBox: Box | null;
  videoBox: Box | null;
  videoIntrinsic: { w: number; h: number } | null;
  videoOpacity: string | null;
  posterBox: Box | null;
  posterNaturalWidth: number | null;
  posterSrc: string | null;
  gradients: string[];
};
type Box = { x: number; y: number; w: number; h: number };

/**
 * Read every computed gradient inside the hero.
 *
 * Computed rather than declared: Tailwind's `to-40%` and `md:via-55%` are two
 * separate utilities that only contradict each other once the cascade has run,
 * and reading the class attribute would have found nothing wrong with either.
 */
const GEOMETRY = `(function () {
  var hero = document.querySelector('section[aria-labelledby="hero-heading"]');
  if (!hero) return { error: "no hero section on the page" };

  function box(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }

  var video = hero.querySelector("video");
  var img = hero.querySelector("img");

  var gradients = [];
  var all = hero.querySelectorAll("*");
  for (var i = 0; i < all.length; i++) {
    var bg = getComputedStyle(all[i]).backgroundImage;
    if (bg && bg.indexOf("gradient") !== -1) gradients.push(bg);
  }

  return {
    heroBox: box(hero),
    videoBox: box(video),
    videoIntrinsic: video ? { w: video.videoWidth, h: video.videoHeight } : null,
    videoOpacity: video ? getComputedStyle(video).opacity : null,
    posterBox: box(img),
    posterNaturalWidth: img ? img.naturalWidth : null,
    posterSrc: img ? (img.currentSrc || img.src) : null,
    gradients: gradients,
  };
})()`;

/**
 * Colour stops, in the order they appear, as percentages.
 *
 * Only stops carrying an explicit percentage are returned — an implicit stop is
 * positioned by the browser and cannot be out of order by construction.
 */
function stopPositions(gradient: string): number[] {
  const out: number[] = [];
  // Match "<something> NN%" — the percentage that follows a colour.
  for (const match of gradient.matchAll(/([\d.]+)%/g)) {
    const value = Number(match[1]);
    if (!Number.isNaN(value)) out.push(value);
  }
  return out;
}

/** A stop that sits behind the one before it. Returns the offending pair. */
function backwardsStop(stops: number[]): [number, number] | null {
  for (let i = 1; i < stops.length; i += 1) {
    if (stops[i] < stops[i - 1]) return [stops[i - 1], stops[i]];
  }
  return null;
}

async function atWidth(browser: Browser, width: number, videoConfigured: boolean) {
  const context = await browser.newContext({
    viewport: { width, height: width < 500 ? 844 : 900 },
    deviceScaleFactor: 1,
    isMobile: width < 500,
    hasTouch: width < 500,
  });
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: "load", timeout: 120_000 });
  // Long enough for the deferred video to have mounted and started.
  await page.waitForTimeout(7_000);

  const geometry = (await page.evaluate(GEOMETRY)) as Geometry;

  section(`${width}px`);
  if (geometry.error) {
    check(`the hero is on the page at ${width}px`, false, geometry.error);
    await context.close();
    return;
  }

  /* --- the poster ------------------------------------------------------- */
  check(
    `${width}: the poster is in the DOM and decoded`,
    geometry.posterBox !== null &&
      geometry.posterBox.w > 0 &&
      (geometry.posterNaturalWidth ?? 0) > 0,
    geometry.posterBox
      ? `naturalWidth ${geometry.posterNaturalWidth}`
      : "no <img> inside the hero",
  );

  /* --- gradients: no stop may go backwards ------------------------------ */
  let worst: { gradient: string; pair: [number, number] } | null = null;
  for (const gradient of geometry.gradients) {
    const pair = backwardsStop(stopPositions(gradient));
    if (pair) worst = { gradient, pair };
  }
  check(
    `${width}: no gradient has a colour stop behind the one before it`,
    worst === null,
    worst
      ? `a stop at ${worst.pair[1]}% follows one at ${worst.pair[0]}%, so the ` +
        `browser clamps it and draws a hard edge instead of a fade — ` +
        worst.gradient.replace(/\s+/g, " ").slice(0, 120)
      : "",
  );

  /* --- the video -------------------------------------------------------- */
  if (!videoConfigured) {
    console.log(
      `  \x1b[2m·\x1b[0m no video_url on this hero — video checks skipped, not passed`,
    );
    await page.screenshot({ path: `screenshots/hero-${width}.png` });
    await context.close();
    return;
  }

  check(
    `${width}: the video mounted`,
    geometry.videoBox !== null,
    "no <video> after load and idle",
  );

  if (geometry.videoBox && geometry.posterBox) {
    const v = geometry.videoBox;
    const p = geometry.posterBox;
    check(
      `${width}: the poster and the video occupy the same box`,
      v.x === p.x && v.y === p.y && v.w === p.w && v.h === p.h,
      `video ${v.w}x${v.h}@(${v.x},${v.y}) vs poster ${p.w}x${p.h}@(${p.x},${p.y})`,
    );
  }

  if (geometry.videoBox && geometry.videoIntrinsic?.w) {
    const v = geometry.videoBox;
    const source = geometry.videoIntrinsic;
    // object-cover scales by whichever axis needs the most.
    const scale = Math.max(v.w / source.w, v.h / source.h);
    const shownW = Math.min(source.w, v.w / scale);
    const shownH = Math.min(source.h, v.h / scale);
    const framePercent = Math.round(((shownW * shownH) / (source.w * source.h)) * 100);
    check(
      `${width}: the source is not upscaled past ${MAX_UPSCALE}x`,
      scale <= MAX_UPSCALE,
      `${source.w}x${source.h} at ${scale.toFixed(2)}x, showing ${framePercent}% of the frame`,
    );
    console.log(
      `      \x1b[2m${source.w}x${source.h} → ${v.w}x${v.h}  ${scale.toFixed(2)}x  ${framePercent}% of frame visible\x1b[0m`,
    );
  }

  await page.screenshot({ path: `screenshots/hero-${width}.png` });
  await context.close();
}

async function main() {
  mkdirSync("screenshots", { recursive: true });

  /* Is a video configured at all? Read the served HTML, which is also the
     assertion that no <video> is server-rendered. */
  const html = await (await fetch(BASE_URL, { cache: "no-store" })).text();
  const videoConfigured = html.includes("site-video");

  section("the served HTML");
  check(
    "no <video> element is server-rendered — the poster is the only media at first paint",
    !/<video[\s>]/i.test(html),
    "a <video> in the initial HTML makes it an LCP candidate",
  );
  console.log(
    `  \x1b[2m·\x1b[0m hero video ${videoConfigured ? "is" : "is NOT"} configured on this database`,
  );

  const browser = await chromium.launch();
  try {
    for (const width of WIDTHS) {
      await atWidth(browser, width, videoConfigured);
    }

    /* --- reduced motion: the poster is the whole experience -------------- */
    if (videoConfigured) {
      section("prefers-reduced-motion: reduce");
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const videoRequests: string[] = [];
      page.on("request", (request) => {
        if (/\.mp4|\.webm/i.test(request.url())) videoRequests.push(request.url());
      });
      await page.goto(BASE_URL, { waitUntil: "load", timeout: 120_000 });
      await page.waitForTimeout(7_000);
      const hasVideo = await page.evaluate(
        `document.querySelector("video") !== null`,
      );
      check("no <video> element is created", hasVideo === false);
      check(
        "not one byte of video is requested",
        videoRequests.length === 0,
        `${videoRequests.length} request(s)`,
      );
      await page.screenshot({ path: "screenshots/hero-reduced-motion.png" });
      await context.close();
    }
  } finally {
    await browser.close();
  }

  console.log(
    `\n  screenshots written to screenshots/hero-{${WIDTHS.join(",")}}.png\n`,
  );
  console.log(
    failed === 0
      ? `\x1b[1m\x1b[32mhero-media: ${passed} checks, all green.\x1b[0m\n`
      : `\x1b[1m\x1b[31mhero-media: ${failed} of ${passed + failed} checks failed.\x1b[0m\n` +
          failures.map((f) => `  · ${f}`).join("\n") +
          "\n",
  );
  process.exit(failed > 0 ? 1 : 0);
}

void main();
