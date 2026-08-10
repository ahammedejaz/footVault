# Phase 10 · Batch A — the image pipeline

**Complete.** The owner can upload a crooked phone photograph of a sandal and it
comes out looking like the rest of the catalogue. Every new control is
operate-and-asserted through a real browser, and `audit:reachability` is green.

Branch `batch-a/image-pipeline`. No production migration, no production data
touched.

---

## What was built

### `src/lib/images/pipeline.ts` — the normalisation

One original in, four canonical variants out. Pure: no storage, no database,
which is what lets the gate run it over awkward fixtures with no network and
lets the reprocessor run it over an original it fetched.

Contain never crop; padded in the card's own `#eef1f5`; EXIF orientation applied
and then stripped; WebP at 400/800/1200/1600 at quality 82; deterministic.

### `src/lib/images/constants.ts`

Every tunable, in a file that imports nothing so the browser can read it too.
The panel has to state the same recommendation the server enforces, and a panel
with its own copy of those numbers is the ₹2,499 shape in a different costume.

### `src/lib/images/srcset.ts` — the loader

A `next/image` loader resolving to the pre-made variants, and `loaderFor`
returning **the loader or undefined** so a caller cannot decide a URL is a
derivative and then forget to pass the loader.

### `src/components/storefront/product-image.tsx`

The client boundary the loader needs, adopted by the card, the gallery, the
wishlist row and the cart lines.

### `src/lib/actions/admin/image-pipeline.ts` — `normaliseUpload()`

Runs the pipeline over an original already in storage. `upsert` is safe by
construction rather than by hope: paths are a function of the content hash, so
an overwrite can only replace bytes with identical bytes.

### `src/components/admin/products/image-upload-panel.tsx`

The staged upload. Choose → see it in the real card frame → describe it →
commit. Live preview at `aspect-4/5` over `bg-fog` with `object-contain` — the
same three the storefront card uses. Sub-800px warning, client-side compression,
phase-by-phase progress, required description, unconditional two-shot guidance.

### `scripts/reprocess-images.ts` — `npm run images:reprocess`

Dry-run, real run, `--stage`. Re-runs the pipeline over anything with an
original in the bucket; reports and skips the seed placeholders rather than
guessing at them.

---

## The decision you asked me to make: direct srcset

**Chosen: serve the four emitted variants directly; do not route through the
Next optimiser.**

The pipeline already produces exactly the widths the card asks for, at a fixed
quality, on a flat background, at content-hashed immutable paths stored with a
one-year `cacheControl`. Passing that through the optimiser is a second lossy
pass over pixels that were made for the purpose, billed per transformation, with
a cold first request in front of the page this phase is trying to keep fast.

The argument that decided it is not performance. Under the optimiser,
`VARIANT_BUDGET_BYTES` and the byte assertions in `audit:images` would describe
**a file no customer ever downloads.** A budget on an intermediate is a budget on
nothing, and the gate would be measuring something that does not ship.

A `loader` rather than `unoptimized`, because `unoptimized` turns the srcset off
entirely and every screen would fetch the 1600. The loader keeps `fill`, `sizes`,
`priority`, lazy loading and the reserved box; only the URL changes. Anything
that is not a derivative — every seed SVG, every pre-Phase-10 upload — falls
back to the optimiser untouched, so this needed no catalogue migration to be
safe.

---

## Verification

Every number below was produced by a run, on staging, against a real browser.

| Gate | Result |
|---|---|
| `audit:images` | **41 checks, all green** |
| `audit:image-upload` | **23 checks, all green** |
| `audit:settings-visibility` | **14 checks, all green** |
| `audit:reachability` | **PASS** — every customer-facing page, both widths |
| `audit:admin-pages` | **62 passed, 0 failed** |
| `audit:settings-controls` | **36 passed, 0 failed** |
| `audit:literals` | green |
| `npx tsc --noEmit` | clean |
| `npm run lint` | clean |

**The reprocessor was exercised, not just dry-run.** The first dry run reported
"122 seed placeholders skipped, would process 0", which proves nothing about the
processing path. A row was pointed at a real original: first run processed 1 and
repointed the row; second run reported `1 already-derivative rows skipped`,
which is idempotence observed rather than argued.

