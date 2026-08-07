# Foot Vault — Claude Code Build Prompt

## 0. Role and mission

You are the lead engineer and design lead for **Foot Vault**, an independent footwear retailer. Build a complete, production-grade ecommerce website from scratch: a customer storefront **and** a full admin panel where the shop owner runs the entire business and edits the customer-facing site without touching code.

This is not a demo or a mockup. Every screen must work against real data, on a real phone, with real error states.

**Ground rules for how you work:**

1. Work in the phases listed in Section 9. Finish a phase, self-review it against the acceptance criteria, commit, then move on. Do not jump ahead.
2. Before writing UI code, produce the design plan in Section 3 and show it to me for approval.
3. Ask me before making any decision listed in Section 11 (Open decisions). Do not silently pick.
4. After each phase, run the build, fix every type error and lint error, and take screenshots at 390px and 1440px to check your own work.
5. Never invent data. If something needs seed content, write a real seed script.

---

## 0.1 Standing rules (added Phase 4 — these apply to every remaining phase)

**1. Execution reports.** Every phase produces a report at
`claudeExecutionReport/phase-<n>-<slug>.md`. Each report must contain: what was
built feature by feature with file paths; every decision taken autonomously with
a one-line rationale; every bug found and fixed — including bugs in earlier
phases — with root cause rather than symptom; every measurement with its actual
number; what was got wrong and caught during self-review; an honest list of
known imperfections; what is deliberately deferred and to which phase; and
anything blocked on the owner with the exact steps they need to take. Written
for a reader who was not watching.

**2. Documentation stays current.** No phase is complete until the docs match
the code. Each phase updates, as applicable: `README.md`, `.env.example`,
`docs/architecture.md`, `docs/database.md`, `docs/admin-guide.md`,
`docs/rls-tests.md`, and inline comments where a decision is non-obvious. A
stale doc is a bug; treat it as one.

**3. Authority.** Full authority to fix any bug anywhere in the repo, refactor
what is in the way, add migrations, change dependencies, and adjust tokens where
measurement justifies it — including in code from earlier phases. What still
comes to the owner: business policy (pricing, shipping, returns, sizing,
currency, payment approach), destructive operations on data or git history, and
scope beyond the current phase.

**4. Skills.** Check which skills are available at the start of every phase and
use every one that applies.

---

## 1. The business

- **Name:** Foot Vault
- **Sells:** all varieties of footwear — sneakers, formal shoes, loafers, boots, sports shoes, sandals, slides, flip-flops — across men's, women's, and kids'.
- **Model:** direct-to-customer online store, single shop owner as admin.
- **Two audiences:** customers who want to browse and buy fast on a phone; the owner, who is not technical and needs an admin panel that never requires a developer.

---

## 2. Tech stack (fixed — do not substitute)

| Layer | Choice |
|---|---|
| Framework | Next.js (latest stable, App Router, TypeScript, strict mode) |
| Styling | Tailwind CSS + CSS custom properties for the design tokens |
| Components | shadcn/ui as the primitive layer, restyled to the Foot Vault tokens — do **not** ship default shadcn look |
| Database + Auth + Storage | Supabase, managed **through the Supabase MCP server** |
| Forms + validation | React Hook Form + Zod (one schema shared by client and server) |
| Data mutations | Next.js Server Actions, with Zod validation on the server side of every action |
| State (cart/UI only) | Zustand, for client UI state only. **Superseded Phase 4:** guest carts are rows in `carts`, keyed by an httpOnly `guest_token` cookie — never localStorage, which cannot survive a device change and cannot be read by the server. |
| Images | `next/image`, images served from Supabase Storage |
| Deployment | Vercel |
| Version control | GitHub |

**Supabase MCP rules:**
- Apply all schema changes as **named, numbered migration files** through the MCP server. Never make an untracked change in the Supabase dashboard.
- After every schema change, regenerate TypeScript types into `src/lib/database.types.ts` and commit them.
- Row Level Security is **enabled on every table**, no exceptions. A table without policies is a bug.
- The `service_role` key is used only in server-side code. It must never appear in a client component, a `NEXT_PUBLIC_` variable, or the browser bundle. Verify this before every commit.

---

## 3. Design direction — do this before any UI code

The site must look like it belongs to Foot Vault specifically and to no one else. Cheap, templated, or obviously AI-generated design is a failure condition.

