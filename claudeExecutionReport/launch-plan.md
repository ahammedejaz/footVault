# Launch readiness — Stage 2 plan

**Date:** 2026-08-14 · **Follows:** `claudeExecutionReport/launch-audit.md`
**Status:** plan only. Nothing has been changed. Awaiting approval to build.

---

## What the rulings changed

Five rulings came back on the audit. Each one moved the plan, and in two cases
it moved it away from the obvious fix toward the mechanism underneath.

| Ruling | Effect on this plan |
| --- | --- |
| 1 — body is truth; **the blind spot is the more important half** | The one-line meta fix is A1. The gate extension is **A2**, and it is the larger item: `audit:literals` must read `meta_title`/`meta_description` and must learn time literals. |
| 2 — code fixed, copy not; drive values through tokens | Three new tokens, one new setting, **and** a new gate that catches the privacy page's class of drift — which is not a number and needs a different mechanism (A7). |
| 3 — canonical is a launch blocker; **`notApplicable` is never a pass** | B1 plus a new `audit:seo` gate whose central design rule is that absence fails. Proven by a negative control that removes the export. |
| 4 — Kadapa is the highest-value item | Promoted out of "content polish" into its own cross-cutting batch (**Batch K**) that touches metadata, schema, three pages and the address. |
| 5 — recommend, don't default | §Batch C carries a recommendation with reasoning and the counter-case. **Vercel Analytics + Search Console.** |

---

## Blocker to declare before anything else

### BotID does not exist in this repository

Batch D precondition 4 is *"BotID is on checkout and coupon-check — Group 3 from
the security work."* Measured:

```
grep -rni "botid|@vercel/botid" src scripts package.json vercel.json docs
  → docs/foot-vault-launch-brief.md:123     (the brief itself, and nothing else)
```

No package, no code, no route config. `vercel.json` contains only the `bom1`
region pin.

This is not a gap in the plan below — it is work in a different project (Group 3
of the security brief) that Batch D is gated on. **The flip cannot happen until
it lands**, and no amount of Batch A–C progress changes that.

**Owner decision required:** either BotID is pulled into this project's scope as
a Batch C½ (a real increase — it touches the checkout and coupon-check paths,
which are money paths under the stop-and-ask rule), or Batch D waits for Group 3.
The plan below assumes **it waits**, and Batch D is written as blocked.

One note for whoever builds it: `next.config.ts` already anticipates the
collision — `X-Frame-Options: DENY` is site-wide, and the comment records that
BotID's challenge path will need `SAMEORIGIN` on its own route in `vercel.json`.
That file must keep the `bom1` pin through any such edit.

---

## Cost model for a new `site_settings` key

Stated once, because it prices several items below. Adding a key is four steps,
not one, and skipping any of them fails a gate:

1. The row itself.
2. A classification in `src/lib/settings-visibility.ts` **with a reason** —
   `audit:settings-visibility` fails on an unclassified key, on a mismatch with
   `is_public`, and on a missing reason.
3. An admin control on `/admin/settings` with a **visible label**.
4. An entry in `CONTROLS` in `scripts/audit/settings-controls.ts` that finds the
   control by its label, changes it, and asserts the stored value changed. The
   run fails if any listed control was never operated.

So the plan deliberately adds **one** new settings row, not five. Where a value
already exists in code and nothing on any screen should edit it, the fix is a
token that reads the code — which satisfies ruling 2's actual requirement (the
page cannot be left behind) at a fraction of the cost.

---

# Batch A — the policy pages

## A1 · Fix the returns meta description · **Critical**

**Fix.** Replace `pages.meta_description` for `returns` with copy that describes
the policy the body states — replacement-only, 24-hour damage window, no refunds,
no size exchange. Written to be true first and attractive second; a snippet that
oversells this policy is the defect being removed.

**Files.** Database only — `pages` row `returns`. No code.

**Test.** `audit:literals` extended by A2 scans the column and finds no time
literal; a new assertion in `audit:seo` (B2) checks the returns description
against a forbidden-claims list (`refund`, `exchange`, `7 day`, `free return`).

**Risk.** None technical. The copy is a legal-facing promise, so the wording
goes to the owner before it is written to the database.

## A2 · Extend `audit:literals` to the columns and the units it cannot see · **Critical**

Ruling 1 called this the more important half. It is, because A1 is one row and
this is the reason A1 survived a sweep that was specifically looking for it.

**Fix.** Two changes to `scripts/audit/literals.ts`:

1. **Columns.** The `pages` surface is declared `columns: ["title", "body"]`.
   Add `meta_title` and `meta_description`. Audit the other four surfaces for the
   same shape of omission at the same time.
2. **Units.** The gate knows `CURRENCY = /₹\s*\d/` and `RUPEES_WORD`. Add a time
   detector for day/hour/week counts and clock times, with the same
   allowlist-with-a-reason discipline the currency rule already uses — some
   numbers are legitimately literal (UK 6 = EU 40 in the size guide is a
   conversion, not a promise).

