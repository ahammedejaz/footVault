# Foot Vault — Design System

Approved 2026-08-07. This document is the source of truth for tokens, type, and
the two signature interactions. Section 3 of `PROJECT_BRIEF.md` is superseded by
this file wherever the two disagree; the deviations are recorded and justified in
§7.

---

## 1. Origin

The palette is **derived from the existing logo**, not chosen. `FV_Logo.png` is
deep royal blue `#033894` and saturated orange `#FE9301`, and its mark is an
**outsole tread** — which is the motif the brief was independently reaching for
in its "reveal the sole" note. The tread is therefore the brand's texture, not
decoration invented for the site.

Tagline, from the logo: **Every step counts.**

---

## 2. Color tokens

```css
--fv-ink        #0A1526  /* navy-black. hero, footer, admin chrome */
--fv-ink-soft   #0E2A5C  /* raised navy — cards on dark, admin sidebar */
--fv-blue       #033894  /* logo blue, exact. mark + focus outer ring only */
--fv-steel      #596475  /* secondary text */
--fv-line       #C8D0DB  /* hairlines, input borders */
--fv-fog        #EEF1F5  /* cards, section bands */
--fv-paper      #FBFCFD  /* page base */
--fv-orange     #FE9301  /* logo orange, exact. CTA fills, active states */
--fv-orange-ink #A85400  /* orange for TEXT on light surfaces */
--fv-green      #1F7A55  /* admin status chips ONLY — never on the storefront */
--fv-dim        #646E7B  /* struck-through sold-out sizes, zero facet counts */
```

**One accent.** Orange is the only decorative hue on the storefront. Everything
else earns its place through spacing, weight, and hierarchy.

### Measured contrast

All ratios computed against the actual token values, not estimated.

| Pair | Ratio | Verdict |
|---|---|---|
| `--fv-ink` on `--fv-paper` | 17.81:1 | body text |
| `--fv-orange` on `--fv-ink` | 8.18:1 | accent text on dark |
| `--fv-ink` on `--fv-orange` | 8.18:1 | **CTA label** |
| `--fv-fog` on `--fv-ink` | 16.14:1 | body on dark |
| `--fv-orange-ink` on `--fv-paper` | 5.20:1 | links on light |
| `--fv-steel` on `--fv-paper` | 5.83:1 | secondary on paper |
| `--fv-steel` on `--fv-fog` | 5.29:1 | secondary on cards |
| `--fv-blue` on `--fv-paper` | 10.24:1 | mark on light |
| `--fv-green` on `--fv-paper` | 5.15:1 | admin status |
| `--fv-dim` on `--fv-paper` | 5.04:1 | sold-out sizes |
| `--fv-dim` on `--fv-fog` | 4.57:1 | sold-out sizes on cards |

### Three constraints these measurements force

1. **White on orange is `2.24:1` — fails.** CTAs are therefore **navy text on an
   orange fill**, never white. Every other store puts white on its accent; this
   one cannot, and the result reads as industrial signage, which is on-concept.
2. **Raw orange as body text on paper is `2.18:1` — fails.** Orange text on a
   light surface is always `--fv-orange-ink`. `--fv-orange` never carries text on
   `--fv-paper` or `--fv-fog`.
3. **An orange focus ring on paper is `2.18:1` — fails the 3:1 non-text
   minimum.** Focus is a composite: **2px `--fv-orange` inner ring + 1px
   `--fv-ink` outer ring at 1px offset**. The navy carries the visibility
   (17.81:1); the orange carries the brand.
4. **The original `--fv-muted #98A1AE` was `2.54:1` on paper — fails.** It was
   specified for struck-through sold-out sizes, which is *text carrying
   meaning*, not decoration: "which sizes can I buy" is the question the size
   run exists to answer. Replaced with `--fv-dim #646E7B` at 5.04:1 on paper
   and 4.57:1 on fog, still clearly secondary to `--fv-steel` at 5.83:1.
   Found by the axe pass in Phase 3, not by eye.

### Surface strategy — navy-dominant

