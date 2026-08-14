# Foot Vault — Launch Readiness

**Policy pages, SEO, analytics, and lifting `noindex`. Audit, plan, then build.**

> Save as `docs/LAUNCH.md` and tell Claude Code: *"Read docs/LAUNCH.md and begin Stage 1. No changes until I approve the plan."*

---

## What this is

The shop is finished. It takes payments, refunds them, ships parcels, tracks them, emails customers, runs a loyalty ledger, and is hardened. It is invisible to Google by deliberate switch.

This is the work between "live but hidden" and "open for business."

**One thing to be straight about before starting.** The owner has asked to appear at the top of Google. Nobody can promise that, and any plan that implies it is lying. What is achievable: being *correctly indexed*, ranking for the shop's own name, and competing for realistic long-tail terms. What is not achievable in any timeframe worth planning around: outranking Myntra, Ajio, Amazon or Nike for "buy sneakers online." Say so plainly in the plan, and spend the effort where it can actually pay.

---

## Standing rules

**Three stages, stop between each.** Audit → `claudeExecutionReport/launch-audit.md`. Plan → `claudeExecutionReport/launch-plan.md`, then wait. Build in the approved order.

**Merge policy unchanged.** Money, auth, refunds, production migrations and dashboard changes stop and ask. `audit:build-smoke` before every deploy. Verify by alias, not a 200.

**A blocked tool means stop and report.** Never switch tools.

**Skills:** load and use the **SEO skill** before the SEO work, and `impeccable`/`taste` for anything the customer sees.

**Never invent a fact about the business.** Policy pages state legal commitments. Where a value is unknown — a registered address, a GSTIN, a dispatch time — leave a marked placeholder and put it on the owner's list. A guessed return window in a published policy is a promise the shop did not make.

---

# STAGE 1 — AUDIT

## 1A · What the policy pages actually say now

Read every page in the `pages` table and report each one's real content, not its title. Which are placeholder, which are stale, which contradict the code.

Known: the returns policy was drafted and reviewed; the contact page had `{{PHONE}}` at one point; the ₹2,499 threshold escaped into published copy twice. **Check every published number against `site_settings`** — a hardcoded figure in a policy page is a promise that silently goes stale.

## 1B · What Google would see today

- The exact response headers on `www.footvault.in` — confirm `x-robots-tag` and how `SITE_INDEXABLE` gates it.
- `robots.txt` and `sitemap.xml`: do they exist, what do they contain, are they generated from live data, and do they respect the indexable flag?
- Per-page metadata: title, description, canonical, Open Graph, Twitter card — on home, shop, category, product, collection and CMS pages. Which are DB-driven and which are hardcoded?
- **JSON-LD**: `Product` and `BreadcrumbList` were specced in Phase 3. Report what actually ships, and whether `AggregateRating` appears now that reviews exist — it must never emit with zero or invented ratings.
- Heading structure, alt text, internal linking. `audit:reachability` found `/account` orphaned once; the same shape hurts crawlability.
- Live Lighthouse SEO scores, which have been sitting at 58–69 *solely* because of `noindex` — confirm that is the only cause.

## 1C · Analytics

- Is anything installed today? Report honestly, including anything half-wired.
- **How would analytics interact with the enforcing CSP?** This is the one that will bite: any new script host needs `script-src` and `connect-src` entries, and a missing one fails silently in production. The CSP is enforcing, and the report sink exists.
- What consent obligations apply. India's DPDP Act is in force; the shop already sends personal data to Razorpay, Shiprocket and Resend and has a privacy policy to write. Say what the honest position is rather than assuming a cookie banner is or isn't needed.

## 1D · What is actually competitive

Ground this in the shop's real situation: one location in Cuddapah, ~35 products, no delivered orders, no reviews, no domain authority, no backlinks.

- What terms could this shop realistically rank for? Brand terms, local terms, long-tail product terms.
- What is out of reach, and say so plainly.
- Whether local SEO — Google Business Profile, `LocalBusiness` schema, a physical Cuddapah address — is worth more than product SEO at this stage. It probably is: a real shop with a real address ranks locally in a way a new ecommerce site cannot rank nationally.

---

# STAGE 2 — PLAN

`claudeExecutionReport/launch-plan.md`, then stop. Findings by severity, each with the fix, files touched, the test that proves it, and the risk. Say explicitly what needs the owner. Flag interactions — analytics and CSP is the obvious one.

---

# STAGE 3 — BUILD

## Batch A — The policy pages

Six pages, written in plain language, every fact drawn from `site_settings` via the existing token mechanism so nothing can go stale. **No hardcoded rupee figures. No hardcoded days.**

**Shipping** — that it ships from Cuddapah; real per-destination estimates now that Shiprocket provides them (Delhi 7 days, Hyderabad and Bangalore 4, local 3 — do not say "about 4 days" to everyone); the 11:00 cutoff; the free-delivery threshold as a token; how Pay on Delivery works, including plainly that the customer pays a deposit online covering delivery and the balance in cash.