**Files.** `scripts/audit/literals.ts`.

**Test.** The gate is its own test, and it must be proven by **failing first**:
run it against the current database and confirm it reports A1's meta description
and A6's three time literals. A gate added green proves nothing. Then fix, then
green.

**Risk.** False positives on legitimate numerals — the size guide is the known
case. Mitigated by the existing `ALLOWED` map pattern, which requires a written
reason per entry.

## A3 · Rewrite the privacy policy for DPDP and for truth · **Critical**

**Fix.** Replace the body. It must name every processor and what goes to each —
Razorpay (payments), Shiprocket (delivery), Resend (email), Supabase (hosting and
database), Google (sign-in), Vercel (hosting and request logs) — and carry the
structure DPDP expects: itemised purposes, retention, Data Principal rights
(access, correction, erasure), how to withdraw consent, and a named grievance
contact. Written for a person to read, not for a lawyer to file.

**Files.** `pages` row `privacy`. Plus A7's gate.

**Test.** A7. Plus `audit:reachability` unchanged.

**Risk.** This is the item most likely to need the owner and possibly counsel.
The grievance contact is a real named route that must exist. The deletion
turnaround is currently an unbacked promise (A6).

**Owner input needed:** grievance contact; confirmed deletion turnaround;
whether a registered entity name belongs here as well as in Terms.

## A4 · Rewrite Terms of sale · **High**

**Fix.** Expand from 463 characters to a real Terms: order acceptance, pricing
and error correction, cancellation before dispatch, the replacement-only
position stated in the same words as the returns page, governing law and
jurisdiction, registered business name and GSTIN.

Resolve the wording collision the audit found: Terms says *"refund that line in
full"* for an out-of-stock item while Returns says *"We do not offer refunds."*
The intent is reconcilable — a shop-side failure is not a change of mind — but
the words must be made to agree, because a customer quoting one at the other
wins on the shop's own copy.

**Files.** `pages` row `terms`.

**Test.** A2's extended gate; a new `audit:seo` assertion that the
replacement-only phrasing appears identically in both pages.

**Risk.** Blocked on the owner for GSTIN and registered name. **Do not invent
either.** If they are unavailable at build time, the clause ships with a marked
placeholder and goes on the owner list — never a guessed value.

## A5 · Make WhatsApp reachable, and put the contact details on the contact page · **High**

Two defects that compound, fixed together.

**Fix.**
1. Render `site_settings.contact.whatsapp` as a real `wa.me` link — in the footer
   contact block beside the phone, and on the contact page. The
   `SOCIAL_ICONS.whatsapp` icon already exists and is unused.
2. Rewrite the contact page body to **contain** the phone, WhatsApp, email,
   address and hours rather than pointing at the footer — every value from
   `site_settings` through the token mechanism, no literals. This is also the
   page `LocalBusiness` and the local pack are judged against.

**Files.** `src/components/storefront/site-footer.tsx`; `pages` row `contact`;
new tokens in `src/lib/content-tokens.ts` (`{{contact_phone}}`,
`{{contact_whatsapp}}`, `{{contact_address}}`, `{{business_hours}}`).

**Test.** Extend `audit:reachability` to assert a `wa.me` link is present and
its href matches `site_settings.contact.whatsapp` after normalisation. New
`audit:seo` assertion that the contact page body contains the phone and address
strings from settings.

**Risk.** The number itself is unverified (owner item). Building the link
against an unconfirmed number ships a dead contact route for the shop's one
warranty commitment — so **the owner confirmation gates the deploy of this item,
not just the copy.**

## A6 · Tokenise the shipping and privacy time values · **High**

The heart of ruling 2. Three values, three different right answers — the ruling
asked for values driven from `site_settings` **and** from the estimate logic, and
picking correctly per value is what stops this becoming five new settings rows.

| Value | Today | Fix | Why this mechanism |
| --- | --- | --- | --- |
| Dispatch cutoff "4pm" | literal, wrong by 5h | **`{{dispatch_cutoff}}` reading `PICKUP_CUTOFF_HOUR_IST`** | `estimate.ts:44-50` argues explicitly that the cutoff belongs in code because it is not a price and nothing on any screen edits it. A token reading the constant honours that and still makes the page impossible to leave behind. No new setting. |
| "3–5 working days" nationwide | literal, wrong for most of India | **`{{delivery_examples}}` from a new `site_settings.delivery_examples` row** | The real figures are per-PIN and live. See below. |
| Privacy "7 days" deletion | literal, unbacked | **`{{deletion_window}}`** from the same new row, or owner-confirmed prose | A genuine policy commitment with no code behind it. |

**On `delivery_examples`, and the tension it resolves.** The brief asks for real
per-destination estimates (Delhi 7, Hyderabad and Bangalore 4, local 3).
`estimate.ts` states the opposing doctrine: *"Null in means unknown out — never a
default, because a default here is a promise the shop has not checked."* Those
three figures were a measurement on one day, not settings — hardcoding them into
the page would recreate the exact defect the module was built to remove, just
with better numbers.

