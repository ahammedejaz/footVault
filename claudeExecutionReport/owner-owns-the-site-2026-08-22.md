# The owner owns the site — pictures, pages, and the shop's own name

**2026-08-22.** The brief: *"Admin should have the capability to upload/remove
the static images on the entire website … entire website content should be
editable by admin. I won't be changing the code regularly. Image frames should
have the capability to adjust the uploaded images. And the admin panel should
not be clumsy … I will be stopping the development."*

That last sentence is the specification. Everything below is decided by it:
anything only a developer can change is, from this week, a thing nobody can
change.

---

## 1 · The audit — what the owner could and could not touch

I started by measuring rather than assuming, because this codebase already had
a homepage editor and a media library and it was not obvious what was missing.

**Already owner-editable, and left alone:** the homepage layout and section
order, products, variants, stock, categories, brands, collections, coupons,
loyalty, reviews, orders, delivery thresholds, the contact block, social links,
the announcement bar, hero video upload, and product photographs — which already
had a full pan/zoom/rotate crop tool.

**The gaps, with the evidence for each:**

| # | Surface | How I knew |
|---|---|---|
| G1 | The seven CMS pages | `pages` table since migration 0004, no admin route. `/admin/settings` says so in prose: *"a half-built editor for them would be worse than a link"* |
| G2 | Department tile pictures | `categories.image_url` exists; the category form had **no image field**. Production rows for `men`/`women`/`kids` read `/seed/category-men.svg` — drawn placeholder art committed to the repo |
| G3 | The hero still | `banners.home_hero.image_url` = `/seed/hero-desktop.svg`; no banner admin anywhere |
| G4 | Hero and brand imagery | Bare text inputs. The brand form's hint read *"Upload the picture on the Media screen, then paste its address here"* — **every brand in production has a null logo**, which is what that instruction was worth |
| G5 | Framing | Existed only for product photographs, and only as a forced square |
| G6 | Logo, favicon, share card | `import lockup from "../../../public/brand/logo.png"` — a *compiled import*. The favicon was `src/app/icon.png`, a file route |
| G7 | Shop name, tagline, description | `siteConfig` constants, under a comment promising they would move to `site_settings` "from Phase 7". Three phases later they had not |

Two storage buckets — `category-images` and `site-assets` — were created in
migration 0007 and used by nothing.

**The shape of the finding.** The data model was already right. What was missing
was almost entirely *reach*: controls that were never built over rows that
already drove the site. That matches this repo's own recorded lesson about gates
proving human reachability, and it meant most of the work was interface, not
schema.

---

## 2 · What I built

### 2.1 One control, everywhere

`SiteImageField` — Choose picture / Adjust / Remove — is now the single control
behind every non-product image: the logo, the favicon, the share card, the hero
(desktop, phone, video still), department tiles, banner backgrounds, brand
logos. They were seven different arrangements before; five of them were a text
box you pasted a URL into.

Choosing renders immediately with the plain centred crop, so the common case is
one press. **Adjust** is the second, optional step: drag with one finger, pinch
to zoom, with labelled sliders underneath for keyboard and screen-reader use.

### 2.2 Re-framing without re-uploading — why there is a new table

The interesting half of "adjust the uploaded images" is not the first crop, it
is the second one, next month. `site_images` keeps the **original** plus five
framing numbers per slot, and the served file is a pure function of them. So a
picture can be moved inside its frame indefinitely without ever re-cutting an
already-cut derivative, and a frame that changes shape next year can be
re-rendered from what is already in the bucket.

The storefront does **not** read that table. The rendered URL is written into
the field that already drove the page — `categories.image_url`, the hero
payload, `site_settings.branding` — so no renderer learned about a new table,
and if `site_images` vanished tonight every page would render exactly what it
renders now. Only *re-adjusting* would be lost.

### 2.3 Two framing modules, not one

`crop.ts` frames a product photograph: always square, allowed to overhang the
picture, padding the difference with transparency. None of that is true for a
hero, which must cover its box with no padding at all. Generalising the existing
module would have added an aspect parameter that is `1` at every existing call
site, to serve a use that shares none of its rules.