Navy is used generously, not as an accent on a white page: full-bleed navy hero,
navy footer, navy section bands, navy admin chrome. Paper and fog carry the
catalog and long-form reading, where product photography and legibility need a
light ground.

---

## 3. Type

| Role | Face | Scope |
|---|---|---|
| Display | **Archivo** Expanded, 700–800, `-0.02em` | Hero and section headers only |
| Body | **Instrument Sans**, 400/500/600 | Everything readable |
| Utility | **Geist Mono**, 400/500 | Sizes, SKUs, prices, order numbers, stock counts |

All three self-hosted via `next/font`. No network font requests.

### Scale — 12 · 14 · 16 · 20 · 28 · 40 · 64

| Size/LH | Face | Tracking | Use |
|---|---|---|---|
| 64/60 | Archivo 800 Expanded | -0.03em | Hero, desktop only |
| 40/44 | Archivo 800 Expanded | -0.02em | Hero mobile, section heads |
| 28/34 | Archivo 700 Expanded | -0.02em | Product page `h1` |
| 20/28 | Instrument Sans 600 | — | Sub-heads |
| 16/26 | Instrument Sans 400 | — | Body default |
| 16/16 | Geist Mono 500 | — | Price |
| 14/22 | Instrument Sans 400 | — | Card titles, labels |
| 12/16 | Geist Mono 400 | +0.06em | **Size run**, announcement bar, SKU |

Mono at 12px with positive tracking is what makes the size run read as a shoebox
label rather than a row of buttons. Nothing outside this scale ships.

---

## 4. The signature — the size-run strip

> Every card and every product page shows the full UK run in mono, live sizes
> tappable, sold-out sizes struck through and never hidden — so a customer
> scanning the grid on a phone knows in one glance which shoes exist in their
> size.

**Rules:**

- UK is primary. EU, US, and CM appear in the size-guide modal only.
- Sold-out sizes are struck through in `--fv-dim`. **Never hidden.**
- On the product page the run is a `radiogroup`: one tab stop, arrow keys within
  it, 48×48 chips. Sold-out sizes stay in the run and stay selectable, and their
  accessible name says "sold out" — the strikethrough is invisible to a screen
  reader, and dropping them from the tab order would hide exactly the
  information the strip exists to show. Choosing one is a real answer: the line
  underneath says so.
- Selected size: `--fv-ink` fill, `--fv-paper` label. (The brief said orange
  fill; orange is the *facet* state on the listing, and using it for both made
  a selected size and an applied filter look like the same kind of thing.)
- Chips are 12px mono on cards, read-only, `aria-hidden`, with one spoken
  sentence beside them: "Available in UK 7, 8, 9, 11. Sold out in UK 6, 12."
- Selecting a size updates the URL — with `replaceState`, not a push. A back
  button that walks back through five sizes before leaving the page is a back
  button nobody can use.

**Not yet true:** the design system says a sold-out size opens "notify me".
There is no notify-me until Phase 8, so selecting one currently surfaces the
stock line and nothing else. The seam is the `onSelect` handler in
`size-selector.tsx`.

## 5. Second move — the outsole

Card hover (desktop) and swipe (touch) crossfades from the three-quarter hero to
the **outsole shot**. Every product carries both. A 1px `--fv-orange` underline
draws in on hover alongside the crossfade.

The logo's tread pattern recurs as texture: a 4% navy watermark behind the hero,
the divider between homepage sections, the empty-bag state, and the 404.

## 6. Motion

- One orchestrated hero load sequence. No scattered effects.
- Card hover: image crossfade + 1px orange underline draw-in.
- Scroll reveals: subtle, once, never repeating — and they **rise without
  fading**. An opacity-0 start means everything below the fold is invisible
  until scrolled to, which an automated accessibility pass reads (correctly) as
  text with no contrast against its background, and which a customer whose
  browser stalls the animation reads as a blank page. Reveals are also kept off
  product cards: a grid where each card animates in as it arrives is a grid you
  cannot scan, and scanning is exactly what a size run on every card is for.