So: an owner-editable row of representative lanes, **plus a drift gate** that
re-quotes Shiprocket for each named destination and fails when the stored figure
disagrees. The page then carries real per-destination estimates that cannot go
quietly stale, and continues to point at the PIN-code check as the authoritative
answer.

This is the one new settings key in the plan, and it pays the full four-step cost
in §Cost model.

**Files.** `src/lib/content-tokens.ts`; `src/lib/shipping/estimate.ts` (export a
formatter for the cutoff); `src/lib/settings-visibility.ts`;
`src/components/admin/settings/settings-forms.tsx`;
`scripts/audit/settings-controls.ts`; new `scripts/audit/delivery-copy.ts`;
`pages` rows `shipping` and `privacy`.

**Test.** A2's extended gate finds no time literal in either page. New
`audit:delivery-copy` re-quotes each stored lane against live Shiprocket and
fails on disagreement. `audit:settings-controls` operates the new control by
label and asserts the write.

**Risk.** The drift gate calls a live third-party API, so it is
network-dependent and will need the same "cannot reach it → fail loudly, never
pass silently" handling the other Shiprocket-touching gates use.

## A7 · Gate the privacy page against the CSP allowlist · **High**

The privacy page's defect is not a number, so tokens cannot protect it. But it
has the same shape as ruling 2 describes — the system changed and the copy did
not — and it has a mechanism available that is arguably better than a token.

**Fix.** A new check: every third-party host family in `CSP_DIRECTIVES` and every
configured processor in the environment must be named on the privacy page. Adding
a new external service to the CSP without naming it in the privacy policy fails
the gate.

This inverts the failure. Today, adding a processor silently makes the privacy
policy false. After this, it fails a build-time check with the processor's own
hostname in the message.

**Files.** New `scripts/audit/privacy-processors.ts`; a small named mapping from
host family → processor name, kept beside `src/lib/csp.ts` so the two are read
together.

**Test.** Negative control, in the manner of the CSP A/B proof: add a throwaway
host to a copy of `CSP_DIRECTIVES` and confirm the gate goes red; remove it and
confirm green. A gate that has never failed is not known to work.

**Risk.** Host families do not map one-to-one to processors (four
`razorpay.com` hosts, one processor). The mapping is explicit and reasoned, like
`SETTINGS_VISIBILITY`, rather than derived by string-matching.

## A8 · Rewrite the About page · **Medium**

**Fix.** A real page about a real shop, at the length the job needs (~400 words
against the current ~80). Its SEO job is secondary but genuine: it is the natural
place for the shop's location in prose, which Batch K depends on.

**Files.** `pages` row `about`. Also fix `<title>About Foot Vault — Foot Vault>`
by setting `meta_title` to `About` so the root template supplies the brand once.

**Test.** `audit:seo` title-length and brand-duplication assertions.

**Risk.** Requires facts only the owner has — when the shop opened, who runs it,
what it stocks and why. **Never invented.** If the owner cannot supply them, the
page ships shorter and honest rather than longer and fictional.

## A9 · Dead code and a dead settings row · **Low**

Two tidy-ups that both say something false:

- `src/lib/site-config.ts:19` — `export const RETURN_WINDOW_DAYS = 7;`, never
  imported, contradicting the live 24-hour policy. Delete.
- `site_settings.payment_methods = {cod: true, online: false}` — **nothing reads
  it.** `availablePaymentMethods()` filters on `ADAPTERS[method].isAvailable()`,
  which keys off whether the provider is configured, not off this row. The row is
  classified `public`, so it is readable by anyone with the anon key and it
  currently states that online payment is off while the shop takes online
  payments. Either wire it or delete it; deleting is cleaner and needs a
  `SETTINGS_VISIBILITY` removal in the same change.

**Risk.** The `payment_methods` deletion touches a public settings row near the
money path — it reads as trivial and is worth confirming rather than assuming.
Flagged under the stop-and-ask rule.

---

# Batch K — Kadapa

Ruling 4 promoted this out of content polish. It is cheap, it is measurable, and
it is the difference between matching half the local searches and matching all of
them. Measured today: **"Cuddapah" ×12 on the homepage, "Kadapa" ×0 site-wide.**

The rule for every item below: **Kadapa is the real place name and leads.
Cuddapah is retained as the secondary form**, because the older spelling is still
what a good share of searchers type and dropping it would trade one half of the
audience for the other.

| # | Surface | Change |
| --- | --- | --- |
| K1 | `site_settings.contact.address` | `…Kadapa (Cuddapah), Andhra Pradesh 516360`. Feeds footer, contact page and schema from one row. |
| K2 | `siteConfig.description` | `…from our store in Kadapa (Cuddapah), Andhra Pradesh.` Flows to the root description, OG and Twitter on every page. |
| K3 | `LocalBusiness` schema (B3) | `addressLocality: "Kadapa"`. `name` must match the GBP listing **exactly** — so K1 and the GBP listing are decided together, not separately. |
| K4 | `pages.about` (A8) | The location in prose, both names, with the RTC bus stand landmark. |
| K5 | `pages.contact` (A5) | Same, in the address block. |
| K6 | `pages.shipping` (A6) | "We ship across India from our store in Kadapa (Cuddapah), Andhra Pradesh." |
| K7 | Category descriptions (B6) | Where a category description mentions the shop, it uses the same form. |

