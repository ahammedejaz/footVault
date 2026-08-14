# Launch readiness — Stage 1 audit

**Date:** 2026-08-14 · **Scope:** policy pages, SEO, analytics, lifting `noindex`
**Status:** audit only. Nothing was changed. No plan yet — that is Stage 2.

---

## How this was measured

Everything below is either a live measurement, a database read, or a file and
line. Where something could not be established from here it says so and goes on
the owner's list rather than being guessed.

| Instrument | What it produced |
| --- | --- |
| `curl` against `www.footvault.in` | headers, `robots.txt`, `sitemap.xml`, rendered `<head>` on 9 routes |
| Lighthouse 13.4.1, `--throttling-method=devtools` | production SEO score and the per-audit breakdown |
| Supabase SQL (read-only) | `pages`, `site_settings`, `products`, `categories`, `collections`, `product_images`, `homepage_sections`, `orders`, `reviews` |
| `npm run audit:literals` | full run, both halves, against the live database |
| Source reading | `next.config.ts`, `src/lib/csp.ts`, `src/lib/indexing.ts`, `src/lib/content-tokens.ts`, `src/lib/shipping/estimate.ts`, every `generateMetadata`, `scripts/audit/*` |
| Vercel documentation (MCP) | Web Analytics script delivery path, for the CSP question |
| SEO skill references | Whitespark 2026, Search Atlas ML 2025, Sterling Sky, BrightLocal 2026 benchmarks |

No subagents were dispatched. No files were modified.

---

## The thing to be straight about before anything else

The owner has asked to appear at the top of Google. That cannot be promised by
anyone, and a plan that implies it is lying.

**Achievable, and worth the effort:** being correctly indexed; ranking first for
the shop's own name; appearing in the Google local pack for shoe-shop searches
in Kadapa/Cuddapah; picking up long-tail product queries.

**Not achievable in any timeframe worth planning around:** outranking Myntra,
Ajio, Amazon, Flipkart, Nike or Adidas for "buy sneakers online", "shoes online
India", or any head term of that shape. This shop has 35 products, no backlinks,
no domain authority and no delivered orders. The measured reason this still
leaves a real opportunity is in §1D: for local search, domain authority explains
**5.9%** of ranking variance and physical proximity explains **55.2%**. The shop
has the thing that matters and lacks the thing that does not.

---

# 1A · What the policy pages actually say now

Seven pages, all `is_published = true`. All seven have `meta_title = NULL` and
fall back to `pages.title`.

| Slug | Title | Body | Verdict |
| --- | --- | ---: | --- |
| `returns` | Returns and damage | 2,204 ch | Body is good. **Its meta description contradicts it.** |
| `shipping` | Shipping | 1,426 ch | Tokenised for money, **wrong on time** |
| `privacy` | Privacy policy | 618 ch | **States a falsehood**; not DPDP-shaped |
| `size-guide` | Size guide | 601 ch | Accurate, usable |
| `contact` | Contact us | 494 ch | **Contains no contact details** |
| `about` | About Foot Vault | 486 ch | Generic; never says Cuddapah |
| `terms` | Terms of sale | 463 ch | **Missing most of what Terms must carry** |

---

### A1 · CRITICAL — the returns snippet promises the opposite of the returns policy

Live on the wire at `https://www.footvault.in/page/returns`:

```html
<meta name="description" content="Foot Vault&#x27;s 7 day free return and size exchange policy."/>
```

The page it describes says, in bold, in its own body:

> **We do not offer refunds.** Not on change of mind, not on size, not on colour.
> …
> **Sizes.** We cannot exchange for a different size…
> Contact us **within 24 hours of the parcel being delivered**.

And `site_settings.return_window_days = 1`, whose own description reads *"There
is no returns window… No refunds are offered; damage in transit is replaced."*

This is the single worst finding in the audit, and its severity comes from
**where** the text sits rather than what it says. A meta description is the
sentence Google prints under the link. It is read *before* the click, by someone
deciding whether to trust an unknown shop, and it promises a seven-day free
return and a size exchange that this shop explicitly does not offer. The moment
`noindex` lifts, that becomes the shop's advertised returns policy in search
results.

It is also a promise the shop never made — the body was drafted and reviewed;
the description was not updated with it.

### A2 · CRITICAL — the privacy policy states something untrue about data sharing

Full text of the relevant sentence:

> We use it to pack and deliver your order… We do not sell it, and **we do not
> share it with anyone other than the courier carrying your parcel.**

Personal data demonstrably leaves the shop to at least six processors:

