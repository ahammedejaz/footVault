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

CI runs typecheck, lint and build on every pull request, and fails the build if
`SUPABASE_SERVICE_ROLE_KEY` is referenced anywhere outside
`src/lib/supabase/admin.ts`.

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
| `PROJECT_BRIEF.md` | Full requirements and build phases |

## Build status

| Phase | Deliverable | State |
|---|---|---|
| 0 | Foundation: tokens, fonts, restyled primitives, base layout, CI | Done |
| 1 | Supabase schema, RLS, seed data | Next |
| 2 | Auth and role-based middleware | |
| 3 | Storefront catalog | |
| 4 | Cart and wishlist | |
| 5 | Checkout and orders | |
| 6 | Admin CRUD | |
| 7 | Admin appearance and CMS | |
| 8 | Reviews, coupons, dashboard, polish | |
| 9 | Production deploy and owner documentation | |
