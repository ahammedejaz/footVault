# Foot Vault

Ecommerce storefront and admin panel for Foot Vault — sneakers, formal shoes,
boots and sandals for men, women and kids.

The owner runs the entire business from `/admin`, including the customer-facing
homepage, without touching code.

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router, TypeScript strict) |
| Styling | Tailwind CSS v4 + CSS custom properties for design tokens |
| Components | shadcn/ui primitives, restyled to the Foot Vault tokens |
| Database, auth, storage | Supabase (managed through the Supabase MCP server) |
| Forms | React Hook Form + Zod, one schema shared client and server |
| Mutations | Server Actions, Zod-validated server-side |
| Auth | Supabase Auth — **Google only**, PKCE, sessions in cookies |
| Cart | Rows in `carts`, keyed by an httpOnly `guest_token` cookie. Never localStorage |
| Orders | One Postgres transaction. Prices recomputed server-side; stock claimed at checkout |
| Payments | Prepaid and **Pay on Delivery**, both through Razorpay, behind one `PaymentAdapter`. `fetch` + `node:crypto`, **no SDK** |
| Delivery | Rates quoted live from the Shiprocket API. Nothing hardcoded; the thresholds are admin settings |
| Email | Behind an `EmailAdapter`. Console adapter until a provider is configured |
| Scheduled work | `pg_cron`, inside Supabase. One job: the abandoned-order sweep |
| Client UI state | Zustand — the bag drawer, and nothing the server owns |
| Deployment | Vercel |

## Getting started

```bash
npm install
cp .env.example .env.local   # then fill in the values
npm run dev
```

Open http://localhost:3000. The design system renders at `/style-guide`.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run shapes` | Fails if a cached return type changed without a `SHAPE_VERSION` bump. **Runs in CI** |
| `npm run shapes:write` | Re-record the shape snapshot after a deliberate change |
| `npm run seed` | Upsert the seed catalog into Supabase (needs `SUPABASE_SERVICE_ROLE_KEY`) |
| `npm run seed:sql` | Write `supabase/seed.sql` instead, for `supabase db reset` |
| `npm run seed:images` | Regenerate the drawn product assets in `public/seed/` |
| `npm run audit` | The browser and database gate — every `audit:*` below except `security`, `lighthouse`, `shots` and `teardown` |
| `npm run audit:overflow` | Six widths × every route — overflow, 44px tap targets, 16px inputs |
| `npm run audit:a11y` | axe-core, WCAG 2.2 A/AA, at 390px and 1440px, overlays included |
| `npm run audit:keyboard` | home → category → filter → product → size, by keyboard only |
| `npm run audit:keyboard-checkout` | The checkout path by keyboard, to the place-order button |
| `npm run audit:focus` | The composite focus indicator actually paints on every interactive element |
| `npm run audit:gallery` | The product gallery's runtime behaviour |
| `npm run audit:hydration` | Headless-Chromium console: no hydration mismatch below `<body>` |
| `npm run audit:interactions` | The behaviour a screenshot cannot show |
| `npm run audit:links` | Crawls every internal link; checks titles and JSON-LD |
| `npm run audit:auth` | Role escalation over real HTTP; `/admin` 404s for everyone but an admin |
| `npm run audit:cart` | Merge on sign-in against the live database, RLS in force |
| `npm run audit:bag` | The whole purchase path in Chromium at 390px |
| `npm run audit:signedin` | The signed-in storefront: saved list, account menu, account cart |
| `npm run audit:checkout` | Checkout, orders and webhook idempotency against the live database |
| `npm run audit:shipping` | Shiprocket end to end, mocked: token cache, serviceability, the fee split, and that the COD collectable is the balance |
| `npm run audit:totals` | The advance arithmetic in isolation — 15 assertions, no database and no browser |
| `npm run audit:admin` | The admin surface: role gate, inventory ledger, reconciliation |
| `npm run audit:security` | The adversarial regression suite, through the real webhook route over HTTP |
| `npm run audit:lighthouse` | Performance on a local production build, `--throttling-method=devtools` |
| `npm run audit:shots` | Full-page screenshots at all six widths |
| `npm run audit:teardown` | Sweeps accounts and rows a crashed harness left behind |

The audits drive a real browser against a running build, so they need
`npm run build && npm start` first and a reachable database. They are not in CI
for that reason — CI builds with placeholder credentials on purpose. `npm run
shapes` is the exception and does run in CI, because it reads types through the
TypeScript compiler and needs no database, no build and no browser.

Two of them want more than a running server:

```bash
# The order/webhook suites write real rows. They sweep after themselves and
# print the counts, so the sweep can be checked rather than believed.
npm run audit:checkout

# The adversarial suite posts to the real webhook route, so it needs the same
# secret the server was started with, and the port that server is on.
RAZORPAY_WEBHOOK_SECRET=<the value your server was started with> \
FV_BASE_URL=http://localhost:3491 \
npm run audit:security
```

