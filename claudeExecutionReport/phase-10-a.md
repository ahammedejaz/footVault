# Phase 10 · Batch A — the image pipeline

**Complete.** The owner can upload a crooked phone photograph of a sandal and it
comes out looking like the rest of the catalogue. Every new control is
operate-and-asserted through a real browser, and `audit:reachability` is green.

Branch `batch-a/image-pipeline`. One production migration —
`20260810140000_product_images_original_path.sql`, additive and nullable —
applied after a content-verified snapshot, on the owner's approval. No
production data was written by it: the column starts null on all 122 existing
rows, which is the correct value for a seed placeholder.

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
| `audit:images` | **47 checks, all green** |
| `audit:image-upload` | **23 checks, all green** |
| `audit:settings-visibility` | **14 checks, all green** |
| `audit:reachability` | **PASS** — every customer-facing page, both widths |
| `audit:admin-pages` | **62 passed, 0 failed** |
| `audit:settings-controls` | **36 passed, 0 failed** |
| `audit:literals` | green |
| `npx tsc --noEmit` | clean |
| `npm run lint` | clean |
| `npm run rebuild:stage` | **98 migrations, all checks green** — from empty |
| Production migration `20260810140000` | applied; snapshot content-verified against live counts first; PostgREST confirmed serving `original_path` before any code that writes it was deployed |

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

**The media library uploader is still unchanged**, and now that is safe rather
than merely unexamined: it uploads raw originals, and `addProductImage` refuses
them, so the worst it can produce is a file in the bucket that no product uses.
It has no attach-to-product affordance today; if one is ever built it must route
through the pipeline.

**Nothing sweeps orphaned originals.** A normalisation that fails after the
upload succeeds leaves an original in the bucket attached to nothing. The
direction is deliberate — attaching the row first could put an unprocessed file
on the shop — and a retry now reuses the same original rather than minting a
second, so the only source of orphans is an outright failure.

*When it becomes worth sweeping:* not at this size. Each orphan is a few hundred
kilobytes and they are trivially identifiable — anything under `originals/` with
no `product_images` row naming it in `original_path`. That query is only
meaningful now that the column exists, which is the point at which a sweep
becomes a ten-line script rather than a guess. The trigger to write it is either
a bucket bill that shows up, or the first time somebody browsing `originals/`
cannot tell which files are live. Both are far off; a sweep written today would
be a scheduled job whose failure mode is deleting a photograph.

---

---

## Closed after approval, before Batch B

**1 · The original link.** `product_images.original_path` (migration
`20260810140000`) records the storage path of the untouched upload each
derivative came from — a path, not a URL, because a URL carries the project host
and would be a dead link the moment a project moved.

Written by `addProductImage` from a value **echoed back by `normaliseUpload`**
rather than reused from the caller's own variable: the caller does know the path
it just uploaded, but a second copy of that knowledge is a second place it can be
wrong, and the row is useless if it names the wrong file.

The reprocessor now uses it. **Proven, not argued:** a row was pointed at a
fabricated derivative `deadbeefcafe0001/vbprobe-1600.webp` carrying an
`original_path`, and a reprocess rebuilt it from the original to the real hash
`3472b3c4c2d29be2/…` — logged as `(from original_path)`. That is precisely the
`PIPELINE_VERSION`-bump scenario, executed.

Rows written before the column exists still return null and are still skipped —
but now with a reason a human can act on rather than as an unexplained no-op.

**2 · The upload rate limit.** A dedicated `imageProcessing` policy at 120/min
replaces `adminBulk`'s 20. `adminBulk` is sized for whole-table writes; this is
sized for one admin working through a shoebox.

The limit is only half of it. The panel now treats a throttle as a **phase, not
a failure**: it waits out `retryAfterSeconds` with a visible countdown —
*"The shop is pacing itself — trying again in 4s. Nothing has been lost."* —
keeps the file staged and the description typed, and retries **against the same
original** rather than uploading a second copy. A red failure toast partway
through a photography session reads as the shop breaking, which is the outcome
that was asked to be avoided.

**3 · Unprocessed photographs cannot be attached.** `addProductImage` refuses any
URL that is not a pipeline output, with `/seed/` allowed because the drawn
placeholders are first-party and predate the bucket.

The rule is in the **action**, not the panel, because a rule that lives in one
screen holds only for people who used that screen — and the media library
uploads raw originals.

**Stated plainly, because a green tick could imply more than is true:** the
database has no such constraint. The seed writes `product_images` in raw SQL, and
a check constraint would have to encode the URL shape of a storage bucket. So the
guarantee is exactly as strong as *"every application write goes through
`addProductImage`"*. `audit:images` §5 asserts the predicate — including that a
derivative wrapped in `/_next/image?url=…` is **not** mistaken for one, since the
optimiser path contains the same substring.

**4 · Orphaned originals** — see *Known imperfections*.

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