**Returns and replacements** — already drafted and reviewed; verify it is published and current.

**Privacy** — what is collected, why, who it goes to (Razorpay for payments, Shiprocket for delivery, Resend for email, Supabase for hosting, Google for sign-in), how long it is kept, and how to request deletion. Written for DPDP compliance and for a person to actually understand.

**Terms** — order acceptance, pricing and errors, cancellation before dispatch, the replacement-only position, governing law and jurisdiction.

**Contact** — real phone, real WhatsApp, `inquiry@footvault.in`, address, hours. Every value from `site_settings`, no placeholders.

**About** — a real shop with a real history. This is the page that makes a stranger trust an unknown store, and it is worth writing properly rather than filling.

All linked from the footer, reachable, and covered by `audit:reachability`.

## Batch B — SEO

**Load the SEO skill first.**

- **Metadata**: unique, human-written title and description patterns per template. Titles under ~60 characters, descriptions ~155. Never the same description on two pages. Product titles should carry brand, name and category the way a person would search.
- **Structured data**: `Product` with real price, availability and — only where genuine reviews exist — `AggregateRating`. `BreadcrumbList`. `Organization` on the homepage. **`LocalBusiness` with the real Cuddapah address**, which for this shop may be the highest-value schema on the site.
- **`sitemap.xml`** generated from live data, including products, categories, collections and CMS pages, with real `lastmod`. **`robots.txt`** allowing crawl, disallowing `/admin`, `/account`, `/checkout` and `/api`, and pointing at the sitemap.
- **Canonicals** on every page. Watch the filter parameters on `/shop` — faceted URLs are the classic duplicate-content trap and this shop has category, size, colour, brand, gender, price and in-stock filters all in the URL. Decide deliberately which are canonical and which are `noindex`.
- **Content**: category pages need a paragraph of real text, product descriptions need to be more than a line, and headings need a sensible hierarchy. Thin pages do not rank, and this is where most of the achievable gain sits.
- **Images**: real alt text from the database. Once real photography lands this matters for image search, which for footwear is not a small channel.

## Batch C — Analytics

- Install analytics behind an interface, not a hardcoded snippet. **The CSP is enforcing** — add the required `script-src` and `connect-src` hosts in the same change, and prove it with a real page load rather than assuming.
- **Recommend the tool rather than defaulting to one.** Google Analytics 4 is free and integrates with Search Console; Vercel Analytics is one line, privacy-friendly and needs no consent banner but shows less. Say which fits a shop this size and why, and what each costs in consent obligations.
- Track what the owner actually asked for: visitors, where they come from, which products get viewed, and the funnel from product view to add-to-bag to checkout to paid.
- **Do not send personal data to analytics.** No email, no phone, no address, no order contents tied to a person. If ecommerce events are included, say exactly what fields go.
- Consent: implement whatever the audit concludes is required, honestly. If a banner is needed, make it a real choice and not theatre.
- **Google Search Console** is the more important of the two for the owner's actual question — it shows what people search to reach the shop. Set up verification and list the owner steps.

## Batch D — Lifting `noindex`

**Last. Only when everything above is done, and only with the owner's explicit word.**

Because indexing is not instantly reversible — Google caches what it finds, and a shop indexed full of placeholder drawings shows that way in results for weeks.

Preconditions, all of which must be true and stated:

1. Real product photography is live.
2. Policy pages are published with real values and no placeholders.
3. Contact details are real, including the WhatsApp number.
4. **BotID is on checkout and coupon-check** — Group 3 from the security work, which was explicitly tied to this flip. An indexed shop is a discovered shop.
5. Metadata, sitemap, robots and structured data are all correct.

Then: flip `SITE_INDEXABLE`, redeploy, verify on the wire that `x-robots-tag` is gone and the four security headers survived — `audit:headers` covers exactly this, and the early-return trap it was written for lives on this code path. Submit the sitemap in Search Console. Re-run Lighthouse and expect SEO to jump from ~60 to ~100.

---

## Owner tasks — list precisely, do not attempt

Google Search Console verification. Google Business Profile for the physical shop, which is likely worth more than anything on the site for local discovery. The GSTIN and registered business name if they belong in Terms. Confirmation of the real WhatsApp number. And the photographs.

---

## Quality gates

- `audit:reachability` green, including every new page.
- No currency literal or hardcoded day count in any published page — extend the literals gate to the `pages` table content if it does not already cover it.
- Metadata assertions: every route has a unique title and description; no page is missing a canonical.
- Structured data validates, and `AggregateRating` is absent where there are no reviews.
- Analytics does not break the CSP — proven by a real page load with the console clean, not by reading config.
- `audit:headers` green under both `SITE_INDEXABLE` values.
- Lighthouse on the **live domain**, not staging.

---

## Done when

A stranger searching "Foot Vault Cuddapah" finds the shop; a customer can read what the shop actually promises about delivery, returns and their data; the owner can see how many people visited and what they looked at; and Google is indexing a shop that is genuinely ready to be seen.