**Explicitly forbidden defaults.** Do not produce any of these three looks:
1. Warm cream background (~#F4F1EA) + high-contrast serif display + terracotta accent (~#D97757).
2. Near-black page with a single acid-green or vermilion accent.
3. Broadsheet layout — hairline rules, zero border-radius, dense newspaper columns.

**The concept: the vault.** The name is the brief. A vault is precision, weight, brass hardware, numbered compartments, things kept in perfect condition. That is the visual and verbal world — steel and brass, not pastel and bubble. Sneakerheads already call their collection a vault; lean into that without saying it out loud in the copy.

### Starting token system (refine it, justify any change)

**Color**
```
--vault-ink     #14161A   /* graphite, near-black with a cool cast — primary surface for hero/footer */
--vault-steel   #6C727D   /* mid grey — secondary text, borders */
--vault-fog     #EFF1F3   /* cool light surface — cards, section bands */
--vault-paper   #FBFBFC   /* page base */
--vault-brass   #C08B2C   /* the ONLY decorative accent — CTAs, active states, the signature */
--state-stock   #2E7D5B   /* in stock */
--state-low     #B4531F   /* low stock */
--state-out     #9AA0A8   /* sold out */
```
One accent. Everything else earns its place through spacing, weight, and hierarchy.

**Type — three roles**
- **Display:** `Archivo` at expanded width, weights 700–800. Tight tracking, large sizes, used sparingly — section headers and the hero only.
- **Body:** `Instrument Sans`. Everything readable.
- **Utility/mono:** `Geist Mono` (ships with the `geist` package). Sizes, SKUs, prices, order numbers, stock counts. This is the one that makes the site feel like inventory rather than a landing page.

Set a real type scale (e.g. 12 / 14 / 16 / 20 / 28 / 40 / 64) and stick to it.

### The signature element: the size-run strip

Every product card and every product page carries a monospace size run rendered as a horizontal strip:

```
6  7  8  9  10  11  12
      ─── ───
```

Available sizes are live and tappable. Sold-out sizes are struck through and dimmed, never hidden. It is honest, it is instantly useful on mobile (customers filter by their own size at a glance), and it is drawn straight from the subject's world — the size run on a shoebox label. This is the thing the site is remembered by. Spend the boldness here and keep everything around it quiet.

### Second subject-grounded move

Product card hover (and swipe, on touch) reveals the **sole**. Footwear photography always has a tread shot; nobody uses it. First image is the three-quarter hero, second is the outsole. This costs nothing and reads as expertise.

### Motion

- One orchestrated hero load sequence. Not scattered effects everywhere.
- Card hover: image crossfade + a 1px brass underline drawing in.
- Scroll reveals: subtle, once, never on repeat.
- `prefers-reduced-motion: reduce` disables all of it. Non-negotiable.

### Copy voice

Plain, confident, specific. "Free returns within 7 days" beats "Shop with confidence." Buttons say what happens: **Add to bag**, not *Submit*. The button that says "Place order" produces a toast that says "Order placed." Empty states invite action ("Nothing in your bag yet — start with the new arrivals"). Errors say what broke and what to do, and never apologize.

### Deliverable for this section

Before writing UI code, give me: the finalized palette with hex values, the type pairing with a sample scale, an ASCII wireframe of the homepage and the product page at mobile and desktop, and one sentence naming the signature. Then critique your own plan: *"if I were given a generic footwear brief, would I have arrived here?"* If yes, revise and tell me what you changed.

---

## 4. Database schema (Supabase)

Design and migrate the following. Use `uuid` primary keys with `gen_random_uuid()`, `timestamptz` for all times, and add `created_at` / `updated_at` with an `updated_at` trigger on every table.

**Catalog**
- `categories` — id, name, slug (unique), parent_id (self-ref, for Men → Sneakers), description, image_url, sort_order, is_active
- `brands` — id, name, slug, logo_url, is_active
- `products` — id, name, slug (unique), description (rich text), category_id, brand_id, gender (`men` | `women` | `unisex` | `kids`), footwear_type (`sneaker` | `formal` | `sandal` | `slide` | `boot` | `sports` | `flipflop`), material, base_price, sale_price (nullable), is_active, is_featured, meta_title, meta_description
- `product_images` — id, product_id, url, alt_text, sort_order, is_primary. Enforce exactly one primary per product.
- `product_variants` — id, product_id, size (text — keep it flexible for UK/EU), color, color_hex, sku (unique), price_override (nullable), stock_quantity (int, ≥ 0), is_active
- `collections` + `collection_products` — curated rails ("New Arrivals", "Monsoon Sandals") the admin controls

**Customers**
- `profiles` — id (FK → `auth.users.id`), full_name, phone, avatar_url, role (`customer` | `staff` | `admin`, default `customer`). Auto-created by a trigger on `auth.users` insert.
- `addresses` — id, user_id, label, recipient_name, phone, line1, line2, city, state, postal_code, country, is_default

**Commerce**
- `carts` — id, user_id (nullable), guest_token (nullable), status
- `cart_items` — id, cart_id, variant_id, quantity. Unique on (cart_id, variant_id).
- `wishlist_items` — id, user_id, product_id. Unique on (user_id, product_id).
- `orders` — id, order_number (human-readable, e.g. `FV-2026-00147`), user_id, status (`pending` | `confirmed` | `packed` | `shipped` | `delivered` | `cancelled` | `returned`), payment_status (`unpaid` | `paid` | `refunded`), payment_method, subtotal, discount_total, shipping_fee, tax_total, grand_total, shipping_address (jsonb **snapshot**), coupon_code, customer_note, placed_at
- `order_items` — id, order_id, variant_id (nullable on delete), plus **snapshots**: product_name, size, color, sku, unit_price, quantity, line_total, image_url. Orders must remain accurate even if the product is later deleted.
- `order_status_history` — id, order_id, status, note, changed_by, created_at
- `coupons` — id, code (unique), type (`percent` | `fixed`), value, min_order_value, max_discount, usage_limit, used_count, starts_at, expires_at, is_active
- `reviews` — id, product_id, user_id, rating (1–5), title, body, is_verified_purchase, is_approved (default false), created_at

**Site content — this is what makes the admin panel real**
- `homepage_sections` — id, section_type (`hero` | `category_grid` | `product_rail` | `banner` | `promo_strip` | `testimonials` | `rich_text`), title, payload (jsonb), sort_order, is_active. The homepage renders whatever is in this table, in this order. The admin can add, reorder, hide, and delete sections.
- `banners` — id, placement, image_url, mobile_image_url, headline, subtext, cta_label, cta_href, starts_at, ends_at, is_active
- `site_settings` — key (PK), value (jsonb). Store: logo, favicon, announcement bar text, contact email/phone/WhatsApp, address, social links, shipping fee rules, free-shipping threshold, currency, return window, business hours.
- `pages` — id, slug, title, body (rich text), is_published. For About, Contact, Shipping Policy, Returns, Privacy, Terms.

**Storage buckets:** `product-images`, `site-assets`, `category-images`. Public read; write restricted to admins.

**Indexes:** slugs, `products.category_id`, `products.is_active`, `product_variants.product_id`, `order_items.order_id`, `orders.user_id`, and a `pg_trgm` GIN index on `products.name` for search.

---

## 5. Row Level Security

Create a `SECURITY DEFINER` function `public.is_admin()` that reads `profiles.role` for `auth.uid()` and returns true for `admin` and `staff`. Use it in every admin policy. Never trust a role claim from the client.

| Table group | Anonymous / customer | Admin |
|---|---|---|
| categories, brands, products, product_images, product_variants, collections, banners, homepage_sections, pages, site_settings | `SELECT` where `is_active` / `is_published` is true | Full CRUD |
| profiles | Read and update own row only. **Cannot update `role`** — enforce with a column check or a trigger. | Full read; role changes via admin only |
| addresses, carts, cart_items, wishlist_items | Full CRUD where `user_id = auth.uid()`, or matching `guest_token` for anonymous carts | Read |
| orders, order_items, order_status_history | `SELECT` own only. Insert only through a server action. | Full read, status updates |
| reviews | `SELECT` where `is_approved`; insert own; update own while unapproved | Full CRUD, approve/reject |
| coupons | No direct read — validated server-side only | Full CRUD |

Write a `docs/rls-tests.md` with a checklist proving each policy: log in as customer A, attempt to read customer B's order, confirm zero rows.

---

## 6. Storefront

### Routes
```
/                      Home — renders homepage_sections from the DB
/shop                  All products, filters + sort
/shop/[category]       Category listing (supports nested categories)
/product/[slug]        Product detail
/search?q=             Search results
/cart                  Bag
/checkout              Address → summary → payment → confirm
/order/[orderNumber]   Order confirmation + tracking
/account               Profile, addresses, order history
/account/orders/[id]   Order detail
/wishlist              Saved items
/page/[slug]           CMS pages (About, Contact, policies)
/auth/login|register|forgot-password|reset-password
```

### Key behaviours

**Home** — Server Components, revalidated on demand when the admin publishes changes. Section order comes entirely from `homepage_sections`.

**Listing pages** — filters for category, size, color, brand, gender, price range, and "in stock only". Filters live in the URL (`?size=9&color=black`) so they're shareable and back-button-safe. On mobile, filters open in a bottom sheet, not a cramped sidebar. Sort by newest, price ascending/descending, popularity. Paginate or infinite-scroll — pick one and justify it.

**Product page** — image gallery with the sole shot, size-run strip as the primary selector, color swatches, price with strikethrough when on sale, stock messaging ("Only 2 left in size 9"), size guide in a modal, add to bag, add to wishlist, delivery estimate, return policy line, reviews, and a "You may also like" rail from the same category. Selecting a size updates the URL. If the product has one variant, preselect it.

**Cart** — works for guests via `guest_token`, and **merges into the user's cart on login** without losing items. Quantity stepper, remove, live subtotal, coupon field, free-shipping progress indicator. Re-validate stock and price on the server every time the cart page loads — never trust localStorage prices.

**Checkout** — as few steps as possible. Address book or new address, order summary, payment method, place order. Server action does the real work: revalidate every price and stock level, decrement stock in a transaction, create the order, write the address snapshot, return the order number. If any variant went out of stock mid-checkout, fail cleanly and tell the customer exactly which item.

**Accounts** — email/password plus Google OAuth via Supabase Auth. Guests can check out without an account; offer to create one after the order.

---

## 7. Admin panel

Route group `/admin`, protected in middleware by `is_admin()`. Non-admins get a 404, not a redirect that reveals the route exists. Visually distinct from the storefront — denser, more utilitarian, same tokens — but built to the same quality. The owner will live in here.

```
/admin                      Dashboard: today's orders, revenue, low-stock alerts, pending reviews
/admin/products             Table: search, filter, bulk activate/deactivate/delete
/admin/products/new         Create
/admin/products/[id]        Edit — details, images (drag to reorder), variants, SEO
/admin/categories           Tree view, drag to reorder, nest, edit, delete
/admin/brands               CRUD
/admin/inventory            Every variant with stock, inline editable, low-stock filter
/admin/orders               All orders, filter by status/date, search by order number or phone
/admin/orders/[id]          Full detail, change status, add note, print invoice
/admin/customers            List, order history per customer
/admin/coupons              CRUD with usage stats
/admin/reviews              Approve, reject, reply
/admin/appearance           ★ Homepage builder, banners, announcement bar
/admin/pages                CMS page editor
/admin/media                Storage browser, upload, delete
/admin/settings             Store info, contact, social, shipping rules, currency, policies
```

**`/admin/appearance` is the feature that makes the owner independent.** It must let them:
- add, reorder (drag and drop), hide, and delete homepage sections
- choose a section type and fill in its fields — pick products for a rail, pick categories for a grid, upload a hero image with separate mobile and desktop crops
- edit the announcement bar and schedule banners with start and end dates
- preview before publishing, then publish, which revalidates the affected paths

**Non-negotiables across the admin:**
- Every destructive action asks for confirmation and names what is being deleted.
- Deleting a product that appears in past orders **soft-deletes** it. Order history never breaks.
- Image upload: drag-and-drop, client-side compression before upload, progress indicator, alt text field.
- Every table: server-side pagination, search, sortable columns, and an empty state that tells the owner what to do first.
- Works on a tablet. The owner will use it standing in the shop.
- Optimistic UI with rollback on failure, and a toast on every mutation.

---

## 8. Quality floor

**Responsive** — build mobile-first. Test at 360, 390, 768, 1024, 1440, 1920. No horizontal scroll anywhere. Tap targets ≥ 44×44px. Sticky "Add to bag" bar on mobile product pages. Test with a long product name and a 40-character category name — nothing may overflow.

**Performance** — Lighthouse mobile ≥ 90 on performance, accessibility, best practices, SEO. LCP < 2.5s on a simulated 4G connection. All images through `next/image` with explicit dimensions and `sizes`. Skeleton loaders that match the real layout so there is no cumulative layout shift. Fonts self-hosted via `next/font`.

**Accessibility** — semantic HTML, one `h1` per page, visible keyboard focus rings in brass, labelled form fields, `aria-live` for cart updates, ≥ 4.5:1 contrast on body text, full keyboard navigation through the entire purchase flow, images with real alt text.

**SEO** — per-page metadata from the DB, Open Graph images, `Product` and `BreadcrumbList` JSON-LD, `sitemap.xml`, `robots.txt`, canonical URLs, human-readable slugs.

**Errors** — `error.tsx` and `not-found.tsx` styled to the brand. Every server action returns a typed result, never throws to the user. Log server errors with enough context to debug.

---

## 9. Build phases

Commit at the end of each. Open a PR per phase so I get a Vercel preview to review.

| Phase | Deliverable | Done when |
|---|---|---|
| **0** | Repo, Next.js + TS + Tailwind, design tokens in CSS variables, fonts, shadcn restyled, base layout, GitHub repo, Vercel project connected | `npm run build` passes; empty styled shell deploys |
| **1** | Full Supabase schema, RLS on every table, seed script with ~30 realistic footwear products and variants, generated TS types | RLS checklist in `docs/rls-tests.md` passes |
| **2** | Auth: register, login, OAuth, password reset, profile trigger, role-based middleware | Non-admin gets 404 on `/admin` |
| **3** | Storefront catalog: home, listing, filters, product page, search | Real data, real images, responsive at all breakpoints |
| **4** | Cart and wishlist, guest cart, merge on login | Guest adds item → logs in → item is still there |
| **5** | Checkout and orders, stock decrement in a transaction, order confirmation, account order history | Two concurrent checkouts on the last unit — exactly one succeeds |
| **6** | Admin CRUD: products, variants, categories, brands, inventory, orders, customers | Owner can add a product and see it live on the storefront without touching code |
| **7** | Admin appearance/CMS: homepage builder, banners, pages, settings | Owner reorders the homepage and it changes on the live site |
| **8** | Reviews, coupons, dashboard analytics, polish pass | Lighthouse targets met |
| **9** | Production deploy, custom domain, env vars, README + `docs/admin-guide.md` written for a non-technical owner | Live and shoppable |

---

## 10. Repo, Git, and deployment

```
src/
  app/
    (storefront)/        # storefront route group + its layout
    (auth)/
    admin/               # admin route group + its layout
    api/
  components/
    ui/                  # restyled shadcn primitives
    storefront/
    admin/
  lib/
    supabase/            # server.ts, client.ts, middleware.ts, admin.ts
    actions/             # server actions, grouped by domain
    validations/         # Zod schemas, shared client + server
    database.types.ts
  styles/
supabase/migrations/
docs/
```

- Branch `main` is protected and always deployable. Work on `feat/<phase>-<slug>`.
- Conventional Commits (`feat:`, `fix:`, `chore:`, `refactor:`).
- `.env.local` is gitignored. Commit `.env.example` with every key listed and no values.
- Env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server only), `NEXT_PUBLIC_SITE_URL`.
- Vercel: connect the GitHub repo, set env vars for Preview and Production separately, enable automatic preview deployments per PR.
- Add a GitHub Action running typecheck, lint, and build on every PR.

