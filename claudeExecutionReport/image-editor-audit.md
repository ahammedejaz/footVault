# Image editor — audit before any feature code

Written against `docs/foot-vault-image-editor-brief.md`. Every claim below was
read out of the tree or measured today; where something is an estimate or an
untested assumption it says so.

**The short version.** The Phase 10 pipeline is in better shape than the brief
assumes, and the crop step drops into it cleanly — but three things in the
current implementation would quietly defeat parts of the brief if the feature
were built on top of them unchanged:

1. **The "original" is not an original.** The browser shrinks every upload to
   1600px on its long edge and re-encodes it as WebP q0.82 *before* it reaches
   `originals/`. A crop is a zoom, and there is no headroom to zoom into.
2. **Auto-frame works, but not with the background the brief implies.** Trimming
   against `CARD_SURFACE` finds nothing on a real table; trimming against the
   *inferred* corner pixel works across every plain background I threw at it.
   Measured table below, including the four cases where it fails.
3. **The reprocessor would un-crop the catalogue.** `images:reprocess` feeds
   `original_path` straight to the pipeline. The day crop params exist and the
   reprocessor does not read them, a `PIPELINE_VERSION` bump rebuilds all 35
   images with the owner's framing thrown away.

None of these is a blocker. All three change the design, which is why the brief
asked for the audit first.

---

## 1 · What exists today

| Piece | File | State |
|---|---|---|
| Pure pipeline | `src/lib/images/pipeline.ts` | rotate → flatten(fog) → contain-resize to 1600² → WebP at 400/800/1200/1600, content-hashed. Pure, no I/O. |
| Tunables, browser-readable | `src/lib/images/constants.ts` | `CARD_SURFACE #eef1f5`, `CANONICAL_EDGE 1600`, `CANONICAL_WIDTHS`, `PIPELINE_VERSION 1`, `MIN_RECOMMENDED_EDGE 800`, `RECOMMENDED_EDGE 2000`, per-width byte budgets. No imports — importable from client code. |
| Serving | `src/lib/images/srcset.ts` | `next/image` loader that resolves to a pre-made variant; regex-matches `derived/v1/<hash>/<stem>-<w>.webp`. |
| Server action | `src/lib/actions/admin/image-pipeline.ts` | `normaliseUpload({ path })` — downloads the original from Storage, normalises, uploads 4 variants, returns canonical path. Guarded by `adminAction` + `imageProcessing` limit (120/min). |
| Upload UI | `src/components/admin/products/image-upload-panel.tsx` (487 lines) | choose → preview in the real card frame → describe → commit. Client-side `shrink()`, direct-to-Storage upload, then the action. |
| Gallery UI | `src/components/admin/products/image-manager.tsx` | order, make-main, alt text, delete. |
| Row link to source | `product_images.original_path` (migration `20260810140000`) | nullable text, a bucket path. Written by `addProductImage`. |
| Reprocessor | `scripts/reprocess-images.ts` | re-runs the pipeline over `original_path`; safe to repeat because paths are content-derived. |
| Gates | `audit:images` (pure, 41 assertions), `audit:image-upload` (browser, drives the real panel, fetches and measures the stored asset) | both registered in `run-all.ts`. |
| Storage | bucket `product-images`, public read, admin write via RLS on `storage.objects`, 5MB per object, jpeg/png/webp/avif/svg | `supabase/migrations/20260807120600_storage.sql` |

`audit:image-upload` is the model for the new gate: it locates the control by
visible label, uploads an EXIF-rotated portrait fixture, and then *fetches the
stored object and measures it* — square, WebP, canonical edge, red mark back in
the top-left. That is the bar the crop gate has to clear.

---

## 2 · The three findings that change the design

### F1 · `originals/` holds a 1600px lossy copy, not the original

`image-upload-panel.tsx:shrink()` caps the long edge at `CANONICAL_EDGE` (1600)
and re-encodes to WebP q0.82 in the browser. That was the right call when the
server always contained the whole frame — it saves a four-megabyte upload on shop
wifi and nothing downstream needed the extra pixels.