**Test.** A new `audit:seo` assertion: both `Kadapa` and `Cuddapah` appear in the
rendered `LocalBusiness` schema, in `site_settings.contact.address`, and on the
about, contact and shipping pages. Fails if either name disappears.

**Risk.** Low technical, one real coupling: **K3's `name` must equal the GBP
listing exactly**, and the GBP listing does not exist yet. If the schema ships
first with a name the owner later types differently into GBP, the entity match is
weakened. So K3 either waits for the GBP listing or the owner fixes the exact
legal shop name now, in writing, and both are built from it.

---

# Batch B — SEO

## B1 · Homepage canonical · **Launch blocker (ruling 3)**

**Fix.** Add a `metadata` export to `src/app/(storefront)/page.tsx` with
`alternates: { canonical: "/" }`, and a description distinct from the root
layout's so the homepage is not sharing its description with the site default.

**Files.** `src/app/(storefront)/page.tsx`.

**Test.** B2, and specifically B2's negative control.

**Risk.** None. This is a four-line change whose entire difficulty was noticing
it was needed.

## B2 · A new `audit:seo` gate where absence is failure · **Launch blocker (ruling 3)**

The ruling's second clause is the design brief: *`notApplicable` must never be
counted as a pass anywhere in the SEO gates.*

This is the same failure shape as `audit:literals` (A2) and as the reachability
gate (B7): a check that reports "nothing to see" when the thing it checks is
missing. It is the most common way an SEO gate lies, and Lighthouse does it by
default on `canonical`.

**Fix.** New `scripts/audit/seo.ts`, run against a **production build**
(`build:stage`, not `next dev` — a dev server re-renders per request and cannot
support cache or metadata claims). For every indexable route:

| Assertion | Absence behaviour |
| --- | --- |
| A `<link rel="canonical">` exists, is absolute, self-referencing, query-stripped | **FAIL** — never skip |
| `<title>` exists, unique across routes, ≤ 60 rendered chars including the template | FAIL |
| `<meta name="description">` exists, unique, 120–160 chars | FAIL |
| OG title/description/image present | FAIL |
| Every `application/ld+json` block parses and carries `@context` + `@type` | FAIL |
| `Organization` **and** `LocalBusiness` present on `/` | FAIL |
| `AggregateRating` absent wherever `reviewCount = 0` | FAIL |
| Both place names present (Batch K) | FAIL |
| Returns description carries no refund/exchange claim (A1) | FAIL |

**The negative control, which is the part the ruling asked for.** The gate is not
trusted until it has been shown to fail: remove the `metadata` export added in
B1, run `audit:seo`, confirm it goes **red on the homepage canonical**, restore
the export, confirm green. Recorded in the execution report with both outputs.
This is the same A/B discipline used to prove the Zod `jitless` fix, and for the
same reason — a check that has never failed is not known to work.

**Files.** New `scripts/audit/seo.ts`; `package.json` script entry;
`scripts/audit/run-all.ts`.

**Risk.** Route enumeration drifting from reality. Mitigated by deriving routes
from the filesystem the way `customer-reachability.ts` already does, so a new
template is covered the day it exists rather than when someone remembers.

## B3 · `Organization` and `LocalBusiness` on the homepage · **High**

**Fix.** Emit both from the homepage, built from `site_settings` so the address
and phone cannot drift from the footer. `LocalBusiness` is typed **`ShoeStore`**
(Schema.org `LocalBusiness` → `Store` → `ShoeStore`) rather than the generic type,
per the rule of using the specific subtype where one exists. Required properties
are `name` — matching GBP exactly, see K3 — and a full `PostalAddress`. Add
`openingHoursSpecification` from `site_settings.business_hours`, `telephone`,
`email`, `areaServed`, and `sameAs` for the social profiles **only once the owner
has confirmed they are the shop's** (audit A12).

Honest framing, from the SEO reference and worth keeping in the plan so nobody
oversells it: schema is **not a direct ranking factor** (confirmed by both
Mueller and Illyes). It buys rich results, entity understanding and AI-search
citability. It does not buy position.

**Files.** New `src/components/storefront/structured-data.tsx`;
`src/app/(storefront)/page.tsx`.

**Test.** B2's `Organization`/`LocalBusiness` assertions plus a JSON-parse and
required-property check.

**Risk.** `sameAs` pointing at profiles that are not the shop's is an active
harm — it tells Google those accounts are this business. **Gated on owner
confirmation**; omitted entirely until then.

## B4 · `lastmod` in the sitemap · **High**

