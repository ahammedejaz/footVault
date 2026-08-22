/**
 * Every shape a picture on this site can be, as data.
 *
 * ## Why a table rather than a parameter at each call site
 *
 * A category tile is 4:3 because `home-sections.tsx` draws it in an
 * `aspect-4/3` box. If the admin panel also *said* 4:3, in its own literal,
 * those two numbers would agree today and disagree the first time somebody
 * redesigns the grid — and the failure is silent: the owner frames a picture in
 * a 4:3 preview, the page draws it in a 3:2 box, and the shoe they carefully
 * centred is cut off at the ankle. There is no error, no gate, nothing to see
 * except a slightly wrong homepage.
 *
 * So the shape is named once, here, and both sides read the name. The storefront
 * gets `FRAME_CLASS` for its container and the panel gets `aspect` for its
 * preview, out of the same entry. Changing a shape is one edit in one file.
 *
 * ## `cover` and `contain` are different tools, not a setting
 *
 * A photograph fills its box and is cropped to do it — that is `cover`, and it
 * needs the framing stage because *which* part survives is a decision.
 *
 * A logo must not be cropped at all. There is no interesting choice to offer
 * about which corner of a wordmark to discard, and offering one only lets the
 * owner cut the shop's name in half. `contain` fits the whole artwork inside
 * the box on transparency, shows no stage, and keeps alpha.
 *
 * That is why `mode` sits on the frame rather than on the image: it is a fact
 * about the place, and it decides which controls the owner is even shown. A
 * panel that offers a crop tool for a favicon is a panel that has to explain
 * why the crop tool does nothing useful.
 */

export type FrameMode = "cover" | "contain";

export type FrameSpec = {
  /** What the owner calls this place. */
  label: string;
  /** The sentence under the field, saying what it is for. */
  hint: string;
  mode: FrameMode;
  /** Output width in pixels. */
  width: number;
  /** Output height in pixels. Together with width this is the aspect. */
  height: number;
  /**
   * WebP everywhere except the favicon.
   *
   * WebP is smaller at the same quality and carries alpha, so it is right for
   * photographs and for a logo alike. The favicon is the exception and not for
   * a quality reason: it is fetched by browsers, feed readers and link
   * unfurlers that predate WebP and will simply show nothing, and a missing
   * favicon looks like a broken site rather than a slow one.
   */
  format: "webp" | "png";
};

export const IMAGE_FRAMES = {
  hero_desktop: {
    label: "Hero picture — wide screens",
    hint: "What fills the top of the homepage on a laptop or a desktop.",
    mode: "cover",
    /*
      1600, and it is a measured ceiling rather than a round number. The hero
      band is capped at `max-w-[1600px]` in `home-sections.tsx` for the reason
      written there: `object-cover` on a band wider than 16:9 scales by width,
      so beyond this the source is being stretched and the only cures are a
      wider render or a bigger file. Rendering wider here would ship every phone
      on the site a larger download to fix a wide-monitor problem.
    */
    width: 1600,
    height: 900,
    format: "webp",
  },
  hero_mobile: {
    label: "Hero picture — phones",
    hint: "The same spot on a phone, where the picture is a band above the words.",
    mode: "cover",
    /*
      5:4, because that is the box: the hero renders `aspect-5/4` below `sm`.
      A separate upload rather than a crop of the desktop one — the whole point
      of art direction is that the phone gets a differently *composed* picture,
      not the middle of a wide one.
    */
    width: 1000,
    height: 800,
    format: "webp",
  },
  hero_poster: {
    label: "Video still",
    hint: "The frame shown before the clip plays, and instead of it for anyone who has asked their phone for less motion.",
    mode: "cover",
    width: 1600,
    height: 900,
    format: "webp",
  },
  category_tile: {
    label: "Department picture",
    hint: "The photograph behind this department's tile on the homepage.",
    mode: "cover",
    /* `aspect-4/3`, from the grid in home-sections.tsx. */
    width: 1200,
    height: 900,
    format: "webp",
  },
  banner_background: {
    label: "Banner picture",
    hint: "An optional photograph behind the banner. Leave it empty for the plain tread pattern.",
    mode: "cover",
    width: 1600,
    height: 700,
    format: "webp",
  },
  logo: {
    label: "Logo",
    hint: "Shown in the header and the footer. A PNG with a transparent background works best.",
    mode: "contain",
    /*
      Three times the largest place it is drawn (the footer lockup renders at
      176px wide), so it stays sharp on a 3x phone screen and no larger.
    */
    width: 540,
    height: 180,
    format: "webp",
  },
  favicon: {
    label: "Favicon",
    hint: "The small square icon on the browser tab. Square artwork, ideally with nothing important near the edges.",
    mode: "contain",
    width: 512,
    height: 512,
    format: "png",
  },
  share_image: {
    label: "Share picture",
    hint: "What shows when someone pastes a link to the shop into WhatsApp, Instagram or a message.",
    mode: "cover",
    /* 1200×630 is what every unfurler crops to. Anything else gets cut. */
    width: 1200,
    height: 630,
    format: "webp",
  },
  brand_logo: {
    label: "Brand logo",
    hint: "The maker's own mark, shown on their products and on the brand list.",
    mode: "contain",
    width: 480,
    height: 240,
    format: "webp",
  },
} as const satisfies Record<string, FrameSpec>;

export type FrameKey = keyof typeof IMAGE_FRAMES;

export function isFrameKey(value: string): value is FrameKey {
  return Object.hasOwn(IMAGE_FRAMES, value);
}

/** The frame's shape as width ÷ height, which is what `frameRect` wants. */
export function aspectOf(frame: FrameKey): number {
  const spec = IMAGE_FRAMES[frame];
  return spec.width / spec.height;
}

/**
 * What a source photograph may be before it is framed.
 *
 * These match the `site-assets` bucket's own `file_size_limit` and
 * `allowed_mime_types`, set in `…_storage.sql`. Storage re-checks both on
 * arrival — this is the number the panel can show the owner *before* they spend
 * two minutes uploading something that was never going to be accepted.
 *
 * SVG is absent and that is not an oversight. `next.config.ts` runs with
 * `dangerouslyAllowSVG` on for the drawn seed art, and this pipeline decodes
 * whatever it is given with sharp — an uploaded SVG would be rasterised, which
 * is fine, but the *original* stays in a public bucket where it can be linked
 * directly and rendered unsandboxed. There is nothing an owner needs an SVG
 * hero for that a PNG does not do.
 */
export const ALLOWED_SOURCE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
] as const;

/** Bytes. The `site-assets` bucket's own limit. */
export const MAX_SOURCE_BYTES = 5 * 1024 * 1024;

/** The bucket originals and derivatives both live in. */
export const SITE_ASSET_BUCKET = "site-assets";