---

## What I got wrong and caught in self-review

**The EXIF assertion was vacuous and passing.** `withExifMerge` silently writes
no tag, so the pipeline was being tested against a file with nothing to handle.
The gate now asserts the fixture *really carries* orientation 6, and runs the
same pixels untagged to prove the check discriminates — tagged (0.17, 0.06),
untagged (0.06, 0.83).

**A comment claimed something the code did not do.** I wrote that
`.toFormat("png")` padded a small source to a square. It does not. Probing
sharp's real behaviour exposed the actual problem underneath:
`withoutEnlargement` was leaving a small subject adrift in a large fog square —
the exact inconsistency the pipeline exists to remove.

**A build failure neither tsc nor eslint reports.** The action file re-exported a
constant; every export of a `"use server"` module must be an async function.

**Client-side compression was about to destroy orientation.** `shrink()` decodes
to a canvas, which has no EXIF, so whatever comes out has lost the tag
permanently. If the bitmap were decoded without applying the tag first, a
portrait phone photograph would be baked sideways *and* stripped of the only
record of which way was up — and the careful server-side rotation would have
nothing left to work with. The historical default for `imageOrientation` was
`"none"`; the spec later moved to `"from-image"`. It is now passed explicitly.

**Two gate checks failed for reasons unrelated to what they named** — the
failure mode you asked me to watch for, twice in one file:

*The two-shot guidance* only appeared when a shot was missing, so it was
invisible on precisely the products that already satisfied it. The gate was
right to fail; the copy was wrong. A rule you cannot read once you have followed
it is a rule nobody learns.

*The storefront check* reported "the loader is not wired" while the loader was
working perfectly. It picked its product from Postgres and got one that sits on
page two of `/shop`, with no card to assert about — and on the product page the
gallery filters by colourway, so a freshly uploaded image with no colour is not
rendered there either. It now harvests the slug **from the listing**, so the
surface is guaranteed by construction.

I also removed a dead branch from the reprocessor. "Already current, skip the
write" can never be reached — a processed row points at `derived/` and is caught
by the already-derivative skip far above. Running it twice is what proved it. A
counter that can only ever report zero reads as coverage.

---

## Known imperfections

**Byte budgets remain unproven.** The fixtures are flat-background synthetics
that compress to 1–5KB against budgets of 60–320KB, so the budgets are asserted
but never stressed. A real photograph on a real background is the only test that
matters, and it needs real photography. **Open item, recorded as you asked
rather than synthesised.**

**The media library uploader is unchanged.** `src/components/admin/media/` still
uploads unprocessed originals. It is the general asset library rather than the
product-photograph path, and Batch A's brief is about product photography — but
a photograph attached to a product *from* the library would bypass the pipeline.
Named so it does not read as coverage.

**A failed normalisation leaves an orphaned original.** Deliberate: the
alternative order attaches the row first and can put an unprocessed file on the
shop. A stray original costs a few hundred kilobytes and can be reprocessed;
nothing sweeps them yet.

**The reprocessor cannot re-run over an already-processed row.** Once
`product_images.url` points at a derivative, the original it came from is not
recorded anywhere on the row, so a `PIPELINE_VERSION` bump would skip exactly the
images it is meant to rebuild. Feeding a derivative back through would compound
the compression, so skipping is right and the missing piece is a column — or a
convention — linking a row to its original. **This is the one real gap in the
reprocessing story and it should be closed before the first version bump.**

**`normaliseUpload` is `adminBulk` rate-limited** (20/min). An owner adding many
photographs quickly could hit it. Generous for two shots per product; worth
watching during the first real photography session.

---

## Not in Batch A, by scope

The `originals/` separation is done for the product path only. Existing
pre-Phase-10 uploads stay where they are — they are still reprocessable, since
the reprocessor works from whatever the row points at.

---

## Blocked on the owner

Nothing. Batch A needs no decision and no dashboard change.

Real product photography remains the outstanding blocker to opening the shop,
and it is now the only thing standing between this pipeline and a finished
catalogue.