| Processor | What goes | Evidence |
| --- | --- | --- |
| Razorpay | name, email, phone, amount | `src/lib/payments/*`, live CSP allowlist |
| Shiprocket | name, full address, phone | `src/lib/shipping/*` |
| Resend | email address, order contents | `src/lib/email/*`, `audit:emails` |
| Supabase | everything — it is the database | `NEXT_PUBLIC_SUPABASE_URL` |
| Google | identity, on sign-in | `src/app/auth/callback` |
| Vercel | request logs, IP | hosting |

At 618 characters the page also carries none of the structure India's DPDP Act
expects: no itemised notice of purposes, no statement of Data Principal rights,
no named grievance route, no retention periods beyond one sentence. The "7 days"
deletion commitment is a hardcoded promise with no setting behind it.

This is a legal exposure that exists **today**, independently of analytics, and
it gets worse the moment the shop is indexed and findable.

### A3 · HIGH — the dispatch cutoff on the shipping page is five hours wrong

| Source | Says |
| --- | --- |
| `/page/shipping` body | "Orders placed before **4pm** on a working day are dispatched the same day." |
| `src/lib/shipping/estimate.ts:50` | `export const PICKUP_CUTOFF_HOUR_IST = 11;` |
| `scripts/audit/delivery-estimate.ts:66` | asserts the 10:59 / 11:00 boundary differs by exactly one day |

A customer ordering at 15:00 reads the page, expects same-day dispatch, and gets
tomorrow's pickup. The code is right, gated, and has been for some time — the
published sentence was never brought along.

### A4 · HIGH — one delivery figure is quoted for the whole country

The page says *"Most addresses receive in 3–5 working days"* to everyone.

`src/lib/shipping/estimate.ts` was written specifically to end this habit, and
its header names the real numbers:

> The shop told every customer "about 4 days". The real figures from the live
> serviceability response are **Delhi 7, Hyderabad and Bangalore 4, Cuddapah
> local 3** — and the correct number was already in the response the shop
> fetches on every quote.

So the module that removes the defect shipped, and the page that contains the
defect did not. A Delhi customer is under-promised by two or more days on the
page, then shown a correct, later date at checkout.

### A5 · HIGH — WhatsApp is unreachable, and two policies route customers through it

Measured: **zero** `wa.me` links on the homepage or the contact page. The string
`98450 22001` appears nowhere in the rendered site.

What depends on it:

- **Returns policy** — *"Call or WhatsApp the store on the number on our contact
  page… With only 24 hours, call or WhatsApp first rather than waiting on an
  email reply."*
- **Contact page** — *"The fastest way to reach us is WhatsApp — we answer during
  shop hours and usually within the hour."*

Why it is missing: `site_settings.contact.whatsapp` is set to `+91 98450 22001`,
but `site-footer.tsx` renders only `phone`, `email` and `address` from that
object (lines 67–94). WhatsApp *is* wired as a social icon
(`SOCIAL_ICONS.whatsapp`), but `site_settings.social` contains only `facebook`
and `instagram`. The setting exists and nothing reads it.

Compounding it: **the contact page body contains no phone number, no WhatsApp
number, no address and no opening hours.** It defers to the footer — *"Our
contact details and opening hours are in the footer of every page"* — so the
page a person lands on from a "contact" search carries none of the four things
they came for. That is also the page `LocalBusiness` schema and the local pack
will be judged against.

Net effect: a customer with a damaged parcel and a 24-hour deadline is told to
WhatsApp a number the site never shows them.

### A6 · HIGH — Terms of sale is 463 characters and missing most of its content

Present: pricing includes taxes, order acceptance on our confirmation, live
stock counts, statutory rights preserved.

Absent, all named by the brief: cancellation before dispatch, the
replacement-only position, governing law and jurisdiction, the registered
business name, the GSTIN.

There is also a wording collision between two published pages: Terms says *"we
will **refund** that line in full"* for an out-of-stock item, while Returns says
flatly *"**We do not offer refunds.**"* The two are reconcilable in intent — a
shop-side failure is not a change of mind, and Returns says so elsewhere — but
they are not reconciled in words, and a customer quoting one at the other is a
dispute the shop would lose on its own copy.

### A7 · MEDIUM — hardcoded time values in published copy, one of which has a token already

| Page | Literal | Setting or token that exists |
| --- | --- | --- |
| `returns` | "24 hours" ×2 | **`{{return_window}}`** — resolves to exactly `"24 hours"` (`content-tokens.ts:92`, `describeWindow`) |
| `shipping` | "3–5 working days", "4pm" | none — see A3, A4 |
| `privacy` | "7 days" | none |

