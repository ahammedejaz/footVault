# C5 · the hero fixes, applied — and the one the options list did not price

Follow-up to [phase-10-c4-live.md](phase-10-c4-live.md), which found two visual
defects on the live hero and presented the remedies without choosing. The owner
chose: **A** for the upscale, **scrim 3**, and a real frame for the poster.

This records applying them, the measurements that replaced §5's estimates now
that ffmpeg exists on this machine, and one thing the options list got wrong —
scrim 3 could not be had at the price it was quoted at.

---

## 1 · What changed

| | |
|---|---|
| `src/components/storefront/home-sections.tsx` | the media band is capped at 1600px above `md`; the desktop scrim is rewritten and terminated; the hero paragraph moves from `--muted-foreground` to paper |
| staging `homepage_sections` | `poster_url` → a real frame-zero still, replacing `/seed/hero-desktop.svg` |
| [phase-10-c4-live.md](phase-10-c4-live.md) §5 | the 1080p and 1440p figures are measurements now, not estimates |
| production `homepage_sections` | **not changed — blocked, and it is an owner action.** See §7 |
| *second round* | the loop starts on a shoe, the audio is gone, the watermark is painted out, and the band edges dissolve. See §8 |

`npm run audit:hero-media` is **23/23**, from 19/23.

---

## 2 · The encodes, measured

The owner's standing note on §5 was that a number recorded as an estimate should
become a measurement once it can be one. ffmpeg arrived, so it did.

### The method, because "measured" is not self-evidently meaningful

Encoding the same footage at a bigger frame size proves nothing on its own — the
answer moves with whatever CRF or bitrate is picked. So the encoder was
**calibrated against the source itself first**: find the CRF at which a *native*
1280×720 re-encode reproduces the source file's own video-stream size, then hold
that CRF and change only the resolution.

x264, `-preset slow`, `yuv420p`, `+faststart`, no audio:

| CRF | bytes at 720p |
|---|---|
| 18 | **2,506,220** ← the source's video stream is 2,513,555. 0.3% under |
| 19 | 2,234,687 |
| 20 | 1,972,903 |
| 21 | 1,726,591 |
| 22 | 1,505,371 |
| 23 | 1,300,096 |

CRF 18 it is. The whole ladder at that setting:

| | bytes | | video bitrate |
|---|---|---|---|
| 640×360 | 811,832 | 0.77MB | 649 kbps |
| 960×540 | 1,574,211 | 1.50MB | 1,259 kbps |
| 1280×720 | 2,506,220 | 2.39MB | 2,004 kbps |
| **1920×1080** | **5,135,257** | **4.90MB** | 4,106 kbps |
| **2560×1440** | **7,465,192** | **7.12MB** | 5,969 kbps |

### The caveat, and why it does not move the answer

The only source available is the delivered 1280×720 file. Encoding it at 1080p
means encoding an *upscale*, which carries no detail above 720p — so in
principle these are a floor, and a true 1080p master of the same scene would
cost more.

That worry is testable without a master. The 360p and 540p rungs are genuine
downscales: real content at those resolutions, with real detail. Fitting
size ∝ pixels^k across 360→540→720 gives **k = 0.813** — this footage's own
rate-resolution curve, measured on detail-bearing frames. Extrapolating that
curve upward predicts:

| | from the measured curve | actually measured | difference |
|---|---|---|---|
| 1080p | 4.62MB | 4.90MB | measured is 6.0% **higher** |
| 1440p | 7.38MB | 7.12MB | measured is 3.5% lower |

The two methods agree inside 6%, and at 1080p the upscaled encode came out
*larger* than the curve predicts rather than smaller — lanczos ringing costs
bits that detail would have. The floor-not-a-measurement worry is real in
general and immaterial here.

### What it changes

**Nothing, which is the useful result.** The owner's condition was "if 1080p
turns out to be well under 4MB, that changes the picture next time." It is
**4.90MB** — over the panel's 4MB warning, exactly where the estimate put it.
Option A remains the right call and would remain it next time on this footage.

