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
| Cart/UI state | Zustand, persisted for guest carts |
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
| `npm run audit` | The whole quality gate: overflow, axe, keyboard, interactions, links |
| `npm run audit:overflow` | Six widths × every route — overflow, 44px tap targets, 16px inputs |
| `npm run audit:a11y` | axe-core, WCAG 2.2 A/AA, at 390px and 1440px, overlays included |
| `npm run audit:keyboard` | home → category → filter → product → size, by keyboard only |
| `npm run audit:interactions` | The behaviour a screenshot cannot show |
| `npm run audit:links` | Crawls every internal link; checks titles and JSON-LD |
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
    (auth)/           login, register, password reset
    admin/            admin route group and its layout
    api/
  components/
    ui/               restyled shadcn primitives
    brand/            logo and mark
    storefront/
    admin/
  lib/
    supabase/         server.ts, client.ts, middleware.ts, admin.ts
    actions/          server actions, grouped by domain
    validations/      Zod schemas, shared client and server
    database.types.ts
supabase/migrations/
docs/
```

## Documentation

| Document | Covers |
|---|---|
| [`docs/design-system.md`](docs/design-system.md) | Tokens, type scale, measured contrast, the signature element |
| [`docs/rls-tests.md`](docs/rls-tests.md) | Row Level Security checklist, run against the live database, with results |
| [`docs/phase-3-report.md`](docs/phase-3-report.md) | What Phase 3 changed, what it measured, and what it did not finish |
| `PROJECT_BRIEF.md` | Full requirements and build phases |

## A note on phase order

Phase 3 was built before Phase 2. Nothing in the storefront needs a session —
every read is public catalog data through the anon key — so the two do not
block each other, but it does mean there is no sign-in on the site yet. The
header has no account control for that reason, and the role-escalation checks in
`docs/rls-tests.md` §6b are run at the database level rather than through a
signup form that does not exist.

## Build status

| Phase | Deliverable | State |
|---|---|---|
| 0 | Foundation: tokens, fonts, restyled primitives, base layout, CI | Done |
| 1 | Supabase schema, RLS, seed data | Done |
| 2 | Auth and role-based middleware | **Not started** — see the note below |
| 3 | Storefront catalog | Done — see [`docs/phase-3-report.md`](docs/phase-3-report.md) |
| 4 | Cart and wishlist | |
| 5 | Checkout and orders | |
| 6 | Admin CRUD | |
| 7 | Admin appearance and CMS | |
| 8 | Reviews, coupons, dashboard, polish | |
| 9 | Production deploy and owner documentation | |
