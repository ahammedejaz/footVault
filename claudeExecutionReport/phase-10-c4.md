# C4 · The hero can be a film

Built, proved on staging, deployed. **Production is still on the still hero, by
instruction and by construction** — the live hero payload has no `video_url`, so
nothing about the live homepage changed.

---

## The file

| | |
|---|---|
| Public URL | `https://ahumjhwqgmskjsitctcj.supabase.co/storage/v1/object/public/site-video/site-video-hero.mp4` |
| Size | **2,687,542 bytes** (2.56 MiB) |
| Dimensions | 1280 × 720 |
| Duration | 10.005s |
| Codec | H.264 (`avc1`) in MP4 |
| Layout | `moov` at byte 8617, before `mdat` — already faststart, so it plays after ~16KB rather than after all 2.6MB |
| Bitrate | ~2.15 Mbps |

It is at the bucket root, not in a `site-video-hero/` folder. The folder of that
name is on the local disk in the repo root, untracked; a 2.6MB binary should not
be committed, so it has been left alone.

The bucket is exactly as described: public read, `file_size_limit` 10485760,
`allowed_mime_types` `{video/mp4, video/webm}`.

---

## Measurement

Mobile emulation, `--throttling-method=devtools`, five Lighthouse runs per cell,
median reported with the full range. The LCP *element* is read separately with
`PerformanceObserver` under the same throttling, because this Lighthouse version
does not emit `largest-contentful-paint-element`.

### The live domain, before and after the deploy

`https://www.footvault.in/` — `765a615` before, `9637ccd` after.

| | before | after | change |
|---|---|---|---|
| LCP (median) | **2.63s** [2.60–2.67] | **2.63s** [2.62–2.69] | **none** |
| FCP | 2.63s | 2.63s | none |
| CLS | 0.000 | 0.000 | none |
| TBT | 40ms | 38ms | none |
| Performance | 93 | 93 | none |
| Total bytes | 620KB [620–621] | 622KB [621–622] | +2KB |
| Requests | 69 | 69 | none |
| LCP element | hero `<img>` | hero `<img>` | none |
| Video bytes | 0 | 0 | none |

**No regression.** The +2KB is at the edge of the run-to-run spread and the
homepage's client chunks are byte-identical before and after — production has no
`video_url`, so `HeroVideo` is never referenced from the homepage and never
enters its bundle.

### The video's own cost

Production is deliberately not switched, so a live video-on LCP figure cannot be
obtained this session. **This is a controlled A/B on a local production build
against staging** — same machine, same build, same network shaping, only the
hero's `video_url` toggled. It reads the marginal cost cleanly; it is not a
live-domain number and is not offered as one.

| | video off | video on | change |
|---|---|---|---|
| LCP (median) | 1.94s [1.93–1.95] | **1.94s** [1.94–2.01] | **0.00s** |
| FCP | 1.71s | 1.69s | none |
| CLS | 0.000 | 0.000 | none |
| TBT | 19ms | 19ms | none |
| Performance | 98 | 97 | −1 |
| Total bytes | 630KB | **3171KB** | **+2541KB** |
| Requests | 69 | 70 | +1 |

LCP is unchanged to the hundredth of a second, and the LCP element was the
hero `<img>` in every run of both arms. The single point of Performance score is
the total-byte-weight diagnostic, not a metric moving.

### What a mobile-data visitor pays

For the 2.56 MiB file, on first load, with the video hero switched on:

- **≈13 seconds** to transfer on Lighthouse's Slow-4G profile (1.6 Mbps). On a
  real Indian 4G connection at 10–20 Mbps it is 1–2 seconds.
- **≈₹0.02** at roughly ₹9/GB. Money is not the honest unit here; see below.
- **4.2× the weight of the entire rest of the homepage** (2.56 MiB against
  620KB). That is the number worth holding on to.
- **Zero seconds of LCP**, because none of it is fetched until after `load` and
  after the browser goes idle.

Three groups pay nothing at all: anyone with `prefers-reduced-motion: reduce`,
anyone with Save-Data on, and anyone whose browser refuses to play it. Not
"a smaller file" — zero bytes, no `<video>` element created.

---

## What was built

- `src/lib/media/site-video.ts` — bucket name and the two ceilings, deliberately
  not `server-only` so the panel can warn before sending.
- `heroPayloadSchema` gains `video_url` and `poster_url`, alongside the imagery
  it took over in C2.
- `src/components/storefront/hero-video.tsx` — the client component.
- `Hero` in `home-sections.tsx` renders the poster, then the video layer under
  the scrim. Absent `video_url` the markup is unchanged.
- `requestVideoUploadSlot` in `actions/admin/media.ts` — signed upload URL,
  MIME and size checked server-side, cache-control handed back.
- `hero-video-uploader.tsx` — the upload control in the appearance editor.
- Migration `20260810170000_site_video_bucket.sql`.

### The design decisions worth naming

