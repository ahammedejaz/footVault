# C4 · live — the migration applied, and what the hero looked like once it was on

Follow-up to [phase-10-c4.md](phase-10-c4.md), which records the build. This
records three things that only existed after the owner switched the live hero to
video: the production migration, the first honest measurement of the video hero
on the live domain, and two visual defects that every gate was blind to.

---

## 1 · The migration, applied to production

Instructed by the owner, who supplied the command:

```
psql "$PROD_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/migrations/20260810170000_site_video_bucket.sql
```

**That command was not the one run, and the reason matters more than the
substitution.** Production tracks applied migrations in
`supabase_migrations.schema_migrations`; the newest row was `20260810160000`,
the migration immediately before this one. A raw `psql -f` applies the DDL and
writes **no** row there, so the next `supabase db push` would have tried
`20260810170000` again and stopped on `policy … already exists`.

This is the same failure Batch 2 recorded when `public.shipment_errors` was
created out of band, and it is written down in
[batch-2-delivery-controls.md](batch-2-delivery-controls.md) §2. Meeting it a
second time in the same repository would be a choice.

So `supabase db push` was used, which applies **and** records.

### The migration was made re-runnable first

The file's own header claimed it was "the only shape that is safe to run in both
places". That was true of the bucket upsert and false of the four
`create policy` statements. Fixed before applying — each policy is now dropped
`if exists` before it is created — and **proved** by re-running the whole file
against staging, which already had all four. Commit `68a65a9`.

The `NOTICE … does not exist, skipping` lines in the production push output are
those four drops finding nothing on a first run. They are the fix working.

### The sequence

| Step | Result |
|---|---|
| Snapshot | `pg_dump` **17.9** — the Homebrew 14.19 client refuses a 17.6 server outright. 1.2MB. |
| Content-verified | 15 tables compared against live, **all exact**: products 35, variants 403, images 122, categories 15, collections 3, orders 21, order_items 21, payments 17, profiles 11, site_settings 10, homepage_sections 6, banners 1, pages 7, coupons 1, shipments 1 |
| `db push --dry-run` | listed **exactly one** file, nothing else |
| `db push` | applied; four skip notices as designed |
| Verification | 4 policies, count exactly 4, correct roles |
| Bucket | unchanged — `public=t`, `10485760`, `{video/mp4,video/webm}`. The upsert was the no-op it was written to be. |
| Pre-existing policies | the four `storefront assets` policies intact; `storage.objects` went 4 → 8 |
| Recorded | `20260810170000` is now the newest row |
| Post-DDL health | homepage 200 (1.98s), shop 200 (1.09s), product 200 (0.46s). `pgrst_ddl_watch` fired a schema reload and nothing broke. No PostgREST gate was needed: this adds no columns, functions or params. |
| Live hero | still reported `video_url = (none)` at that moment — the owner switched it afterwards |

---

## 2 · The live domain, with the video actually on

Every number in the previous report described a page that never fetched the
file. These do not.

Mobile emulation, `--throttling-method=devtools`, eleven Lighthouse runs across
two passes, plus four `PerformanceObserver` runs for the element.

| | baseline (no video) | video live |
|---|---|---|
| LCP | **2.63s** [2.60–2.67] | **2.62s / 2.65s** [2.61–2.74] |
| FCP | 2.63s | 2.62–2.65s |
| CLS | 0.000 | 0.000 |
| TBT | 40ms | 36–41ms |
| Performance | 93 | 90–91 |
| Total bytes | 622KB | **2714KB** |
| Requests | 69 | 70 |
| LCP element | hero `<img>` | **hero `<img>`, 4 runs of 4** |

**No LCP regression.** The deferred-mount design holds against a real CDN, a
real network and a real cold start: 2.56MB of video arrives and the poster is
still what LCP reports.

The cost is weight. **622KB → 2714KB is 4.4×**, and the Performance score's
2-to-3 point drop is the total-byte-weight diagnostic rather than any metric
moving.

**One run in eleven returned LCP 22.58s.** A second six-run pass had no outlier,
so it is recorded as transient rather than a pathology — but it is recorded,
because a median quietly absorbing a 22-second sample is how a real problem gets
buried. Worth a second look if it recurs.

> **It did not recur.** Eleven more runs against the same live URL with the same
> method returned 2.64–3.22s, the 3.22s being run 1 cold. Median 2.67s, CLS
> 0.000 throughout. One 22.58s sample now stands against 27 clean ones across
> three passes. See [phase-10-c5.md](phase-10-c5.md) §5.

---

## 3 · The cache header — a correction to the previous report

[phase-10-c4.md](phase-10-c4.md) said the production video carried
`cache-control: no-cache`, that this was the dashboard's default, and that
re-uploading through the panel would fix it. **The first part is true and the
rest is wrong.**

