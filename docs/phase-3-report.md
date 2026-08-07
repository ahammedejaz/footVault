# Phase 3 — the storefront

Phase 1 shipped these routes as data plumbing. This turns them into the product.

Everything below was measured against a production build (`npm run build && npm
start`) on the live Supabase project, not asserted.

---

## Preflight

**1 · Escalation test — passes.** A user created with
`{"role":"admin","is_admin":true,"user_role":"admin"}` in `raw_user_meta_data`
gets a profile with `role = customer`; `handle_new_user()` never reads the
client's payload. Re-running the Phase 1 escalation as that user raises
`ERROR: 42501: Only an admin can change a profile role`, `is_admin()` stays
false, and the role is unchanged. The same user *can* still edit their own
`full_name` — the guard is targeted, not a blanket denial. Written up with the
queries and results in [`docs/rls-tests.md`](rls-tests.md) §6b.

> **Substitution, recorded as one.** The brief asks for the signup to go through
> the real client. `supabase.auth.signUp()` returns
> `429 over_email_send_rate_limit` on this project — email confirmation is on
> and the built-in SMTP allowance is exhausted — so **no** user can be created
> over HTTP at all, with any payload. The check above uses the same fixture
> shape GoTrue writes, because `options.data` is copied verbatim into
> `raw_user_meta_data`. Re-run the client-side version once SMTP is configured
> or "Confirm email" is off.

**2 · Sold-out coverage — was missing, now seeded.** The seed had 25 sold-out
variants across 11 products but **no fully sold-out product** and no
single-size product, so two of the states the size run exists to show were
untestable. Three products added, each of which broke something the first time
it rendered:

| Product | What it is for |
|---|---|
| Gazelle Indoor | Sold out in every size — the whole strip struck through |
| Nubuck Trek Boot | One size, one colourway, no sale price |
| Gel-Kayano 31 Wide Fit Stability Running Trainer for Overpronation | 66 characters |

Now: 35 products, 403 variants, 33 sold-out variants, 1 fully sold out, 1
single-size, 17 with no sale price, 4 categories holding exactly one product.

**3 · Error swallowing — the structural fix had not landed.** Phase 1 added an
`unwrap()` helper inside `catalog.ts` and applied it to some call sites.
`getSiteSettings()`, `listPageSlugs()` and one `.then()` inside
`getFilterFacets()` still dropped the error, and nothing stopped the next one.
Now:

- Every read goes through **`src/lib/queries/run.ts`** (`run` / `rows` /
  `maybeRow` / `pagedRows`), which throws with the call site in the message.
- **`footvault/no-unchecked-supabase-error`** (`eslint-rules/`) fails the build
  on: destructuring a query result without `error`; destructuring `error` and
  never reading it; awaiting a builder without destructuring at all; `.then()`
  on a builder; a raw builder inside `Promise.all`. It tracks locals, so
  `let q = supabase.from(…); … await q.range(…)` is caught too.

  It found **32 violations on its first run**, including 17 in `scripts/seed.ts`
  where four read-backs were silently producing empty lookup maps.

**4 · Baseline.** Build, typecheck and lint were clean. Lighthouse mobile
before/after is in the table further down.

---

## What changed, and why

Every decision taken without asking, with its reason.

### Data layer

| Decision | Why |
|---|---|
| **`catalog_query()`** — one RPC returns page ids, exact total, and every facet count | The listing issued 2–4 round trips and, with a size or colour filter on, pulled *every* matching product id into Node before paginating. Now two queries whatever the filters. |
| Facet counts computed **with each facet's own selections lifted** | Otherwise "Black (12)" reports the current result count against every colour, which is the point at which faceted search stops helping. |
| Size and in-stock narrow to variants **with stock**; colour does not | Picking a size is "sold to me, today". Picking a colour should still show the sold-out tan pair struck through — the same honesty the size run is built on. |
| **`color_family()`** — derive twelve colour families from the hex | The catalog holds 39 colourway names; the men's listing offered 26 as filter options. That is a glossary, not a filter. Derived rather than tagged, so an uploaded colourway is classified on save. |
| **`products.search_keywords`** | Searching "running" found nothing: the copy says "trainer", "tempo", "race". Loosening the matcher to reach it would have loosened it for everything. A column the owner edits beats a synonym table baked into a function. |
| Search is **AND over words**, with filler dropped | "nike sandal" must not mean every sandal. But "office shoes" returned 1 of 7 until "shoes" was treated as filler. |
| **Edit distance for brands only** | `similarity('Nike','nkie')` is 0.111 — a transposition in a four-letter brand is invisible to trigram, and no threshold that catches it rejects anything else. Brands are a closed vocabulary of twelve, so an edit-distance pass over that list is cheap. |
| **Public reads moved to the cookieless client** | Every catalog query went through `cookies()`, which makes a route dynamic — so `/` and every product page were rendered per request despite their `revalidate`. Now `/` and all 35 product pages are static. |
| **`discontinued_product_hint()`** (SECURITY DEFINER, narrow) | A 404 on a sold-through product should offer the shelf it came off. One slug in, three fields out, no price, no stock, no enumeration. |
| Per-colourway product images (`product_images.color`) | The brief asks a swatch to change the gallery *and* the size run. It could not: every product had one hero and one outsole. 122 images now, one pair per colourway. |