**Fix.** Add `lastModified` to every entry from the `updated_at` each source
table already carries. Drop or keep `changeFrequency`/`priority` as preferred —
they are largely ignored — but `lastmod` is read.

**Files.** `src/app/sitemap.ts`; the four query functions in
`src/lib/queries/catalog.ts` and `content.ts` must return `updatedAt` alongside
the slug.

**Test.** New `audit:seo` assertion: every `<url>` has a `<lastmod>`, each parses
as a date, none is in the future. Fails on a single missing one.

**Risk.** `staticParamsOr` degrades to static routes when the catalog is
unreachable at build. That path must still emit valid dates rather than
`undefined` — the SSG-zero-paths landmine in a new costume.

## B5 · Withhold the sitemap while the shop is hidden · **Medium**

**Fix.** `src/app/sitemap.ts` returns an empty array when `isIndexable()` is
false, matching what `robots.ts` already documents as the intent: *"the sitemap
is withheld rather than advertising every URL we are asking not to be indexed."*
Today the link is withheld and the document is not — 62 URLs are served at
`/sitemap.xml` right now.

**Files.** `src/app/sitemap.ts`.

**Test.** Extend `audit:headers`, which already exercises both values of
`SITE_INDEXABLE`, to assert the sitemap is empty under false and populated under
true. That gate is the natural home because it already owns the flip.

**Risk.** Low. Worth noting the ordering trap: B4's `lastmod` assertion and B5's
empty-under-noindex assertion must not contradict each other — the `lastmod`
check runs only in the indexable branch.

## B6 · Content depth · **Medium**

The largest body of work in the plan and where most of the achievable on-site
gain sits. Measured gaps from the audit:

| Surface | Now | Target |
| --- | --- | --- |
| Category descriptions | **12 of 15 empty**; fallback yields 12 near-identical boilerplate strings | A real paragraph each, written for the department |
| Product descriptions | min 72 / avg 126 / max 192 **characters** | Enough to be worth reading and to rank; 35 SKUs makes this tractable |
| Product meta descriptions | avg 54, max 99 chars | 120–160, unique, carrying brand + model + category |
| Product titles | 34 fine, 1 at 87 rendered chars | ≤ 60 rendered |

**Files.** Database — `categories.description`, `products.description`,
`products.meta_title`, `products.meta_description`.

**Test.** `audit:seo` length and uniqueness assertions, with the **boilerplate
check as its own rule**: no two descriptions may be identical after removing
their title prefix. Plain uniqueness passes the 12 templated category
descriptions today, which is precisely why plain uniqueness is not enough.

**Risk.** This is copywriting at volume; the failure mode is filler that passes a
length check and helps nobody. The length assertion is a floor, not the goal, and
the gate cannot tell the difference — so this is the item where the gate is the
weakest proxy and human review matters most.

## B7 · Reachability asserts published pages, not route shapes · **Medium**

**Fix.** `matcherFor("/page/[slug]")` compiles to `^/page/[^/]+$`, so one linked
CMS page satisfies the gate for all seven. Change the expectation for that route
to be **derived from the database** — every `pages` row with `is_published = true`
must be individually reached.

Worth recording why the practical risk is low today: the footer's Help column is
`pages.map(...)` over every published page, so a page published from the admin
self-links with no deploy. The architecture is right; the gate does not prove it.
Batch A edits and adds pages, which is exactly when that stops being academic.

**Files.** `scripts/audit/customer-reachability.ts`.

**Test.** Negative control: unpublish one page, confirm the gate's expected set
shrinks; add an unlinked page, confirm red.

**Risk.** The crawl caps at `MAX_PAGES = 40`. Seven CMS pages plus the catalogue
should fit, but the cap needs checking against the expanded expectation rather
than assumed.

## B8 · A deliberate position on AI crawlers · **Low**

**Fix.** `robots.ts` emits only a `*` rule, so on flip day GPTBot, ClaudeBot and
PerplexityBot are allowed by default rather than by decision. Make it a decision
and write down which. Optionally add `llms.txt` (currently 404).

**Recommendation:** allow them. A shop whose problem is being undiscovered has
little to gain from blocking the crawlers that increasingly answer "where can I
buy X in Kadapa", and citation-related factors now appear among the top AI
visibility signals.

**Risk.** None material either way. It should just not be an accident.

---

# Batch C — Analytics

## The recommendation, and the reasoning (ruling 5)

**Install Vercel Web Analytics. Set up Google Search Console immediately. Do not
install GA4 now.**

### Why not GA4, given the Search Console integration is its main draw

The integration argument is weaker than it looks. **Search Console is a separate,
free Google product the owner gets regardless**, and it is the thing that
actually answers their question — *what did people search to reach the shop*.
GA4's integration surfaces that data inside GA4; it does not produce data the
owner cannot have without GA4. So the choice is not "search-query data or none".
It is "search-query data in one place, or the same data in two".

### Why Vercel Analytics wins on the constraint that actually binds here