The seed is idempotent — every write is an upsert on a natural key, so running
it twice produces one catalog rather than two. `scripts/seed-data.ts` is the
single source of truth for both the live and the SQL path.

CI runs typecheck, lint, the shape snapshot and build on every pull request, and
fails the build if `SUPABASE_SERVICE_ROLE_KEY` is referenced anywhere outside
`src/lib/supabase/admin.ts`, or if a Client Component imports a `server-only`
module. The build runs with placeholder Supabase credentials, so a pull request
can be verified without live database access.

The shape step is the one that is not obvious. `unstable_cache` keys on its key
parts and never on the code that produced the value, so adding a field to a
cached return type does *not* invalidate the entries already on disk — the new
code reads old objects silently missing it. Phase 4 shipped exactly that
(`variantId` on `SizeAvailability`) and add-to-bag quietly believed no size had
been chosen. `npm run shapes` expands all 13 cached return types structurally
through the TypeScript checker and fails when one changes without a
`SHAPE_VERSION` bump.

CI also fails if a `"use server"` file exports anything but an async function.
That one is not theoretical: Phase 4 shipped a plain constant from an actions
module, which type-checked, linted and built clean, then threw the first time a
customer pressed the button.

Two project ESLint rules live in `eslint-rules/` and run as part of `npm run
lint`:

| Rule | Stops |
|---|---|
| `footvault/no-unchecked-supabase-error` | Reading a PostgREST result without looking at `error` — the shape that turns a failed query into an empty page. Also catches `.then()` on a builder and a raw builder inside `Promise.all`. |
| `footvault/no-off-scale-type` | `text-[13px]` and friends. The type scale is seven steps; arbitrary values bypass the theme. |

Every database read goes through `src/lib/queries/run.ts`, which throws on a
PostgREST error rather than returning nothing. The lint rule is what keeps it
the only path.

## Database

The schema lives in `supabase/migrations/`, applied in order through the
Supabase MCP server. Row Level Security is on for every table in `public`, and
[`docs/rls-tests.md`](docs/rls-tests.md) records the checks that prove it —
including the two defects that pass found and fixed.

Money is stored as **integer paise** throughout (₹8,995 is `899500`). Nothing
touches a float; `src/lib/format.ts` converts at the UI boundary.

## Environment

See `.env.example` for the full list and the reasoning attached to each one.

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public by design |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server-only.** Bypasses RLS; never a `NEXT_PUBLIC_` prefix, never outside `src/lib/supabase/admin.ts`. Checkout needs it — the order transaction runs through the admin client |
| `NEXT_PUBLIC_SITE_URL` | Absolute origin for `metadataBase`, OG images and the sitemap. Not the OAuth redirect |
| `RAZORPAY_KEY_ID` | Publishable. Reaches the browser, but only inside a `PaymentInitiation` the server returns |
| `RAZORPAY_KEY_SECRET` | Secret. Basic-auth password, and the HMAC key for the *browser callback* signature |
| `RAZORPAY_WEBHOOK_SECRET` | A **different** secret. HMAC key for `x-razorpay-signature`, and only that |
| `EMAIL_API_KEY`, `EMAIL_FROM` | Names only. Nothing reads them yet; the console adapter is what ships |
| `SITE_INDEXABLE` | Only the exact string `true` lets search engines in. Anything else is noindex. Changing it needs a **fresh build**, not a redeploy — the header is baked into the build manifest |
| `SHIPROCKET_EMAIL`, `SHIPROCKET_PASSWORD` | An **API user** created in the Shiprocket panel, not the panel login. `/v1/external/auth/login` trades them for a JWT valid 240 hours. **Not** a static API key — there is no `SHIPROCKET_API_KEY` and the one that used to sit in `.env.local` authenticated nothing |
| `SHIPROCKET_PICKUP_LOCATION` | The pickup nickname exactly as spelled in the panel. Unset falls back to `"Primary"`, which this account is not called, so it fails when a real parcel is created rather than at boot |

Leaving the Shiprocket pair unset turns the integration off rather than
breaking it: checkout still works, Pay on Delivery is still offered, and the
delivery charge falls back to `site_settings.shipping.fallback_fee_paise`. **No
rate is ever hardcoded.** Every real delivery price comes from the Shiprocket
API; the fallback exists because refusing to sell during a courier outage is
worse than mispricing a handful of orders, and it is a setting so the owner can
correct it without a deploy.

**There is deliberately no `NEXT_PUBLIC_RAZORPAY_KEY_ID`.** The key id is
publishable, but a `NEXT_PUBLIC_` variable is inlined into every page in the
bundle, including the ones that will never take a payment. The server hands it
over inside the payment initiation, at the moment an order exists and is about
to be paid — same value, a hundredth of the exposure, and rotating it does not
need a redeploy of the whole site.