The 1440p estimate was the one that was wrong: 7.5–10MB predicted, **7.12MB**
measured. It sits inside the bucket's 10MB hard limit rather than at or past it.
Still 2.8× the current file's weight for a monitor problem.

### Found on the way: 174KB of audio nobody can hear

The live file carries an AAC track. The hero is `muted`, `aria-hidden`, and has
no control that could unmute it. Stream-copying the track out — no re-encode, no
visible change — takes it from 2,687,542 to **2,513,555 bytes**. 6.5% of the
hero's weight, free, and it applies to whatever is uploaded next too.

---

## 3 · The scrim, and the thing option 3 could not buy at its quoted price

### The defect, and the one token that fixes it

`to-40%` was inherited unconditionally into the `md` gradient, which added
`md:via-55%` and never overrode the `to` position — computing to
`ink 0%, ink/70 55%, transparent 40%`, a stop behind its predecessor, which CSS
clamps up and draws as a line. **`md:to-100%` is the fix.** All three desktop
positions are now written out even though 0% and 100% are defaults: the defect
*was* an unstated position, and a position nobody writes is a position nobody
can see is wrong.

The turn also moved from 55% to 70%. 55% is where the copy ends at `lg` and
wider; at `md` itself the copy runs to ~70% of the band, so the old gradient was
fully transparent across the last fifth of its own copy column. That never
showed as a contrast failure on this clip — the frame is dark out there — but it
meant coverage depended on the footage rather than on the layout.

### How the scrim was actually measured

Contrast over video cannot be asserted from a stylesheet, so it was measured off
pixels:

1. Every frame of the loop was scanned for the one where the **headline's own
   box** is brightest. That is `t = 2.292s`, a white shoe crossing the copy.
2. The page was screenshotted twice at that paused frame with the scrim removed
   — once with the copy visible, once hidden.
3. The pixels that differ are the glyphs. Dilated 2px, that mask is the
   background a letter is actually read against, fringe included.
4. Candidate gradients were composited over the *hidden* shot inside the mask.

Step 3 is the one that matters. A first pass scored **bounding boxes** and
reported the paragraph failing everywhere — but a box is mostly not text, and
one bright patch in its empty right-hand side counts as a failure no letter is
anywhere near. Under the glyphs the eyebrow reads 8:1 rather than 2.4:1, because
it is short and sits high where the frame is dark. Two different answers from
the same pixels; only one of them is about legibility.

### What the measurement found

At 1440, under the glyphs, mean / 95th percentile:

| desktop gradient | eyebrow #fe9301 | headline #fbfcfd | paragraph #a8b4c6 |
|---|---|---|---|
| **before** — ink → ink/70 @55% → cut | 8.2 / 8.2 ✓ | 14.4 / 11.2 ✓ | 7.5 / 6.3 ✓ |
| ink/55 → ink/45 @70% → 0 | 8.1 / 8.1 ✓ | 7.7 / 5.0 ✓ | **3.6 / 2.8 ✗** |
| ink/62 → ink/52 @70% → 0 | 8.1 / 8.1 ✓ | 8.9 / 6.1 ✓ | **4.2 / 3.4 ✗** |
| ink/70 → ink/60 @70% → 0 | 8.1 / 8.1 ✓ | 10.4 / 7.6 ✓ | 5.0 ✓ / **4.2 ✗** |
| ink/80 → ink/70 @70% → 0 | 8.1 / 8.1 ✓ | 12.6 / 10.0 ✓ | 6.1 / 5.5 ✓ |
| no scrim at all | 7.9 / 7.9 ✓ | **3.0 / 1.6 ✗** | **1.3 / 1.1 ✗** |

Floors: 4.5:1 for the 12px eyebrow and the 16px paragraph, 3:1 for the display
headline.

**The old scrim passed everything.** It was heavy because it was doing real
work, and the hard edge was a separate bug rather than a symptom of the weight.

