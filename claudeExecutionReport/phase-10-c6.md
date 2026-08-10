# C6 · a switch, a swap nobody sees, and a control that gets out of the way

Follow-up to [phase-10-c5.md](phase-10-c5.md). Three changes to the hero, and
one of them turned out to be a change to something else.

---

## 1 · The hero can be a still, on purpose

`media_mode` on the hero payload, `video` or `poster`, chosen from
`/admin/appearance` directly beneath the two fields it arbitrates between.

**Absent means `video`.** That is load-bearing rather than tidy: every hero
written before this field exists has no `media_mode`, and each one must keep
playing its clip. A default of `poster` would have silently stopped every
existing video hero the moment this shipped.

### The implementation is one line, and that is the point

```ts
const posterOnly = payloadString(section.payload, "media_mode") === "poster";
const video = posterOnly ? null : payloadString(section.payload, "video_url");
```

Nothing downstream is conditional. `<HeroVideo>` is never constructed, so no
`<video>` element exists and no byte of the file is requested — the identical
path a customer already gets under `prefers-reduced-motion` or `Save-Data`,
which `audit:hero-media` has asserted creates no element and fetches nothing
since the day it was written. The owner's switch **inherits that proof** instead
of needing a parallel one.

The other way to write this was to hide a playing video with CSS. It would have
downloaded 2.5MB to show nobody.

### Measured, at the same four widths as the video path

| | 390 | 768 | 1440 | 2560 |
|---|---|---|---|---|
| `<video>` element created | none | none | none | none |
| pause control rendered | none | none | none | none |
| video bytes requested | **0** | **0** | **0** | **0** |
| poster decoded and is the hero | ✓ | ✓ | ✓ | ✓ |

The served HTML contains neither `<video` nor the string `site-video` at all.

### The control has a test that operates it

`audit:appearance` §6, five new checks. It finds each mode **by its visible
name** (`getByRole("radio", { name })`, which resolves through the accessible
name), selects it, publishes, and asserts the stored `media_mode` changed — the
rule `audit:settings-controls` was written to enforce after a delivery selector
and a Pay-on-Delivery switch sat unfound on a page for two phases.

Then one step further, because a stored value is not a feature: it re-fetches
the live homepage and asserts there is no `<video>` in it. Asserting the payload
alone would pass in a world where the renderer ignored the field entirely.

**23 passed, 0 failed**, axe included.

> **But `audit:appearance` is not in `npm run audit`.** It is one of the eight
> scripts in neither `GATES` nor `EXCLUDED` — the drift left alone by
> instruction. So this control's test exists, passes, and does not run in the
> suite. Registering it is a one-line change whenever the drift is picked up.

### One trap worth writing down

Flipping `media_mode` directly in the database **did not change the page**, and
the reason was not the code. `homepage_sections` is read through `use cache`
tagged `catalog`; the panel's `publishHomepage` calls `updateTag`, a raw SQL
write calls nothing, and **`next build` deliberately preserves `.next/cache`**.
The old payload kept rendering through a rebuild and a restart. `rm -rf .next`
was what actually cleared it.

This never bites an owner — they change it in the panel, which busts the tag —
but it will bite the next person who edits a payload by hand and concludes the
feature is broken.

### What poster mode means, said plainly

**The still becomes the entire hero, permanently, for everyone.** Not a first
paint, not a fallback: the whole thing. It should therefore be a *designed
image* — one composed for a headline to sit on the left of it — and not a frame
grabbed from a clip. The frame-zero still that ships today is a good handoff
image and a mediocre poster: it was chosen for continuity with the video's first
frame, which is a different job. The editor's own hint now says this.

---

## 2 · The swap: what was removed, and what was proved

The poster stays exactly where it was — server-rendered, `priority`, the LCP
element, first paint. What changed is that the fade is gone.

### The fade was wrong, and only recently

```
- "transition-opacity duration-700 ease-[cubic-bezier(0.4,0,0.2,1)]",
```