Every Razorpay value is set **separately for Preview and Production** in Vercel,
so a preview build can never take a live payment and a preview webhook secret
can never verify a production event.

## Running checkout locally

```bash
npm run build && npm start          # the audits need a production build
```

Then `/cart` → **Checkout**. Two ways through it, and **both need Razorpay
keys** — that is the Phase 6 change, and it is the whole of the new payment
model:

**Prepaid** settles the grand total online. **Pay on Delivery** charges an
*advance* online at checkout and the courier collects the balance in cash. Both
go through the same adapter, so a shop with no keys configured offers neither —
`codAdapter.isAvailable()` is `razorpayAdapter.isAvailable()`.

Neither is confirmed before money moves. Both orders are written `pending` and
`unpaid` with their stock already claimed, and only a captured payment moves
them to `confirmed`. Nothing is `confirmed` at the moment it is placed any more:
that path is what produced `FV-2026-00488`, a confirmed and unpaid order holding
₹1,719 of stock against a promise.

`RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` come from a **test mode** account:

1. <https://dashboard.razorpay.com> → toggle to **Test Mode** (top of the
   sidebar; test keys start `rzp_test_`).
2. *Account & Settings* → *API Keys* → **Generate Test Key**. You are shown the
   secret once.
3. Put both in `.env.local`. Neither takes a `NEXT_PUBLIC_` prefix.
4. Restart. Both methods now appear — with no keys the list is empty, on
   purpose, because a customer who picks a method that 500s has been failed
   twice.
5. Test cards are in Razorpay's docs; `4111 1111 1111 1111` with any future
   expiry and any CVV succeeds.

**The webhook cannot reach localhost.** Razorpay posts server-to-server to a
public HTTPS URL, so on a laptop the browser callback is the only thing that
confirms an order. That is enough to develop against, and it is exactly the
degraded mode the code is written for: the callback verifies a signature and
reads the payment back from Razorpay's API, and the webhook — when it exists —
applies the same outcome through the same seam under a different idempotency
key. To exercise the webhook properly, either deploy to a preview and register
the URL, or run `npm run audit:security`, which posts real HMAC-signed events at
the local route.

## Layout

```
src/
  app/
    (storefront)/     storefront route group and its layout
      checkout/       one page, not a wizard
      order/          the confirmation and receipt, by order number
      account/        orders, addresses
    auth/callback/    OAuth code exchange, cart merge, order adoption, pending intents
    admin/            admin route group (placeholder until Phase 6)
    api/              cart JSON for the drawer, search suggestions,
                        payments/razorpay/webhook — the only route an outsider posts to
    global-error.tsx  the boundary that can catch a failing root layout
    error.tsx         RouteError — everything below the root layout
  components/
    ui/               restyled shadcn primitives
    brand/            logo and mark
    storefront/
    checkout/         the checkout flow, order detail, timeline, totals
    admin/
  lib/
    supabase/         server.ts, client.ts, proxy.ts, static.ts, admin.ts
    actions/          server actions, grouped by domain
    queries/          server-only reads; cached.ts holds the LCP-path cache
    cart/             the bag's token and the merge
    orders/           the state machine, the only writer of order state, and
                        totals.ts — the one place a total is computed
    payments/         the PaymentAdapter seam; cod.ts and razorpay.ts behind it.
                        advance.ts is the pure advance/balance split
    shipping/         Shiprocket: token, serviceability, the fee rules,
                        fulfilment, and the settings the owner tunes
    email/            the EmailAdapter seam; console adapter until a provider exists
    validations/      Zod schemas, shared client and server
    indexing.ts       the noindex gate, dependency-free for next.config.ts
    catalog-types.ts  view models with no server dependency —
    cart-types.ts       the client half imports from these
    database.types.ts
  proxy.ts            session refresh and the /admin guard (Next 16's middleware)
supabase/migrations/
docs/
```

## Documentation