### Interface

| Decision | Why |
|---|---|
| Mobile filter panel's open state lives in **the URL** (`?panel=filters`) | Every facet is a link, so tapping one is a navigation — and the panel comes back open with counts that are now true. Draft state would mean either a second source of truth or counts that lie until you commit. |
| **Price as four buckets**, not a slider | A slider needs JavaScript to mean anything, needs its own keyboard story, and asks a phone for precision nobody wants. The stops come from what the listing actually holds. |
| Product page reads size/colour from the URL via **`useSyncExternalStore`**, not `useSearchParams` | `useSearchParams` opts the whole route out of static rendering. This keeps the page static; the cost is that a deep link fills the chip in just after hydration, with nothing moving. |
| Size selection uses **`replaceState`** | A back button that walks back through five sizes before leaving the page is a back button nobody can use. The URL still updates, which is what makes it shareable. |
| Selected size is **navy fill**, not the orange the design system specified | Orange is the *facet applied* state on the listing; using it for both made a chosen size and an applied filter look like the same kind of thing. |
| Four overlays **lazily imported** (search, drawer, filter sheet, size guide) | They were the largest block of JavaScript on the critical path, in service of panels most visits never open. Loaded on `pointerdown`, so the chunk is usually there before the tap completes. |
| Geist Mono switched from the `geist` package to **next/font/google** | The package ships one variable file covering every unicode range — 71KB preloaded on every page. Google's copy subsets to latin: 23KB. |
| **Scroll reveals rise without fading** | An opacity-0 start makes everything below the fold invisible until scrolled to, which an accessibility pass correctly reads as text with no contrast. Also removed from product cards: a grid that animates as it arrives is a grid you cannot scan. |
| `--fv-muted #98A1AE` → **`--fv-dim #646E7B`** | 2.54:1 on paper. Struck-through sizes are text carrying meaning, not decoration. Now 5.04:1 on paper, 4.57:1 on fog. |
| **`.hit-44`** utility | The announcement strip is 33px tall and breadcrumbs are 12px mono on purpose; making them 44px would push the whole page down. The target grows without the box growing. |
| Sticky bar waits until the CTA **has been seen and left** | On a 390px phone the buttons start below the fold, so "not visible" is true before the customer has scrolled at all. A bar that slides up over an untouched page is an advert for itself. |
| Footer built entirely from `categories`, `pages` and `site_settings` | Nothing hardcoded the admin will later expect to edit. Publishing a policy page in Phase 7 puts it in the footer with no deploy. |
| Announcement dismissal via a **blocking inline script** | localStorage in an effect means the strip renders and then vanishes — a 33px shift on every page load for the people who visit most. A cookie read would make every route dynamic. |
| **Open Graph images generated** per page (`next/og`) | The seed's product art is SVG, which no social platform renders. The card carries brand, name, price and the size run, struck through where sold out. |
| Playwright + axe added as dev dependencies | "Audit programmatically, not by eye" needs a browser. Five scripts under `scripts/audit/`, all runnable with `npm run audit`. |

---

## Quality gates

Measured against `npm start` on the live database.

### Lighthouse mobile

Two throttling methods, because they disagree and only one of them is telling
the truth about this site.

**`--throttling-method=devtools`** (Chrome applies real 4G throttling and
measures what happens):

| Route | Perf | A11y | Best practices | SEO | LCP | CLS | TBT |
|---|---|---|---|---|---|---|---|
| `/` | **98** | 100 | 100 | 100 | 1.9 s | 0 | 20 ms |
| `/shop` | **99** | 100 | 100 | 100 | 1.6 s | 0 | 30 ms |
| `/shop/mens-sneakers` | **99** | 100 | 100 | 100 | 1.6 s | 0.002 | 20 ms |
| `/product/nike-air-max-90-mens` | **99** | 100 | 100 | 100 | 1.6 s | 0.002 | 20 ms |

