/**
 * The numbers the image pipeline is defined by, in the one file both sides can
 * read.
 *
 * `pipeline.ts` is `server-only` and imports `sharp`, which is a native module
 * and cannot exist in a browser bundle. But the admin's upload panel has to
 * state the same recommendation the server enforces — "2000 × 2000", "we will
 * warn you under 800" — and a panel that carries its own copy of those figures
 * is a panel that eventually disagrees with the pipeline about what it accepts.
 *
 * That is the ₹2,499 shape again in a different costume: one truth, typed
 * twice, drifting silently. So the constants live here with no imports at all,
 * and both sides read them.
 */

/**
 * The card's surface, and it must equal `--fv-fog` in `globals.css`.
 *
 * Baked into every stored asset at upload time, because the padding is burnt
 * into the pixels. A CSS variable that changed later would repaint the frame
 * and leave every previously processed image padded in the old colour — a
 * visible square inside every card. `audit:images` asserts the two agree.
 *
 * Safe to bake in for a second reason: `--fv-fog` is a brand constant defined
 * once on `:root` and deliberately not redefined for dark mode, so there is no
 * second value it could need to be.
 */
export const CARD_SURFACE = "#eef1f5";

/**
 * The widths emitted, largest last.
 *
 * Chosen against what the card is actually asked to be: roughly 156px on a
 * phone two-up, ~300px in the desktop grid, and full width on a product page.
 * Doubling for high-density screens puts the useful range at 400–1600, and the
 * two in between keep the jump under 2×.
 */
export const CANONICAL_WIDTHS = [400, 800, 1200, 1600] as const;

/** The canonical edge. Square, so this is both width and height. */
export const CANONICAL_EDGE = 1600;

/**
 * Bumping this re-derives every derivative path, which is how a change to the
 * frame reaches photographs uploaded before it.
 *
 * Part of the path rather than a column so that a reprocess after a bump writes
 * *new* objects instead of overwriting live ones: the old catalogue keeps
 * rendering until the new rows are swapped in, so a half-finished reprocess is
 * never a half-broken shop.
 */
export const PIPELINE_VERSION = 1;

/**
 * Below this on either side, the pipeline is upscaling and it will look like
 * it.
 *
 * A warning rather than a refusal: the owner may have one irreplaceable
 * photograph of a shoe there are two pairs left of, and refusing it helps
 * nobody. The panel says so at the point of choosing the file.
 */
export const MIN_RECOMMENDED_EDGE = 800;

/** What the upload panel asks for. Square, and comfortably over the canonical edge. */
export const RECOMMENDED_EDGE = 2000;

/**
 * The long edge the browser shrinks an upload down to before it leaves the
 * tablet — and the ladder it steps down if the result will not fit the bucket.
 *
 * ## Why this is not `CANONICAL_EDGE`, which is what it used to be
 *
 * Shrinking to the canonical edge was right while the server always contained
 * the *whole* frame: every pixel above 1600 was one the pipeline was going to
 * throw away, and throwing it away on the tablet saved a four-megabyte upload
 * on shop wifi.
 *
 * The crop step changes what those pixels are for. A crop is a zoom, and the
 * pixels it zooms into have to exist. A shoe photographed on a table typically
 * occupies about 40% of the frame's long edge; framing it to the target fill
 * means keeping roughly half the frame, so a 1600px upload puts about 750px
 * into a 1600px canvas — a 2.1x enlargement, which is precisely the softness
 * this whole area exists to remove.
 *
 * It is also **irreversible**. `originals/` is what a re-crop and a
 * `PIPELINE_VERSION` bump both read, so a photograph uploaded under a 1600px
 * cap carries that ceiling for as long as it is in the catalogue. That is why
 * this constant moved before the crop UI was built rather than alongside it:
 * every photograph taken in the meantime would have been capped forever.
 *
 * ## Why 3000, and why a ladder rather than a number
 *
 * The bucket refuses anything over `MAX_UPLOAD_BYTES`. At 1600 that limit was
 * unreachable and the panel's over-size branch was effectively dead code; at
 * 3000 it is merely unlikely, which is a different thing to design for.
 * Measured 2026-08-13 against a full-frame gaussian-noise fixture — which
 * compresses far worse than any photograph of a shoe on a table — WebP q82
 * lands at 0.86MB at 1600, 1.93MB at 2400 and 3.02MB at 3000, all inside the
 * 5MB ceiling. A real photograph will be well under half of those.
 *
 * So 3000 is the size that fits the worst input I could construct, and the
 * ladder is what happens if a real one beats it: the panel re-encodes one step
 * smaller rather than refusing a photograph the owner is standing in the shop
 * holding. Refusing is still possible at the bottom of the ladder, and it is
 * the honest end state — but it now takes a file that cannot be squeezed under
 * 5MB at 1600px, which is not a photograph, it is a problem.
 */
export const UPLOAD_EDGE_LADDER = [3000, 2400, 2000, 1600] as const;

/** The size an upload is stored at when nothing goes wrong. */
export const UPLOAD_EDGE = UPLOAD_EDGE_LADDER[0];

/**
 * The bucket's own ceiling, in the one file both the panel and the gates read.
 *
 * It must equal `file_size_limit` on the `product-images` bucket, set in
 * `supabase/migrations/20260807120600_storage.sql`. It lived as a private
 * constant in the upload panel until the ladder above started depending on it,
 * and a limit the client believes in while the server enforces a different one
 * is a refusal message that lies — or worse, an upload that passes the panel's
 * check and is rejected by Storage after the owner has waited for it.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * A ceiling per emitted variant, in bytes.
 *
 * The 1600 is the one that matters — it is what a product page fetches — and
 * 320KB for a contained photograph on a flat background is generous. It exists
 * so a pathological source (a photograph of gravel, which compresses terribly)
 * is reported rather than quietly shipped onto the LCP path of the page this
 * phase is trying to keep fast.
 */
export const VARIANT_BUDGET_BYTES: Record<number, number> = {
  400: 60_000,
  800: 140_000,
  1200: 240_000,
  1600: 320_000,
};

/**
 * What the owner is asked for, in one sentence, in the one place it is written.
 *
 * The panel renders this rather than composing its own sentence out of the
 * numbers above, so the recommendation cannot drift from the constants it is
 * describing.
 */
export const UPLOAD_RECOMMENDATION =
  `${RECOMMENDED_EDGE} × ${RECOMMENDED_EDGE} px, square, the shoe centred on a plain light background.`;