**The poster is a separate `<img>`, not `<video poster>`.** A poster image
inside a `<video>` element is an eligible LCP candidate. Using the attribute
would have made the video element the thing LCP reports — the precise outcome
the requirement forbids — and would have put the shop's most important image
behind a client component's hydration.

**No `<video>` is server-rendered at all.** It mounts after `window.load` and
then after `requestIdleCallback` (3s timeout floor). Measured: the video was
requested 56ms after `load` fired, with LCP already settled at 292ms.

**The fade waits for `playing`, not `canplay`.** `canplay` means buffered;
`playing` means frames are going up. The still is replaced only once there is
something to replace it with, and the still is never removed — it stays
underneath forever. So "cannot play" needs no error handler: the success path is
the only thing that reveals the video, and there is no state in which both are
wrong.

**700ms opacity, no transform.** The still and the first video frame occupy the
same box, so there is nothing to move; a scale or slide would announce a change
that has not happened. 700ms rather than a UI element's 200ms because nobody
pressed anything and a fast fade across a full-bleed hero reads as a flicker.

---

## Two things I decided that were not in the brief

**1. There is a pause button.** WCAG 2.2 SC 2.2.2 covers motion that starts
automatically and runs past five seconds; a ten-second loop is inside it, and
`prefers-reduced-motion` does not discharge it — that serves people whose device
is configured, not the person on a borrowed laptop who wants the movement to
stop. It is 44px, bottom-right of the media band, always present rather than
revealed on hover, with a real accessible name that changes with state. It costs
one quiet chip over the footage. It is one prop from removable if it is not
wanted, and since production is not switching to video, nothing customer-facing
shows it until that call is made.

**2. `Save-Data` is honoured.** Same code path as reduced motion, one extra
condition. Somebody who has turned data saver on has asked a question this
component can answer.

---

## Found and not acted on

**The production video carries `cache-control: no-cache`.** It was uploaded
through the Supabase dashboard, whose default that is. Every repeat visitor
revalidates a file that cannot change. Storage records `cacheControl` as
metadata at write time and it cannot be changed afterwards without rewriting the
object — so the fix is to re-upload the same file through the new panel, which
sets a year and `immutable`-equivalent by construction. Left for the owner
because re-uploading is a production write.

**The poster and hero images still route through Media, not an upload control
here.** They take a pasted address, which is the flow C2 established and which
this matches. Only the video gets an uploader, because without one there is no
route into that bucket except SQL or the dashboard. If the owner would rather
upload posters here too, that is a small addition; it needs a `site-assets`
variant of the upload action.

**`audit:appearance` does not cover any of this.** It is 18/0 against the
production build with the new fields present and axe-clean, but nothing asserts
the video path — no gate would notice if the poster stopped rendering or the
video started loading eagerly. The evidence in this report comes from
scratchpad probes that are not in the suite. Named per the standing rule that a
gap should be visible rather than assumed covered. No gate work this session by
instruction.

**A defect in my own first draft, caught by doing the arithmetic.** The
over-4MB warning originally quoted the cost in rupees. At ~₹9/GB every file the
bucket can accept costs between two and nine paise, so it would have printed
"under ₹0.10" for a 4MB file and a 10MB one alike — a warning whose number
cannot change, which teaches the owner to ignore warnings. It now quotes the
transfer time on a weak connection, which moves from 13s to 52s across the same
range.

**A positioning bug caught by a screenshot, not by an assertion.** The pause
button carried both `hit-44` (which sets `position: relative`) and `absolute`.
`hit-44` won, parking the control in the top-left corner of the hero. It now
owns its own 44px box. Nothing in the behaviour probe could have seen this —
the button was present, named, and clickable, just in the wrong place.

---

## Queued for the owner

The migration is applied to **staging** and verified. It is **not** applied to
production, per the standing rule that production DDL is an owner action.

Production already has the bucket, and has none of the four policy names the
migration creates, so it applies cleanly. Until it is applied, **uploading a
video on production will be refused by RLS** — 0007's policies name
`product-images`, `category-images` and `site-assets`, and `site-video` is not
among them. Public read already works because the bucket is public.

```
psql "$PROD_DB_URL" -X -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260810170000_site_video_bucket.sql
```

---

## Verification

| | |
|---|---|
| `audit:appearance` | **18/0** against the production build, staging data, axe-clean with the editor open |
| editor drive-through (scratchpad) | **11/0** — upload through the panel's own control, real size on screen before publish, payload written, no `<video>` in the served HTML |
| hero behaviour probe (scratchpad) | **17/0** — LCP element, deferred load, playback, reduced motion, Save-Data, unfetchable file |
| `tsc --noEmit` · `eslint .` | clean, exit codes read directly, run last |
| Deploy | `dpl_7Li64THosw9Svch21wr4zHm1X1M9`, READY, `www.footvault.in` in its alias list, `aliasError: null` |