What is actually the case:

- The owner **did** re-upload through the panel. The live hero points at
  `site-video-hero-1e4d5086.mp4`, carrying the random suffix `buildVideoPath`
  generates, and its stored metadata is `cacheControl = max-age=31536000`
  against the old dashboard file's `max-age=3600`. The upload path did exactly
  what it claimed.
- **Every object in this project returns `cache-control: no-cache` regardless.**
  Product images whose metadata also says `max-age=31536000` return `no-cache`
  too. It is the storage layer, not the upload, and no upload route can change
  it.
- **Repeat visitors do not re-download 2.56MB.** Measured: a request carrying
  `If-None-Match` returns **HTTP 304 with 0 bytes**; an unconditional request
  returns 200 with 2,687,542. The repeat cost is one round trip, not the file.

The original claim conflated *revalidating* with *re-downloading*. They are not
the same, and the difference is the whole practical question. Nothing needs
doing here.

---

## 4 · Two visual defects, and how they got through

Both were reported by the owner opening the site and looking at it. That is now
the third defect found that way — after the pause button's position and this
pair — and it is the reason §5 exists.

### 4a · A hard vertical edge at 55% width, on every viewport from `md` up

**Not the poster.** The first hypothesis was a poster showing beside a video
that did not fill the same box. Disproved: the poster and the video occupy the
**identical rectangle** — same x, y, width, height and `object-fit` — at 390,
768, 1440 and 2560.

It is the scrim, and it is a malformed gradient. Computed at `md`+:

```
linear-gradient(to right,
  rgb(10, 21, 38) 0%,
  oklab(0.195396 -0.00738042 -0.0373932 / 0.7) 55%,   <- via
  rgba(0, 0, 0, 0) 40%)                                <- to, BEHIND the via
```

A colour stop positioned before the one preceding it is clamped up to its
predecessor. So transparent begins at 55% as well, the fade has zero width, and
the browser draws a line.

The cause is in one class list, `home-sections.tsx:211`. `to-40%` is written
unconditionally — it is the *mobile* gradient's intent, where the direction is
`to-t` and there is no `via` to conflict with. At `md` the direction flips to
`to-r` and `md:via-55%` is added, and nothing ever overrides the `to` position.
There is no `md:to-100%`.

**This is pre-existing.** It has been in the hero since the hero was written.
The video did not cause it; footage has tonal range the flat SVG placeholder did
not, so the video is what made it visible. Mobile is correct and always was —
its computed gradient is `to top, ink 0%, transparent 40%`, well-formed.

### 4b · A 1280×720 source stretched 2.00× across a 2560px band

| Viewport | Band | Upscale | Frame still visible |
|---|---|---|---|
| 390 | 390 × 312 | 0.43× | 70% |
| 768 | 768 × 544 | 0.76× | 79% |
| 1440 | 1440 × 560 | **1.13×** | 69% |
| 2560 | 2560 × 560 | **2.00×** | **39%** |

Upscaling begins at exactly **1280px** of viewport width.

One structural fact constrains every remedy: the band is far wider than 16:9, so
`scale = max(w/1280, h/720)` is **always width-dominated** above 1280px. Making
the hero taller changes how much of the frame is visible and **cannot reduce the
upscale at all**. Only the rendered width, or a larger source, can.

### 4c · Found while measuring: the poster is not a frame from the video

There is no `poster_url` on the live hero, so the poster falls back to the
`banners` row — `/seed/hero-desktop.svg`, the drawn placeholder. When the video
fades in, the picture changes from placeholder artwork to photography.

This is exactly the case the field's own hint warns about, and it is free to
fix: set `poster_url` to a real frame. Independent of everything in §5.

---

## 5 · The options, with their costs

Presented rather than chosen, at the owner's instruction.

**A · Constrain the rendered width.** Cap the media band, e.g.
`max-w-[1600px]`. Takes 2560 from 2.00× to 1.25×.
*Cost:* zero bytes, no new asset, one line. The hero stops being full-bleed on
wide screens — ink margins either side. A composition change, not a quality one.

**B · A higher-resolution source.** 1920×1080 makes 2560 a 1.33× upscale;
2560×1440 makes it 1.00×.
*Cost:* **4.90MB at 1080p** and **7.12MB at 1440p** — the first over the 4MB
warning and under the 10MB ceiling, so the panel would say so and quote ~30
seconds on slow 4G; the second inside the bucket's hard limit but with almost
nothing to spare.

**These are measured, not scaled.** ffmpeg was installed after this report was
first written and the encodes were run (see
[phase-10-c5.md](phase-10-c5.md) §2 for the method and the full ladder). What
replaced the estimate:

| | estimated here | measured |
|---|---|---|
| 1080p | 4.5–5.6MB | **4.90MB** — 5,135,257 bytes |
| 1440p | 7.5–10MB | **7.12MB** — 7,465,192 bytes |

The 1080p estimate was right; the 1440p one was half a megabyte too pessimistic
at its low end and three too pessimistic at its high end. Neither changes the
decision — 1080p still crosses the 4MB warning, which was the question.

One thing the measurement found that the estimate could not: **the current file
carries an AAC audio track worth 174KB** on a hero that is `muted` and
`aria-hidden`. Stream-copying it out takes 2,687,542 bytes to 2,513,555 with no
re-encode and no visible change. All the figures above are audio-free; add
~174KB back if a future export keeps a track that cannot be heard.

**C · Art-directed crops per breakpoint.** A tall crop for phones, a wide crop
for desktop, each encoded at the resolution its breakpoint needs.
*Cost:* the most work, and one trap worth knowing before committing to it — the
`media` attribute on `<source>` inside `<video>` is unreliable, unlike inside
`<picture>`, so this needs a JavaScript breakpoint decision in the component
rather than markup. Two files to produce and store; each visitor still fetches
one. The poster must then be art-directed to match each crop, or the fade jumps
at one breakpoint.

**The scrim, separately.** The owner asked for the dark blue shade under the
headline to be removed. Three treatments:

1. **Remove it entirely** — what was asked, and it deletes the hard edge for
   free. *Cost:* white text sits directly on footage with no legibility floor.
   Fine on this dark clip; illegible if a brighter one is ever uploaded, and
   contrast then depends on video content, which cannot be asserted.
2. **Keep it, add `md:to-100%`** — one token, gives the intended smooth
   left-to-right fade. *Cost:* the shade stays.
3. **A much lighter, properly terminated scrim** — keeps a contrast floor while
   removing most of the wash.

Held rather than applied because the choice interacts with which of A/B/C is
taken.

> **Chosen: A, and scrim 3.** Applied and verified in
> [phase-10-c5.md](phase-10-c5.md). Scrim 3 turned out to cost one thing this
> list did not anticipate — a much lighter scrim cannot hold the hero paragraph
> at 4.5:1 while that paragraph is `--muted-foreground`, so the colour moved to
> paper. The measurement that established it is in §3 of that report.

---

## 6 · The gate that was missing

`npm run audit:hero-media`, commit `33347a1`. Registered in `package.json` and
in `run-all`'s `GATES`.

It walks 390, 768, 1440 and 2560 against a production build and asserts:

- the poster is in the DOM **and decoded** (`naturalWidth > 0`)
- no `<video>` is server-rendered — the property the whole LCP design rests on
- the poster and the video occupy the same rectangle
- the source is not upscaled past **1.25×**
- no gradient anywhere in the hero has a colour stop behind the one before it
- under reduced motion: no `<video>` element and **zero** video bytes

**19 of 23 green, 4 red, and the 4 red are exactly the two defects at the widths
they occur.** Proven to fail where the failure is.

Two things are documented inside the gate rather than left implied:

- **The gradient check is the one that would have caught 4a.** It reads the
  *computed* `background-image`, not the class attribute, because `to-40%` and
  `md:via-55%` only contradict each other after the cascade runs. Reading the
  class list would have found nothing wrong with either utility.
- **The same-box check would NOT have caught either defect.** Both were already
  pixel-identical at all four widths. It is in the suite because it is the
  assertion everyone assumes exists, and an assumed check that does not exist is
  worse than one that has never fired.

Screenshots are written on every run, pass or fail, to
`screenshots/hero-{390,768,1440,2560}.png` and `hero-reduced-motion.png`. Both
defects were instantly visible and invisible to every predicate anyone had
thought to write; the next one will be too.

### Consequences to expect

- **`npm run audit` is red until the fixes land.** Correct, and it names real
  defects, but it is a change in the suite's resting state.
- The pre-existing drift in `run-all` — 8 `audit:*` scripts in neither `GATES`
  nor `EXCLUDED` — is untouched and still there.

---

## Verification

| | |
|---|---|
| Production migration | applied via `db push`, recorded, 4 policies confirmed, live shop healthy after |
| Snapshot | content-verified against live on 15 tables, all exact |
| `audit:hero-media` (new) | **19/23** — red on both defects by design |
| Live LCP | 11 Lighthouse runs, 4 element runs; no regression against the 2.63s baseline |
| Cache behaviour | 304 / 0 bytes on a conditional request, measured |
| `tsc --noEmit` · `eslint .` | clean, exit codes read directly, run last |