**`--throttling-method=simulate`** (Lighthouse's default: observe fast, then
model a slow network):

| Route | Before | After | LCP before | LCP after |
|---|---|---|---|---|
| `/` | 80 | 84 | 4.9 s | 4.3 s |
| `/shop` | 87 | 91 | 4.1 s | 3.5 s |
| `/shop/mens-sneakers` | 89 | 87 | 3.8 s | 4.0 s |
| `/product/nike-air-max-90-mens` | 89 | 87 | 3.8 s | 4.1 s |

**Simulated mode is below the ≥90 gate on three routes, and I do not think it is
measuring the site.** The trace shows `observedLargestContentfulPaint: 120–189 ms`
— on localhost every byte arrives before the first paint, so the simulator
attributes the *entire* critical chain to the LCP and reports ~4s. The devtools
run, which throttles for real, paints at 1.6–1.9s. Both are in the table because
picking the flattering one and calling it a pass would be the wrong move; see
"known imperfections".

Accessibility went 89–96 → **100** on every route in both modes.

### Responsive

`npm run audit:overflow` — 15 routes × 6 widths (360, 390, 768, 1024, 1440,
1920), 90 page loads:

> Clean: no horizontal overflow, no tap target under 44×44, no form input under
> 16px.

The route list includes the hostile cases on purpose: the fully sold-out
product, the one-size product, the 66-character name, a filtered listing, a
zero-result search, and a 404.

### Accessibility

`npm run audit:a11y` — axe-core, WCAG 2.2 A/AA + best-practice, 15 routes at
390px and 1440px, scanning the page **and then** the overlays:

> Clean: no violations.

`npm run audit:keyboard` — home → department → size filter → product → size,
Tab and arrow keys only:

> Clean: focus visible at every stop, no traps, size in the URL, Escape returns
> focus.

Also: one `h1` per page and a correct heading order (enforced by the crawler),
`aria-live` on the result count, the gallery frame and the stock line, alt text
from `product_images.alt_text`, and `prefers-reduced-motion` honoured.

### Links and SEO

`npm run audit:links` — 122 pages crawled (every distinct path, plus three
filtered variants per path):

> No broken links, no missing titles, no malformed JSON-LD.

Per-page metadata from the database, canonicals without the query string
(a filtered listing is a narrower view of one page, not a page of its own),
`Product` JSON-LD with **one `Offer` per variant** — a shoe sold out in UK 6 and
in stock in UK 9 is two different answers to "can I buy this" — `BreadcrumbList`
generated from the same array the customer sees, and `sitemap.xml` / `robots.txt`
from real data.

### Interactions

`npm run audit:interactions` — the five things a screenshot cannot show:

> Clean: announcement dismissal persists without a flash, the filter sheet
> survives a facet tap, search forgives a misspelling, a swatch changes the
> gallery and the URL, and the sticky bar waits for the CTA.

---

## What I got wrong and caught

1. **Making pages static broke the credential-less CI build.** `/` and the two
   Open Graph routes are now rendered during `next build` — and CI builds with
   placeholder Supabase credentials on purpose, so that a pull request can be
   verified without live database access. The first CI run failed on
   `getaddrinfo ENOTFOUND placeholder.supabase.co`. `src/lib/prerender.ts` now
   applies the rule `staticParamsOr` already established — at build time there
   is no customer waiting, so a route that cannot read its data defers to
   on-demand rendering via `connection()` rather than being baked with whatever
   fallback was lying around. Outside a production build it rethrows, so a
   customer still gets `error.tsx` rather than a page pretending the shop is
   empty.

2. **The gallery downloaded every image twice.** A touch carousel and a desktop
   pane side by side, one hidden with `lg:hidden` — and `display: none` stops an
   element painting, not its image loading. The waterfall showed the LCP image
   requested at High priority and again at Low. One DOM tree now.

3. **My own accessibility audit had a blind spot.** It opened the size guide
   *before* scanning, and a Radix modal marks everything outside itself
   `aria-hidden` — so it was checking the dialog and nothing else. It reported
   clean while Lighthouse was reporting a broken `<dl>` on the same page. Now it
   scans the page first, then the overlays, and the `<dl>` is fixed (an
   icon-plus-text layout produces `div > div > dt`, which is invalid).