**The headline is never the problem and the eyebrow never was.** The one
constraint is the paragraph, and the reason is its colour: `--muted-foreground`
on an ink surface is `#a8b4c6`, a token designed for secondary text on a **flat
navy panel**, where it measures against one known colour. Over footage it has no
reserve. The lightest scrim that keeps it at 4.5:1 is ink/80 → ink/70 — which at
its turn is the same 70% ink as before, i.e. not a lighter scrim at all.

So option 3 as written — *much lighter, and keeps a contrast floor* — was not
purchasable while the paragraph stayed muted. **This is what the options list
got wrong**, and it was only findable by measuring pixels rather than reasoning
about gradients.

### What was shipped

Put to the owner with the numbers. Chosen: **the light scrim, and lift the
paragraph.**

```
md:from-ink/55  md:from-0%   md:via-ink/45  md:via-70%   md:to-transparent  md:to-100%
```

and the paragraph moves `text-muted-foreground` → `text-paper`. Roughly 45% of
the ink is gone, the fade is properly terminated, and the hierarchy that the
tone used to carry is carried by size and weight instead — 16px regular under a
40–64px extrabold display line.

Measured on the shipped page, text colours read back out of `getComputedStyle`
so a token change cannot silently invalidate the numbers:

| | eyebrow #fe9301 12px | headline #fbfcfd 40–64px | paragraph #fbfcfd 16px |
|---|---|---|---|
| 768 | 8.0 / 7.9 ✓ | 8.1 / 5.1 ✓ | 7.7 / 5.0 ✓ |
| 1440 | 8.1 / 8.0 ✓ | 7.7 / 5.0 ✓ | 7.1 / 5.7 ✓ |
| 2560 | 8.0 / 8.0 ✓ | 7.2 / 5.0 ✓ | 7.2 / 5.8 ✓ |

Every run clears its floor at mean and at the 95th percentile, on the worst
frame the clip has. It is also the only variant that survives a **brighter**
clip, which was the owner's whole reason for keeping a scrim at all: the video
is editable from `/admin/appearance`, and the scrim is the only thing that can
assert anything about footage that does not exist yet.

**This measurement is not a gate.** It should be — it is the third hero defect
found by a person looking rather than by a predicate. It was not added this
session because the owner asked for `audit:hero-media` at 23/23 and for the
`run-all` registration drift to be left alone, and a new gate is a change to
both. The method above is written out in enough detail to rebuild in an hour.

---

## 4 · The band cap, and the edge it creates

`md:mx-auto md:max-w-[1600px]` on the media band. Below 1600px of viewport it
does nothing whatsoever, which is every phone and every laptop.

| viewport | band | upscale | frame visible |
|---|---|---|---|
| 390 | 390 × 312 | 0.43× | 70% |
| 768 | 768 × 544 | 0.76× | 79% |
| 1440 | 1440 × 560 | 1.13× | 69% |
| 2560 | **1600 × 560** | **1.25×** (was 2.00×) | **62%** (was 39%) |

1600 is not a round number picked for looks: on a 1280-wide source it is exactly
1.25×, which is exactly the ceiling `audit:hero-media` enforces. It is therefore
**the widest band the quality rule permits** — the smallest possible composition
change that satisfies the constraint. Upload a video narrower than 1280 and the
gate fails and names it, which is the behaviour wanted.

### The new boundary, measured

Capping the band means the hero is framed rather than full-bleed above 1600px,
and a framed image has edges. How visible, at 2560, measured across the loop as
the contrast step from band to ink margin:

| frame | left edge | right edge |
|---|---|---|
| t = 1.90s | 1.00:1 | 1.02:1 |
| t = 2.29s | 1.00:1 | 1.17:1 |
| **t = 2.46s** | **2.07:1** | **7.74:1** |
| t = 3.40s | 1.00:1 | 1.03:1 |

For most of the loop the boundary is invisible — the clip's own edges are near
`#0a1526`, which is the ink margin. At t=2.46s a white shoe reaches the right
edge and the frame line is plainly there at 7.74:1.

