# Foot Vault — Phase 3 Brief

> Paste into Claude Code, or save as `docs/PHASE_3.md` and say: *"Read docs/PHASE_3.md and begin."*

---

## Authority

You have **full authority** to take whatever action is needed to make this phase excellent. Specifically, without asking me first:

- Fix any bug you find, anywhere in the repo — including code from Phases 0–2. If Phase 3 work exposes a defect in earlier work, fix it properly rather than routing around it.
- Refactor anything that is in your way. If a Phase 1 component has the wrong shape for what Phase 3 needs, change its shape.
- Add migrations, indexes, columns, or database functions if the storefront genuinely needs them.
- Add, remove, or replace dependencies where justified.
- Adjust design tokens, spacing scales, or component styling where measurement or real content proves the current value wrong. You did this correctly in Phase 0 — same standard applies.
- Reorganise files, rename things, and improve conventions.
- Write scripts, tests, lint rules, and tooling that raise the quality floor.

**Limits — these still come to me:**
- Anything that changes a business policy: pricing, shipping rules, returns window, currency, size system, payment approach.
- Destructive operations on data or history: dropping a table with data in it, force-pushing, rewriting `main`.
- Scope beyond Phase 3 (see "Out of scope" at the bottom). Note it and move on; don't build it.

Every autonomous decision goes in the PR description with a one-line rationale. I want to see what you chose and why — I just don't want to be a bottleneck while you're choosing.

## Standard

This is a commercial product a real shop depends on, not a portfolio piece. The bar is **best-in-class SaaS quality**: the kind of storefront where a customer never notices the interface because nothing ever snags. Nothing half-built, nothing that works only on the happy path, nothing that looks fine at 1440 and breaks at 390.

If you find yourself about to ship something you'd describe as "good enough for now," stop and fix it. If you genuinely can't fix it in this phase, don't hide it — list it explicitly in the "known imperfections" section of your report.

## Skills

Before you start, check what skills are available to you in this environment and use every one that applies. At minimum, load the **frontend-design** skill before writing any UI — this phase is almost entirely interface work, and that skill governs how it should look and why. Use the relevant skills for any document, spreadsheet, or asset work that comes up. If you find yourself repeating a project convention across many files, consider writing it up as a project skill so it stays consistent for Phases 4–9.

---

## Preflight — do these before writing Phase 3 code

Report the result of each. If any fails, fix it first.

1. **Phase 2 escalation test.** Sign up through the real client with `{"role":"admin"}` in `raw_user_meta_data`, then select the resulting profile row and show me the role value. It must be `customer`. Then re-run the Phase 1 escalation test (`update profiles set role='admin'`) as that freshly-created user and show it failing.
2. **Sold-out coverage in the seed.** Confirm the seed includes out-of-stock variants and at least one fully sold-out product. The struck-through state on the size-run strip is this site's signature element and it must be visible during development, not theoretical. If coverage is missing, extend the seed.
3. **Error swallowing.** Confirm the structural fix landed — a shared query wrapper, an ESLint rule, or both. A query error must never render as an empty page anywhere in the codebase. Show me how it's enforced, not just that it was fixed once.
4. **Baseline.** Run `npm run build`, typecheck, and lint. Record current Lighthouse mobile scores for `/`, `/shop`, and a product page so we can compare at the end.

---

## What Phase 3 is

Phase 1 shipped these routes as **data plumbing** — they fetch correctly and render. Phase 3 turns them into **the product**. The URLs mostly already exist; what changes is that they become fast, beautiful, fully responsive, accessible, and complete in every state.

Judge your own work by: *would a stranger assume a well-funded brand built this?*

---

## Screen specifications

### Global chrome

- **Header** — nested navigation built from the `categories` tree, not hardcoded. Desktop: a proper dropdown/mega panel. Mobile: a slide-in drawer with accordion nesting, closable by swipe, backdrop tap, and Escape. Search entry point, wishlist and bag icons with count badges (badge logic wired; the panels themselves are Phase 4).
- **Announcement bar** — from `site_settings`, dismissible, dismissal persisted, never causes layout shift when it disappears.
- **Footer** — links, contact details and social from `site_settings`. CMS page links from `pages`. Nothing hardcoded that the admin will later expect to edit.
- **Loading** — skeletons that match the real layout's dimensions exactly. If a skeleton and its content differ in height, you've built a layout shift.
- **Errors** — `error.tsx` and `not-found.tsx` styled to the brand, with a route back into the catalogue. A 404 on a discontinued product should suggest the category it belonged to.

### Homepage

Renders `homepage_sections` in order. Build a clean renderer that maps `section_type` to a component and fails gracefully on an unknown type rather than crashing the page.

- Hero honours separate mobile and desktop crops. The hero image is the LCP element — `priority`, correct `sizes`, no lazy loading.
- Product rails: horizontal scroll with CSS scroll-snap on mobile, arrow controls on desktop, no scrollbar jank, keyboard navigable.
- Category grid uses the tread motif as texture. Restraint — it's a background, not a pattern swatch.
- One orchestrated load sequence for the hero. Nothing else animates on first paint.

### Listing — `/shop`, `/shop/[category]`, `/collection/[slug]`