A crop is a zoom, and it makes those pixels load-bearing:

- A shoe on a table typically occupies ~40% of the frame's long edge. Framing it
  to 85% means the crop box is roughly 47% of the source — about **750px fed
  into a 1600px canvas, a 2.1× upscale**. The pipeline already upscales
  deliberately (`withoutEnlargement` is off, for good reasons documented in
  `pipeline.ts`), so this will not fail; it will just look soft, which is the
  exact complaint the feature exists to answer.
- `original_path` inherits the ceiling **permanently**. Re-crop a year from now
  and you are still cropping into 1600px.
- The brief's 2000×2000 zoom-ready figure is unreachable twice over: the source
  is capped at 1600 and `CANONICAL_EDGE` is 1600.

Measured, worst case — a full-frame gaussian-noise image, which compresses far
worse than any photograph:

| Pre-shrink cap | WebP q82 | JPEG q82 | Bucket ceiling |
|---|---|---|---|
| 1600px (today) | 0.86MB | 0.76MB | 5.00MB |
| 2000px | 1.34MB | 1.19MB | 5.00MB |
| 2400px | 1.93MB | 1.72MB | 5.00MB |
| 3000px | 3.02MB | 2.68MB | 5.00MB |

**Proposal:** raise the client cap to a new `UPLOAD_EDGE` constant (3000
suggested — it stays inside the 5MB bucket limit on the worst input I could
construct, and a real photograph will land well under half of it), keep the WebP
re-encode, and leave `CANONICAL_EDGE` alone unless the owner wants the 2000px
zoom asset — which is a `PIPELINE_VERSION` bump and a full reprocess, so it is a
separate decision, listed in §6.

This is also the one change that must land **before** the first real photography
session, for the same reason `original_path` did: every photograph uploaded
under the old cap keeps its 1600px ceiling forever.

### F2 · Auto-frame with `sharp.trim` — what it actually does

`sharp` 0.35.3 is already a dependency; `trim`, `extract`, `rotate`, `modulate`
and `linear` are all present, so no new dependency is needed. But **the
background matters more than the threshold**, and the obvious implementation is
the broken one.

Trimming against a named background — `trim({ background: CARD_SURFACE })`, the
natural reading of "our pad colour is fog" — finds the subject only when the
photograph's background is *already* `#eef1f5`:

| Fixture (subject = 40% × 32% of frame) | `trim({background: CARD_SURFACE})` |
|---|---|
| plain fog `#eef1f5` | correct bbox |
| warm off-white table `#e8e2d6` | **whole frame — found nothing** |
| busy background | whole frame |

Trimming with the background *inferred from the top-left pixel* —
`trim({ threshold })` with no background — works on any plain surface:

| Fixture | thr 2 | thr 5 | thr 8 | thr 12 | thr 20 | thr 30 |
|---|---|---|---|---|---|---|
| dark shoe on fog | ok | ok | ok | ok | ok | ok |
| dark shoe on warm table / mid-grey | ok | ok | ok | ok | ok | ok |
| light-grey shoe on fog (Δ≈50) | ok | ok | ok | ok | ok | ok |
| dark shoe, JPEG q78 artefacts | +3px | ok | ok | ok | ok | ok |
| dark shoe, uneven gradient light | fail | fail | fail | fail | ok | ok |
| **white shoe on fog (Δ≈8)** | ok | ok | **fail** | fail | fail | fail |

No single threshold serves both a very low-contrast subject and uneven lighting.
**Proposal:** a threshold ladder — try 10, then 20, then 30, then 5 — and accept
the first result that is ≤92% of the frame on at least one axis and ≥8% on both.
Anything else is "not found".

**What auto-frame fails on, plainly.** These are measured, not hypothetical:

- **A busy background** — bedspread, wood grain, patterned floor. Returns the
  whole frame at every threshold. Detectable, and the fallback is a centred crop.