That is the image ending, not a gradient artefact, and it is what the owner
priced when they wrote that ink margins on ultrawide read as deliberate framing.
Recorded because it is a *new* visible vertical line at 2560 introduced by
fixing a different visible vertical line at 2560, and that is worth saying out
loud rather than discovering later.

---

## 5 · The 22.58s LCP outlier did not recur

Eleven runs against `https://www.footvault.in/`, mobile emulation,
`--throttling-method=devtools` — the same method that produced the outlier.

| run | LCP | CLS | TBT | perf | bytes |
|---|---|---|---|---|---|
| 1 | 3.22s | 0.000 | 26ms | 84 | 2709KB |
| 2 | 2.65s | 0.000 | 27ms | 91 | 2707KB |
| 3 | 2.68s | 0.000 | 43ms | 90 | 2711KB |
| 4 | 2.70s | 0.000 | 66ms | 90 | 2721KB |
| 5 | 2.64s | 0.000 | 31ms | 91 | 2709KB |
| 6 | 2.67s | 0.000 | 49ms | 90 | 2717KB |
| 7 | 2.70s | 0.000 | 86ms | 90 | 2715KB |
| 8 | 2.64s | 0.000 | 46ms | 91 | 2720KB |
| 9 | 2.66s | 0.000 | 37ms | 90 | 2712KB |
| 10 | 2.70s | 0.000 | 62ms | 90 | 2721KB |
| 11 | 2.64s | 0.000 | 52ms | 91 | 2712KB |

Median **2.67s**, range 2.64–3.22s. The 3.22s is run 1 and it is a cold start,
not a tail — every subsequent run sits in a 60ms band.

**No second sighting.** One 22.58s sample now stands against 27 clean ones
across three passes. On the owner's own rule — one in eleven with a clean second
pass is transient, a second sighting is a pathology — this is transient, and the
note in [phase-10-c4-live.md](phase-10-c4-live.md) §2 has been updated to say so.

It stays in the record rather than being deleted. A 22-second sample that
happened once is still a thing that happened once.

---

## 6 · The poster is frame zero, exactly

### That it is frame zero is proved, not assumed

Three independent extractions, hashed:

| route | sha256 |
|---|---|
| `select=eq(n\,0)` | `8f8d49b9…a737` |
| first of a `select=lt(n\,3)` run | `8f8d49b9…a737` |
| no filter at all, `-frames:v 1` | `8f8d49b9…a737` |
| frame 1, for contrast | `016d4288…4e26` |
| frame 2, for contrast | `a537763b…cb34` |

All three routes agree and neither neighbour matches, so the still is the frame
the video starts on and the fade has nothing to jump across. 1280×720 PNG,
lossless, 95,822 bytes — small because the frame is nearly empty, which is the
next point.

### What frame zero actually is, and what that costs

**It is an empty room.** The clip is a sequence of shoes arriving over a dark
studio floor, and at frame 0 no shoe has arrived yet — mean luma 41/255, peak
pixel 58/255, tread marks on the floor and nothing else.

Three consequences, none of which change the decision but all of which follow
from it:

- It is now the **LCP element** on the busiest page on the site. LCP does not
  care what the picture is of, so the number is unaffected — but the thing a
  customer sees at first paint is a dark empty floor.
- A visitor with **`prefers-reduced-motion`** or **Save-Data** never sees
  anything else. `HeroVideo` returns `null` before a byte is requested, by
  design, so for them the empty room is the entire hero rather than the first
  200ms of it.
- The old fallback — the drawn `/seed/hero-desktop.svg` — at least showed a
  shoe.

This is inherent to "poster = frame 0": any frame that shows a shoe is a frame
the video does not start on, and it will visibly jump. The two properties cannot
both be had **from this clip**. They can be had from a different cut — rotating
the loop so it starts on a shoe costs one command and no bytes:

```
ffmpeg -i site-video-hero.mp4 -filter_complex \
  "[0:v]trim=start=1.667,setpts=PTS-STARTPTS[a]; \
   [0:v]trim=end=1.667,setpts=PTS-STARTPTS[b]; [a][b]concat=n=2:v=1[v]" \
  -map "[v]" -an -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p \
  -movflags +faststart hero-rotated.mp4
```

> **Done in the second round.** The owner's call: an empty floor is not a hero.
> The loop now starts on a shoe and the poster is frame zero of *that* file.
> See §8.

### Also visible, once you look at a still of it

Every frame of the clip carries a small four-pointed sparkle at the bottom
right — the generative-video watermark. It has always been on the live homepage;
it is only worth a line here because a poster turns it into a static image that
sits on screen before playback and stays there for reduced-motion visitors.

> **Removed in the second round**, at the owner's instruction. What it was, why
> it was painted out rather than cropped, and what provenance survives: §8.

### Where it is set

Staging: `product-images/site/hero-poster-83c00e16.png`, served 200,
95,822 bytes, `image/png`, and `poster_url` now points at it.

Production: **not set — the write was refused by the safety classifier**, which
is the same behaviour recorded for production DDL. It is an owner action; see §7.

---

## 7 · Owner actions

**1 · The production video and poster, together.** The classifier denied a
script doing this; the panel is the better route anyway, because its Server
Actions call `updateTag` and the change is live at once instead of waiting out
the one-hour `revalidate`. Both files are in `site-video-hero/`.

1. `/admin/appearance` → hero → the video uploader → `site-video-hero-v2.mp4`.
   Uploading through the panel is what sets `cacheControl: 31536000` on the
   object; the dashboard would not.
2. `/admin/media` → upload `hero-poster-frame0.png`.
3. Back on `/admin/appearance` → paste that image's URL into **The video's still
   frame** → Save.

**Both, or neither.** The poster is frame zero *of the new file*. Pairing it
with the old video puts an Air Force still over a clip that starts on an empty
floor, which is a worse jump than the one the poster exists to remove — and
pairing the old poster with the new video leaves the placeholder-to-photography
jump in place. Until both land, the live hero keeps the `/seed/hero-desktop.svg`
fallback, the hard scrim edge, the 2.00× upscale and the watermark.

**2 · The code has not been deployed.** The band cap, the scrim and the
paragraph colour are in the working tree and verified against a production build
on staging. Production still serves the hard edge and the 2.00× upscale.

---

## Verification

| | |
|---|---|
| `npm run audit:hero-media` | **23/23**, against `build:stage` + `start:stage`, from 19/23 |
| 2560 by eye | hard edge gone; band 1600×560 centred with ink margins; shoe sharp. Confirmed at an arbitrary frame **and** at the loop's brightest frame, not only by predicate |
| Contrast, shipped page | 9 measurements (3 runs × 3 widths), all clear at mean and p95, worst frame of the clip, colours read from `getComputedStyle` |
| Frame zero | 3 extraction routes agree by sha256; frames 1 and 2 differ |
| Encodes | CRF calibrated to within 0.3% of the source's own video stream; cross-checked against a rate-resolution curve fitted to genuine downscales, agreeing within 6% |
| Live LCP | 11 runs, median 2.67s, no outlier |
| Band edge | measured across 4 frames; 1.00–1.17:1 for most of the loop, 7.74:1 at its brightest |
| Rotation | frame identity proved by PSNR — 47.8 dB against the intended frame, 19.2 dB against its neighbour; loop seam 46.9 dB |
| Watermark | fixed position proved by a 128-frame temporal mean; the same mean on the new file is clean; 72 c2pa/jumbf hits before, 0 after |
| Band edge | 7.74:1 → 1.32:1 at the loop's brightest frame; fade width read off `getComputedStyle` at ten viewports, 0px at and below the cap |
| Audio | 0 audio streams in the shipped file; 173,987 bytes of the 192,099 saved |
| `tsc --noEmit` · `eslint .` | **clean, exit 0 both**, read directly, run as the last thing after every edit |

---

## 8 · Second round — a hero that is a shoe, and edges that dissolve

