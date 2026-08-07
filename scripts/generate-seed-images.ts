/**
 * Generates the seed catalog's product imagery as flat-vector SVG.
 *
 * Foot Vault has no photography yet, and inventing photographs is not an
 * option — so the seed ships drawn assets instead: a side profile and an
 * outsole for every product, in that product's own colour. That exercises the
 * whole image pipeline for real (two images per product, primary flagged, the
 * card's hover swapping hero for sole) and makes the grid legible, without any
 * of it pretending to be a photograph.
 *
 * When the owner uploads real photographs from /admin/products the rows are
 * replaced and nothing else changes: the storefront only reads
 * product_images.url.
 *
 * Run: npm run seed:images
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { categories, products, type SeedProduct } from "./seed-data";
import { colorSlug } from "./color-slug";

const OUT_DIR = join(process.cwd(), "public", "seed");

/** Portrait 4:5 — the aspect the product card reserves. */
const W = 800;
const H = 1000;

/** Brand tokens. An SVG cannot read a CSS custom property, so they live here. */
const INK = "#0a1526";
const FOG = "#e9edf3";
const PAPER = "#fdfdfe";

type Shape = SeedProduct["footwearType"];

/**
 * Side profiles, toe to the left, drawn against a ground line at y = 300 in a
 * 760-wide band. Boot shafts run up into negative y; the wrapper's transform
 * accounts for it.
 *
 * `upper` is filled. `straps` is stroked at `strapWidth` — an open sandal has
 * no closed upper to fill, and stroking is what makes it read as straps rather
 * than as a solid shoe with holes.
 */
type Profile = {
  upper?: string;
  sole: string;
  straps?: string;
  strapWidth?: number;
  detail?: string;
  /** Fraction of the sole's height painted as the darker outsole. */
  outsoleFrom: number;
};