4. **The audits were measuring skeletons.** A dynamic route streams its
   `loading.tsx` fallback first; at the `load` event the real content is in the
   DOM but still inside a hidden container. The first run reported "no
   level-one heading" on every listing page. Everything now waits for a visible
   `h1`.

5. **The desktop hero ran off the frame.** Scaled 1.5× from 44% of the width, it
   overran the right edge by 65px and read as an abstract blue shape. And the
   *mobile* hero put the shoe directly behind the headline — no scrim fixes
   that, so below `md` the image is now a band above the copy rather than a
   backdrop behind it.

6. **`role="group"` on the gallery scroller orphaned its list items.** Added to
   fix "scrollable region must have keyboard access"; it overrode the list role
   and every `<li>` became a violation. `tabIndex` and a label were the fix.

7. **The colour-family buckets were wrong twice.** HSL saturation is unstable at
   the extremes — "Cloud White" (94% light, 3% chroma) reported s = 0.27 and
   came out Beige; "White / Green" came out Yellow. Chroma is the honest test,
   and the cut had to move from 0.10 to 0.075 before Bone and Sea Salt stopped
   being Grey.

8. **Overwriting `--fv-muted` was not a preference.** I went looking for why
   Lighthouse scored accessibility at 96 and found the token the design system
   specified for struck-through sizes measured 2.54:1.

---

## Known imperfections

1. **Lighthouse's simulated mode is below the gate.** 84–91 against ≥90, for the
   reason above. What would settle it is measuring a deployed URL rather than
   localhost — the simulator's pessimism comes from observing a zero-latency
   server. I have not done that because there is no deployment yet (Phase 9). If
   the number matters before then, the honest next step is a preview deploy and
   a re-run, not more local tuning. The single biggest remaining lever either
   way is Archivo: 90KB for the latin subset, because the display face uses the
   `wdth` axis, which is a brand decision rather than an oversight.

2. **The escalation test did not go through the HTTP signup.** The project's
   email allowance is exhausted, so no signup of any kind completes. Recorded as
   a substitution in `docs/rls-tests.md` §6b rather than papered over.

3. **`npm run seed` has not been run in this pass.** `SUPABASE_SERVICE_ROLE_KEY`
   is empty in `.env.local`, so the live-seed path is untested code. The SQL
   path (`npm run seed:sql`) is regenerated and correct, and this pass applied
   its statements to the live database through the Supabase MCP server; the
   supabase-js path was updated in step with it but not executed.

4. **Migration history is collapsed.** Iterating on `catalog_query()` recorded
   thirteen versions in `supabase_migrations.schema_migrations`; the repo carries
   six files that add up to the same final state. `supabase db reset` from files
   produces the right schema, but the local history and the remote history are
   not row-for-row identical.

5. **A sold-out size does not open "notify me".** The design system says it
   should; there is no notify-me until Phase 8. Selecting one currently surfaces
   the stock line and nothing else. The seam is `onSelect` in
   `size-selector.tsx`.

6. **Search does not handle natural language.** "shoes for my son" returns
   nothing — "son" matches no product, brand, category, keyword or colourway.
   Single-word misspellings ("pegasis", "sketchers", "wodland", "crcos",
   "nkie") all work; a sentence does not.

7. **The audits are not in CI.** They need a real browser against a running
   build with a live database, and CI builds with placeholder credentials on
   purpose. They are one command (`npm run audit`) and they are documented, but
   nothing enforces that anyone runs them.

8. **What I am least confident about:** the `.hit-44` technique. It gives the
   announcement link and the breadcrumbs a 44px target through an absolutely
   positioned `::before`, and the audit measures it correctly — but a
   pseudo-element hit area is invisible in the DOM, and two of them overlapping
   would silently steal each other's taps. Nothing measures that today.

---

## Out of scope, noted and not built

Cart, wishlist and add-to-bag behaviour (Phase 4). Checkout and orders (5).
Admin (6–7). Reviews and coupons (8). The UI affordances they need are built,
disabled, and honest about it: the bag and saved-item badges read from a real
persisted store that nothing writes to yet, and the add-to-bag buttons measure
exactly as they will when they work, so nothing shifts when they do.

**Phase 2 (auth) is also not built** — this phase was done out of order. Nothing
in the storefront needs a session, so the two do not block each other, but there
is no sign-in on the site and the header carries no account control.