- **A subject touching the top-left corner.** The corner pixel *is* the shoe, so
  the "background" it trims against is the shoe. Returns the whole frame.
  Detectable, same fallback.
- **A white shoe on a white table** (Δ under ~8 per channel). Returns the whole
  frame. Genuinely ambiguous — the boundary is not in the pixels.
- **Two shoes photographed apart.** Returns a box spanning both (measured
  1480×880 for two 640×380 subjects). Arguably correct; the owner nudges.
- **Uneven light** — a soft gradient across the table needs threshold ≥20, which
  is exactly the threshold that loses the white-on-white case. The ladder trades
  between them; it does not solve both.

The UI must say which happened. "Framed automatically" and "couldn't find the
shoe against that background — centred instead, drag to adjust" are different
sentences, and the second one is the honest one about a third of the time.

### F3 · The reprocessor would throw the framing away

`scripts/reprocess-images.ts` calls `normaliseProductImage(original)` with no
other input. Once crop parameters exist on the row, that call silently means
"rebuild without the crop". A `PIPELINE_VERSION` bump — the entire reason
originals are kept — would then un-frame all 35 photographs at once, and the
script would report a confident green.

Crop params have to be threaded through `normaliseProductImage`, the reprocessor
and `normaliseUpload` **in the same change that introduces them**, and
`audit:images` needs an assertion that a row with crop params reprocesses *to the
same framing*.

---

## 3 · Smaller findings, each with a consequence

- **`original_path` is not read into the admin UI.** `getAdminProduct` selects
  `id, url, alt_text, sort_order, is_primary, color`
  (`src/lib/queries/admin/products.ts:301`) and `AdminImage`
  (`components/admin/products/types.ts`) has no field for it. Re-crop needs both.
- **No column for crop parameters.** `product_images` has no place to record
  offset/scale/rotation/adjustments. New migration required — one `jsonb crop`
  column, nullable, null meaning "whole frame, as before". Nullable rather than
  defaulted so existing rows keep meaning what they mean.
- **Re-crop orphans four objects per image.** Derivative paths are a hash of the
  output, so a new crop writes to new paths and the old four stay in the bucket.
  `listMedia` already computes an `unusedCount`, so they will surface on the
  media screen — but a decision is needed: delete on re-crop, or leave and sweep.
  Deleting is not obviously right (a shared hash across two rows is possible in
  principle), so my recommendation is **leave and let the media screen report**.
- **Determinism has to be re-proved, not assumed.** The brief's gate — "re-running
  the same crop is byte-identical" — is currently true because every parameter is
  fixed. Rotation adds an interpolation step. `sharp`'s rotate is deterministic
  for a fixed input and version, but the gate should assert it rather than trust
  it, and `PIPELINE_VERSION` must move if the crop maths ever changes.
- **`originalPath()` in `pipeline.ts:264` is dead.** Nothing calls it; the panel
  invents `originals/<productId>/<uuid>.<ext>` itself. Two conventions for one
  thing, and re-crop is about to depend on reading those paths. Reconcile.
- **The preview must be computed from shared maths, not eyeballed.** If the
  browser previews with CSS transforms and the server crops with `extract`, the
  two round differently and the tool lies about what it will produce. Proposal: a
  pure `src/lib/images/crop.ts` — no imports, like `constants.ts` — that turns
  (offset, scale, rotation, source dims) into an integer extract rect, imported
  by both sides. `audit:images` asserts the browser's numbers and the server's
  agree on a table of cases.
