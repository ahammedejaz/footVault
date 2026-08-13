# Foot Vault — Image Editor Brief

**A crop-and-adjust step in the admin, modelled on how the big marketplaces actually do it.**

> Save as `docs/IMAGE_EDITOR.md` and tell Claude Code: *"Read docs/IMAGE_EDITOR.md and begin. Audit first — report before writing feature code."*

---

## The problem

The image pipeline built in Phase 10 normalises what it is given: contain-not-crop, square, fog-padded, EXIF corrected, WebP at four widths. It cannot decide *how much of the frame the shoe should occupy*, because that is a composition decision and it is currently made by whoever held the camera.

The result is a catalogue where one shoe fills its card and the next floats in the middle of a fog square — the exact inconsistency the pipeline was built to remove, arriving one step earlier than the pipeline can reach.

**The owner needs to crop and adjust before the pipeline runs**, and the whole thing has to be operable by a non-technical shopkeeper on a tablet.

---

## What the marketplaces do — the research this is built on

Both Amazon and Flipkart converge on the same numbers, and they converge for a reason worth understanding.

- **Square, 1:1.** <cite index="40-1">Amazon strongly recommends a 1:1 square aspect ratio for all product images, because square images display uniformly in search results, category pages, mobile apps and desktop browsers without awkward cropping or letterboxing.</cite>
- **The product fills about 85% of the frame.** <cite index="47-1">Amazon's rule is that the product must fill at least 85% of the frame, and in practice the majority of listings violate it — products floating in too much white space.</cite> <cite index="41-1">Flipkart states the same 85% figure alongside a minimum of 1000px on both dimensions.</cite>
- **Why 85 and not 100:** <cite index="40-1">the remaining 15% provides breathing room, and a product touching the frame edges can trigger rejection.</cite>
- **2000 × 2000 is the zoom-ready size.** <cite index="43-1">Flipkart's public spec is a square 1:1 canvas, minimum 850×850, with 2000×2000 recommended for the zoom feature on the product detail page.</cite>
- **The failure mode is knowing the rule and not meeting it.** <cite index="43-1">Flipkart's seller documentation is gated behind a login, so most Indian sellers learn the bar through trial-and-error rejection.</cite>

**The lesson to take is not the numbers — we already have them.** It is that the marketplaces enforce composition with a *tool*, not a guideline: the seller uploads whatever they have, sees a live square preview, nudges the framing, and exports. <cite index="43-1">The typical flow is: start with whatever you have — a phone photo on a dining table or a studio shot — the tool cuts out the subject and drops it onto a spec canvas, and you preview the 1:1 crop and nudge the centering before export.</cite>

That is what is missing here, and it is what this brief asks for.

**One adaptation:** the marketplaces mandate pure white. Foot Vault's card surface is `#EEF1F5` and the pipeline already pads with it. Keep our colour — matching the card is what makes a padded image invisible at the seam — but adopt everything else.

---

## Standing rules

**Audit first.** Report what exists — the upload panel, the pipeline, `normaliseUpload`, `original_path`, the reprocessor — and what has to change, before writing feature code.

**Skills.** Load and use `impeccable`, `taste` and `emilkowalski` before any UI work. This is a tool the owner will use dozens of times in a sitting; the interaction quality is the feature.

**Merge policy** unchanged. This touches no money, no auth, no payments — so it may merge on green gates, with `audit:build-smoke` first and verification by alias rather than a 200.

**Every owner-facing control needs an operate-and-assert test.** Find it on screen, use it, assert the result changed. The whole point of this feature is that a human operates it.

**Business numbers stay the owner's.** The target fill percentage is a decision — build it as a setting with 85% as the suggested default, and say where the number comes from.

---

## What to build

### 1 · A crop step between choosing a file and committing it

The current flow is choose → preview → describe → commit. The new one is **choose → frame → describe → commit**.