`playing` fires with the video at frame zero, and since C5 the still underneath
**is** frame zero. A 700ms fade therefore cross-dissolved a *static* frame zero
against a video that was already moving: for 700ms the hero showed the same shoe
in two places at partial opacity. A ghost. It was the right call when the poster
was unrelated placeholder art and the wrong one the moment the poster became a
real frame.

The reveal still hangs off `playing` rather than `loadeddata`, so the structural
fallback is untouched: the success path remains the only thing that reveals the
video, and a clip that never starts leaves the still exactly where it was.

### Proof 1 — the two images either side of the swap

The video paused at `currentTime = 0`, the hero screenshotted with it showing
and with it removed, and the two differenced. Everything is in that comparison:
the decoder's YUV→RGB conversion, the video scaler, next/image's re-encode of
the poster, and whichever srcset candidate the browser chose.

| viewport | mean abs difference | worst channel | channels differing by >16 |
|---|---|---|---|
| 390 | 1.41 / 255 | 92 | 0.835% |
| 768 | 0.81 / 255 | 32 | 0.023% |
| 1440 | 0.62 / 255 | 17 | 0.000% |
| 2560 | 0.62 / 255 | 14 | 0.000% |

**No tonal or colour shift at any width.** Amplified 14×, the residual is
visible only as thin outlines around the shoe's contours — the signature of two
different resampling paths, not of a colour-space or brightness mismatch, which
would have shown as a uniform glow across the whole frame.

The 390 figure is the largest and it is explained: on a phone the browser picks
a 640px-wide optimised candidate for the poster while the video is scaled to the
same box from its full 1280. Two different downscales of the same frame differ
on fine texture. **Not chased**, and deliberately: the only levers are serving a
bigger candidate or an unoptimised PNG, both of which spend mobile bytes on the
LCP image, which is the thing this entire design exists to protect.

### Proof 2 — the moment itself, which a still comparison cannot see

A steady-state diff cannot rule out a single black frame while the decoder warms
up. So the page was recorded, and every recorded frame differenced against the
one before it. A marker parked at the bottom of the viewport — far outside the
band being measured — flips white on `playing`, which timestamps the reveal in
the recording rather than leaving it to be guessed.

| | frame-to-frame change in the hero band |
|---|---|
| the reveal frame itself | **6.65** |
| ordinary playback, mean | 3.03 |
| ordinary playback, largest | **10.38** |
| the page's own first paint | 201.35 |

**The takeover is smaller than the largest ordinary frame of playback.** There is
no flash, no step and no fade — the only spike anywhere in 388 recorded frames
is the page painting for the first time.

### The consequence to know about

"The poster is a frame of this video" is now **load-bearing**. It always was —
the field's hint says so — but a 700ms fade used to soften a mismatched poster,
and nothing does now. Change the video without changing the poster and the hero
will visibly cut.

### A measurement trap, recorded so it is not re-discovered

`img.naturalWidth` on these posters reads 960 at 1440 and 853 at 2560, which
looks like the poster being upscaled 1.88× into the band — the very defect C5
spent its time removing. It is not. When an image is chosen from a `srcset` with
`w` descriptors, the HTML spec corrects its intrinsic dimensions by the current
pixel density, and `1280 ÷ (3840/2560) = 853`. Asking the optimiser directly
settles it: `w=1920` and `w=3840` both return **1280×720**, the source's full
resolution. `naturalWidth` is not a resolution check and must not be read as one.

---

## 3 · The pause control, as quiet as AA allows

### What changed

The 44px target did not. The paint did: the button now carries none of its own,
and the visible mark is a 32px disc holding a 14px glyph.

| | before | after |
|---|---|---|
| target | 44px | **44px, unchanged** |
| visible disc | 44px, `bg-ink/55` | 32px, `bg-ink/70` |
| icon | 16px, `text-paper` | 14px, `text-paper/60` |
| focus | `focus-visible:outline-none` + a paper ring | the site's composite indicator |