| Document | Covers |
|---|---|
| [`docs/design-system.md`](docs/design-system.md) | Tokens, type scale, measured contrast, the signature element |
| [`docs/rls-tests.md`](docs/rls-tests.md) | Row Level Security checklist, run against the live database, with results |
| [`docs/architecture.md`](docs/architecture.md) | How the pieces fit: rendering, caching, the client/server boundary, the bag, the order state machine, the payment seam |
| [`docs/database.md`](docs/database.md) | Every table, its policies, and the functions with their grants |
| [`docs/admin-guide.md`](docs/admin-guide.md) | For the shop owner. How to make yourself an admin, what you can change, and what to do with an order |
| [`docs/phase-3-report.md`](docs/phase-3-report.md) | What Phase 3 changed, what it measured, and what it did not finish |
| [`claudeExecutionReport/phase-4-cart-wishlist.md`](claudeExecutionReport/phase-4-cart-wishlist.md) | Phase 4, in full: decisions, bugs, measurements, known imperfections |
| [`claudeExecutionReport/phase-5-checkout-payments.md`](claudeExecutionReport/phase-5-checkout-payments.md) | Phase 5, in full — and what a six-agent build cost and returned |
| [`claudeExecutionReport/phase-5-security-review.md`](claudeExecutionReport/phase-5-security-review.md) | The adversarial review of checkout, orders and payments: eight findings, five fixed |
| `PROJECT_BRIEF.md` | Full requirements and build phases |

## Signing in

Google only. No email/password, no registration form, no password reset —
absent rather than disabled, because each is a surface to secure, rate-limit and
support, and a shop this size gets nothing from them that "continue with Google"
does not already give.

**Customers never need an account to buy.** Signing in is what makes a bag
survive a new phone, keeps a saved list, and puts orders in one place. Checkout
stays open to guests, and a guest who signs in afterwards keeps the order they
placed — `/auth/callback` moves it onto the new account before it drops the
guest cookie, and refuses to drop the cookie if that fails.

## A note on phase order

Phase 3 was built before Phase 2. Phase 4 folded Phase 2 in, since cart merge on
login cannot be built or tested without auth. The role-escalation checks in
`docs/rls-tests.md` §6b, which Phase 3 could only run at the database level, now
run over real HTTP — see §6b.1.

## What is blocked

Phase 4's two blockers are **cleared**. Google OAuth is enabled on the Supabase
project and real accounts have been created through it, and
`SUPABASE_SERVICE_ROLE_KEY` now has a value in `.env.local` — which matters more
than it used to, because checkout runs its order transaction through the admin
client and does not work without it. What replaced them are four owner tasks,
written out step by step for a non-developer in
[`docs/admin-guide.md`](docs/admin-guide.md):

**1. `RAZORPAY_WEBHOOK_SECRET` is not set.** You invent this value
(`openssl rand -hex 32`); Razorpay does not generate it. Register the webhook at
`https://<domain>/api/payments/razorpay/webhook` — public HTTPS only —
subscribed to `payment.captured`, `payment.failed`, `payment.authorized` and
`order.paid`, then set the same string in Vercel for Preview and Production
separately and redeploy. Until it exists, the webhook route rejects everything
with a 400, which is the correct direction to fail but means a customer whose
browser never comes back is charged and left `pending`. **That now applies to
every order rather than to the prepaid ones**: Pay on Delivery takes its advance
through Razorpay too, so both methods depend on the same confirmation.

**2. No real Razorpay payment has ever completed.** Every branch around it is
proven — dismissal, blocked script, resume, webhook capture, signature forgery,
replay — but the actual test-card → callback → confirmation round trip needs a
human typing into Razorpay's own iframe. Do it once before launch.

**3. No email provider is connected.** Confirmations are written and sent, but
the only adapter prints them to the server log. Verify a sending domain (SPF +
DKIM), set `EMAIL_API_KEY` and `EMAIL_FROM`, then a developer adds one adapter
file.

**4. Indexing is off.** Set `SITE_INDEXABLE=true` in Vercel — Production only,
so previews stay hidden — then trigger a **fresh build** with the build cache
**unchecked**, and verify with `curl -I` that no `X-Robots-Tag` comes back. A
plain redeploy is not enough and fails silently; see `docs/admin-guide.md`.

Optional: leaked-password protection is off in Supabase Auth. Low relevance
while sign-in is Google-only, and free to turn on.

## Build status

| Phase | Deliverable | State |
|---|---|---|
| 0 | Foundation: tokens, fonts, restyled primitives, base layout, CI | Done |
| 1 | Supabase schema, RLS, seed data | Done |
| 2 | Auth and role-based middleware | Done — folded into Phase 4 |
| 3 | Storefront catalog | Done — see [`docs/phase-3-report.md`](docs/phase-3-report.md) |
| 4 | Cart and wishlist | Done — see [`claudeExecutionReport/phase-4-cart-wishlist.md`](claudeExecutionReport/phase-4-cart-wishlist.md) |
| 5 | Checkout, orders and payments | Done — see [`claudeExecutionReport/phase-5-checkout-payments.md`](claudeExecutionReport/phase-5-checkout-payments.md) |
| 6 | Admin CRUD | |
| 7 | Admin appearance and CMS | |
| 8 | Reviews, coupons, dashboard, polish | Refunds were listed here and are not planned: the shop does not offer them. Cancelling a paid order still needs an answer — see `docs/admin-guide.md` |
| 9 | Production deploy and owner documentation | |
