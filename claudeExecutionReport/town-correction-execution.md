# The town correction — Cuddapah → Proddatur

2026-08-14, third message of the day. Follows `batch-a-closeout-execution.md`,
which raised the conflict. The shop is in **Proddatur**; nothing
shipping-related changed, because nothing shipping-related was wrong.

---

## 1 · The landmark check, and what it turned up

You asked me to check whether "Near RTC Bus Stand" actually describes the
Proddatur location. I could not answer that from the embed you supplied — its
viewport is 61 km across — so I rendered the **same place ID at street zoom**
locally, in a throwaway page, and read it. Screenshot:
`claudeExecutionReport/batch-a/evidence/proddatur-street.png`.

**"Near RTC Bus Stand" is accurate.** *APSRTC Bus Stand, Proddatur* is labelled
about 250 m north of the marker. The landmark stays.

Three more facts came out of the same screenshot, none of which I had before:

| Read from | Fact |
|---|---|
| The listing card | "Foot vault branded store — DCSR Colony, Nadimpalli, Modamidipalle, Andhra Pradesh **516360**" |
| The listing card | **4.8 ★, 16 reviews** — an established listing, not a stub |
| The map | The shop sits just off **Mydukur Rd**, which is the GST certificate's road |

That last row settles something I had got wrong. `src/lib/legal.ts` said the
registered address and the shop were "genuinely different places". They are the
same shop on the same street, under two PINs — 516361 on the certificate, 516360
on the listing and the courier. I have corrected that header rather than leave a
tidy explanation of a thing that is not true.

The reason for keeping the two values apart survives the correction and is now
stated properly: the PINs differ, a delivery quote is keyed on the pickup PIN,
and one string is fixed by a certificate while the other is a line you edit in
`/admin/settings`. `audit:privacy` §5 still enforces the single importer.

---

## 2 · `site_settings.contact.address` — before and after

Seven surfaces read this row, so it changed by exactly one word:

```
- Classic Vastralayam Complex, Shop No. 2, Near RTC Bus Stand, Cuddapah, Andhra Pradesh 516360
+ Classic Vastralayam Complex, Shop No. 2, Near RTC Bus Stand, Proddatur, Andhra Pradesh 516360
```

PIN `516360` untouched. Landmark kept, because the map verified it. The other
three fields of the `contact` block were not read or rewritten — the update
carries them through unchanged.

Revert: `claudeExecutionReport/batch-a/revert-town.sql`, generated from the rows
before they were written.

---

## 3 · Everything else that said the wrong town

**Customer-facing copy** — production database and the seed, in step:

| Surface | Now reads |
|---|---|
| `pages.about` body | "a footwear shop in **Proddatur**, in the YSR Kadapa district of Andhra Pradesh" |
| `pages.about` meta | same, replacing "Kadapa (Cuddapah)" |
| `pages.contact` body | "**Where we are.** {{contact_address}}. That is **Proddatur**, in the YSR Kadapa district of Andhra Pradesh." — the "Kadapa and Cuddapah are the same city" sentence is gone |
| `pages.contact` meta | "…the Foot Vault shop in **Proddatur**, YSR Kadapa district…" |
| `pages.shipping` body | "We ship across India from our shop in **Proddatur**, Andhra Pradesh." |
| `pages.shipping` meta | "…when your order leaves our shop in **Proddatur**…" |
| `siteConfig.description` | "…from our shop in **Proddatur**." — flows to the root description, OG and Twitter on every page |

**Records of fact** — 13 further replacements, each asserted to match exactly
once before being made, none of them a value:

`src/lib/payments/advance.ts`, `src/lib/shipping/pickup.ts`,
`src/lib/shipping/estimate.ts`, `scripts/audit/totals.ts`,
`scripts/audit/shipping.ts`, `scripts/audit/delivery-rules.ts`,
`scripts/audit/delivery-estimate.ts`, `scripts/audit/settings-controls.ts`,
`docs/architecture.md`, `docs/admin-guide.md` (×3).

These are comments and fixture labels recording rate measurements taken from PIN
516360 — "Cuddapah 516360 → Bangalore 560001". The PIN was right; the town label
beside it was not. No threshold, rate, PIN or assertion changed.

`docs/foot-vault-launch-brief.md` still says "one location in Cuddapah". Left
alone — it is your brief, and a record of what was believed when it was written.

---

## 4 · The new map URL is not zoomed in

It is the same view. Diffed segment by segment against the old one — 27 segments
each, and **exactly one differs**:

```
old  …!4v1786712602016!5m2!1sen!2sin
new  …!4v1786715127420!5m2!1sen!2sin
```

`!4v…` is the generation timestamp. The viewport is `!1d61735.230793421586` in
both — roughly a **61 km** span — and the centre coordinates and place ID are
byte-identical. Reopening Share on an unzoomed map returns a URL that looks new
and is not.

I applied it anyway, since it is your canonical link and costs nothing, and I
confirmed mechanically rather than by assumption that `frame-src` already admits
it: the origin is `https://www.google.com`, listed verbatim.

**To actually zoom it:** zoom the map *first*, then Share → Embed. You can check
before pasting — the `!1d…` number is roughly the frame width in metres. Street
level is around `!1d2000`. Send me a URL whose `!1d` is a few thousand and the
map will show the shop and Mydukur Road instead of 61 km of countryside.