The returns case is the clearest: a token exists, produces the identical string
today, and is not used — so an owner who raises the window in `/admin/settings`
changes the checkout and not the policy page.

### A8 · MEDIUM — the literals gate is green, and cannot see any of the above

`npm run audit:literals` passes in full: 179 component files, 367 source files,
7 pages, 13 settings, 6 homepage sections, 1 banner, 3 collections. Both halves
ran — the content half reached the live database.

Two structural reasons it is green anyway:

1. **It only tests currency.** `const CURRENCY = /₹\s*\d/` and
   `RUPEES_WORD = /\bRs\.?\s*\d/`. A day count, an hour count and a clock time
   are invisible to it. The brief's own quality gate asks for both.
2. **It does not read the columns where the worst defect lives.** The `pages`
   surface is declared `columns: ["title", "body"]`. `meta_title` and
   `meta_description` are never scanned — and A1 is in `meta_description`.

Worth stating plainly, because this gate's own header is about exactly this
failure mode: *"a gate that checks the two places you already fixed is a gate
that proves you fixed them."* It has now happened a fourth time, in a new column.

### A9 · MEDIUM — the About page is 486 characters and never says where the shop is

No history, no founding, no owner, no street, and the word "Cuddapah" does not
appear. For an unknown shop this is the page that converts a stranger, and for
local search it is one of the strongest places to state the location in prose.

### A10 · LOW — a dead constant that contradicts the live policy

`src/lib/site-config.ts:19` — `export const RETURN_WINDOW_DAYS = 7;`. Never
imported anywhere. Harmless today, wrong by a factor of seven, and sitting one
import away from becoming A1 in code form.

### A11 · LOW — doubled brand in the About title

`<title>About Foot Vault — Foot Vault</title>`. The root template is
`%s — ${siteConfig.name}` and the page title already contains the name.

### A12 · OWNER — the social links are presented as the shop's identity and are unverified

`site_settings.social` holds `facebook.com/footvault` and
`instagram.com/footvault`, rendered in the footer with `rel="noopener
noreferrer me"`. `rel="me"` is an identity claim. Both hosts answered a bare 301
to their `www` form, which proves nothing about whether the profiles exist or
belong to this shop. **Not something to determine from here** — owner
confirmation, per the rule about never inventing a fact about the business.

### A13 · GOOD — the ₹2,499 escape is genuinely closed

No currency literal exists anywhere in code or owner-edited content. The
threshold now lives in one place, `site_settings.shipping.free_above_paise =
159900` (**₹1,599**), and the shipping page reads it through
`{{free_shipping_threshold}}`. The token mechanism also covers
`{{cod_minimum_order_value}}` and `{{delivery_advance}}`, and an unknown token is
left visible rather than blanked. This part of the work held.

---

# 1B · What Google would see today

### B1 · Correct, and confirmed on the wire

```
x-robots-tag: noindex, nofollow, noarchive
```

`robots.txt` returns `User-Agent: *` / `Disallow: /`. Both read the same
`isIndexable()` gate, so they cannot disagree. Also present and correct:
`x-content-type-options`, `x-frame-options: DENY`, `referrer-policy`,
`permissions-policy`, an **enforcing** `content-security-policy`,
`reporting-endpoints`, and `strict-transport-security: max-age=63072000` from
Vercel. `https://footvault.in/` answers `308 → https://www.footvault.in/`.

### B2 · MEASURED — Lighthouse SEO is 66, and `noindex` is the only failing audit

Production homepage, devtools throttling:

```
SEO score: 66
FAIL  is-crawlable  score=0  :: Page is blocked from indexing
```

Nothing else fails. The brief's hypothesis is **confirmed**: the 58–69 band is
`noindex` and nothing else. One caveat, in B3.

### B3 · HIGH — the homepage has no canonical, and the score will never tell you

Confirmed two ways. On the wire, the homepage `<head>` has no `<link
rel="canonical">` at all. In source, `src/app/(storefront)/page.tsx` exports no
`metadata` and no `generateMetadata` — it is the only storefront template
without one. The other five have canonicals:

| Template | Canonical |
| --- | --- |
| `product/[slug]` | ✅ `/product/${slug}` |
| `shop` | ✅ `/shop` |
| `shop/[category]` | ✅ `/shop/${slug}` |
| `collection/[slug]` | ✅ `/collection/${slug}` |
| `page/[slug]` | ✅ `/page/${slug}` |
| **`/` (home)** | ❌ **none** |