Three instructions after the first round landed, plus one that arrived while it
was being carried out.

| | |
|---|---|
| the loop | rotated to start on a shoe; frame zero re-extracted from the rotated file |
| the audio | stripped |
| the band edges | dissolved into the ink instead of stopping at a line |
| the watermark | painted out of every frame *(added mid-round)* |

`site-video-hero-v2.mp4`, **2,495,443 bytes** against the original's 2,687,542 —
192,099 fewer, 7.1%. Of that, 173,987 is the audio track and 18,112 is the video
stream coming back marginally smaller at the calibrated CRF.

### 8a · Where the loop now starts, and why there

The clip is four shoes crossing right-to-left with near-empty gaps between them,
so **every** rotation point is seam-continuous: rotating to frame *N* makes the
new loop join *N-1 → N*, a pair that was already adjacent. The original 239 → 0
join simply becomes an internal moment, and it was itself a gap-to-gap cut.

Choosing *N* was a measurement rather than a preference. For all 240 frames, the
mean luma of the copy column (left 52%, and only the rows the desktop band
actually shows) against the mean of the subject side:

| frame | copy column | subject side | separation |
|---|---|---|---|
| 65 | 49.7 | 97.3 | 47.6 |
| 67 | 49.1 | 92.5 | 43.4 |
| **68** | **51.6** | **89.5** | **37.9** |
| 70 | 56.8 | 83.8 | 27.0 |
| 84 | 69.3 | 96.2 | 26.9 |

65 and 67 score higher but still carry a sliver of the *previous* shoe at the
left edge, directly under where the headline begins. **Frame 68** is the first
frame where that has cleared, the Air Force is whole and sharp, and the copy
column is still dark. `t = 2.8333s`.

That it is frame 68 and not near-enough is proved rather than assumed:

| comparison | PSNR |
|---|---|
| new frame 0 vs source frame 68 | **47.8 dB** — the same frame, re-encoded |
| new frame 0 vs source frame 69 (control) | 19.2 dB |
| new frame 239 vs source frame 67 (the loop seam) | 46.9 dB |

`trim=start_frame=`, not `-ss`: a time seek lands on the nearest decodable point,
and this file has **exactly two keyframes** — 0 and 189 — so a seek would have
missed by up to seven seconds. Two keyframes is also why the rotation had to
re-encode rather than stream-copy.

Frame zero of the shipped file is proved by the same three routes as before —
`select=eq(n,0)`, the first of a `select=lt(n,3)` run, and no filter at all —
all hashing to `6ae0965d…9fa0`, with frame 1 differing.

### 8b · The watermark: what it is, and what is left of it

The container answers the question the owner asked. `encoder=Google`, and the
file carries an embedded **C2PA manifest** — `urn:c2pa:d0128914-…`, signed by
"Google C2PA Media Services", "Google Media Processing Services". This is Google
generative video, and the sparkle is Google's generative-AI marker.

**Can it be regenerated without it?** Yes, but it depends on the tier it came
from, and that is a fact about the account rather than about the file: Google's
paid routes — Veo through the Gemini API or Vertex AI, and the top consumer tier
through Flow — return output without the visible sparkle. Consumer/free Gemini
output carries it. Regenerating there is the clean route and costs no pixels; it
is worth checking which tier produced this one, **including its terms**, since
some Google product terms ask that the marker not be removed.

**What was done instead:** painted out in place. `delogo=x=1126:y=565:w=70:h=72`,
in the same pass as the rotation so there is only one generation of loss. The
mark is in a **fixed** position — proved by a 128-frame temporal mean, in which
anything that moves averages away and the sparkle stayed crisp — so one static
box covers all 240 frames. The same mean taken from the new file is clean.

**Why not a crop, which is what was asked to be proposed:**

- **Cropping the right is impossible.** The mark sits at x 1136–1184, so removing
  it from the right means a source narrower than 1280. At 2560 the band is
  1600px, so the upscale is `1600 / width` — anything under 1280 breaks the
  1.25× ceiling `audit:hero-media` enforces. The cap and a right crop are
  mutually exclusive.