Keeping 44 rather than dropping to SC 2.5.8's 24px minimum: the project's own
floor is 44, a touch user has no hover to reveal anything, and shrinking the
target is not what "quieter" asked for. The button paints nothing itself now, so
44px costs nothing visually.

### Why 70/60 and not something dimmer

SC 1.4.11 wants 3:1 for the visual information identifying a control, and the
binding ratio is the icon against the disc it sits on. Measured across the
corner the control occupies — which on this clip never rises above luma 54/255
across the whole loop:

| behind the control | icon vs disc |
|---|---|
| this clip's corner | 6.77:1 |
| its brightest pixel | 5.96:1 |
| a mid-bright clip | 5.03:1 |
| **a pure white clip** | **3.57:1** |

The last row is why the disc is opaque rather than the icon bright. A more
opaque disc costs nothing in quietness — ink over a dark corner is still dark,
and the disc measures **1.16:1** against the footage behind it, so as a *shape*
it is invisible — but it is what fixes the icon's background against a clip that
does not exist yet. Thinning the icon instead would have failed the first time
somebody uploaded daylight footage. That is the same argument the scrim settled
in C5, and the same reason: the video is owner-editable.

### The focus indicator, which was a bug

The old button carried `focus-visible:outline-none`. That utility lives in
`@layer utilities`, beats the composite indicator `@layer base` defines, and
deletes the orange half of it for the component that uses it — **precisely what
`audit:focus-ring` was written to catch.** Removing it took that gate from two
failures to one; the remaining one is unrelated and pre-existing (§4).

So keyboard focus now draws the site's real indicator: a 2px orange outline on a
4px navy halo, at full strength. That is the "comes forward on focus" half of
the brief, and it was free.

### What it costs, stated rather than glossed

A sighted mouse user who wants the motion to stop has to look harder than
before. The mitigations are real but they are mitigations: the control sits
where controls sit (bottom-right of the media), the target is a full 44px, it
goes to full contrast on hover, and the keyboard path is unchanged. And the
glyph never drops below 3.57:1 against anything, on any clip — this is quieter,
not hidden.

---

## 4 · Gates

**`audit:hero-media` — 23/23**, video mode, against a production build.
2560 still reports `1280x720 → 1600x560  1.25x  62% of frame visible`.

**`audit:appearance` — 23/23**, including the five new switch checks.

**`npm run audit` — 33/39 green.** Six red, and **all six are pre-existing**.
That is asserted rather than assumed: the changes were stashed, the tree rebuilt
at the base commit, and the same six re-run.

| gate | failure | at base |
|---|---|---|
| `audit:fixtures-guard` | `inbound-email.ts`, 35/36 | identical |
| `audit:overflow` | 12 findings, every one `HTTP 200, expected 404` on fake order routes | identical |
| `audit:focus` | `/search` input never focused in 150 tab stops | identical, **plus a second failure this change fixed** |
| `audit:bag` | the coupon field is present and plainly not live | identical |
| `audit:signedin` | move-to-bag is offered | identical |
| `audit:admin` | ledger reconciliation, 1 drifting variant | identical |

None is in the hero, the editor or anything this change touches. `audit:overflow`
found no overflow at any of six widths across 9,227 measured elements — its
findings are all routing.

**`tsc --noEmit` · `eslint .` — clean, exit 0 both**, run last. Lint caught one
real thing on the way: the new gate dropped a Supabase `error`, which would have
rendered a failed read as "the field is absent" — indistinguishable from "the
switch did nothing", the exact result that section exists to tell apart.

### Screenshots

Written locally, and `screenshots/` is gitignored — so these are artefacts of
the run rather than of the repository:

- `screenshots/hero-video-mode/` — 390, 768, 1440, 2560, plus reduced-motion
- `screenshots/hero-poster-mode/` — the same four widths
