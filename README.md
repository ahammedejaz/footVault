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
| `npm run seed` | Upsert the seed catalog into Supabase (needs `SUPABASE_SERVICE_ROLE_KEY`) |
| `npm run seed:sql` | Write `supabase/seed.sql` instead, for `supabase db reset` |
| `npm run seed:images` | Regenerate the drawn product assets in `public/seed/` |
| `npm run audit` | The whole quality gate, all eight below |
| `npm run audit:overflow` | Six widths × every route — overflow, 44px tap targets, 16px inputs |
| `npm run audit:a11y` | axe-core, WCAG 2.2 A/AA, at 390px and 1440px, overlays included |
| `npm run audit:keyboard` | home → category → filter → product → size, by keyboard only |
| `npm run audit:interactions` | The behaviour a screenshot cannot show |
| `npm run audit:links` | Crawls every internal link; checks titles and JSON-LD |
| `npm run audit:auth` | Role escalation over real HTTP; `/admin` 404s for everyone but an admin |
| `npm run audit:cart` | Merge on sign-in against the live database, RLS in force |
| `npm run audit:bag` | The whole purchase path in Chromium at 390px |
| `npm run audit:signedin` | The signed-in storefront: saved list, account menu, account cart |
| `npm run audit:shots` | Full-page screenshots at all six widths |

The audits drive a real browser against a running build, so they need
`npm run build && npm start` first and a reachable database. They are not in CI
for that reason — CI builds with placeholder credentials on purpose.

The seed is idempotent — every write is an upsert on a natural key, so running
it twice produces one catalog rather than two. `scripts/seed-data.ts` is the
single source of truth for both the live and the SQL path.

CI runs typecheck, lint and build on every pull request, and fails the build if
`SUPABASE_SERVICE_ROLE_KEY` is referenced anywhere outside
`src/lib/supabase/admin.ts`, or if a Client Component imports a `server-only`
module. The build runs with placeholder Supabase credentials, so a pull request
can be verified without live database access.

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

See `.env.example` for the full list. `SUPABASE_SERVICE_ROLE_KEY` is server-only
— it bypasses Row Level Security and must never carry a `NEXT_PUBLIC_` prefix or
reach a client component.

## Layout

```
src/
  app/
    (storefront)/     storefront route group and its layout
    auth/callback/    OAuth code exchange, cart merge, pending intents
    admin/            admin route group (placeholder until Phase 6)
    api/              cart JSON for the drawer, search suggestions
  components/
    ui/               restyled shadcn primitives
    brand/            logo and mark
    storefront/
    admin/
  lib/
    supabase/         server.ts, client.ts, proxy.ts, static.ts, admin.ts
    actions/          server actions, grouped by domain
    queries/          server-only reads; cached.ts holds the LCP-path cache
    cart/             the bag's token and the merge
    validations/      Zod schemas, shared client and server
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
| [`docs/architecture.md`](docs/architecture.md) | How the pieces fit: rendering, caching, the client/server boundary, the bag |
| [`docs/database.md`](docs/database.md) | Every table, its policies, and the functions with their grants |
| [`docs/admin-guide.md`](docs/admin-guide.md) | For the shop owner. How to make yourself an admin, and what you can change |
| [`docs/phase-3-report.md`](docs/phase-3-report.md) | What Phase 3 changed, what it measured, and what it did not finish |
| [`claudeExecutionReport/phase-4-cart-wishlist.md`](claudeExecutionReport/phase-4-cart-wishlist.md) | Phase 4, in full: decisions, bugs, measurements, known imperfections |
| `PROJECT_BRIEF.md` | Full requirements and build phases |

## Signing in

Google only. No email/password, no registration form, no password reset —
absent rather than disabled, because each is a surface to secure, rate-limit and
support, and a shop this size gets nothing from them that "continue with Google"
does not already give.

**Customers never need an account to buy.** Signing in is what makes a bag
survive a new phone, keeps a saved list, and puts orders in one place. Checkout
stays open to guests.

Before sign-in works you need to enable the provider — see *What is blocked* below.

## A note on phase order

Phase 3 was built before Phase 2. Phase 4 folded Phase 2 in, since cart merge on
login cannot be built or tested without auth. The role-escalation checks in
`docs/rls-tests.md` §6b, which Phase 3 could only run at the database level, now
run over real HTTP — see §6b.1.

## What is blocked

Two things need the account owner, and nothing in the code can do them:

**1. Google OAuth is not enabled on the Supabase project.** Every sign-in
surface is built and will work the moment it is. Steps:

1. Google Cloud Console → *APIs & Services* → *Credentials* → **Create OAuth
   client ID** → *Web application*.
2. Authorised redirect URI:
   `https://ahumjhwqgmskjsitctcj.supabase.co/auth/v1/callback`
3. Supabase dashboard → *Authentication* → *Providers* → **Google**: paste the
   client ID and secret, enable it.
4. Supabase → *Authentication* → *URL Configuration* → **Redirect URLs**, add:
   - `http://localhost:3000/auth/callback`
   - `https://<your-vercel-domain>/auth/callback`
   - `https://*-<your-team>.vercel.app/auth/callback` for previews

**2. `SUPABASE_SERVICE_ROLE_KEY` is empty in `.env.local`.** The name is there,
the value is not, which looks configured at a glance. `npm run seed` and three
checks in `npm run audit:auth` need it. Supabase dashboard → *Project Settings*
→ *API* → **service_role**.

## Build status

| Phase | Deliverable | State |
|---|---|---|
| 0 | Foundation: tokens, fonts, restyled primitives, base layout, CI | Done |
| 1 | Supabase schema, RLS, seed data | Done |
| 2 | Auth and role-based middleware | Done — folded into Phase 4 |
| 3 | Storefront catalog | Done — see [`docs/phase-3-report.md`](docs/phase-3-report.md) |
| 4 | Cart and wishlist | Done — see [`claudeExecutionReport/phase-4-cart-wishlist.md`](claudeExecutionReport/phase-4-cart-wishlist.md) |
| 5 | Checkout and orders | |
| 6 | Admin CRUD | |
| 7 | Admin appearance and CMS | |
| 8 | Reviews, coupons, dashboard, polish | |
| 9 | Production deploy and owner documentation | |
