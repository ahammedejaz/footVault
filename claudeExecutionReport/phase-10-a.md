# Phase 10 · Batch A — the image pipeline (in progress)

**Status: the pipeline and its gate are built and proven. The admin panel, the
bulk reprocessor and the storefront wiring are not.** This report covers what
exists on `batch-a/image-pipeline` so far; it is not a completion report and
Batch A should not be merged on the strength of it.

---

## What was built

### `src/lib/images/pipeline.ts` — the normalisation itself

One original in, four canonical variants out. Pure: it touches no storage and no
database, which is what lets the gate run it over awkward fixtures with no
network and lets the reprocessor run it over an original it fetched.

- **Contain, never crop.** A shoe is the subject and the subject is the whole
  object; `cover` would take the toe off a low-cut sandal to satisfy a ratio.
- **Padded in `#eef1f5`**, the card's own `--fv-fog`.
- **EXIF orientation applied, then stripped.** `.rotate()` first, no
  `withMetadata()` after. Also drops the GPS tag, which on a phone photograph is
  the coordinates of the room the shoes were photographed in.
- **WebP at 400 / 800 / 1200 / 1600**, quality 82, effort 6.
- **Deterministic**, so reprocessing is idempotent.

### Two decisions worth defending

**The output is square, though the card is `aspect-4/5`.** The brief asks for
"the card's aspect ratio" in one sentence and for a square asset in its gate.
The card already contains over `bg-fog` so it never crops — what it cannot do is
make two differently-shaped photographs occupy the *same proportion* of the
frame, which is the actual complaint. A square padded in the frame's own colour,
letterboxed into 4:5, is invisible at the seam and identical for every product.
Square is the reading that produces what both sentences are after.

**Enlargement is allowed.** `withoutEnlargement: true` is the instinctive
setting and it defeats the module: it caps the *subject* at its original size
while `contain` still pads the canvas to 1600, so a 900px photograph becomes a
small shoe adrift in a large fog square — the exact inconsistency the pipeline
exists to remove, reintroduced by the pipeline. A small source is scaled up like
every other one, and the cost is paid where it is honest: `belowRecommended`
drives a warning under 800px at the point of choosing the file.

### `src/lib/images/constants.ts`

Every tunable, in a file that imports nothing so the browser can read it too.
`pipeline.ts` is `server-only` and pulls in `sharp`, a native module, but the
upload panel must state the same recommendation the server enforces. A panel
carrying its own copy of those numbers is the ₹2,499 shape in a different
costume.

### `src/lib/actions/admin/image-pipeline.ts` — `normaliseUpload()`

Runs the pipeline over an original already in Storage, writes the derivatives
back, returns the canonical path plus the warnings.

A second step rather than part of the upload. The bytes deliberately do not
travel through a Server Action (`requestUploadSlot` explains why: Next caps an
action body at 1MB and a phone photograph is several times that), and that split
is what makes reprocessing possible at all — re-running over a six-month-old
photograph is this same call with no upload attached.

`upsert: true` is safe **by construction rather than by hope**: paths are a
function of the content hash, so an overwrite can only ever replace bytes with
byte-identical bytes. Two admins processing the same photograph concurrently
cannot corrupt each other.

### `scripts/audit/images.ts` — `npm run audit:images`

**41 checks, all green.** The brief named the test and each clause is a section:

| Section | What it proves |
|---|---|
| 1 | `CARD_SURFACE` still equals `--fv-fog`, and the card still uses `bg-fog` + `object-contain` |
| 2 | Portrait 3000×4000, 4:3, huge 5000×5000, square 2000×2000, tiny 400×400 and a 4000×600 panorama all come out square, fog-padded, all four widths, within budget |
| 3 | EXIF orientation applied then stripped |
| 4 | Reprocessing is idempotent — same hash, byte-identical variants, same paths |
| 5 | The frame reserves its box before the image loads |