The binding constraint is the one the audit measured: **the CSP is enforcing and
its failure is undetectable.** `docs/operations.md` is explicit that silence at
the report sink proves nothing, because browser-to-sink delivery has never been
demonstrated.

| | Vercel Analytics | GA4 |
| --- | --- | --- |
| Script origin | **same-origin** `/…/script.js` | `www.googletagmanager.com` |
| Beacon origin | **same-origin** | `*.google-analytics.com`, `*.analytics.google.com`, regional endpoints |
| New CSP surface | **none** — covered by existing `'self'` | ≥3 host families across ≥2 directives |
| Silent-failure candidates | **0** | one per host, incl. regional endpoints — the classic omission |
| Cookies / identifiers | none | `_ga`, pseudonymous client ID |
| DPDP posture | privacy-notice update only | materially stronger consent argument + cross-border transfer |
| Consent banner needed | no | realistically yes |

The last row compounds badly at this shop's scale. A banner means the funnel
measures only consenting visitors — and at near-zero traffic, a partial and
self-selected sample is worse than a complete small one. The owner asked for
visitors, sources, product views, and the view → bag → checkout → paid funnel.
Vercel Analytics does page views, referrers and custom events, which covers it.

### The honest counter-case

GA4 is free at any volume, is the industry default, is required if the owner ever
runs Google Ads, and is far stronger at acquisition and cohort analysis. Vercel
Analytics is weaker there, and on the **Hobby plan** — which this project is on —
it carries a monthly event allowance that a busy shop can reach. That allowance
should be checked against expected volume before install, not after.

Which is the real argument for **C1**: behind an interface, this decision is
reversible for the cost of one adapter. Pasted as a snippet, it is not.

## C1 · Install analytics behind an interface · **High**

**Fix.** An `analytics` module with a narrow surface — `pageView()`,
`track(event, props)` — and a Vercel adapter behind it, mirroring the shape
`src/lib/payments/index.ts` already uses for payment providers (`ADAPTERS`,
`isAvailable()`, everything outside importing from the index and never from the
adapter). Swapping or adding a provider is then one entry.

There is a second reason beyond swappability, and it is time-sensitive:
`src/lib/csp.ts` names the **nonce migration** as a live follow-up, which removes
`'unsafe-inline'` from `script-src`. A tag mounted through a component survives
that. A snippet pasted into the layout does not.

**Files.** New `src/lib/analytics/{index,types,vercel}.ts`;
`src/app/layout.tsx`; `package.json`.

**Test.** C3.

**Risk.** Low. The interface is small and has a working local precedent.

## C2 · Funnel events, with the field list stated · **High**

**Fix.** Four events, matching what the owner asked for:

| Event | Fires | Properties |
| --- | --- | --- |
| `product_view` | product page render | `slug`, `category`, `brand` |
| `add_to_bag` | bag mutation succeeds | `slug`, `size`, `qty` |
| `checkout_start` | checkout page render with a bag | `item_count`, `value_band` |
| `purchase` | payment confirmed | `order_value_band`, `payment_method`, `item_count` |

**No personal data. Stated as a rule and gated, not as an intention.** No email,
no phone, no address, no name, no order number, no line contents tied to a
person. Order value goes as a **band**, not an exact figure, because an exact
value plus a timestamp is a re-identification key against the orders table.

**Files.** `src/lib/analytics/*`; call sites in the product page, bag action,
checkout page, payment confirmation.

**Test.** A new `audit:analytics` assertion that intercepts outgoing beacons on a
real page load and fails if any payload key matches a personal-data denylist
(`email`, `phone`, `address`, `name`, `order_number`, `pin`). Asserting on the
*wire*, not on the call sites, because the call sites are what changes.

**Risk.** The `purchase` event fires on a money path. It must be incapable of
failing the payment — fire-and-forget, wrapped, never awaited in the
confirmation path.

## C3 · Prove the CSP on the wire, not in the config · **High**

The brief's gate, and per audit §C3 the only instrument that works.

**Fix.** A gate that loads the real routes against a **production build**, with
the browser console captured, and fails on any CSP violation.

Two constraints, both learned the hard way in this project and both easy to
repeat:

1. **Not `next dev`** — its policy carries `'unsafe-eval'`, which masks exactly
   the class of violation being looked for.
2. **Not `page.evaluate`** — CDP `Runtime.evaluate` is not subject to the page's
   CSP, so an injected probe proves nothing. A positive control requires an **A/B
   production build**, the method that proved the Zod `jitless` fix.

**The positive control for this item specifically.** Because the recommendation
needs no CSP change, "the console is clean" is also what a completely broken
install looks like. So the gate must additionally assert the beacon **fired** —
a request to the analytics path was observed — not merely that nothing was
blocked. Absence of a violation is not evidence of presence, which is the same
`notApplicable`-is-not-a-pass rule as B2, in a different costume.

**Files.** New `scripts/audit/analytics-csp.ts`.

**Risk.** The one that matters: writing this gate so it passes when analytics is
silently dead. The beacon assertion is what prevents it.