`frame.ts` is the new one. What the two share is the property that matters: **one
function computes the rectangle and both sides of the wire import it.** The
browser previews `frameRect`; the server extracts `frameRect`.

### 2.4 The straighten control is deliberately absent

A product crop can rotate because it is already padded — the corners a tilt
uncovers are fog the page paints anyway. A hero is full-bleed, so the same tilt
leaves *visible holes*. The obvious repair (enlarge the extract, then re-crop)
only works when the framing is zoomed in far enough to have that much picture in
hand, which would make straighten a control that silently works at some zooms
and not others.

Every phone gallery can straighten a photograph before upload, against the whole
frame rather than what survives a crop. That is the better place for it, so this
tool does not pretend to offer it. Written up in `frame.ts`.

### 2.5 `/admin/pages`

Full editing for the seven policy pages, with a **Preview that is the
storefront's own renderer** (`ProseBlocks`, imported, not reimplemented) and a
token panel showing every `{{token}}` beside its live value.

That panel is load-bearing. `audit:literals` *fails the build* on a rupee figure
typed into `pages.body`, so the owner is required to write the token — and a
preview that showed them the braces would teach them the token is broken and to
type the number instead, which is the exact thing the gate exists to forbid.

The slug of an existing page is read-only, because it is in the footer of every
page, in the terms customers agreed to at checkout, in Google and in bookmarks,
and renaming it 404s all of them with nothing to redirect.

### 2.6 The shop's own identity

`store_name` / `store_tagline` were **already** editable and already read by the
OG image — they were simply ignored by the header, the footer and the browser
tab, all three of which carried a `siteConfig` constant. Those now read the
database. I deliberately did **not** add a second shop name to the branding row:
two answers to "what is this shop called" diverge the first time somebody edits
the wrong one.

The branding row holds what had no home at all — the logo, the favicon, the
share card and the search description.

### 2.7 The menu is grouped

Sixteen sections under five headings (Today · Selling · What you sell · The
website · Offers and customers · The shop itself). `ADMIN_NAV` stays the flat
list both gates already iterate; `ADMIN_NAV_SECTIONS` is derived from it, so
there is no second hand-maintained copy to rot.

---

## 3 · What went wrong, and what caught it

### 3.1 My own gate found two bugs in my own gate

`audit:site-images` drives a real browser at 390px and asserts the controls are
on screen and touch-sized. Its first run reported **`1x1 — under a touch target`
on all four surfaces**.

The controls were fine. `getByRole("button", { name: "Choose picture" })` was
resolving to the **visually hidden `<input type="file">`** — a file input carries
the `button` role, and the `<label>` in front of it supplies its accessible name.
I was measuring the accessible control and calling it the touch target. They are
two different elements and both claims need checking, so the gate now checks each
against the thing it is actually about.

Second: matching the hero row by its title text resolved to the **disabled
"Move … up" arrow**, which carries the same title in its `aria-label`. A selector
that finds a disabled sibling reports a working page as broken.

### 3.2 I shipped a contrast regression and axe caught it

The new nav headings were `text-sidebar-foreground/45`. `audit:admin-pages` went
from 0 to **6 colour-contrast violations on every admin page** — one per heading.
I confirmed it was mine by stashing the changes and re-running (baseline: 0).
`/70` fixes it, and the hint lines under each link have been `/60` since they
were written — a heading must not be quieter than what it labels.

### 3.3 My round-trip test asserted against the wrong row

The end-to-end upload check read `categories … limit(1)` and assumed the browser
had opened *that* department. It had not — the list renders in tree order and an
unordered `limit(1)` is whatever Postgres hands back. The lookup came back empty
and reported a working write as broken. It now finds the row **by the address the
page was shown**, which is the one value that can only exist if the whole chain
ran.

### 3.4 A silent no-op I nearly shipped

