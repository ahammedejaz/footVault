# Three owner-reported problems — audit only

**Date:** 2026-08-15 (session ran 14 Aug 11:45 PM → 15 Aug 12:15 AM IST)
**Scope:** causes and options only. No `src/` changes, no migrations, no schema edits, no dashboard changes. The only writes made anywhere were a staging repro fixture (one image row + one QA account, both created and deleted by the repro script) — production was only read.

---

## 1 · The uploaded photo that did not appear

### Verdict first

**The hypothesis is disproven as the primary cause.** Admin image writes *do* invalidate the read cache, and the invalidation was proven to work end-to-end against a staging production build — the served page carried the new image roughly **one second** after the upload committed. The photo the owner uploaded is invisible for a different reason: **the product-page gallery renders only the images tagged with the currently selected colourway, and an admin upload is written with no colour at all.** On a product whose colourways have their own photography — which is all 35 of them, seeded — a fresh upload can never appear in the gallery. Not for an hour; not ever.

### The incident, located in production data

The upload behind the report is identifiable: `asics-gel-kayano-31-wide-womens`, uploaded 14 Aug 22:09 IST, the only image on that product with `original_path` set (a real pipeline upload; the other four images are seed placeholders).

| product | image colour tags | what the customer sees |
|---|---|---|
| asics-gel-kayano-31-wide-womens | Peacoat Navy ×2, Sea Salt ×2 (seed), **null ×1 (the real upload, promoted to main)** | Gallery: seed drawings only, on both colourways. Card/hero + JSON-LD: the real photo. |
| woodland-nubuck-trek-mens | null ×3 (one real upload, 13 Aug) | Everything shows — its one colourway (Khaki) has **no** colour-tagged images, so the gallery falls back to the untagged set. |

That asymmetry is why uploads "sometimes work": the Woodland upload appeared, the Asics one didn't. The mechanism (`src/lib/queries/catalog.ts:157-171` + `src/components/storefront/product-viewer.tsx:87-95`): each colourway's gallery = images whose `color` string equals the variant's colour; only when a colourway owns **zero** tagged images does it fall back to the `color IS NULL` set. The viewer defaults to the first colourway, so Peacoat Navy's two seed drawings win. The production page tonight confirms it: the new photo's derivative hash appears exactly once in the HTML — hero/JSON-LD — and never in the gallery markup.

### The full path, upload → render

1. **Bytes**: browser → `requestUploadSlot` (signed URL) → Supabase Storage bucket **`product-images`** (originals; RLS `is_admin()` on the bucket policy).
2. **Processing**: `normaliseUpload` (Server Action) reads the original, writes four WebP derivatives to `product-images/derived/v1/<contentHash>/…` (content-hashed paths, `cacheControl` 1 year — safe because a new crop is a new path).
3. **Row**: `addProductImage` inserts into **`product_images`** — `url`, `original_path`, `crop`, `alt_text`, `sort_order` = end of gallery, `is_primary` only if it is the first image. **`color` is never written** (`src/lib/actions/admin/products.ts:819-837`), and no admin action exists to set it.
4. **Cached bindings** (`src/lib/queries/cached.ts`): product page content through `cachedProductContent` (tag `catalog`, 1 h, keyed `SHAPE_VERSION`+project-ref+name); homepage rails through `cachedHomepageSections` / `cachedCollectionProducts` (same tag). `/shop` and `/search` are deliberately uncached and dynamic.
5. **Revalidation**: `addProductImage` → `revalidateCatalog()` = `updateTag("catalog")` + `revalidatePath("/", "layout")` + `revalidatePath(/product/[slug])`. The route is ISR (`revalidate = 3600` + `generateStaticParams`), so both halves are needed and both fire.

### Which admin writes revalidate, and which do not

Every storefront-visible write revalidates. The table is less interesting than hoped — the discipline is real:

| write path | storefront cache action |
|---|---|
| products: save/delete/restore/activate, variants, **all four image actions**, re-crop (`image-pipeline.ts`) | `updateTag(catalog)` + layout & slug paths |
| brands, categories | `updateTag(catalog)` + `updateTag(chrome)` + paths |
| settings: shipping/store/announcement/image | `updateTag(catalog` or `chrome)` + paths |
| appearance publish, media delete/detach | `updateTag(catalog)` + paths |
| inventory adjust, checkout, RTO restock, order transitions, abandoned-order cron | `stockChanged()` → `updateTag(catalog)` (cron route uses the `revalidateTag` variant legally) |
| orders/refunds/rto/coupons/loyalty/customers admin panels | admin + account paths only — correct; nothing cached on the storefront reads those tables |
| `requestUploadSlot`, `normaliseUpload`, `proposeFrame` | none — correct; no customer-visible change until the row lands |

**`updateTag` vs the Data Cache**: `updateTag` and `revalidateTag` funnel into the same tag-encoding + incremental-cache machinery in this Next build (16.3.0, `dist/server/web/spec-extension/revalidate.js`), so `unstable_cache` tags are covered despite the doc only naming `fetch`/`'use cache'`. Proven locally under `build:stage` (this session, ~600 ms to fresh; and previously by the appearance gate going 14/4 red when `updateTag` was deleted). **Never proven against Vercel's production Data Cache** — every past production fix used a `SHAPE_VERSION` bump, which changes the key rather than expiring it. Tonight's production page does not settle it either: by the time it was fetched, the hourly window had passed on its own. That is the honest boundary of what is known.

### Is there a gate that would go red if revalidation were deleted from the image path?

**No.** Honestly: `audit:image-upload`'s only storefront read is `/shop` — which is uncached and dynamic, so it stays green with `revalidateCatalog` deleted entirely — and its derivative assertion is `html.includes("derived/v1/")` over the whole page, satisfiable by any other product's card. `audit:images` is pipeline-only (no browser); `audit:gallery` is geometry. The settings and appearance paths *do* have freshness gates (built after the earlier incident, and only meaningful under a production build); the catalog/image path has none. CI runs typecheck, lint, shapes, build and the two guards — no runtime cache behaviour at all.

### The staging reproduction (production build, `build:stage` + `next start` :3210)

Product: Classic Clog — Navy ×2 / Black ×2 / Bone ×2, all colour-tagged, the same shape as the Asics incident. Real upload through the admin Photographs panel, real customer reads through a separate browser:

```
18:40:49  commit pressed
18:40:51  product_images row written  (color=null, is_primary=false, sort=6, +2.4 s)
18:40:52  customer product page: served payload contains the new derivative — cache CLEARED (+0.6 s)
          customer gallery DOM: does not render it
18:41:15  "Make main" pressed
18:41:35  customer product page: payload fresh; gallery still does not render it
```

**What the customer actually gets, and for how long:** on `/shop`, `/search` — the new photo as soon as it is primary (uncached). On the product page and homepage — data refreshed within ~1 s of the write (locally proven; on Vercel the designed lever is the same one, with the 1-hour `revalidate` window as the outside bound if it were ever to fail, plus one stale-while-revalidate request). **In the product gallery — never**, until the image can carry a colour. The gallery is where a customer decides; that is the surface the report was about, and no amount of cache work changes it.

*(Repro artifacts: the script cleaned up its row and account; four derivative files remain unreferenced in the staging bucket, same as `audit:image-upload` leaves.)*

---

## 2 · Images per colour — what exists

### The model today

- **A colour is not a first-class thing.** A colourway exists only as a repeated text string: `product_variants.color` (`NOT NULL`, part of `unique (product_id, size, color)`), with `color_hex` and `color_family` duplicated onto every size row. 35 products, 403 variants, 39 distinct colour strings; 11 products have one colourway, 22 have two, 2 have three. One colour is **not** one product.
- **`product_images.color` already exists** — nullable text, indexed `(product_id, color, sort_order)` (migration `20260807135027`), matched to variants by exact string equality. Written **only by the seed**: of the 124 production images, 120 carry a colour (all seed), 4 are null (3 Woodland + the Asics upload — i.e. both real uploads ever made, plus two Woodland placeholders).
- **The storefront selection is already per-colour** (§1): per-colourway gallery with null-set fallback; the *card* hero is colour-blind — first image by sort/primary across the whole product, stock summed across colourways.
- **The admin can read but not write it**: the image manager shows a "*{colour} only*" badge when set (`image-manager.tsx:118-120`); no upload field, no action, no editor sets it. `addProductImage`'s schema has no colour input.
- **A latent orphaning bug while it stays a string:** `saveVariant` renames a colourway without touching `product_images.color`. Rename "Navy" to "Midnight" and the two Navy images stop matching anything — the gallery falls back to the null set (empty for seeded products), so the colourway loses its photography silently. Nothing gates this.