- **Cropping the bottom would have worked** — the mark spans y 575–625, so
  1280×565 clears it, and that survives both bands (desktop shows 448 of 565
  rows, mobile scales by height and shows 706 of 1280 columns). But it discards
  22% of the frame, and what it discards is the foreground floor with the tread
  reflection, which is the part of the composition that gives the shoe a place
  to be.
- Painting it out costs none of that, and on a smooth dark gradient it is
  invisible at 1:1. It was checked at 1:1 against three box sizes before one was
  chosen, not only at zoom where every method looks bad.

**What survives, stated plainly:** Google embeds **SynthID**, an imperceptible
in-pixel watermark, in this output. It is designed to survive re-encoding, and a
70×72 patch does not touch it — the clip remains machine-identifiable as
AI-generated. What did *not* survive is the C2PA manifest: `strings` counts 72
c2pa/jumbf hits in the original and **0** in the new file. That is the ordinary
consequence of any re-encode rather than a goal, but it is a provenance record
that existed and now does not, so it is written down.

### 8c · The band edges dissolve now

`.hero-band-edge` in `globals.css` — two edge-anchored `linear-gradient` layers,
ink to transparent, sized by:

```css
--hero-band-fade: clamp(0px, (100vw - 1600px) / 2, 3.5rem);
```

That expression **is** the margin beside the band, capped at 56px, which makes
the whole thing self-cancelling rather than gated on a guessed breakpoint. Read
straight off `getComputedStyle`:

| viewport | band | margin/side | fade painted |
|---|---|---|---|
| 390 / 768 / 1280 / 1440 | full-bleed | 0px | **0px — nothing paints** |
| 1599 | 1599px | 0px | 0px |
| 1600 | 1600px | 0px | 0px |
| 1620 | 1600px | 10px | 10px |
| 1712 | 1600px | 56px | 56px |
| 1920 / 2560 | 1600px | 160 / 480px | 56px |

No vignette on any phone or laptop, because below the cap there is no edge to
soften; no step to cross while resizing, because the fade starts at zero exactly
where the margin does. Two layers rather than one four-stop gradient so that no
colour-stop position has to be written at all — this file should not be
re-introducing the class of bug §3 exists to catch.

The measured result, at 2560, as the contrast step across each edge:

| frame | left edge before | left after | right edge before | right after |
|---|---|---|---|---|
| loop's brightest | 2.07:1 | **1.08:1** | **7.74:1** | **1.32:1** |
| worst copy frame | 1.00:1 | 1.00:1 | 1.17:1 | 1.04:1 |
| t=1.0s, t=5.0s | 1.00:1 | 1.00:1 | 1.02–1.03:1 | 1.00:1 |

The 7.74:1 line is gone. 1.32:1 is what a 56px ramp reads as when sampled either
side of its midpoint — a gradient, not an edge.

### 8d · Re-verified

The video changed, so every measurement anchored to a timestamp was re-taken
rather than carried over. The rotation moved the worst frame by 172 frames
exactly as arithmetic says it should — the headline's brightest box went from
frame 55 to frame 227 with the identical luma of 127.5 — which is itself a check
that the rotation did what it claimed.

Contrast under the glyphs, on the new file's worst frame (t=9.458s):

| | eyebrow #fe9301 | headline #fbfcfd | paragraph #fbfcfd |
|---|---|---|---|
| 768 | 8.0 / 7.9 ✓ | 8.0 / 5.0 ✓ | 7.0 / 5.0 ✓ |
| 1440 | 8.1 / 8.0 ✓ | 8.4 / 5.2 ✓ | 6.7 / 5.3 ✓ |
| 2560 | 8.0 / 8.0 ✓ | 7.7 / 5.1 ✓ | 6.9 / 5.5 ✓ |

`npm run audit:hero-media` — **23/23**, unchanged. 2560 still reports
`1280x720 → 1600x560  1.25x  62% of frame visible`.