Fixtures are generated, not checked in: a generated file states its awkwardness
in the code that makes it, and it is the only way to *construct* an EXIF case
with a known tag.

---

## What I got wrong and caught in self-review

**The EXIF test was vacuous and passing.** The first version built its fixture
with `withExifMerge({ IFD0: { Orientation: "6" } })`, which silently writes
nothing — `inspect()` reported orientation `1`. So "the pipeline handles the tag
correctly" was being asserted against a file that had no tag to handle. It was
only visible because a *different* assertion in the same section failed and made
me read the reported dimensions.

Three things changed as a result: the fixture uses `withMetadata({ orientation })`,
which works; the gate now asserts the fixture **really carries orientation 6**,
so a fixture that stops carrying it fails loudly rather than passing quietly;
and it runs the same pixels **untagged** and asserts the mark lands somewhere
else. Tagged puts the mark at centroid (0.17, 0.06), untagged at (0.06, 0.83).
Without that counter-case the assertion would be satisfied by a pipeline that
ignores orientation entirely.

**A comment claimed something the code did not do.** I wrote that
`.toFormat("png")` padded a small source out to a full square under
`withoutEnlargement`. It does not — `toFormat` has nothing to say about
geometry. Probing sharp's actual behaviour showed the canvas is always padded to
the requested size, which then exposed the *real* problem: the subject was being
left small inside it. That is what produced the "enlargement is allowed"
decision above. A comment I could not verify turned out to be hiding a design
error rather than a documentation error.

**A build failure neither tsc nor eslint reports.** The action file originally
ended `export { MIN_RECOMMENDED_EDGE };` so the uploader could import it from
one place. Every export of a `"use server"` module is treated as a callable
endpoint and must be an async function, so that is a build error. Both gates
passed on it. It is what prompted the constants split, which is the better
structure anyway.

---

## Known imperfections

**The pipeline is not yet reachable by the owner.** `normaliseUpload` exists and
is guarded, but nothing in `MediaUploader` calls it — an upload today still
lands as an unprocessed original. This is precisely the "built but unreachable"
failure the brief says has cost this project twice, and it is why Batch A is
reported as in progress rather than done.

**The emitted widths are recorded and unused.** `normaliseUpload` returns all
four paths, but `product_images.url` is a single column and the storefront still
goes through the Next optimiser. Until the storefront reads them, three of the
four widths are dead weight — the same "field no caller reads" criticism this
phase's preflight levelled at `currency` and `regions`. Either the storefront
gets a direct srcset or the extra widths should stop being emitted.

**Byte budgets are unproven against real photographs.** The gate's fixtures are
flat-background synthetics that compress to 1–5KB against budgets of 60–320KB,
so the budgets are asserted but never *stressed*. A real photograph on a real
background is the test that matters and it needs real photography, which is the
owner's outstanding blocker.

**The bucket accepts 5MB, the brief specifies 10MB.** `MAX_UPLOAD_BYTES` is
`5 * 1024 * 1024` and matches the bucket's own `file_size_limit`, set in a
migration. Raising it to 10MB is a storage-config migration and has not been
written.

**No `originals/` separation.** Originals are retained — they are simply left
where the media library already puts them, and derivatives go under
`derived/v1/<hash>/`. That keeps the existing media browser working unchanged,
but it means the library lists originals and derivatives together, which will be
confusing once there are many.

---

## Not yet built

- The admin upload panel: live preview **in the actual card frame**, the
  sub-800px warning, client-side compression, a progress bar, the required
  alt-text field, and the two-shots-per-product guidance.
- The bulk reprocessor.
- Attaching a processed image to a product, and the storefront reading the
  emitted widths.
- The `audit:reachability` and operate-and-assert coverage that standing rule 7
  requires for every owner-facing control.

## Verification

| Check | Result |
|---|---|
| `npm run audit:images` | **41 checks, all green** |
| `npx tsc --noEmit` | clean |
| `npm run lint` | clean |

No production migration; no production data touched. Nothing here is on `main`.