- `prefers-reduced-motion: reduce` disables all of it. Non-negotiable.

### Tap targets

44×44 minimum, everywhere, measured programmatically rather than by eye
(`npm run audit:overflow`). Two utilities carry it:

- `.tap-target` — sets the minimum box. For anything that can afford to be 44px.
- `.hit-44` — an invisible, centred `::before` that grows the *target* without
  growing the *box*. The announcement strip is 33px tall on purpose and
  breadcrumbs are 12px mono; making either 44px tall would push the whole page
  down. Same technique as `size="sm"` on Button.

WCAG 2.5.8 exempts a link inside a sentence, and the audit encodes that
exemption rather than padding prose links until the paragraph falls apart.

## 7. Deviations from PROJECT_BRIEF.md §3

| Brief | Shipped | Why |
|---|---|---|
| `--vault-brass #C08B2C` | `--fv-orange #FE9301` | Brass and orange both play the warm-metal accent role; orange is in the logo, brass is not. One accent preserved. |
| `--vault-ink #14161A` | `--fv-ink #0A1526` | Logo blue darkened and desaturated. Same job as graphite, derived from the brand. |
| `--state-stock`, `--state-low` | **cut** | A second warm orange for low-stock fights the brand orange and dilutes the single accent. Stock is now language — "Only 2 left in UK 9" — in steel with a mono numeral. Sold out is struck through. Green survives in `--fv-green` for admin status columns only, where a scannable column genuinely needs color. |
| CTA label color unspecified | navy on orange | Forced by measurement: white on orange is 2.24:1. |
| "focus rings in brass" | composite orange+navy ring | Forced by measurement: orange alone on paper is 2.18:1, below the 3:1 non-text floor. |

## 8. Copy voice

Plain, confident, specific. Buttons name their outcome: **Add to bag**, not
Submit. "Place order" produces "Order placed." Empty states invite action.
Errors say what broke and what to do, and never apologize.

Prices are Indian Rupees, tax-inclusive, Indian digit grouping (`₹1,24,999`),
always set in Geist Mono. Every price is followed by "Inclusive of all taxes"
where a total is shown.

## 9. Brand assets

The supplied `FV_Logo.png` is 1024×1024 raster on an opaque grey field with an
outer glow, a drop shadow, and a blurred wordmark. It is unusable at header
(32px) or favicon (16px) size. Rebuilt as:

- **Mark** — tread silhouette as flat SVG, single-color-capable, 16px→512px.
- **Wordmark lockup** — `FOOT VAULT` in Archivo Expanded 800 beside the mark,
  horizontal, transparent background.
- Original PNG retained for OG and social cards, where the glow reads fine at
  large sizes.

All asset paths resolve through `site_settings`, so the owner can swap them from
`/admin/settings` without a deploy.

## 10. Settled product decisions

- **Colour filtering:** by *family*, not by colourway name. The catalog holds 39
  names — "Peacoat Navy", "Wolf Grey", "Fire Orchid", "Bone" — and the men's
  listing alone offered 26 of them as filter options, which is a glossary rather
  than a filter. `public.color_family()` buckets the hex the owner already
  enters into twelve families, so "Blue (7)" is possible without anyone tagging
  anything twice. Colourway names survive intact on the product page, where the
  distinction is the point.
- **Market:** India. `₹` INR, tax-inclusive, Indian digit grouping.
- **Sizes:** UK primary, EU/US/CM in the size guide.
- **Seed photography:** generated placeholders (hero + outsole per product),
  swappable via `/admin/media`.
- **Listing pagination:** "Load more" button over real `?page=n` URLs, not
  infinite scroll — infinite scroll breaks the back button, makes the footer
  (contact, policies) unreachable, and hides pages from crawlers.

### Still open

Payments, shipping rules, and language are deferred to the phases where they
bind (Phase 5 for the first two). The **returns window** is a placeholder of
**7 days** in the announcement bar and product page until confirmed; it reads
from `site_settings` either way.