---

## 11. Open decisions — ask me, do not assume

1. **Currency and market** — currency symbol, formatting, and whether prices include tax.
2. **Size system** — UK, EU, US, or show multiple? This shapes the size-run strip and the size guide.
3. **Payments** — start with Cash on Delivery only, or integrate a gateway now? If a gateway, which one? Build the payment layer behind an interface either way so it can be swapped.
4. **Shipping** — flat rate, weight-based, or free above a threshold? Which regions do we deliver to?
5. **Returns window and policy** — needed for the product page and the policy page.
6. **Product photography** — do I have real images, or should the seed use placeholders until I supply them?
7. **Logo** — do I have one, or should you set the wordmark in the display face for now?
8. **Language** — English only, or multilingual later? (Affects whether we structure content for i18n from day one.)

---

## 12. Definition of done

The site is finished when the shop owner can, without opening a code editor or calling anyone:

- add a new sandal with four sizes and two colors, upload photos, and see it live within a minute
- create a category, nest it under Women's, and reorder the navigation
- rearrange the homepage, swap the hero banner, and schedule a sale promo strip for next weekend
- take an order, mark it shipped, and print the invoice
- update stock after a walk-in sale
- change the shop's phone number and see it update in the footer and the contact page

— and a customer on a mid-range Android phone on 4G can go from the homepage to a placed order in under ninety seconds, without pinching to zoom once.

---

**Start with Section 3.** Give me the design plan and the wireframes. Nothing else until I approve it.