- Filters: category, size, colour, brand, gender, price range, in-stock-only. All URL-driven, all working without JavaScript, all giving the back button real history — keep what Phase 1 built and extend it.
- **Facet counts** — "Black (12)". A filter that leads to zero results should be visibly zero before it's tapped.
- Mobile: filters open in a bottom sheet with a sticky "Show 47 results" action. Desktop: persistent left rail.
- Active filters render as removable chips with a clear-all.
- Sort: newest, price low→high, price high→low.
- Result count always visible. Empty state offers the nearest useful escape — relax a filter, browse the parent category.
- Restore scroll position when returning from a product page. Nothing is more irritating than losing your place after tapping the tenth item.

### Product page — `/product/[slug]`

This is the most important screen on the site. Spend accordingly.

- **Gallery** — side profile and outsole. Mobile: swipe with dot indicators. Desktop: thumbnails plus zoom on hover or click. The outsole reveal on card hover is the brand's second signature — make the PDP gallery feel like the payoff for it.
- **Size-run strip** — the primary selector, rendered in the mono face. Available sizes tappable, sold-out sizes struck through and dimmed but still shown. Selecting a size updates the URL. Single-variant products preselect. Tap targets ≥44px. Full keyboard operation with arrow keys.
- **Colour swatches** — switch the gallery and the available size run together.
- Price with strikethrough when on sale, discount percentage, tax-inclusive note.
- Stock as language, in steel with a mono numeral, per the Phase 0 decision. No colour-only signalling.
- Size guide in a modal, real UK conversions, focus-trapped and Escape-closable.
- Sticky add-to-bag bar on mobile, appearing after the primary CTA scrolls out. Buttons remain disabled with the visible Phase 4 note — but they must look and measure exactly as they will when live.
- Breadcrumbs, delivery estimate, returns line, related products from the same category.
- `Product` and `BreadcrumbList` JSON-LD with correct `offers` and `availability`.

### Search — `/search`

- Trigram-backed, debounced, tolerant of typos and case.
- No-results state that suggests categories or popular products rather than a dead end.
- Mobile: search opens as a full-screen overlay, not a cramped inline field.

---

## Quality gates — all must pass before you open the PR

**Performance**
- Lighthouse mobile ≥ 90 on all four categories, for `/`, `/shop`, `/shop/[category]` and `/product/[slug]`.
- LCP < 2.5s on simulated 4G. CLS effectively zero. INP < 200ms.
- Every image through `next/image` with explicit dimensions and correct `sizes`. Fonts self-hosted via `next/font`.
- Server Components by default. `"use client"` only where interactivity genuinely requires it — justify each one.
- No N+1 queries. Check what the listing page actually issues per request.

**Responsive**
- 360, 390, 768, 1024, 1440, 1920. Zero horizontal overflow. Audit programmatically as you did in Phase 0, not by eye.
- Test with hostile content: a 60-character product name, a category with one product, a product with a single size, a fully sold-out product, a product with no sale price.
- All tap targets ≥ 44×44px. No text below 16px in form inputs (iOS zoom).

**Accessibility**
- Complete keyboard path: home → category → apply a filter → product → select a size. No traps, visible focus throughout.
- One `h1` per page, correct heading order, semantic landmarks.
- `aria-live` for filter result counts and gallery changes.
- Real alt text from the database, not filenames.
- `prefers-reduced-motion: reduce` disables all motion.
- Run an automated axe scan and report it clean.

**SEO**
- Per-page metadata from the database. Open Graph images. Canonicals. `sitemap.xml` and `robots.txt` generated from real data.

---

## Bug policy

1. **Root cause only.** The Phase 1 category 404 is the model: the embed syntax was the bug, the swallowed error was the reason it hid. Fix both layers, every time.
2. **Sweep the class.** When you find a defect, search the repo for the same pattern and fix every instance. One bug of a kind means there are others.
3. **Leave a guard.** Every non-trivial bug gets something that stops it recurring — a test, a lint rule, a type, a database constraint. Preference in that order: make it impossible, then make it caught, then make it documented.
4. **No suppression.** No `any`, no `@ts-ignore`, no disabled lint rules without a comment explaining why and what would let it be removed.
5. **No silent failure.** Every failure path either recovers visibly or surfaces an error. Nothing renders empty and pretends that's the answer.

---

## Before you open the PR

Run the full sweep and report results, not intentions:

- Build, typecheck, lint — clean.
- Crawl every internal link — zero broken.
- Screenshots at all six widths for home, listing, and product page. Look at them.
- Lighthouse for the four routes, before and after.
- Automated axe scan.
- The keyboard path, walked end to end.
- The hostile-content cases above.

Then write the report the way you wrote Phases 0 and 1 — including the part where you list what you got wrong and caught. And include a **known imperfections** section. If it's empty, you didn't look hard enough; say what you're least confident about instead.

---

## Out of scope — note and move on

Cart, wishlist and add-to-bag behaviour (Phase 4). Checkout and orders (Phase 5). Admin panel (6–7). Reviews and coupons (8). Build the UI affordances these will need, wired to nothing, disabled and honest.