---

## 5 · Batch K's premise, amended in the plan

`claudeExecutionReport/launch-plan.md` now opens Batch K with a block that says
the batch below it is wrong, why, and what is already done. The correction that
matters for whoever picks it up:

> Cuddapah is the anglicised name of **Kadapa**, and Kadapa is a different town
> 51 km south. Restating "Kadapa leads" would have optimised the shop for a town
> it is not in — worse than the original defect, because a customer who searched
> Kadapa and drove there would find nothing.

K1, K2, K4, K5, K6 are done. K3 and K7 remain, and K3's blocker changed shape:
the listing **already exists** with 16 reviews, so it is claim-and-verify, not
create. No `LocalBusiness` and no `sameAs` were added, per your instruction.

The original plan text is kept unedited underneath, because the interesting part
is *how* it was wrong: it derived the place name from
`site_settings.contact.address`, and that row said Cuddapah. A plan inherits the
premises of the data it measured.

---

## 6 · Verification

`SHAPE_VERSION` v6 → v7. Needed again, and more than last time: `contact` is
read through `cachedSiteSettings` on **every** route, so without it the footer of
the whole site would have gone on naming the wrong town behind an hour-old entry
while the pages named the right one.

Counted on a production build, every route:

| Route | cuddapah | kadapa | proddatur |
|---|---|---|---|
| `/` | 0 | 0 | 12 |
| `/page/about` | 0 | 4 | 14 |
| `/page/contact` | 0 | 4 | 18 |
| `/page/shipping` | 0 | 0 | 14 |
| `/page/terms`, `/page/privacy`, `/page/returns`, `/shop`, `/cart` | 0 | 0 | 10–12 |

**"Cuddapah" is zero everywhere**, including the production content database —
checked directly across `pages`, `site_settings`, `homepage_sections`, `banners`,
`products`, `collections` and `categories`: no rows.

**Where "Kadapa" is deliberately kept**, and it is only ever the district:

- `/page/about` — "in the YSR Kadapa **district** of Andhra Pradesh"
- `/page/contact` — the same sentence, and "Proddatur, YSR Kadapa district" in
  the meta description

Each appears 4× per page because the same string is served as body text, meta
description, `og:description` and `twitter:description`. Proddatur leads in every
one of them; Kadapa never appears without the word "district" after it.

---

## 7 · A hazard I found and did not fix

`scripts/audit/settings-controls.ts` types QA values into the live
`/admin/settings` form at `BASE_URL` — store name, tagline, phone, WhatsApp,
email, **address**, and both social URLs. Its header says to run it against
`dev:stage`, and nothing enforces that. Pointed at production with an admin
session it would overwrite the shop's entire contact block with
`"12 Gate Street, Proddatur 516360"` and `qa-settings@example.com`.

I found this because I made the neighbouring mistake yesterday in this same
session — `AUDIT_BASE_URL` moves the browser, not the credentials. Not fixed: no
new batches. Worth a guard before anyone runs the suite in a hurry.

---

## 8 · Deploy record

Commit `9d9ae31` → production, promoted **~70 s** after the push. Verified by
alias with **"YSR Kadapa district"** — a phrase that cannot exist in the old tree,
where the same sentence read "Kadapa — still widely written Cuddapah".

Counted on the live site, **both hostnames**, apex and www identical:

| Route | cuddapah | kadapa | proddatur | raw `{{…}}` |
|---|---|---|---|---|
| `/` | 0 | 0 | 12 | 0 |
| `/page/about` | 0 | 4 | 14 | 0 |
| `/page/contact` | 0 | 4 | 18 | 0 |
| `/page/shipping` | 0 | 0 | 14 | 0 |
| `/page/terms` | 0 | 0 | 12 | 0 |
| `/page/privacy` | 0 | 0 | 10 | 0 |
| `/page/returns` | 0 | 0 | 10 | 0 |
| `/shop` | 0 | 0 | 10 | 0 |

Spot checks on the live response:

- footer address on an unrelated route (`/shop`): "…Near RTC Bus Stand,
  **Proddatur**, Andhra Pradesh 516360" — the settings row propagated everywhere,
  which is what the `SHAPE_VERSION` bump was for;
- map embed: new timestamp `1786715127420` present, old `1786712602016` absent;
- `frame-src`: unchanged, `api.razorpay.com checkout.razorpay.com
  www.google.com` — no CSP edit was needed and none was made;
- `https://wa.me/917337579733` still on the contact page.

Gates: `audit:literals` PASS, `audit:privacy` PASS (5 sections),
`audit:build-smoke` PASS, `audit:contact` red on the two social URLs only.
`typecheck` and `lint` clean, run last.

---

## 9 · Still open

1. **The two social URLs** — still the seed fixtures, still live in the footer.
   `audit:contact` stays red until they are confirmed or cleared.
2. **A zoomed map URL**, if you want one — §4 explains how to tell before you
   paste it.
3. **K3 / B3** — the GBP listing name, and then `LocalBusiness` + `sameAs`.
   Neither added, per your instruction.
4. **K7** — category descriptions that mention the shop.
5. `site_settings.payment_methods` — public, read by nothing, says online
   payment is off while the shop takes online payments.
6. A guard on `audit:settings-controls` (§7).