const PROFILES: Record<Shape, Profile> = {
  sneaker: {
    upper:
      "M14 236 C12 198 44 168 102 152 C178 130 256 118 320 104 C372 92 404 70 442 52 C468 40 494 44 508 62 C526 86 552 98 584 96 C620 94 650 76 672 52 C692 30 720 34 734 64 C748 94 754 168 752 236 Z",
    sole:
      "M10 236 L754 234 C762 274 742 300 700 302 L66 302 C22 300 2 274 10 236 Z",
    // Lace bars across the throat, and the toe-cap seam. Two lines are all a
    // side profile needs to read as a sneaker rather than a slipper.
    detail:
      "M366 96 L400 66 M398 106 L432 76 M430 116 L464 86 M462 122 L494 96 M118 152 C150 192 160 214 158 236",
    outsoleFrom: 0.62,
  },
  sports: {
    upper:
      "M18 226 C16 188 48 158 106 142 C182 120 260 108 324 94 C376 82 408 60 446 42 C472 30 500 34 514 52 C532 76 558 88 590 86 C626 84 656 66 678 42 C698 20 726 24 740 54 C754 84 760 158 754 226 Z",
    // Thicker, rockered midsole: the toe and heel both lift off the ground.
    sole:
      "M6 220 L758 216 C772 268 746 302 692 306 L70 306 C16 302 -6 266 6 220 Z",
    detail:
      "M370 86 L404 56 M402 96 L436 66 M434 106 L468 76 M12 270 C120 286 640 284 754 266",
    outsoleFrom: 0.7,
  },
  formal: {
    upper:
      "M32 250 C28 214 66 190 130 178 C214 160 296 146 358 130 C400 119 428 98 464 84 C500 70 542 62 588 62 C650 62 692 84 708 128 C722 166 726 212 722 250 Z",
    // A leather sole is a fraction of a sneaker's, and it steps up at the heel.
    sole:
      "M26 250 L724 246 L722 278 C716 285 704 288 688 288 L64 288 C34 286 18 268 26 250 Z M572 276 L688 272 C698 292 694 308 680 313 C674 315 666 316 656 316 L598 316 C586 316 578 306 578 294 Z",
    // Brogue seam over the vamp, and the facing where the lacing sits.
    detail: "M358 130 C408 142 478 148 566 146 M462 86 L494 136 M544 78 L512 136",
    outsoleFrom: 0.55,
  },
  boot: {
    upper:
      "M22 240 C20 202 52 172 112 156 C190 134 262 122 322 108 C366 98 396 78 428 62 L428 -168 C428 -186 448 -196 484 -196 L666 -196 C704 -196 724 -186 724 -168 L724 214 C724 230 722 236 720 240 Z",
    sole:
      "M14 242 L730 240 C744 284 720 308 674 310 L70 310 C22 308 2 284 14 242 Z",
    // Speed hooks up the shaft, plus the toe seam.
    detail:
      "M452 -152 L698 -152 M452 -104 L698 -104 M452 -56 L698 -56 M452 -8 L698 -8 M452 40 L698 40 M120 156 C152 194 162 216 160 240",
    outsoleFrom: 0.6,
  },
  sandal: {
    // Footbed only; the three adjustable straps are stroked over it.
    sole:
      "M34 242 L722 238 C734 280 710 306 660 308 L96 308 C44 304 22 280 34 242 Z",
    straps:
      "M136 246 C144 224 176 214 216 213 L296 213 C336 214 366 224 374 246 M400 246 C408 222 442 210 484 209 L564 209 C604 210 632 222 640 244 M672 244 C700 232 712 212 708 190 C705 174 694 164 678 160",
    strapWidth: 24,
    detail: "M40 274 L716 270",
    outsoleFrom: 0.58,
  },
  slide: {
    sole:
      "M42 238 L716 234 C730 278 704 306 652 308 L106 308 C52 304 30 280 42 238 Z",
    // One wide band across the forefoot is the whole design.
    straps: "M156 236 C160 190 200 166 268 160 L520 160 C594 166 646 192 660 232",
    strapWidth: 44,
    detail: "M48 272 L710 268",
    outsoleFrom: 0.58,
  },
  flipflop: {
    sole:
      "M52 238 L706 234 C720 278 694 306 642 308 L116 308 C62 304 40 280 52 238 Z",
    // The Y: post up from the footbed, then two straps out to the sides.
    straps:
      "M392 238 L392 168 M392 168 C352 146 306 142 272 154 M392 168 C436 146 486 142 520 156",
    strapWidth: 18,
    detail: "M58 272 L700 268",
    outsoleFrom: 0.58,
  },
};

/**
 * The outsole, seen from below: wide forefoot, narrow waist, rounded heel.
 * Drawn once in a 300x780 box — an outsole is an outsole — and given the
 * product's colour and the tread from the Foot Vault mark.
 */
const OUTSOLE =
  "M150 4 C232 4 296 58 296 138 C296 200 282 250 268 292 C252 340 238 372 232 410 C226 452 224 486 230 524 C240 580 244 626 240 668 C234 736 200 776 150 776 C100 776 66 736 60 668 C56 626 60 580 70 524 C76 486 74 452 68 410 C62 372 48 340 32 292 C18 250 4 200 4 138 C4 58 68 4 150 4 Z";

function mix(hex: string, amount: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const channel = (c: number) =>
    Math.max(0, Math.min(255, Math.round(amount < 0 ? c + (255 - c) * -amount : c * (1 - amount))));
  return (
    "#" +
    [channel((n >> 16) & 255), channel((n >> 8) & 255), channel(n & 255)]
      .map((c) => c.toString(16).padStart(2, "0"))
      .join("")
  );
}

