# Architecture

How the pieces fit, and why. Folder conventions are in PROJECT_BRIEF §10; this
describes the decisions that are not obvious from the tree.

---

## Rendering, and why every route is dynamic

Through Phase 3 the homepage, product pages and CMS pages were statically
rendered with `export const revalidate = 3600`. From Phase 4 every route is
server-rendered on demand. Three things forced it, and they all point the same
way:

1. **The announcement bar reads a cookie.** Dismissal is decided on the server
   so the strip is absent from the HTML rather than hidden after paint. A cookie
   read in a layout makes every route under it dynamic.
2. **The header shows a live bag count**, and product cards show whether *this*
   customer has saved *this* shoe. Both are per-visitor.
3. **ISR plus auth is a session-leak hazard.** A cached response that carries a
   refreshed `Set-Cookie` can be served to the next visitor, signing them in as
   somebody else. Supabase's SSR guidance is explicit: do not use ISR on routes
   where a session refresh can happen. With auth in the layout, that is all of
   them.

Dynamic rendering is not the same as a slow page. What matters is what a render
*waits* for, and the answer is nothing:

```
src/lib/queries/cached.ts   unstable_cache over every public read on the LCP path
```

The category tree, popular brands, site settings, page list, homepage sections,
banners, category tiles, collections, products and CMS pages are all cached for
an hour with tags. So the render happens per request and the data does not.
Measured on a local production build: warm TTFB of 8–15ms, against 111ms cold.

Two things are deliberately **not** cached:

- `/shop` and `/search`. Their filters come from the query string, so a cache
  keyed on them has unbounded keys — and both routes were already dynamic.
- Anything per-customer: `getCart`, `getCartCount`, `getSavedProductIds`,
  `getWishlist`, `getCurrentUser`. These are read *alongside* cached catalog
  data and never folded into it. A wishlist flag inside a shared cache entry
  would show one customer's saved items to the next.

### Cache keys carry a shape version

`unstable_cache` keys on its key parts, never on the code that produced the
value. Adding a field to a cached return type therefore does not invalidate what
is already on disk — the new code reads old objects silently missing it. That
cost real time in Phase 4: adding `variantId` to `SizeAvailability` left every
cached product without one, and add-to-bag quietly believed no size had been
chosen. `SHAPE_VERSION` in the key parts turns a shape change into a cache miss.
**Bump it whenever a cached type changes.**

---

## The client/server boundary

Enforced structurally, not by convention, because a type-only import from a
server module compiles fine today and is one edit away from pulling the Supabase
server client into the browser bundle. CI greps for it (`.github/workflows/ci.yml`).

So view-model types live in modules with no server dependency, and both halves
import from there:

```
src/lib/catalog-types.ts   products, variants, size runs
src/lib/cart-types.ts      the bag, its lines, adjustments, shipping progress
```

`src/lib/queries/*` is `server-only` and re-exports those types for server
callers, so there is still one name per concept.

---

## Data flow

```
Server Component
  └── src/lib/queries/*        reads, through the session-aware client (RLS applies)
        └── src/lib/queries/run.ts   the only way a PostgREST result becomes data

Client Component
  └── src/lib/actions/*        "use server" mutations, Zod-validated
        └── revalidatePath      the server re-renders; the client's guess is replaced
```

**`run.ts` is the single path.** Destructuring `{ data }` and dropping `{ error }`
makes a failed query indistinguishable from an empty one, which renders as a
page claiming the shop is empty. `footvault/no-unchecked-supabase-error` fails
the build on any query whose error is not read — including in `scripts/`, where
a dropped error would make a test pass for the wrong reason.

---

## Auth

```
src/proxy.ts                 Next 16's name for middleware. Refreshes the session
src/lib/supabase/proxy.ts    on every page request, and 404s /admin for non-admins
src/app/auth/callback/       exchanges the PKCE code; merges the bag; finishes intents
src/lib/auth.ts              getCurrentUser(), React-cached per request
```

