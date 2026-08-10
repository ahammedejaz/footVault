import { CANONICAL_WIDTHS, PIPELINE_VERSION } from "./constants";

/**
 * Serving the widths the pipeline already made, instead of making them again.
 *
 * ## The decision
 *
 * `normaliseProductImage` emits WebP at 400, 800, 1200 and 1600 — exactly the
 * sizes the card and the product page ask for, at a fixed quality, on a flat
 * background. Passing the 1600 to the Next optimiser and letting it derive the
 * rest means **decoding and re-encoding an image that is already correct**: a
 * second lossy pass over pixels that were produced for this purpose, billed per
 * transformation, with a cold first request in front of the page this phase is
 * trying to keep fast.
 *
 * The alternative that was rejected — emit only the 1600 and let the optimiser
 * do the rest — is simpler, and it has one consequence that decided it:
 * `VARIANT_BUDGET_BYTES` and the assertions in `audit:images` would then
 * describe **a file no customer ever downloads.** A byte budget on an
 * intermediate is not a budget on anything.
 *
 * Derivative paths are content-hashed, so they are immutable and are stored with
 * a one-year `cacheControl`. That is the ideal case for a CDN and it is not
 * something the optimiser can improve on.
 *
 * ## Why a loader rather than `unoptimized`
 *
 * `unoptimized` turns off the srcset entirely, so every screen would fetch the
 * same file — a phone downloading the 1600. A `loader` keeps everything
 * `next/image` is actually good at: `fill`, `sizes`, `priority`, lazy loading
 * below the fold, and the reserved box that makes CLS impossible. Only the URL
 * it resolves to changes.
 *
 * Next asks the loader for the widths in its `deviceSizes`/`imageSizes`, which
 * are not our four. `snapWidth` maps each request up to the smallest variant
 * that covers it, so several requested widths collapse onto one real file and
 * the browser picks from the four that exist.
 *
 * ## What happens to everything else
 *
 * The seed catalogue is drawn SVGs and older uploads are single files; neither
 * matches the derivative pattern. `derivativeSrc` returns null for those and the
 * caller renders an ordinary `next/image`, exactly as before. One branch, in one
 * place, and it disappears on its own as the catalogue is reprocessed.
 */

/**
 * `derived/v1/<hash>/<stem>-<width>.webp`, anywhere in a public storage URL.
 *
 * The width is the only part that varies between siblings, which is what makes
 * the whole set derivable from the one URL stored in `product_images.url` — no
 * extra column, and therefore no way for the column and the files to disagree.
 * `audit:images` asserts this pattern still matches what `derivativePath`
 * produces, so the two cannot drift apart silently.
 */
const DERIVATIVE = new RegExp(
  `/derived/v${PIPELINE_VERSION}/[0-9a-f]+/[^/]+-(\\d+)\\.webp$`,
);

/** True when this URL is one of the pipeline's own outputs. */
export function isDerivative(url: string): boolean {
  return DERIVATIVE.test(url);
}

/**
 * The smallest emitted width that still covers what was asked for.
 *
 * Rounding *up* rather than to the nearest: a 1200 request served an 800 is
 * visibly soft, and the bytes saved are not worth a blurry product photograph.
 * Anything above the largest variant gets the largest — there is nothing better
 * to give it.
 */
export function snapWidth(requested: number): number {
  for (const width of CANONICAL_WIDTHS) {
    if (width >= requested) return width;
  }
  return CANONICAL_WIDTHS[CANONICAL_WIDTHS.length - 1]!;
}

/**
 * A `next/image` loader that resolves to a pre-made variant.
 *
 * `quality` is deliberately ignored — it is baked into the stored file at
 * encode time and there is no per-request knob to honour. Accepting the
 * argument and quietly not using it is the honest shape here; the alternative
 * would be pretending a quality prop does something.
 */
export function derivativeLoader({
  src,
  width,
}: {
  src: string;
  width: number;
  quality?: number;
}): string {
  return src.replace(DERIVATIVE, (match, current: string) => {
    const target = snapWidth(width);
    return match.replace(`-${current}.webp`, `-${target}.webp`);
  });
}

/**
 * The loader to hand `next/image`, or undefined to leave it on the optimiser.
 *
 * Returned as a function-or-undefined rather than a boolean so a caller cannot
 * decide the URL is a derivative and then forget to pass the loader — the two
 * halves arrive together or not at all.
 */
export function loaderFor(url: string) {
  return isDerivative(url) ? derivativeLoader : undefined;
}