- **The browser sends parameters, never pixels.** Keeps §5 of the brief ("the
  pipeline stays where it is") true, keeps the 1MB Server Action body limit
  irrelevant, and makes re-crop and reprocess the same code path.
- **Rate limit is fine, with one edge.** `imageProcessing` is 120/min — ample for
  a session. A "re-crop everything" sweep from the contact sheet over 35 images
  would sit under it, but a bulk operation should be sequential anyway.
- **Fill percentage needs a definition, not just a number.** "Fills 85% of the
  frame" is ambiguous between area and longest side. For a shoe — a wide, low
  subject — 85% *by area* is not achievable at all; 85% on the longest side is
  about 40% by area for a typical shoe silhouette. Recommend defining it as
  **the subject bounding box's longest side ÷ the frame edge**, stating that in
  the UI, and making the number a setting. Amazon and Flipkart both mean
  something close to this in practice.

---

## 4 · Gate and harness gaps

- **`audit:shots` cannot photograph the panel.** `AUDIT_ROUTES`
  (`scripts/audit/routes.ts`) contains no admin route, and `screenshots.ts`
  starts a browser with no session — every admin route would capture the sign-in
  page. The brief asks for shots at 390/768/1024/1440, so the new gate takes its
  own, with an admin session. Precedent exists: `audit/hero-media.ts` writes
  `screenshots/hero-<width>.png` from inside a gate.
- **`audit:reachability` will not prove this feature is reachable.** It derives
  its page list from `src/app/(storefront)` only — it is the *customer's*
  reachability gate. Keeping it green is a regression check, which is what the
  brief asks for, but the crop step being operable by the owner has to be
  asserted by the new gate itself, the way `audit:settings-controls` does for
  `/admin/settings`. I will not report reachability green as evidence the crop
  step can be found.
- **Operate-and-assert on a pointer-driven canvas needs designing, not just
  writing.** Sliders (straighten, brightness, contrast) are labelled inputs and
  `getByLabel` handles them. The crop frame is not: the assertion has to be
  "drag/wheel the frame → the live fill readout changes → the committed row's
  crop params differ from the auto-proposal → the stored derivative differs".
  That chain is assertable end-to-end, and it is what I intend to build.
- Two new gate names will need registering in `run-all.ts` `GATES` — the drift
  check fails otherwise, which is the intended behaviour.

---

## 5 · What I propose to build, in order

Each step is independently gate-able; nothing merges without `audit:build-smoke`
first, per the standing merge policy.

1. **Headroom and the shared maths.** `UPLOAD_EDGE` constant, panel shrink cap
   raised, `src/lib/images/crop.ts` (pure), crop params threaded through
   `normaliseProductImage` → `normaliseUpload` → `reprocess-images.ts`.
   Migration: `product_images.crop jsonb null`. Gate: `audit:images` extended.
2. **Auto-frame server-side.** A `proposeFrame` action returning a bbox in source
   coordinates plus a confidence flag, with the threshold ladder and the honest
   "not found" state. Gate: plain-background fixture within tolerance, busy
   fixture falls back.
3. **The crop step in the panel.** Square frame, pinch/drag on touch,
   wheel/drag on desktop, fill guide at the target, live fill readout with the
   under-target nudge, last-crop memory for the session. `impeccable`, `taste`
   and `emilkowalski` loaded before this step, per the standing rule.
4. **Straighten + brightness/contrast.** Two controls, conservative ranges,
   applied server-side from the same recorded parameters.
5. **Re-crop from `original_path`**, plus the contact sheet on the product images
   screen.
6. **The gate**, written alongside 3–5 rather than after: `audit:image-editor`,
   operate-and-assert by visible label, on a production build, with screenshots
   at the four widths.

Estimated shape: one migration, ~4 new files, ~6 modified, 2 new gate scripts.

---

## 6 · Decisions that are yours, not mine

1. **Target fill percentage, and its definition.** 85% is what both marketplaces
   use and is the suggested default. I propose defining it as *the subject's
   longest side ÷ the frame edge* and storing it in `site_settings` so it is
   tunable once there are real photographs to look at. A shoe may sit better at
   78–80.
2. **Raise the pre-upload cap to 3000px?** It costs upload time on shop wifi
   (roughly 2–3× today's bytes) and buys the resolution that makes cropping
   possible. My recommendation is yes, and before the first real session.
3. **Move `CANONICAL_EDGE` from 1600 to 2000?** This is the brief's "zoom-ready"
   figure. It is a `PIPELINE_VERSION` bump and a full reprocess of the catalogue,
   plus a re-look at `VARIANT_BUDGET_BYTES`. It is genuinely separable from the
   crop feature and I would not bundle it in.
4. **Orphaned derivatives after a re-crop** — leave them for the media screen to
   report (my recommendation), or delete on re-crop.

---

## 7 · What this audit did not establish

- Every trim measurement above is against **synthetic fixtures** — flat blocks on
  flat and noisy fields. They bound the behaviour honestly, but the first real
  photograph of a shoe on the owner's actual table may sit anywhere inside those
  bounds. The auto-frame tolerance in the gate should be set after seeing one.
- The byte figures for the upload cap are worst-case gaussian noise. Real
  photographs will be considerably smaller; nothing here measured a real one.
- Nothing was run against staging in this pass; no browser gate was executed.
- I have not yet read `node_modules/next/dist/docs/` for the App Router
  specifics this panel will touch, per `AGENTS.md`. That happens before the
  first line of feature code, not before this report.

---

# Progress after the audit — 2026-08-13

Your four decisions are recorded in §6 above as taken: fill measured by longest
side with 85% default and the definition stated in the settings hint; cap raised
to 3000px first; `CANONICAL_EDGE` left at 1600; orphaned derivatives left to
`unusedCount`.

## Step 1 · Upload headroom — **live in production**

Merged as `3053a205`, deployed, and verified by alias rather than by build
state: `www.footvault.in` resolves to `dpl_8XHMYaHkWLRzyXkdNjJaDJTNd5eR`, whose
commit is that merge, aliased to both the apex and `www`, serving from `bom1`.

- `UPLOAD_EDGE_LADDER` = 3000 → 2400 → 2000 → 1600. First rung that fits under
  the bucket's 5MB ceiling wins; each rung re-encodes from the bitmap rather
  than from the rung above, so stepping down costs time and no quality.
- `MAX_UPLOAD_BYTES` moved out of the panel into `constants.ts`, and
  `audit:images` asserts it equals `file_size_limit` in the storage migration.
- `audit:image-upload` now builds a fixture at `UPLOAD_EDGE + 200`, downloads
  the stored original and measures it: **2250×3000 from a 2400×3200 source**,
  where yesterday it would have been 1200×1600. That check fails if the cap is
  ever lowered back, which nothing else in either gate would have noticed.

**You can shoot.** Anything uploaded from now keeps 3000px in `originals/`.

## Step 2 · The crop model — built, gated, **not merged**

`src/lib/images/crop.ts`, pure and import-free. Six numbers, every one a
fraction of the frame rather than a pixel, for three reasons that are each a
bug that now cannot happen: the preview is 320px while the source is 3000; a
re-crop may read an original at a different resolution; and neither side has to
predict how libvips rounds a rotated bounding box, because each resolves against
the frame it actually has.

`DEFAULT_CROP` is exactly the framing the pipeline has always produced, and a
**null** crop takes the untouched branch — so existing rows recompute the same
content hashes and therefore the same paths. The migration has no backfill and
should never get one.

Threaded through `normaliseProductImage` → `normaliseUpload` (which echoes back
what it applied, the way `originalPath` does) → `addProductImage` → and
`scripts/reprocess-images.ts`, which was the finding: a reprocessor that ignored
the column would have un-framed the whole catalogue on the next
`PIPELINE_VERSION` bump and reported a confident green while doing it.

`audit:images` is 67/67, up from 51. Two things it taught me, both now written
into the file so they are not re-learned:

- **sharp runs `extract` before `extend`** whatever order the calls are written
  in. Chaining them threw `bad extract area` on every default crop of a
  non-square photograph; the padding is its own buffer pass now.
- **The crop path and the untouched path are byte-identical** when the
  photograph's own edge is already the pad colour, and differ by 0.87% of
  subpixels (max delta 31) along the seam when it is not. Enough to change a
  content hash, which is exactly why null keeps the old branch.

Three of the checks in that section were wrong before they were right, and the
corrections are the interesting part: one compared *compressed* WebP bytes and
reported "100% differing, max delta 255" about two nearly identical pictures;
one asserted an exact pad colour that a lossy encoder is entitled to move by a
level; and one passed while proving nothing, because a flat fixture has no
content at its edge and therefore no seam to blend. That last one is the
failure mode this codebase keeps naming — a check that can only report zero.

## What is blocking, and it is yours to run

`supabase db push` against staging was **refused by the tool classifier**. Per
the standing rule I did not route around it with a different tool.

```
npm run push:stage          # applies 20260813040000 to staging
npm run push:stage -- --list   # what is pending, without applying
```

`scripts/db-push.ts` is new and staging-only by construction — it is the same
`db push --db-url` that `rebuild:stage` runs, without the drop-and-reseed, so a
one-column migration no longer costs a full rebuild.

**Two consequences until that runs:**

1. `audit:image-upload` cannot be re-run end to end. `addProductImage` now
   writes `product_images.crop`, and staging has no such column.
2. **Branch `image-editor-2-crop-model` must not merge until the migration is
   on _production_.** Merging is deploying, and deploying a write to a column
   production does not have breaks every upload — while you are photographing.
   Step 1 is separately merged and live precisely so this one can wait.

`src/lib/database.types.ts` carries the `crop` column by hand, because the
generator reads staging. Re-run `npm run types:stage` after the push to confirm
the generated shape matches what I wrote.

## Still to build

Steps 3–6 from §5: auto-frame as a server action with the threshold ladder and
an honest "couldn't find the shoe — centred instead"; the crop step in the panel
with the fill guide and live readout; straighten and brightness/contrast; the
target-fill setting; re-crop from `original_path`; the contact sheet; and
`audit:image-editor` with screenshots at the four widths.

**On gate coverage, restated because it would otherwise read as coverage:**
`audit:reachability` walks `src/app/(storefront)` only. Keeping it green proves
nothing whatsoever about whether the crop step can be found in the admin. The
new gate has to assert that itself, the way `audit:settings-controls` does for
`/admin/settings`, and I will not report the former as evidence of the latter.

---

# The crop step — built, gated, still unmerged

## What is on the branch now

`image-editor-2-crop-model` carries everything: the crop model, auto-frame, the
panel, the two adjustments, the target-fill setting, re-crop, the contact sheet
and `audit:image-editor`.

**The flow is choose → frame → describe → commit**, and the original now uploads
the moment a file is chosen rather than at the end. That is not a detail: auto-
frame runs server-side, so the bytes have to be somewhere the server can read
before there is anything to propose. Uploading at choose time means the network
works while the human does, and the proposal is on screen before the first drag
is over.

**Auto-frame** is `sharp`'s trim over a threshold ladder — 10, 20, 30, then 5.
There is no single threshold, and that is measured, not assumed: 20 and above is
needed for uneven light across a table, and 8 and above loses a white shoe on a
fog background. When nothing plausible comes back, the panel says *"couldn't
find the shoe against that background — centred instead"* and falls back to the
whole photograph rather than a guessed zoom. Both halves of that are deliberate:
a confident wrong crop looks like a decision and gets approved, and inventing a
zoom would look exactly like a successful auto-frame.

**The target fill is a settings row** and the control's hint states what the
number measures — the subject's longest side, not area. That sentence is
load-bearing rather than decorative: 85% by area is not a demanding target for a
shoe, it is an unreachable one, so an owner assuming the area reading would
conclude the tool was broken and turn the number down until it "worked".

**Re-crop** runs the pipeline again from `original_path` with different numbers.
Old derivatives stay in the bucket as unused files, per your decision.

## Three bugs the gates found, two of them invisible to every predicate

1. **Straightening switched auto-frame off.** Rotation pads the new corners, and
   the corner is exactly where the background colour is inferred from — so
   padding a warm wooden table with fog made every pixel of the photograph
   "not background" and the detector correctly reported nothing. Measuring now
   pads with the photograph's own corner colour; the output still pads with
   `CARD_SURFACE`, and both frames come out the same size so the fractions hold.
   `audit:images` asserts both directions, including that the old behaviour
   fails.

2. **The contact sheet took the product page down.** It passed `loader` — a
   function — from a Server Component to `next/image`, which throws *Functions
   cannot be passed directly to Client Components*. Every render after a refresh
   died. It is a Client Component now.

3. **The crop stage rendered empty while every assertion passed.** The readout
   said 85%, the stored asset was correct at 85%, the recorded crop was correct
   — and the photograph was translated clean out of the square, because CSS
   translate percentages are relative to the element's own size and the code
   treated them as relative to the container. **A screenshot caught it.** The
   gate now screenshots the stage itself and fails if the pixels are a flat
   colour.

And a fourth, from the 390px screenshot: adding the Re-frame button pushed the
per-photograph control row past its own card border — "Re-frame" clipped,
"Delete" hanging outside the box. That is the third time a screenshot has caught
a defect in this area that every predicate passed, which is the entire argument
for taking them.

## Gates

| Gate | Result |
|---|---|
| `audit:images` | **76/76** — pure; crop maths, determinism, and what auto-frame fails on |
| `audit:image-upload` | **26/26** on a production build |
| `audit:image-editor` | **32/32** on a production build — new |
| `audit:settings-controls` | blocked: needs `20260813050000` |

`audit:image-editor` operates every control by its visible label **and by
keyboard** — Zoom, Straighten, Brightness, Contrast, Frame it for me, Whole
photograph, Re-frame, Save this framing — drags the square with a real pointer,
then measures the stored object against what the panel promised: 85% shown, 85%
stored. It drives the busy-background fallback through the real panel, re-frames
end to end and asserts the derivative changed, and writes screenshots at 390,
768, 1024 and 1440.

Two assertions in `audit:image-upload` had gone stale and one of them was
**passing for the wrong reason** — it looked for the old 4:5 preview and matched
the contact sheet's tiles, which use the same three classes. A check that
matches something else on the page reports coverage of a control that no longer
exists, so it now asserts the framing square by its accessible name.

## The gate-coverage statement, restated because it would otherwise read as coverage

`audit:reachability` derives its page list from `src/app/(storefront)` and plays
a customer clicking around the shop. **It says nothing whatsoever about whether
the crop step can be found in the admin.** Keeping it green is a storefront
regression check and is reported as exactly that; the only evidence that this
feature is reachable and operable is `audit:image-editor`, which prints that
disclaimer at the end of every run.

## What is queued for you

Two migrations, in order, then the merge decision:

```
npm run push:stage      # 20260813040000 (crop column) is already on staging;
                        # 20260813050000 (images settings row) is not
```

`20260813050000` inserts the `images` settings row. Until it is applied,
`audit:settings-controls` cannot operate the target-fill control — and saving it
returns an honest *"there is no photograph settings row to save into yet"*
rather than the silent no-op an `update ... where key = 'images'` would
otherwise be against a database with no such row.

**Neither migration is on production, and the branch must not merge until both
are.** The panel writes `product_images.crop` and the settings screen writes the
`images` row; deploying either against a database without them breaks uploads —
while you are photographing. Tell me when you want to land it and I will run
`audit:build-smoke`, merge, and verify by alias.

## Still not built

Nothing from the brief. Everything in §5 of the audit is built and gated. What
is *deliberately* absent is what the brief excluded: filters, saturation, colour
temperature, background removal, blemish tools.

One thing to flag as an assumption rather than a finding: the auto-frame
tolerances are set against constructed fixtures — flat blocks on flat and noisy
fields. They bound the behaviour honestly, but the first real photograph of a
shoe on your actual table may sit anywhere inside those bounds. Upload two or
three and I will tighten the ladder against what they actually show.