## C4 · Consent and the privacy notice · **High**

**Fix.** With the cookieless recommendation, no banner. The privacy policy
rewritten in A3 gains a section naming the analytics processor, what is
collected, that it sets no cookie and identifies no individual, and the fact that
no personal data is sent.

If the owner overrides toward GA4, this item grows a real consent banner with a
genuine refusal path that actually suppresses the tag — and A3's processor list
and A7's gate both grow an entry.

**Risk.** Stated plainly: this is not legal advice. The DPDP position in audit
§C7 is a structural reading, not counsel's opinion, and the final call is the
owner's.

## C5 · Google Search Console · **Owner, unblock immediately**

Verification is an owner action. The site-side half is a DNS TXT record or a meta
tag, and if the meta-tag route is chosen it belongs in the root layout in the
same change. Sitemap submission follows the flip, not before — there is nothing
to submit while `robots.txt` disallows everything.

---

# Batch D — lifting `noindex`

**Last, and currently blocked.** Not by anything in Batches A–C.

## Preconditions, all five, each with its current state

| # | Precondition | State |
| --- | --- | --- |
| 1 | Real product photography is live | ❌ **120 of 123 images are placeholder SVGs.** Also gates Product rich results (audit B7) — Google's Product image requirement excludes SVG |
| 2 | Policy pages published with real values, no placeholders | ⏳ Batch A |
| 3 | Contact details real, including WhatsApp | ❌ owner confirmation outstanding (A5, audit A12) |
| 4 | **BotID on checkout and coupon-check** | ❌ **not built — does not exist in this repository** |
| 5 | Metadata, sitemap, robots, structured data correct | ⏳ Batch B + K |

## D1 · The flip

**Fix.** Set `SITE_INDEXABLE=true` in Vercel Production only, redeploy.

**Test.** In this order:
1. `audit:build-smoke` before the deploy — the merge policy requires it.
2. `audit:headers` green under **both** values. It already covers the exact trap
   this code path was written for: the early return that would have deleted every
   security header alongside the noindex.
3. On the wire: `curl -I` shows **no** `x-robots-tag`, and all four security
   headers plus the enforcing CSP survive.
4. `robots.txt` shows `Allow: /` and the sitemap line.
5. `/sitemap.xml` populated with `lastmod` (B4, B5).
6. `audit:seo` green against production.
7. Lighthouse on the **live domain**: SEO should move from the measured **66** to
   ~100.

**And one assertion the score cannot make (ruling 3).** Lighthouse reporting ~100
must not be read as confirmation, because the homepage canonical would have been
`notApplicable` — invisible, not failed. **`audit:seo` is the gate; Lighthouse is
the thermometer.** The report must state both, and must not offer the Lighthouse
number as proof of the canonical.

**Risk — the one that makes this last.** Indexing is not instantly reversible.
Google caches what it finds, and a shop indexed full of placeholder drawings
shows that way in results for weeks after the photographs land. Every precondition
above is a version of "do not let Google see a draft".

**Verification note.** Verify by alias, not by a 200, and use an identifier absent
from the old tree — `READY` is a build state, and `*.vercel.app` is SSO-gated.

## D2 · After the flip · **Owner**

Submit the sitemap in Search Console. Expect indexing over days, not hours.
Re-run Lighthouse on the live domain and record it.

---

# Findings → work items

| Audit | Severity | Item | Files | Test | Risk |
| --- | --- | --- | --- | --- | --- |
| A1 | Critical | A1 returns meta | db | `audit:literals`, `audit:seo` | copy is a legal promise |
| A1 | Critical | **A2 literals gate blind spot** | `literals.ts` | must fail first, then green | false positives on size guide |
| A2 | Critical | A3 privacy rewrite | db | A7 | needs owner + counsel |
| A6 | High | A4 terms rewrite | db | A2, `audit:seo` | blocked on GSTIN/legal name |
| A5 | High | A5 WhatsApp + contact page | footer, db, tokens | `audit:reachability`, `audit:seo` | number unconfirmed — gates deploy |
| A3, A4, A7 | High | A6 tokenise time values | tokens, settings, admin, gates | `audit:delivery-copy` | live API dependency |
| A2 | High | A7 privacy processor gate | new gate | negative control | host→processor mapping |
| A9, A11 | Medium | A8 about rewrite | db | `audit:seo` | needs owner facts |
| A10 | Low | A9 dead code + dead row | `site-config.ts`, db | existing gates | public row near money path |
| D5 | High | **Batch K — Kadapa** | settings, schema, 3 pages | `audit:seo` | K3 name must match GBP |
| B3 | **Blocker** | B1 homepage canonical | `page.tsx` | B2 negative control | none |
| B3 | **Blocker** | **B2 `audit:seo`, absence = failure** | new gate | removes B1's export, must go red | route drift |
| B4 | High | B3 Organization + LocalBusiness | new component | B2 | `sameAs` needs owner |
| B5 | High | B4 sitemap lastmod | `sitemap.ts`, queries | B2 | SSG-zero-paths |
| B6 | Medium | B5 withhold sitemap when hidden | `sitemap.ts` | `audit:headers` both values | ordering vs B4 |
| B8 | Medium | B6 content depth | db | B2 + boilerplate rule | gate is a weak proxy |
| B10 | Medium | B7 reachability per page | `customer-reachability.ts` | negative control | `MAX_PAGES` cap |
| B11 | Low | B8 AI crawler position | `robots.ts` | — | none |
| C1 | High | C1 analytics interface | new module | C3 | low |
| C1 | High | C2 funnel events, no PII | analytics + call sites | wire denylist | fires on money path |
| C2 | High | **C3 prove CSP on the wire** | new gate | A/B build + beacon assertion | passing while dead |
| C7 | High | C4 consent + notice | db | — | not legal advice |
| C8 | Owner | C5 Search Console | maybe layout | — | — |
| — | **Blocked** | D1 the flip | env | `audit:headers`, `audit:seo`, Lighthouse | not reversible |