- A square crop frame over the source image, showing exactly what the pipeline will receive.
- **Pinch and drag on touch, scroll and drag on desktop.** The owner will do this on a tablet standing in the shop.
- The frame is fixed square; the image moves and scales inside it. Never let the owner produce a non-square result — that decision is already made.
- **A fill guide**: a subtle inset rectangle at the target percentage, so "fill this much of the frame" is something you can see rather than something you have to judge.
- **Live fill readout** — "the shoe fills 78% of the frame" — with a nudge below target. Not a blocker; a hint that teaches the rule.

### 2 · Auto-frame, because most uploads need the same thing

Detect the shoe's bounding box against its background and propose a crop that puts it at the target fill, centred. The owner adjusts from there rather than starting from nothing.

This is where most of the value sits. A dozen products means a dozen crops, and if each starts correct, the tool costs seconds rather than minutes.

Use `sharp`'s trim/threshold capability server-side rather than adding a computer-vision dependency. It works on the case this shop actually has — a shoe on a plain background — and degrades to a centred default when the background is busy. **Say plainly in the report what it fails on**, rather than implying it always works.

### 3 · Adjustments, but only the ones that earn their place

Two, and no more:

- **Straighten** — a small rotation slider, ±15°, for the handheld shot that sits at a slight angle.
- **Brightness / contrast**, one control each, conservative range.

**Explicitly not building:** filters, saturation, colour temperature, background removal, blemish tools. A shopkeeper needs a photograph that is square, well-framed and not too dark. Everything beyond that is a photo editor, and a photo editor is a different product.

Colour accuracy matters more than looking good — a customer who receives a shoe that doesn't match the picture is a "not as described" claim, and this shop's policy is replacement-only.

### 4 · Consistency across the set, which is the real goal

One well-framed image is not the point; thirty consistent ones are.

- **Remember the last crop's settings** as the starting point for the next upload in a session. Photographed on the same table at the same distance, the same crop is usually right.
- **A contact sheet** on the product images screen: every image in the catalogue at card size, so the odd one out is visible at a glance rather than found by browsing.
- **Re-crop an existing image** without re-uploading, using `original_path`. The original is retained precisely so this is possible, and it means a framing decision is never permanent.

### 5 · The pipeline stays where it is

The crop step produces a square source; the existing pipeline still does orientation, padding, WebP, four widths, content-hashed paths. **Do not duplicate any of that in the browser.** The crop is a transform recorded and applied server-side, so it is reproducible and so a `PIPELINE_VERSION` bump can rebuild from the original.

Store the crop parameters — offset, scale, rotation, adjustments — on the image row alongside `original_path`. That is what makes re-crop possible and what makes the whole thing idempotent.

---

## Gates

- Upload a deliberately awkward source — portrait, off-centre, EXIF-rotated, dim — frame it through the real panel, and assert the stored derivative is square, correctly oriented, and at the intended fill.
- Auto-frame proposes a crop within a stated tolerance of the target on a plain-background fixture, and falls back sanely on a busy one.
- Re-crop from `original_path` produces a different derivative from the same original, and re-running the same crop is byte-identical.
- Every control operate-and-asserted by visible label, on a production build.
- Screenshot the panel at 390, 768, 1024 and 1440 — **the last defect in this area was a mispositioned button that every predicate passed and a screenshot caught.**
- `audit:reachability` green.

---

## The decision for the owner

**Target fill percentage.** 85% is what Amazon and Flipkart both use, and it is the suggested default. Build it as a setting so it can be tuned once there are real photographs to look at — a shoe is a wide, low subject and may sit better slightly under the figure a marketplace picked for boxes and bottles.

---

## Done when

The owner can photograph a pair of shoes on a table, upload the picture, see it snap to a sensible square crop, nudge it if they want, and get a catalogue image that sits beside the other thirty-four as though all thirty-five were shot the same afternoon — without knowing what 85% means, and without leaving the tablet.