### What the two options cost

**Option A — finish the string model (colour becomes writable).**
Schema: none — the column, index and storefront selection all exist. Migration for the existing images: none (120 are already tagged; the 4 nulls are legitimately "all colours"). Work: a colour picker on the upload panel and image manager (choices = that product's variant colours + "all colours"), `addProductImage` accepts an optional colour validated against the product's variants, one new `setImageColor` action, `SHAPE_VERSION` bump, and extending `audit:image-upload` to operate the picker and assert the gallery under the right colourway (which §1 shows is also the missing freshness surface). `audit:literals`: no new table, nothing to classify.
Trade-offs: keeps string matching, so the rename-orphan bug above stays and should be patched in the same pass (`saveVariant` cascading the rename, ~10 lines); per-colour ordering stays derived from the global `sort_order`; "main image" stays product-global.

**Option B — first-class colourways.**
Schema: new `product_colorways (id, product_id, name, hex, family, sort)` + `colorway_id` FKs on `product_variants` and `product_images`; RLS policies; grants restated (the function-ACL lesson). Migration: derive rows from the 403 variants' distinct `(product, color)` pairs, backfill 403 variants + 124 images, then either drop or keep the legacy text columns through a transition. Admin UI: a colourway manager (create/rename/re-sort) plus the same picker as A. Storefront: query joins change shape → `SHAPE_VERSION` bump, shapes snapshot re-record. Audits: `audit:literals` **must classify the new table** (colourway names are customer-visible content → scanned surface with a label function); `security-advance`, shapes and the RLS gates all touch it. This is a production migration → the full `production-migration-procedure` (rebuild:stage, verified dump, dry-run push, PostgREST gates).
Trade-offs: rename-safe by construction, hex/family stop being duplicated per size row, and it is the foundation if colourways ever need their own price, SEO URL or card. Meaningfully more work and a production schema migration for a catalogue of 35 products.

Both are viable; per the brief, no recommendation is made here.

---

## 3 · Shiprocket / Razorpay state does not flow back

### Source of truth and its writers

`orders.status` is the source of truth, moved by exactly four writers, all serialised by compare-and-swap or row locks: `create_order_with_stock` (checkout), `cancel_order_with_restock` (admin cancel, customer cancel, abandoned sweeps), `applyPaymentOutcome` (Razorpay events — webhook, browser callback, reconciler), and `transitionOrder` (admin buttons; delegates cancellation to #2). `shipments.status` is a separate, admin-only column that mixes our workflow states (`creating`→`created`→`awb_assigned`→`pickup_scheduled`) with, after any tracking refresh, Shiprocket's raw string.

### Every inbound path that exists now

| path | trigger | what it can change | exercised with real data? |
|---|---|---|---|
| Razorpay webhook (`/api/payments/razorpay/webhook`) | push | payment state → order `confirmed`/stays `pending`; refund events settle `refunds` rows (dashboard refunds arrive this way) | **Yes** — production `payment_events`: `payment.captured`×8, `order.paid`×8, `payment.authorized`×2, `payment.failed`×2, `refund.processed`×2 (9–10 Aug) |
| Browser success callback | customer's phone | same seam (`client.callback`×8) | Yes |
| Reconciler cron (`release-abandoned-orders`, every 10 min) | pg_cron→pg_net | asks Razorpay about pending orders; cancels only on a definite "no money" | Yes — 10 system cancellations in the history |
| Delivery poller (`poll-deliveries`, every 30 min) | pg_cron→pg_net | `shipped` orders with an AWB → `delivered` (courier-stamped) or RTO reroute | **No — it has never once had a candidate.** No order in this shop's history has reached `shipped`. Fixture-tested only (`audit:delivery-poll`), and that gate's own header says so: *"`deliveredTimestamp` has never seen one… the first real delivery is the real test."* |
| Admin "Refresh tracking" button | manual | same `fetchTracking`; caches SR's status string on the shipment row | **No** — both production shipments still hold internal statuses; no SR tracking payload has ever been applied in production |
| Manual admin actions | manual | any legal transition | Yes |

**What the tracking path could even recognise if it ran:** `/delivered/i` (with a courier timestamp) and `/rto/i`. A Shiprocket **"Canceled"** is neither — at most it would appear as a caption on the admin shipping panel after a manual refresh. It never transitions the order, never prompts anything.

**The incident order:** FV-2026-00668 — Razorpay-paid ₹13.50, AWB assigned 14 Aug 21:22 IST, cancelled in the Shiprocket portal, still `packed` here. It is not `shipped`, so the poller will *never* examine it; no webhook exists to tell us; the admin page still shows a bookable pickup. Also live: FV-2026-00571 — COD, ₹349 deposit paid of ₹1,848, shipment created 8 Aug, `packed` since.

### What each provider offers that we do not consume

- **Shiprocket**: consumed = auth, serviceability, adhoc order create, AWB assign, pickup, label/manifest/invoice, AWB tracking, wallet balance, pickup addresses. **Not consumed:** their **status-update webhook** (push on every shipment status change, configured in their portal — a dashboard change, so owner-only), the order-details/status pull APIs (we only pull per-AWB tracking, and only for `shipped` orders), the **order-cancel API** (our own admin cancel does not cancel the Shiprocket order either — the desync runs in both directions), NDR and returns APIs.
- **Razorpay**: consumed = orders, payment fetch, refunds create/fetch, and the webhook family above (`refund.processed`/`refund.failed` handled; dashboard refunds already flow back). **Not consumed:** `refund.created` (in-flight visibility), `payment.dispute.*` (a chargeback today is invisible until money leaves), settlement/reconciliation APIs.

### The money question

What the code does today, traced not assumed:

- **Our own cancel refuses to run ahead of the money.** `cancel_order_with_restock` is called with `p_require_unpaid: true`; a paid order comes back `already_paid` and the admin is shown the exact outstanding amount (net of settled refunds — the FV-2026-00623 double-refund lesson is already encoded). Refunds move through `initiateRefund` (server-computed amount, recompute-and-refuse on mismatch) or through the Razorpay dashboard, whose `refund.processed` webhook settles our row. This machinery is sound **but is only reached when *our* order is being cancelled.**
- **A Shiprocket-portal cancellation reaches none of it.** The order stays `packed`, `payment_status = paid`. FV-2026-00668's ₹13.50 sits captured with no queue entry, no instruction, no timer — the refund happens only if the owner independently remembers. The dashboard's refund queue lists captures against *cancelled* orders; an order that never becomes cancelled here never enters it.
- **POD deposit, same shape:** FV-2026-00571's ₹349 advance is refundable through the same panel, but only after someone notices the shipment is dead and cancels the order here first.

Per the brief, nothing about refunds was implemented or configured, and the Shiprocket/Razorpay portals were not touched — webhook subscription there is a dashboard change and stays with the owner.

---

## Method and confidence notes

- Production was **read only** (SQL selects, public-page fetches). The repro wrote to staging only, behind `assertServerNotProduction`, and removed its fixtures.
- The staging repro ran against a production build (`build:stage`), because dev re-renders per request and proves nothing about caching. What a local production build cannot prove is Vercel's own Data Cache honouring tag expiry; that remains the one untested link in §1's cache chain, and it is secondary — the gallery filter dominates regardless.
- During the repro the staging server wedged once mid-run (requests hung; restart cleared it) — noted for completeness; the completed run above is from the clean server.
