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

The seed is idempotent — every write is an upsert on a natural key, so running
it twice produces one catalog rather than two. `scripts/seed-data.ts` is the
single source of truth for both the live and the SQL path.

CI runs typecheck, lint and build on every pull request, and fails the build if
`SUPABASE_SERVICE_ROLE_KEY` is referenced anywhere outside
`src/lib/supabase/admin.ts`, or if a Client Component imports a `server-only`
module. The build runs with placeholder Supabase credentials, so a pull request
can be verified without live database access.

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
| `PROJECT_BRIEF.md` | Full requirements and build phases |

## Build status

| Phase | Deliverable | State |
|---|---|---|
| 0 | Foundation: tokens, fonts, restyled primitives, base layout, CI | Done |
| 1 | Supabase schema, RLS, seed data | Done |
| 2 | Auth and role-based middleware | Next |
| 3 | Storefront catalog | Partly done — catalog, listing, filters, product page and CMS pages are live on real data; reviews and colourway galleries remain |
| 4 | Cart and wishlist | |
| 5 | Checkout and orders | |
| 6 | Admin CRUD | |
| 7 | Admin appearance and CMS | |
| 8 | Reviews, coupons, dashboard, polish | |
| 9 | Production deploy and owner documentation | |