---

# Interactions to watch

1. **Analytics × CSP.** The obvious one, and the recommendation is chosen partly
   to shrink it to nothing. But "no CSP change needed" means a broken install and
   a working install look identical — hence C3's beacon assertion.
2. **Analytics × the nonce migration.** `csp.ts` names removing `'unsafe-inline'`
   as a follow-up. C1's interface survives it; a pasted snippet would not.
3. **Photography × structured data × Batch D.** One fact, three consequences: no
   Product rich result, precondition 1 unmet, and B6's product copy is worth less
   next to placeholder art.
4. **BotID × Batch D.** A hard blocker that no work in this plan can clear.
5. **Kadapa × GBP.** K3's schema `name` must match the GBP listing exactly, and
   GBP does not exist yet. Decide the exact shop name once, then build both.
6. **A6 × `audit:settings-controls`.** The new `delivery_examples` row needs a
   labelled admin control and a `CONTROLS` entry, or coverage fails.
7. **B4 × B5.** `lastmod` assertions must run only in the indexable branch, or
   the two gates contradict.
8. **Batch A × the "Last updated" line.** CMS pages print `pages.updated_at`.
   Every Batch A edit bumps a visible date — which is correct and desirable, and
   worth knowing before it looks like a bug.
9. **Every new gate × `run-all.ts`.** Three new gates land here. A gate not
   registered is a gate that runs once.
10. **Full battery last.** Typecheck plus full lint as the literally last thing
    before merge, after the final edit.

---

# What needs the owner

**Blocking the build:**

1. **BotID** — pull into scope, or Batch D waits for Group 3.
2. **GSTIN and registered business name** — A4 cannot be written truthfully
   without them.
3. **WhatsApp number confirmation** — A5 ships a dead contact route otherwise,
   for the shop's one warranty commitment.
4. **Grievance contact and deletion turnaround** — A3.
5. **The exact shop name as it will appear in GBP** — K3 and B3.

**Blocking the flip:**

6. **Photographs.** Precondition 1, and the reason product structured data cannot
   pay yet.
7. **Google Business Profile** — verified, correct primary category. The highest
   value action available, and not on the website: GBP signals are 32% of the
   local pack and proximity is 55.2% of the variance.
8. **Google Search Console** verification.

**Decisions:**

9. **Analytics** — the recommendation is Vercel Analytics + Search Console
   (§Batch C). The owner's call, and reversible by design.
10. **Facebook and Instagram** — confirm both are the shop's before `sameAs`
    claims them.
11. **About page facts** — opening, who runs it, why. Never invented.
12. **`payment_methods` row** — wire or delete (A9).

---

# Suggested order

Ordered so gates land before the work they judge, and so nothing waits on an
owner reply that could have been asked for earlier.

| Stage | Items | Why here |
| --- | --- | --- |
| 0 | Owner questions 1–5 sent | Longest lead time. Ask on day one. |
| 1 | **A2, B2, A7, B7** — the four gate changes | Ruling 1's point: build the detector first, watch it fail, then fix. |
| 2 | **A1, B1** | One row and four lines; both now provably fixed by stage 1. |
| 3 | **A6, A5, K1–K7** | Token mechanism and the Kadapa sweep together — both touch the same pages. |
| 4 | **A3, A4, A8, A9** | The rewrites, once the owner's facts are in. |
| 5 | **B3, B4, B5, B6, B8** | Schema, sitemap, content depth. |
| 6 | **C1, C2, C3, C4** | Analytics behind its interface, proven on the wire. |
| 7 | Full battery, `audit:build-smoke`, deploy | Typecheck + full lint literally last. |
| 8 | **D1** | Only when all five preconditions are true and the owner says the word. |

Stages 1–2 are worth doing as one merge: a gate that fails, and the fix that makes
it pass, read as a single change and prove each other.

---

**Stage 2 complete. Nothing has been changed. Awaiting approval to begin Batch A,
and answers to the five blocking owner questions.**