The trap is in how Lighthouse reports it. The `canonical` audit came back
`notApplicable` — not a failure — because Lighthouse skips the audit when no
canonical element exists. So **lifting `noindex` will move this route from 66 to
roughly 100 while the gap stays invisible.** A score of 100 will be read as
"done".

It matters most on `/`, which is the URL that reliably attracts duplicates:
`?utm_*` and `?fbclid` from any campaign, and the apex/`www` pair.

### B4 · HIGH — the homepage carries zero structured data

Measured: **0** `application/ld+json` blocks on `/`. What ships site-wide is
`Product` (product pages) and `BreadcrumbList` (via `Breadcrumbs`). Absent
entirely: `Organization`, `LocalBusiness`, `WebSite`.

For this shop specifically, `LocalBusiness` with the real Cuddapah address is
likely the single highest-value markup on the site — see §1D.

### B5 · HIGH — the sitemap has no `lastmod` on any URL

Measured on production: **62 `<loc>` elements, 0 `lastmod` elements.**
`src/app/sitemap.ts` emits `changeFrequency` and `priority` — the two fields
Google has said it largely ignores — and omits the one it uses.

Composition is otherwise correct and DB-driven: 35 products, 15 categories, 7
CMS pages, 3 collections, `/`, `/shop`. `/cart`, `/wishlist`, `/search`,
`/account`, `/checkout` and `/order` are deliberately absent.

Every table the sitemap reads carries an `updated_at`, so the data for real
`lastmod` values already exists.

### B6 · MEDIUM — the sitemap is served in full while the shop is hidden

`https://www.footvault.in/sitemap.xml` answers **200 with all 62 URLs** today,
with `SITE_INDEXABLE=false`. `robots.ts` withholds the *link* to it, and its
comment states the intent as:

> the sitemap is withheld rather than advertising every URL we are asking not to
> be indexed.

The link is withheld; the document is not. Low practical risk — the URLs also
carry `noindex` and `robots.txt` disallows everything — but the stated intent
and the actual behaviour differ, and this is exactly the kind of gap that gets
inherited as an assumption.

### B7 · MEDIUM — Product markup cannot produce a rich result while the images are SVG

| `product_images` | Count |
| --- | ---: |
| Total rows | 123 |
| `.svg` | **120** |
| raster (`.webp`/`.jpg`/`.png`) | 1 |
| missing `alt_text` | **0** |

The `Product` JSON-LD is well built — real prices, per-variant `Offer` with real
availability, and `aggregateRating` correctly omitted at zero reviews. But
Google's Product rich-result image requirement does not accept SVG, so no
product on the site can currently produce a rich result regardless of markup
quality.