`saveBranding` was an `update` against a migration-seeded row. PostgREST reports
**no error for zero rows changed** — so in the window between this code deploying
and its migration being applied, the owner would press Save, read "Artwork
saved", and have changed nothing. It is an upsert now, which also makes the seed
row a convenience rather than a dependency.

### 3.5 The gate damaged the data it was testing against

After four runs I checked staging and found only **one** of the three seeded
department pictures left. The cleanup set `image_url` to **null**, which is not
the same as putting it back — `men`, `women` and `kids` all carry drawn
placeholder art, and the gate had been quietly erasing whichever one the browser
opened.

Nulling a column is a restore only when the column was null. The gate now
captures every department's picture before it runs and writes the original value
back; I restored the three on staging by hand and re-ran to prove it: 28/28,
and all three survive.

This is the same rule this codebase recorded once before — a proof must restore
the *data*, not just the structure.

### 3.6 A stale cache made a working feature look broken

The banner background is a new renderer branch no gate covers (no banner has an
image yet), so I set one on staging and screenshotted it. It did not render.
Neither did a subtitle I changed as a probe — which is what identified it: an
`unstable_cache` entry, not a code bug. `rm -rf .next/cache` was not enough;
`rm -rf .next` was. The screenshot then showed the intended stacking — photograph,
scrim, tread texture, legible type on top.

Worth writing down because the first two minutes of it looked exactly like a
broken feature, and the discriminator was cheap: **change something else and see
whether that appears either.**

### 3.7 The red-green control

A gate that cannot fail proves nothing. I hid the category image field behind
`{false ? …}` and re-ran: the category surface went red with *"nothing carries
that accessible name"* while the other three stayed green. Restored, 28/28.

---

## 4 · Measurements

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run shapes` | 16 cached shapes unchanged at v9 |
| `npm run build` | exit 0 |
| `npm run guard:use-server` | 30 files, all export only async functions |
| `npm run guard:client-imports` | 102 client files against 80 server-only modules, none value-imports one |
| `npm run audit:site-images` | **28 passed, 0 failed** (new) |
| `npm run audit:admin-mobile` | 45 passed, 0 failed — every page at 360px and 390px, `/admin/pages` included |
| `npm run audit:admin-pages` | 75 passed, 0 failed |
| `npm run audit:appearance` | 23 passed, 0 failed |
| `npm run audit:settings-controls` | 52 passed, 0 failed — all 40 controls located, changed and checked |
| `npm run audit:a11y` | clean, 23 routes × 15 states at 390px and 1440px |
| `npm run audit:overflow` | 9,584 interactive elements measured, exit 0 |

### The full suite

`npm run audit` — **59 of 64 gates green in 20.7 minutes**, including the new
one. All five failures are accounted for and none is a regression from this
work:

| Gate | Why | What I did |
|---|---|---|
| `audit:literals` | Reads **production**, where `site_images` does not exist yet | Nothing — it is correct. See §5 |
| `audit:settings-visibility` | Reads **production**, where the `branding` row does not exist yet | Nothing — same |
| `audit:admin-mobile` | `/admin/customers` needs a sideways table scroll to reach its two action columns at 360/390px | **Pre-existing.** See §4.1 |
| `audit:image-upload` | Asserted on the literal `derived/v1/` | **Fixed** — see §4.2 |
| `audit:image-colour` | Same literal, in a fingerprint split | **Fixed** — same |

### 4.1 The `/admin/customers` failure is pre-existing, and I did not fix it

It only appears when there are customers, so it is invisible on a clean staging
database and the suite's own fixtures create them. Three proofs it is not mine:
my commit touches no file under `admin/customers` (that screen last changed
2026-08-08); running the gate alone against a clean staging gives **45/0**; and
clearing the QA fixtures with `audit:teardown` returns it to **45/0**
immediately.

It is a real defect, though — the row ends in *two* action columns ("Pay on
Delivery" and "Orders"), and only one column can pin to the edge, so fixing it
properly means redesigning that row for phones. The controls **are** reachable,
by scrolling the table sideways; the gate's rule is the stricter "reachable
without sideways scroll". That is a change to a screen this brief did not ask
about, so I have reported it rather than made it. It is yours to scope.

### 4.2 Two gates had rotted on a version bump, and I fixed them

`audit:image-upload` asserted `html.includes("derived/v1/")` and
`audit:image-colour` split on `"/derived/v1/"`. `PIPELINE_VERSION` moved to **2**
on 2026-08-20, so every fresh upload lands under `derived/v2/` — both gates had
been failing for two days for a reason that has nothing to do with what they
test. `image-colour`'s three red checks were all about *colourway tagging*, and
the actual cause was an empty fingerprint.

`scripts/audit/images.ts` had already taken exactly this lesson and says so in
its own comment — *"this fixture carried a hand-written `derived/v1/` and went
red the day PIPELINE_VERSION moved to 2 — a copy of a derivable value asserting
the past, again."* These two were the copies nobody went back for. Both now
build the prefix from `PIPELINE_VERSION`. After the fix: **image-upload 31/31,
image-colour 20/20.**

---

## 5 · The one thing left, and it is yours

Two migrations need applying to production. Both are purely additive — one
`CREATE TABLE` with its RLS policies, one `INSERT` of a settings row. Nothing is
dropped, altered or rewritten.

**I made the gap safe rather than assuming it would be short.** Until they are
applied:

- The admin screens **do not 500.** `getSiteImages` recognises PostgREST's
  `PGRST205` ("Could not find the table … in the schema cache") and returns
  nothing, with a warning in the log. I verified that error shape against the
  live production database rather than guessing it.
- Image fields render as empty, and an upload says plainly *"the database has not
  been updated for this feature … everything else on this screen works"* —
  instead of "try again", which is advice that cannot possibly work.
- `/admin/pages`, the branding text, the grouped menu and every existing screen
  work normally.

### The commands

```bash
# 1 · Snapshot first — the rule in docs/admin-guide.md §12, and this is DDL.
export FV_DB_URL='<copy from Supabase → Connect, session mode, port 5432>'
npx supabase db dump --db-url "$FV_DB_URL" -f "backup-$(date +%Y%m%d-%H%M)-schema.sql"
npx supabase db dump --db-url "$FV_DB_URL" -f "backup-$(date +%Y%m%d-%H%M)-data.sql" --data-only
ls -lh backup-*.sql        # both non-empty before going further