/** Relative luminance, so a near-black colourway lightens instead of darkens. */
function isDark(hex: string): boolean {
  const n = parseInt(hex.replace("#", ""), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.42;
}

/** Midsole / outsole / seam tones derived from one colourway. */
function palette(hex: string) {
  const dark = isDark(hex);
  return {
    upper: hex,
    midsole: mix(hex, dark ? -0.3 : 0.22),
    outsole: mix(hex, dark ? -0.14 : 0.42),
    seam: dark ? "rgba(255,255,255,0.34)" : "rgba(10,21,38,0.20)",
    tread: dark ? "rgba(255,255,255,0.20)" : "rgba(10,21,38,0.17)",
    dark,
  };
}

/* -------------------------------------------------------------------------- */
/* one frame, one scale                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The content box every product asset is fitted into, inside the 800x1000
 * canvas. 48px of horizontal padding and 120px of vertical, so a boot shaft and
 * a flip-flop both sit inside the same rectangle and no card can be the one
 * whose shoe touches the edge.
 *
 * The padding lives here rather than in the card's CSS on purpose. It is a
 * percentage of the frame, so it is the same 6% on a 156px card in a phone grid
 * and on a 296px card in a desktop rail; 8px of CSS padding would be 5% of one
 * and 10% of the other, which is the inconsistency this box exists to remove.
 */
const CONTENT = { x: 48, y: 120, w: W - 96, h: H - 240 };

/**
 * The bounding box of one or more path strings.
 *
 * Every path in this file is absolute `M`/`L`/`C` with plain `x y` pairs and a
 * bare `Z`, so the numbers pair up in order and min/max over them is the box.
 * Control points are included, which over-estimates a curve's true extent by a
 * few pixels — the error is in the safe direction: the art is fitted slightly
 * smaller than it needs to be rather than slightly clipped.
 */
function pathBounds(paths: string[], pad = 0) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of paths) {
    const numbers = d.match(/-?\d*\.?\d+/g) ?? [];
    for (let i = 0; i + 1 < numbers.length; i += 2) {
      const x = Number(numbers[i]);
      const y = Number(numbers[i + 1]);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return {
    x: minX - pad,
    y: minY - pad,
    w: maxX - minX + pad * 2,
    h: maxY - minY + pad * 2,
  };
}

/**
 * Fit a drawing's box into CONTENT, constrained by whichever dimension binds
 * first, and centre what is left over.
 *
 * This is the whole answer to "the boot fills its frame and the Gazelle does
 * not". Before, every profile was drawn at a fixed 1.02 with a shared ground
 * line, so a boot — which carries 500 units of shaft above the same sole —
 * occupied twice the canvas of a sneaker and the two cards beside each other
 * read as two different card sizes. Fitting by `min(sx, sy)` makes every
 * product exactly as wide as the content box and never taller than it, so the
 * visual weight is a property of the frame rather than of the subject.
 */
function fitTransform(box: { x: number; y: number; w: number; h: number }) {
  const scale = Math.min(CONTENT.w / box.w, CONTENT.h / box.h);
  return {
    scale,
    tx: CONTENT.x + (CONTENT.w - box.w * scale) / 2 - box.x * scale,
    ty: CONTENT.y + (CONTENT.h - box.h * scale) / 2 - box.y * scale,
  };
}

/**
 * The frame every asset shares: a soft vignette rather than a pattern, so the
 * shoe is the only thing with contrast.
 *
 * It used to carry three mono captions on hairline rules — brand top left, view
 * top right, colourway bottom left. They were the wrong layer. Baked into the
 * image they scaled with it, so on a 156px card the brand rendered at under 4px
 * and on an 80px bag thumbnail it was grey noise; and because they were pixels
 * rather than text, the card's wishlist heart could sit on top of "ADIDAS" and
 * turn it into "IDAS" with nothing in the DOM to say so. They are now real DOM
 * in the card's label row, where they stay 12px at every card size and where
 * the heart is a sibling that cannot overlap them.
 */
function frame(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">
  <defs>
    <radialGradient id="bg" cx="0.5" cy="0.42" r="0.78">
      <stop offset="0" stop-color="${PAPER}"/>
      <stop offset="1" stop-color="${FOG}"/>
    </radialGradient>
    <radialGradient id="contact" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${INK}" stop-opacity="0.20"/>
      <stop offset="1" stop-color="${INK}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
${body}
</svg>
`;
}

function heroProfileSvg(product: SeedProduct, color: { name: string; hex: string }): string {
  const p = PROFILES[product.footwearType];
  const c = palette(color.hex);
  const id = product.slug.replace(/[^a-z0-9]/gi, "");

  // Half the widest stroke this drawing paints, so a strap centred on the edge
  // of its own path still lands inside the content box.
  const pad = Math.max(2, (p.strapWidth ?? 0) / 2);
  const drawn = [p.sole, p.upper, p.straps, p.detail].filter(
    (d): d is string => typeof d === "string",
  );
  const { scale, tx, ty } = fitTransform(pathBounds(drawn, pad));

  // The contact shadow follows the sole rather than a constant: once the art is
  // fitted, "the ground" is wherever this product's sole ends up.
  const sole = pathBounds([p.sole]);
  const groundY = ty + (sole.y + sole.h) * scale;
  const shadowRx = (sole.w * scale) / 2.3;

  const strapStroke = p.straps
    ? `<path d="${p.straps}" fill="none" stroke="${c.upper}" stroke-width="${p.strapWidth}" stroke-linecap="round" stroke-linejoin="round"/>`
    : "";
  const upperFill = p.upper
    ? `<path d="${p.upper}" fill="${c.upper}" stroke="${c.seam}" stroke-width="2" stroke-linejoin="round"/>`
    : "";
  const detail = p.detail
    ? `<path d="${p.detail}" fill="none" stroke="${c.seam}" stroke-width="4" stroke-linecap="round"/>`
    : "";

  const body = `  <ellipse cx="${W / 2}" cy="${(groundY + 22).toFixed(0)}" rx="${shadowRx.toFixed(0)}" ry="34" fill="url(#contact)"/>
  <g transform="translate(${tx.toFixed(1)} ${ty.toFixed(1)}) scale(${scale.toFixed(4)})">
    <defs><clipPath id="sole-${id}"><path d="${p.sole}"/></clipPath></defs>
    <path d="${p.sole}" fill="${c.midsole}"/>
    <rect x="-40" y="272" width="840" height="80" fill="${c.outsole}" clip-path="url(#sole-${id})"/>
    <path d="${p.sole}" fill="none" stroke="${c.seam}" stroke-width="2"/>
    ${strapStroke}
    ${upperFill}
    ${detail}
  </g>`;

  return frame(body);
}

function soleSvg(product: SeedProduct, color: { name: string; hex: string }): string {
  const c = palette(color.hex);
  const id = product.slug.replace(/[^a-z0-9]/gi, "");

  // Siping across the last: wide bars under the forefoot, narrower through the
  // waist where the sole itself narrows, so the tread follows the shape.
  const sipes = Array.from({ length: 16 }, (_, i) => {
    const y = 40 + i * 45;
    // Half-width of the sole at this height, approximated from the outline.
    const t = y / 780;
    const halfWidth =
      t < 0.36 ? 140 : t < 0.62 ? 140 - (t - 0.36) * 300 : 82 + (t - 0.62) * 190;
    const w = Math.max(40, halfWidth * 2 - 34);
    return `<rect x="${(150 - w / 2).toFixed(0)}" y="${y}" width="${w.toFixed(0)}" height="17" rx="8.5" fill="${c.tread}"/>`;
  }).join("\n      ");

  // Fitted by the same rule as the profile, so the crossfade between the two is
  // two views of one object rather than two differently-sized pictures.
  const { scale, tx, ty } = fitTransform(pathBounds([OUTSOLE], 2));

  const body = `  <ellipse cx="${W / 2}" cy="${H / 2}" rx="${((300 * scale) / 1.4).toFixed(0)}" ry="${((780 * scale) / 2.3).toFixed(0)}" fill="url(#contact)"/>
  <g transform="translate(${tx.toFixed(1)} ${ty.toFixed(1)}) scale(${scale.toFixed(4)})">
    <defs><clipPath id="outsole-${id}"><path d="${OUTSOLE}"/></clipPath></defs>
    <path d="${OUTSOLE}" fill="${c.outsole}"/>
    <g clip-path="url(#outsole-${id})">
      ${sipes}
      <circle cx="150" cy="196" r="62" fill="none" stroke="${c.tread}" stroke-width="22"/>
      <circle cx="150" cy="640" r="46" fill="none" stroke="${c.tread}" stroke-width="20"/>
    </g>
    <path d="${OUTSOLE}" fill="none" stroke="${c.seam}" stroke-width="3"/>
  </g>`;

  return frame(body);
}

/* -------------------------------------------------------------------------- */
/* the homepage hero, and the category tiles                                  */
/* -------------------------------------------------------------------------- */

const ORANGE = "#fe9301";

/** The mark's siping, as a tile. Same motif as the .tread-texture utility. */
function treadTile(opacity: number): string {
  return `<pattern id="tread" width="64" height="64" patternUnits="userSpaceOnUse">
      <g fill="#ffffff" opacity="${opacity}">
        <rect x="4" y="8" width="56" height="8" rx="4"/>
        <rect x="14" y="26" width="36" height="8" rx="4"/>
        <rect x="4" y="44" width="56" height="8" rx="4"/>
      </g>
    </pattern>`;
}

/**
 * The hero, in two crops of one scene.
 *
 * Landscape puts the shoe on the right, where the copy is not; portrait puts it
 * low and centred, under the copy. Cropping one image to serve both would
 * either bury the shoe behind the headline on a phone or strand it in a corner
 * on a desktop.
 */
function heroSvg(kind: "desktop" | "mobile"): string {
  const W = kind === "desktop" ? 1920 : 900;
  const H = kind === "desktop" ? 1000 : 720;
  const profile = PROFILES.sports;
  const c = palette("#1d4a86");

  /*
    Two crops, two compositions — which is the whole reason for shipping two
    files rather than one image squeezed twice.

    Desktop is an overlay: the shoe sits in the right third with the copy beside
    it, ground line at 72%, well inside the frame. (The first attempt scaled it
    1.5x from 44% of the width and ran off the right edge, which turned the shoe
    into an abstract blue shape.)

    Mobile is not an overlay at all — the copy sits *below* the image, because at
    390px a headline over a shoe is a headline over a shoe whatever the scrim
    does. So this crop is centred and fills its band, and it is landscape rather
    than portrait because the band above the copy is wider than it is tall.
  */
  const scale = kind === "desktop" ? 0.72 : 0.95;
  const bandWidth = 760 * scale;
  const groundY = kind === "desktop" ? H * 0.72 : H * 0.68;
  const tx = kind === "desktop" ? W - bandWidth - 150 : (W - bandWidth) / 2;
  const ty = groundY - 302 * scale;

  // The mark's own outsole, oversized and part-cropped, as a second shape on
  // the desktop crop only. On the mobile band it had nowhere to be cropped
  // *against* and read as a stray loop floating beside the shoe; the tread
  // texture already carries the motif there.
  const sole =
    kind === "desktop"
      ? `<g transform="translate(${(W * 0.06).toFixed(0)} ${(H * 0.24).toFixed(0)}) scale(0.55) rotate(-14)">
    <path d="${OUTSOLE}" fill="none" stroke="${ORANGE}" stroke-width="9" opacity="0.42"/>
  </g>`
      : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">
  <defs>
    ${treadTile(0.05)}
    <radialGradient id="glow" cx="${kind === "desktop" ? "0.7" : "0.55"}" cy="${kind === "desktop" ? "0.62" : "0.6"}" r="0.66">
      <stop offset="0" stop-color="#16375f"/>
      <stop offset="1" stop-color="#0a1526"/>
    </radialGradient>
    <radialGradient id="contact" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#000000" stop-opacity="0.5"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect width="${W}" height="${H}" fill="url(#tread)"/>
  ${sole}
  <ellipse cx="${(tx + 380 * scale).toFixed(0)}" cy="${(groundY + 16).toFixed(0)}" rx="${(330 * scale).toFixed(0)}" ry="${(30 * scale).toFixed(0)}" fill="url(#contact)"/>
  <g transform="translate(${tx.toFixed(1)} ${ty.toFixed(1)}) scale(${scale})">
    <defs><clipPath id="hero-sole"><path d="${profile.sole}"/></clipPath></defs>
    <path d="${profile.sole}" fill="${c.midsole}"/>
    <rect x="-40" y="272" width="840" height="90" fill="${ORANGE}" clip-path="url(#hero-sole)"/>
    <path d="${profile.sole}" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="2"/>
    <path d="${profile.upper}" fill="${c.upper}" stroke="rgba(255,255,255,0.3)" stroke-width="2" stroke-linejoin="round"/>
    <path d="${profile.detail}" fill="none" stroke="rgba(255,255,255,0.36)" stroke-width="4" stroke-linecap="round"/>
  </g>
</svg>
`;
}

/** A category tile: the department's own shape, on the brand ground. */
function categorySvg(shape: Shape, hex: string): string {
  const W = 1200;
  const H = 900;
  const p = PROFILES[shape];
  const c = palette(hex);
  const scale = 1.16;
  const tx = (W - 760 * scale) / 2;
  const ty = H * 0.72 - 302 * scale;

  const strapStroke = p.straps
    ? `<path d="${p.straps}" fill="none" stroke="${c.upper}" stroke-width="${p.strapWidth}" stroke-linecap="round" stroke-linejoin="round"/>`
    : "";
  const upperFill = p.upper
    ? `<path d="${p.upper}" fill="${c.upper}" stroke="${c.seam}" stroke-width="2" stroke-linejoin="round"/>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">
  <defs>
    ${treadTile(0.06)}
    <linearGradient id="band" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#12294c"/>
      <stop offset="1" stop-color="#0a1526"/>
    </linearGradient>
    <radialGradient id="contact" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#000000" stop-opacity="0.4"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#band)"/>
  <rect width="${W}" height="${H}" fill="url(#tread)"/>
  <ellipse cx="${W / 2}" cy="${H * 0.74}" rx="360" ry="34" fill="url(#contact)"/>
  <g transform="translate(${tx.toFixed(1)} ${ty.toFixed(1)}) scale(${scale})">
    <defs><clipPath id="cat-sole"><path d="${p.sole}"/></clipPath></defs>
    <path d="${p.sole}" fill="${c.midsole}"/>
    <rect x="-40" y="272" width="840" height="80" fill="${c.outsole}" clip-path="url(#cat-sole)"/>
    ${strapStroke}
    ${upperFill}
    ${p.detail ? `<path d="${p.detail}" fill="none" stroke="${c.seam}" stroke-width="4" stroke-linecap="round"/>` : ""}
  </g>
</svg>
`;
}

/** One tile per top-level department, in a shape that department actually sells. */
const CATEGORY_ART: Record<string, { shape: Shape; hex: string }> = {
  men: { shape: "formal", hex: "#3a2a20" },
  women: { shape: "sneaker", hex: "#e8e2d8" },
  kids: { shape: "sneaker", hex: "#2f7fd4" },
};

function main() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  // One hero and one outsole *per colourway*: the swatches on the product page
  // change the gallery, and they can only do that if the gallery has something
  // to change to.
  let count = 0;
  for (const product of products) {
    for (const color of product.colors) {
      const stem = `${product.slug}-${colorSlug(color.name)}`;
      writeFileSync(join(OUT_DIR, `${stem}-hero.svg`), heroProfileSvg(product, color));
      writeFileSync(join(OUT_DIR, `${stem}-sole.svg`), soleSvg(product, color));
      count += 2;
    }
  }

  writeFileSync(join(OUT_DIR, "hero-desktop.svg"), heroSvg("desktop"));
  writeFileSync(join(OUT_DIR, "hero-mobile.svg"), heroSvg("mobile"));
  count += 2;

  for (const category of categories) {
    const art = CATEGORY_ART[category.slug];
    if (!art) continue;
    writeFileSync(join(OUT_DIR, `category-${category.slug}.svg`), categorySvg(art.shape, art.hex));
    count += 1;
  }

  console.log(
    `Wrote ${count} images for ${products.length} products to public/seed/`,
  );
}

main();