This is the same fact as Batch D precondition 1 ("real product photography is
live"), arriving from the SEO side. It is a reason the photography gates the
value of the structured-data work, not just the look of the shop.

### B8 · MEDIUM — content is thin nearly everywhere, measured

Benchmarks from the SEO skill's quality gates, against live data:

| Surface | Measured | Benchmark | Gap |
| --- | --- | --- | --- |
| Product descriptions | min 72, **avg 126**, max 192 **characters** (~20 words) | 400 words | ~20× |
| Product meta descriptions | **avg 54**, max 99 chars | ~155 chars | ~3× |
| Category descriptions | **12 of 15 empty**; the 3 populated average 53 chars | 400 words | near-total |
| About page | 486 chars (~80 words) | 400 words | ~5× |

All 35 products have a unique `meta_title` and a unique `meta_description` — so
there is no duplicate-description problem, only a thinness one. The weakest
example is real and worth quoting: the Woodland Nubuck Trek Boot's entire meta
description is **"End of the line."** (16 characters). It is good copywriting and
a useless search snippet.

The 12 empty categories fall back to a template at
`src/app/(storefront)/shop/[category]/page.tsx:38`:

```
`${title} at Foot Vault. Every size we hold, shown on every shoe.`
```

That produces 12 descriptions differing only by their prefix — "Men · Sneakers
at Foot Vault…", "Women · Sneakers at Foot Vault…". Technically unique strings,
functionally boilerplate. This is where most of the achievable on-site gain sits.

### B9 · LOW — one product title will truncate in results

`Gel-Kayano 31 Wide Fit Stability Running Trainer for Overpronation — ASICS` is
74 characters; the root template appends ` — Foot Vault` for **87**. It is the
only one over the line — the other 34 render between 39 and 44.

### B10 · MEDIUM — `audit:reachability` cannot detect an unlinked policy page

`matcherFor("/page/[slug]")` compiles to `^/page/[^/]+$`, and the crawl marks a
dynamic segment reached when *any* concrete instance is harvested. So linking a
single CMS page satisfies the gate for all seven.

**The practical risk today is low**, and the reason is worth recording: the
footer's Help column is `pages.map(...)` over every published CMS page
(`site-footer.tsx`), so a page published from the admin self-links with no
deploy. The gate is weak; the architecture underneath it is not. Batch A adds
and edits pages, so this is the moment to make the gate assert what the footer
already does.

### B11 · LOW — no stated position on AI crawlers, and no `llms.txt`

`/llms.txt` returns 404. `robots.ts` emits a single `*` rule, so on the day
indexing opens, GPTBot, ClaudeBot and PerplexityBot are all allowed by the
wildcard — by default rather than by decision.

### B12 · GOOD — what is already right

- **Canonicals strip the query string** on `/shop`, `/shop/[category]` and
  `/collection/[slug]`, so the faceted-URL trap the brief warns about is already
  handled: `/shop/mens-sneakers?size=8&color=black` consolidates to
  `/shop/mens-sneakers`.
- **Category titles are unique despite duplicate names.** Three categories are
  named "Sneakers"; `generateMetadata` builds `${parent.name} · ${category.name}`,
  giving "Men · Sneakers", "Women · Sneakers", "Kids · Sneakers".
- **Heading hierarchy is sound.** Exactly one `hero` section is active, so the
  homepage has one `h1` and the rest are `h2`. Every template has an `h1`.
- **Alt text is complete** — 0 of 123 images missing it.
- **Open Graph and Twitter cards are complete** on the homepage, with generated
  per-route OG images at 1200×630.
- **Per-visitor routes are correctly excluded** — `/cart`, `/wishlist`,
  `/account/*`, `/checkout`, `/order/*` carry `robots: noindex`; `/search` is
  `noindex, follow`, which is the right choice.
- **`AggregateRating` is correctly gated** on `reviewCount > 0` and built from
  the live aggregate rather than the cached one.

---

# 1C · Analytics

### C1 · Nothing is installed. Not partially — at all.

- No analytics dependency in `package.json`.
- No `@vercel/*` package in `node_modules`.
- No `gtag`, `dataLayer`, `googletagmanager`, `posthog`, `plausible`, `umami`,
  `mixpanel` or `speed-insights` reference anywhere in `src/` or `scripts/`.

A clean slate, which is the easiest starting position — nothing half-wired to
untangle.

### C2 · The CSP is enforcing and closed by default. This is the interaction that will bite.

Live policy opens with `default-src 'self'`, and the two directives that matter:

```
script-src  'self' 'unsafe-inline' https://checkout.razorpay.com https://cdn.razorpay.com https://checkout-static-next.razorpay.com
connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.razorpay.com https://lumberjack*.razorpay.com
```

No analytics host is present in either. Under `enforce`, a script from an
unlisted host is blocked and a beacon to an unlisted host is blocked — and the
brief is right that it fails silently: analytics that never loads produces an
empty dashboard, which is indistinguishable from a quiet week.

### C3 · The report sink cannot be the detector — this constrains how Batch C must be proven

From `docs/operations.md`, and it is unusually important here:

> `/api/csp-report` receiving nothing does **not** mean there were no
> violations. Browser-to-sink delivery has never been demonstrated.

Two consequences for the analytics work:

1. **The browser console is the only valid primary instrument.** The brief's
   gate — *"proven by a real page load with the console clean, not by reading
   config"* — is not belt-and-braces; it is the only thing that works.
2. **A Playwright `page.evaluate` probe is not a valid control.** CDP
   `Runtime.evaluate` is not subject to the page's CSP, so an injected test
   script proves nothing. Proving a host is *needed* requires an A/B production
   build, the method already used for the Zod `jitless` fix.

### C4 · Vercel Analytics is expected to need no CSP change — and that is checkable

Vercel's documentation shows the injected tag as a **relative, same-origin**
path:

```html
<script defer src="/<unique-path>/script.js"></script>
```

The view/event beacons post to same-origin paths as well; the `scriptSrc`,
`viewEndpoint` and `eventEndpoint` props exist precisely to override that when
someone needs an absolute URL. So the default install is covered by the
`'self'` already in both `script-src` and `connect-src`, and requires **zero**
changes to `csp.ts`.

Stated as an expectation, not a fact: per C3 it must still be proven by a real
production page load with a clean console.

### C5 · GA4 requires CSP changes, and the exact host set must be measured

At minimum `script-src https://www.googletagmanager.com` and `connect-src` for
the `google-analytics.com` / `analytics.google.com` / `googletagmanager.com`
families, plus possibly `img-src` for the pixel fallback path. Regional
endpoints (`region1.google-analytics.com` and siblings) are the classic omission.

The honest position: that list should be **derived from a recorded page load on
a production build**, the same way every Razorpay origin in `csp.ts` was, rather
than transcribed from documentation or memory. Every origin currently in the
policy was measured; a guessed one would be the first exception.

### C6 · One forward-looking constraint on how analytics is installed

`script-src` currently carries `'unsafe-inline'`, so a pasted GA4 snippet would
execute today. But `csp.ts` names the nonce migration as a live follow-up, and
that change removes `'unsafe-inline'`. Analytics installed **behind an
interface**, as the brief requires, survives that migration; a snippet pasted
into the layout does not. Worth deciding once, now.

### C7 · The honest DPDP position

Not legal advice, and the final call belongs to the owner and their counsel.
What can be stated from here:

- **The obligation already exists, before analytics.** Personal data flows to six
  processors today (A2) and the privacy policy denies it. That is the compliance
  problem to fix first; analytics only adds to a notice that has to be rewritten
  regardless.
- **DPDP is not ePrivacy.** India's Act does not carry the EU's specific
  cookie-consent mandate. What it requires is a clear itemised notice, purpose
  limitation, a route to withdraw consent, Data Principal rights, and a named
  grievance contact. "Do we need a cookie banner?" is therefore the wrong first
  question; "does our notice describe what actually happens?" is the right one,
  and the current answer is no.
- **The two candidate tools sit on opposite sides of the line.** Cookieless
  analytics that sets no identifier and stores nothing per-person is defensible
  under an updated privacy notice alone. GA4 sets a pseudonymous client-ID
  cookie and transfers data abroad — a materially stronger argument for explicit
  consent, and a materially larger privacy-notice section.
- **If a banner is implemented it must be a real choice.** A banner that records
  no refusal path is worse than none: it documents an intent to comply while not
  complying.

### C8 · Search Console is not set up, and it is the one the owner actually asked for

The owner's real question — *what do people search to find the shop* — is
answered by Search Console and by nothing else. It is also the only place a
sitemap can be submitted and indexing status verified. Verification is an owner
task; the site-side half is a DNS record or a meta tag.

---

# 1D · What is actually competitive

### The shop's real position, measured

| | |
| --- | ---: |
| Active products | 35 |
| Brands | 12 (adidas, ASICS, Bata, Campus, Crocs, Metro, New Balance, Nike, Puma, Red Chief, Skechers, Woodland) |
| Orders placed | 24 |
| **Orders delivered** | **0** |
| **Reviews** | **0** |
| Locations | 1 — Cuddapah / Kadapa, AP 516360 |
| Backlinks / domain authority | none |
| Indexed | no |

### D1 · Local SEO is worth more than product SEO here, and the margin is not close

This is the brief's own hypothesis and the data supports it strongly.

| Factor | Share of local-pack ranking variance | Source |
| --- | ---: | --- |
| **Proximity of address to searcher** | **55.2%** | Search Atlas ML study, Aug 2025 |
| Review count | 19.2% | same |
| **Domain power** | **5.9%** | same |

And by factor group (Whitespark 2026, 47 experts, 187 factors): **GBP signals
32%**, review signals ~20%, on-page ~15–19%, link signals declining.

The single highest-scoring individual factor is the **primary GBP category**;
the single worst negative factor is an **incorrect primary category**.

Read plainly: the one asset this shop cannot buy — domain authority — is worth
5.9%. The one asset it already has — a real shop at a real address in the town
people are searching from — is worth 55.2%. That is the whole argument for
prioritising local, and it is why a physical shop in Kadapa can win a search
that a new national ecommerce site cannot.

### D2 · Reviews are the second lever, and the shop has zero of both kinds

Two different assets, commonly confused:

| | Feeds | Shop's status |
| --- | --- | --- |
| **Google (GBP) reviews** | the map pack | 0 — no profile yet |
| **On-site reviews** | `AggregateRating` stars in organic results | 0 — machinery exists, unused |

Benchmarks: Sterling Sky finds a significant ranking step at **10** Google
reviews — the "Magic 10", where 9→10 moves rankings and 10→11 does not — and
finds rankings decay if no new review arrives for about three weeks. BrightLocal
2026: **74%** of consumers only care about reviews from the last three months,
and **68%** filter to 4+ stars.

Both are blocked on the same upstream fact: **0 delivered orders**. Nothing can
be reviewed until parcels land. That makes review generation a sequenced
consequence of trading rather than a task that can be started now — worth saying
so the plan does not schedule it as if it were.

One caution from the same references: review gating is prohibited by both Google
and the FTC, and Google removed 240M+ policy-violating reviews in 2024. Asking
every customer is fine; asking only the happy ones is not.

### D3 · Realistically rankable

**Brand terms — should be #1 within weeks of indexing.** "Foot Vault", "Foot
Vault Cuddapah", "Foot Vault Kadapa", "footvault.in". Nothing else competes for
the exact string, and this is the search in the brief's own "done when": *a
stranger searching "Foot Vault Cuddapah" finds the shop*.

**Local terms — winnable, and mostly won in the map pack rather than the blue
links.** "shoe shop in Kadapa", "footwear shop Kadapa", "sneakers Kadapa",
"school shoes Kadapa", "Nike showroom Kadapa", "shoe shop near RTC bus stand
Kadapa". The shop's address — Classic Vastralayam Complex, near the RTC bus
stand — is a genuine local landmark and worth stating in prose, not just in a
settings row.

**Category + local — the sweet spot.** "mens formal shoes Kadapa", "kids school
shoes Kadapa", "womens sandals Kadapa". Low volume, low competition, high intent,
and directly served by the 12 empty category pages in B8.

**Long-tail product — reachable, but only with real content.** "Red Chief leather
oxford price", "wide fit stability running shoe India", "<brand> <model> size 9
India". 35 SKUs is few enough to write 400 genuine words for each, which is
exactly the scale at which that stops being a content-farm exercise.

### D4 · Out of reach — stated plainly, as the brief asks

"buy sneakers online", "shoes online India", "sneakers for men", "running shoes",
"Nike Air Max 90", "best sneakers". These belong to Myntra, Ajio, Amazon,
Flipkart and the brands' own sites. A shop with no backlinks, no domain
authority, 35 SKUs and no trading history does not compete for them — not this
quarter, not this year, and not as a result of anything in this project.

Any effort spent chasing them is effort not spent on the local pack, where the
same shop can genuinely be first.

### D5 · Cuddapah vs Kadapa — the cheapest local finding in this audit

The city's official name is **Kadapa**; "Cuddapah" is the older anglicised
spelling. Both are actively searched, and which one a person types depends
largely on their age and whether they are local.

Measured on the production homepage: **"Cuddapah" appears 12 times. "Kadapa"
appears zero times.** The same holds across `site_settings.contact.address`, the
site description and every policy page.

Whichever the owner treats as primary, both names need to appear — in the
address, in the About page prose, and in the `LocalBusiness` schema — or roughly
half the local searches never match the shop's own text. This costs nothing and
is the highest ratio of value to effort in the entire audit.

### D6 · The right schema type, and an honest note on what schema buys

`ShoeStore` (Schema.org: `LocalBusiness` → `Store` → `ShoeStore`) rather than a
generic `LocalBusiness` — the reference rule is to avoid the generic type where a
specific subtype exists. Required properties are `name`, which must match the
GBP listing **exactly**, and a full `PostalAddress`.

The honest caveat, from the same reference: schema is **not a direct ranking
factor** (confirmed by both Mueller and Illyes). It buys rich results, entity
understanding and AI-search citability. It does not buy position. Worth doing,
worth not overselling.

### D7 · The highest-value action is not on the website

A verified **Google Business Profile** with the correct primary category, real
hours, real photos and the real address. GBP signals are 32% of the local pack;
proximity is 55% of the variance; and neither can be supplied by markup on a
website. Nothing in Batch B substitutes for the listing.

This is an owner task, and it is the one that most deserves to be started before
the code work finishes rather than after.

---

# Summary — findings by severity

| # | Severity | Finding |
| --- | --- | --- |
| A1 | **Critical** | Returns meta description promises a 7-day free return and size exchange; the policy offers neither |
| A2 | **Critical** | Privacy policy denies sharing data with anyone but the courier; six processors receive it |
| A3 | High | Shipping page states a 4pm dispatch cutoff; the real cutoff is 11:00 |
| A4 | High | Shipping page quotes "3–5 working days" nationwide; real figures are Delhi 7 / Hyderabad-Bangalore 4 / local 3 |
| A5 | High | WhatsApp unreachable site-wide; the returns and contact pages both route customers through it |
| A6 | High | Terms of sale is 463 chars; missing cancellation, replacement-only, governing law, GSTIN, legal name |
| B3 | High | Homepage has no canonical — and Lighthouse reports it as *notApplicable*, so the score will read 100 |
| B4 | High | Homepage has zero JSON-LD; no `Organization`, no `LocalBusiness` anywhere on the site |
| B5 | High | Sitemap emits no `lastmod` on any of 62 URLs |
| A7 | Medium | Hardcoded time values in three published pages; `{{return_window}}` exists and is unused |
| A8 | Medium | `audit:literals` tests currency only, and never reads `pages.meta_description` where A1 lives |
| A9 | Medium | About page is 486 chars and never mentions Cuddapah |
| B6 | Medium | `/sitemap.xml` serves all 62 URLs while the shop is `noindex` |
| B7 | Medium | 120 of 123 product images are SVG; no Product rich result is possible until photography lands |
| B8 | Medium | Content thin across the board — 12 of 15 categories empty, products ~126 chars |
| B10 | Medium | `audit:reachability` cannot detect an unlinked CMS page |
| C2 | Medium | Enforcing CSP names no analytics host; a missing one fails silently |
| A10 | Low | Dead `RETURN_WINDOW_DAYS = 7` contradicting the live 24-hour policy |
| A11 | Low | `About Foot Vault — Foot Vault` doubles the brand |
| B9 | Low | One product title renders at 87 chars |
| B11 | Low | No `llms.txt`; AI crawlers allowed by wildcard rather than by decision |
| D5 | — | "Kadapa" appears nowhere on the site; ~half of local searches cannot match |

**Confirmed sound and not to be touched:** the noindex gate and its no-early-return
shape; the four security headers and enforcing CSP; canonicals on five templates;
query-stripped canonicals defusing the faceted-URL trap; unique category titles;
alt text at 100%; `AggregateRating` gating; OG/Twitter and generated OG images;
per-visitor routes correctly `noindex`; the currency-token mechanism.

---

# Owner tasks — listed, not attempted

1. **Google Business Profile** — create and verify, with the correct primary
   category. Highest-value single action available (§D1, §D7).
2. **Google Search Console** — verification, so indexing can be confirmed and
   the sitemap submitted (§C8).
3. **The WhatsApp number** — confirm `+91 98450 22001` is correct and is a
   WhatsApp-capable line. Two policies depend on it and it currently appears
   nowhere (§A5).
4. **Registered business name and GSTIN** — needed before Terms can be written
   truthfully (§A6).
5. **Facebook and Instagram profiles** — confirm both exist and belong to the
   shop; they carry `rel="me"` today (§A12).
6. **Kadapa or Cuddapah** — which is primary in customer-facing copy. Both will
   appear regardless (§D5).
7. **The photographs** — 120 of 123 images are placeholder SVGs. This gates
   Product rich results as well as launch (§B7).
8. **Data-deletion turnaround** — the privacy page promises 7 days with nothing
   behind it. Confirm or change (§A2).
9. **Analytics choice** — a recommendation with costs and consent implications
   comes in Stage 2; the decision is the owner's (§C4, §C5, §C7).

---

# Quality-gate readiness

The brief's own gates, against today's state:

| Gate | Status |
| --- | --- |
| `audit:reachability` green including every new page | ⚠️ passes, but cannot detect an unlinked CMS page (B10) |
| No currency literal in any published page | ✅ genuinely clean (A13) |
| No hardcoded day count in any published page | ❌ three pages, and the gate cannot see them (A7, A8) |
| Every route has a unique title and description | ⚠️ unique, but 12 categories are boilerplate (B8) |
| No page missing a canonical | ❌ homepage (B3) |
| Structured data validates | ⚠️ valid, but no `Organization`/`LocalBusiness` and no rich result possible (B4, B7) |
| `AggregateRating` absent where there are no reviews | ✅ correctly gated |
| Analytics does not break the CSP, proven by a real page load | n/a — nothing installed (C1) |
| `audit:headers` green under both `SITE_INDEXABLE` values | ✅ gate exists and covers exactly this |
| Lighthouse on the live domain | ✅ measured: SEO 66, sole failure `is-crawlable` (B2) |

---

## Stage 2 will need decisions on

1. Whether the returns **policy** or the returns **meta description** is the
   truth (A1). The body reads as deliberate and reviewed; the description reads
   as stale. Assumed stale unless told otherwise — but it is a promise, so it is
   the owner's call.
2. The analytics tool, with the consent obligation of each stated (C4, C5, C7).
3. Whether the deletion SLA and dispatch cutoff become `site_settings` rows or
   stay as owner-confirmed prose (A3, A7).
4. Which name leads in customer-facing copy — Kadapa or Cuddapah (D5).

**Stage 1 complete. No changes made. Awaiting approval to produce
`claudeExecutionReport/launch-plan.md`.**