# 2 · See what is pending — expect exactly these two, and nothing else.
npx supabase db push --db-url "$FV_DB_URL" --dry-run
#   20260822090000_site_images.sql
#   20260822090100_branding_settings.sql

# 3 · Apply.
npx supabase db push --db-url "$FV_DB_URL"

# 4 · Prove PostgREST can see them (its cache reloads itself on DDL).
curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/site_images?select=slot&limit=1" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY"        # expect: []
curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/site_settings?key=eq.branding&select=key" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY"        # expect: one row

# 5 · The two gates that are red should now be green.
npm run audit:literals
npm run audit:settings-visibility
```

The backup files go **outside the repository** — a data dump holds real
customers' names and addresses.

---

## 6 · What is still not owner-editable, named so it does not read as coverage

- **Product photograph framing** is a square, by design. Unchanged.
- **The Google map embed** on the contact page (`shop-map.tsx`) is a constant.
  Regenerating it means Google Maps → Share → Embed, which is a developer job.
- **Microcopy** — button labels, empty states, error messages, the size guide's
  structure. These are interface, not content; making them database-driven would
  mean an owner could break the checkout by editing a label.
- **The legal identity** (`REGISTERED_NAME`, `GSTIN`, `REGISTERED_ADDRESS`) stays
  in code deliberately: `audit:privacy` decides whether a token is resolvable by
  finding its name in `content-tokens.ts` as text.
- **Whether a chosen picture looks good.** That is the owner's decision, and the
  reason the framing stage exists.
- **`/admin/customers` on a phone.** Its two action columns need a sideways
  table scroll at 360 and 390px. Pre-existing, evidenced in §4.1, and left for
  you to scope because the fix is a row redesign rather than a one-line change.