`getClaims()` everywhere, never `getSession()`. The project signs with ES256, so
the signature is verified locally against the published JWKS rather than trusted
from a cookie a browser could have edited — and verified locally means no
per-request round trip to the auth server.

`/admin` is a **rewrite to a 404**, not a redirect. A redirect to a login page
tells an attacker the route exists.

The database is the real authority. Every admin policy calls `is_admin()`, which
is `SECURITY DEFINER` and reads `profiles.role` for `auth.uid()`, so no claim
from a client can influence it.

### The callback does three things, in order

1. Exchange the code for a session.
2. Merge the guest bag into the account bag.
3. Finish whatever the customer was doing when they were interrupted.

It is a Route Handler rather than a page because a Server Component cannot set a
cookie — a page here would authenticate the customer and then lose the session
on the redirect. Its Supabase client is built *before* the exchange, which is
load-bearing: it captures the guest token into the `x-guest-token` header the
anonymous cart policy matches on, and picks up the new session that the account
policy matches on, so one client can see both bags at once. Both stay under RLS.

---

## The bag

**The server is the only authority on price and stock.** `cart_items` stores an
identifier and a quantity. Every total is recomputed from the catalog on every
read, so a stale total is not representable and no browser-supplied number is
ever near the arithmetic.

```
src/lib/queries/cart.ts    getCart() — a pure read
src/lib/actions/cart.ts    add, set quantity, remove, acknowledge
src/lib/cart/merge.ts      merge on sign-in; takes the token, not the cookie
src/lib/cart/token.ts      the guest token, minted lazily
src/app/api/cart/route.ts  the same getCart(), as JSON, for the drawer
```

`getCart()` reports the bag as it *is* — quantities clamped to live stock, dead
lines dropped — without writing any of that back, because it runs during render
and a render that mutates cannot be retried. What the customer is told is
`adjustments`; "Got it" is the write.

`unit_price_seen` exists only so a change can be *noticed*. It is never used in
a calculation.

The merge is **idempotent**. A failure partway through leaves the guest token in
place so the next sign-in retries, which makes a re-run the normal case rather
than the exception — so each guest line is deleted the moment it lands in the
account bag. Without that, the retry would add every already-moved line a second
time, because `existing + guestQty` counts a quantity already inside `existing`.

**The reservation model:** adding to a bag does not reserve stock. Two customers
can hold the last pair and both bags are honest about it. The unit is claimed at
checkout (Phase 5), which decrements in a transaction so exactly one wins.
Reserving at add-time would let an abandoned bag hold real stock hostage, and
the seed catalog runs to single figures in some sizes.

The guest token is minted on the first add, not in the proxy: minting there
would put a `Set-Cookie` on every response the site serves and hand a bag
identifier to people who are only reading.

---

## Surviving the round trip

Saving a shoe while signed out has to end with the shoe saved. The intent
travels in a short-lived httpOnly cookie (`src/lib/pending-intent.ts`), not in
the return URL — a URL that mutates on arrival mutates again on every refresh,
back button and prefetch. It is read once and deleted, and the schema is a
closed set, because the callback executes whatever it decodes to.

---

## Audits

Everything in `scripts/audit/` runs against a production build. `npm run audit`
runs them all.

| Script | What it proves |
|---|---|
| `overflow` | 16 routes × 6 widths: no overflow, no target under 44px |
| `a11y` | axe WCAG 2.2 A/AA, including the drawer and the sign-in prompt |
| `keyboard` | the whole browse-to-size path, focus visible, no traps |
| `interactions` | five runtime-only behaviours, each with a plausible silent failure |
| `links` | every internal link, title and JSON-LD block |
| `auth-rls` | the escalation path over real HTTP |
| `cart-merge` | merge on sign-in, against the live database |
| `bag-flow` | the whole purchase path in Chromium at 390px |
