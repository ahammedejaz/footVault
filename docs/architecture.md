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
an hour with tags — **13 cached bindings**, which is the number
`scripts/shape-snapshot.ts` guards. So the render happens per request and the
data does not. Measured on a local production build at the end of Phase 4: warm
TTFB of 8–15ms, against 111ms cold.

**Stock is not served from the cache.** `unstable_cache` held
`variants[].stock_quantity` for an hour under the `catalog` tag, and nothing that
changed stock invalidated that tag — not checkout, not a cancellation, and not
the admin's own stock editor, which called `revalidatePath("/", "layout")` and so
expired the *route* cache while leaving every `unstable_cache` entry exactly
where it was. A size the owner had zeroed went on being offered for the rest of
the hour. Phase 7 splits the two: catalog **content** stays cached for its hour,
and **availability** is read live and laid over the top
(`src/lib/queries/availability.ts`). Every path that moves a unit also expires
the tag (`src/lib/stock-freshness.ts`), which keeps cards honest; the product
page does not even have that window. Measured cost on a warm production build:
`/product/[slug]` TTFB 11ms → 14ms.

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

### And they carry which database answered

The key parts say nothing about the *connection* a value came through, so the
same code pointed at a different Supabase project asks the same question and is
handed the other project's answer. `DATA_SOURCE` — the project ref parsed out of
`NEXT_PUBLIC_SUPABASE_URL` — is the second key part, and `keyFor()` in
`src/lib/queries/cached.ts` composes both so a new cached read cannot forget
either.

This is why `npm run audit` could not be run against a production build.
`next build` populates `.next/cache/fetch-cache`, the cache survives a rebuild,
and a build made against `.env.local` followed by `npm run build:stage` left the
staging server serving **production's catalogue**. The symptom was a product
with 44 units in staging rendering "sold out" with no Add to Bag button, so
every gate needing a bag failed. The cause recorded at the time — the guest
cookie's `secure` flag being dropped on plain-http localhost — was wrong;
Chromium keeps `Secure` cookies on `http://localhost` and the cookie was never
involved.

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


### The boundary and the appearance preview

The homepage editor's Preview returns real rendered `<HomeSection>` elements
across a Server Action boundary, so the owner previews the storefront's own
renderer rather than a mock. One consequence is invisible in development and
breaks only in a production build: the client components inside that tree (the
rail, the product image, the save-for-later heart) resolve against the **admin
route's** client manifest, and the bundler builds that manifest from the
route's import graph — it does not trace what an action returns. The admin
appearance page therefore renders the live homepage itself ("Live now"), which
puts those modules into the route's graph through a render path that cannot be
tree-shaken. `audit:appearance` runs against a production build
(`npm run build:stage && npm run start:stage`) precisely because this class of
failure — and stale-cache-after-publish, its sibling — does not exist under
`next dev`.

---

## Data flow

```
Server Component
  └── src/lib/queries/*        reads, through the session-aware client (RLS applies)
        └── src/lib/queries/run.ts   the only way a PostgREST result becomes data

Client Component
  └── src/lib/actions/*        "use server" mutations, Zod-validated
        └── revalidatePath      the server re-renders; the client's guess is replaced

An external caller (Razorpay)
  └── src/app/api/.../route.ts  a Route Handler, because a server action cannot
        └── src/lib/payments/    be posted to from outside the app
```

A Route Handler is used where — and only where — something outside the app has
to reach in. The webhook is the whole of that list; `create-order` and
`verify-payment` are server actions, because that is the framework equivalent
and the house idiom, and an endpoint has a URL somebody can find.

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

### The callback does four things, in order

1. Exchange the code for a session.
2. Merge the guest bag into the account bag.
3. Move the guest's *orders* onto the account (`adopt_guest_orders`).
4. Finish whatever the customer was doing when they were interrupted.

It is a Route Handler rather than a page because a Server Component cannot set a
cookie — a page here would authenticate the customer and then lose the session
on the redirect. Its Supabase client is built *before* the exchange, which is
load-bearing: it captures the guest token into the `x-guest-token` header the
anonymous cart policy matches on, and picks up the new session that the account
policy matches on, so one client can see both bags at once. Both stay under RLS.

Step 3 was added in Phase 5 and it is not a nicety. The confirmation page for a
guest order invites the customer to create an account; before adoption existed,
accepting that invitation destroyed their access to the order they had just paid
for. The cart merge reports a *converted* cart as spent (it looks for an active
bag, and a converted one is not that), the cookie is dropped on the strength of
it, and the order was left carrying a token no browser held any more —
unreadable by the guest policy because the header is gone, unreadable by the
customer policy because `user_id` was never set. Unreachable by anyone, forever.
Adoption has to happen before the cookie goes and on this same client, because
this is the only moment in the system that carries both identities at once, and
a failure **vetoes** the cookie deletion rather than being logged and ignored.

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

The merge is **one transaction, and idempotent**. Phase 4 did it line by line
over PostgREST — idempotent, because each guest line was retired the moment it
landed, but not atomic, so a failure at line five left the bag split across two
carts until the next sign-in stitched it back. That was survivable while a cart
was only a display. Checkout converts a cart and decrements stock from it, so a
half-merged bag is now a half-placed order, and Phase 5 moved the whole thing
into `public.merge_guest_cart()`: either all of it happens or none of it does,
and the guest cart is deleted inside the same transaction that empties it.

The function is `SECURITY INVOKER` and granted to `authenticated` only. It needs
nothing more, because RLS already lets exactly one client see both bags — the
`/auth/callback` client, which carries the guest header and the new session at
once. The user comes from `auth.uid()` and the token from the request header;
`p_guest_token` exists only to be *compared* against the header, so a client
merging one bag while carrying another's cookie fails loudly instead of quietly
taking the wrong bag.

**The reservation model:** adding to a bag does not reserve stock. Two customers
can hold the last pair and both bags are honest about it. The unit is claimed
**at checkout**, inside `create_order_with_stock`, which decrements in the same
transaction that writes the order so exactly one wins. Reserving at add-time
would let an abandoned bag hold real stock hostage, and the seed catalog runs to
single figures in some sizes. What claiming at checkout costs instead is an
abandoned *order* holding stock, which is what the sweep further down exists to
reclaim.

The guest token is minted on the first add, not in the proxy: minting there
would put a `Set-Cookie` on every response the site serves and hand a bag
identifier to people who are only reading.

---

## Orders

### The state machine

It is **data, not a `switch`** — `ORDER_TRANSITIONS`, `TERMINAL_ORDER_STATUSES`
and `RESTOCKS_ON_ENTRY` in `src/lib/orders/types.ts`. That is what lets this
diagram be a rendering of the rule the code enforces rather than a second copy
of it that drifts. If the two ever disagree, the file is right and this is
wrong.

```
  ┌─────────┐   ┌───────────┐   ┌────────┐   ┌─────────┐   ┌───────────┐   ┌──────────┐
  │ pending │──▶│ confirmed │──▶│ packed │──▶│ shipped │──▶│ delivered │──▶│ returned │
  └────┬────┘   └─────┬─────┘   └───┬────┘   └────┬────┘   └───────────┘   └──────────┘
       │              │             │             │                          terminal
       │              │             │             │                          NO restock
       └──────────────┴──────┬──────┴─────────────┘
                             ▼
                     ┌─────────────┐
                     │  cancelled  │   terminal · RESTOCKS
                     └─────────────┘
```

| From | May go to |
|---|---|
| `pending` | `confirmed`, `cancelled` |
| `confirmed` | `packed`, `cancelled` |
| `packed` | `shipped`, `cancelled` |
| `shipped` | `delivered`, `cancelled` |
| `delivered` | `returned` |
| `cancelled` | — terminal |
| `returned` | — terminal |

`pending` means the order row exists and **its stock is already claimed** — the
decrement happens in the same transaction as the insert — but money has not
settled. **Every order starts here now, whichever method paid for it.** Pay on
Delivery used to be written `confirmed` at the moment it was placed, on the
reasoning that there was nothing to wait for. There is now — it charges an
advance online — and the old path is what produced `FV-2026-00488`: `confirmed`,
`unpaid`, ₹1,719 of stock committed against a promise. The webhook is the only
thing allowed to confirm an order, and it confirms nothing until a capture
arrives.

Nothing leaves `delivered` except into `returned`, and nothing leaves
`cancelled` or `returned` at all. An order that has to come back from either is
a new order or an admin correction with an audit row, not a status edit.

### What cancellation does to stock, and why `returned` does not

`RESTOCKS_ON_ENTRY` says `cancelled: true` and everything else `false`. Because
stock is claimed at order creation, cancelling has to give the units back or the
shop leaks inventory to every abandoned payment modal.

`returned` deliberately does **not** restock. A returned pair has to be inspected
before it can be sold again, and an automatic restock would put a damaged shoe
back on the shelf and sell it to the next customer. Phase 8 owns returns
properly; until then the owner adjusts the count by hand, and the reason is
written down rather than discovered.

The SQL half of the same rule is `public.cancel_order_with_restock()`, and it
restocks **exactly once**: `orders.stock_restored_at` is the marker, the row is
locked `FOR UPDATE` before the check, and a webhook and an admin cancelling the
same order seconds apart cannot both give the units back. Two restocks would
invent inventory that nobody ordered and nobody has.

### `inventory_movements.reference_id` dangles, and that is not a fault

There is **no foreign key** on `reference_id` — only `actor` and `variant_id`
have one — so deleting an order leaves its movements pointing at nothing. Most
historical rows are in exactly that state: measured on production on
2026-08-09, **21 of the 339** movements that name an order still resolve, and
the order numbers in the free-text `note` column run back to **FV-2026-00489**
for orders that no longer exist. They are the residue of QA runs across several
phases, including the ones that were writing to the live shop.

Two consequences, and they pull in opposite directions:

- **The ledger is unaffected.** `reconcile_inventory` compares each variant's
  `stock_quantity` against the sum of its deltas and never asks whether the
  referenced order exists. Zero drift is still zero drift, and the deleted
  orders' `order` and `cancellation` rows still sum to zero on their own.
- **Anything joining movements to orders must handle a missing order
  explicitly.** An inner join silently drops most of the ledger; a
  `note`-scraping reconciliation chases ghosts. Neither fails loudly. If a
  report needs "which order caused this movement", it has to render "order no
  longer exists" as a real outcome rather than treating a null as impossible.

The reliable question is the one the ledger already answers: deltas per variant,
which is what `reconcile_inventory` asks and what the gate checks.

### One transaction, split across two functions

Placing an order is `public.create_order_with_stock()`: lock the cart row, prove
the bag can be filled while holding every variant, recompute every unit price
from the catalog, decrement stock, write `orders` and the `order_items`
snapshots, write the first history row, mark the cart `converted`. All of it or
none of it. Split across two round trips, two customers buying the last pair
both succeed and the shop owes a shoe it does not have.

**No item price is an argument, and the money that does go in cannot be
aimed.** Every unit price is re-read from the catalog inside the function, under
the lock; a price parameter is a price an attacker eventually supplies. Three
figures are passed — the delivery total, the free-above threshold and the
advance — and each is clamped rather than trusted: the COD handling fee is
capped at the delivery charge it breaks down, and the advance is clamped into
`[0, grand_total]`. The function is `SECURITY INVOKER` and executable by
`service_role` only, so our own server is the only thing that can supply them.
A customer who could reach it over PostgREST would otherwise pay ₹1 for a
₹17,000 order.

**The balance is derived, never passed**, and that is the difference between a
checkout that survives a price change and one that does not. `grand_total` is
recomputed under the row lock and can differ from what the checkout page saw; an
advance and a balance supplied independently would then fail the
`advance_amount + balance_due_on_delivery = grand_total` check constraint and
take the whole checkout down with an opaque error at the pay button. Derived as
`grand_total - advance`, the invariant holds by construction, the customer is
charged online exactly what the modal showed them, and any drift lands where it
belongs — on the amount the courier collects.

The stock check lives in a *second* function, `public.assert_cart_stock()`,
called from inside the first. The split is not architectural taste: the Supabase
MCP migration channel truncates a payload over roughly 5KB **silently**, and the
combined body is well past it. The seam was put where it reads as a sentence —
"prove this bag can be filled and hold the units while we decide" is a different
statement from "write the order" — so the constraint cost nothing. `assert_cart_stock`
locks every variant `FOR UPDATE` **in id order**, so two checkouts over an
overlapping bag queue instead of deadlocking, and it refuses *by name*: the
shortfall comes back as a json `DETAIL` shaped exactly like `OutOfStockItem[]`,
so the page can say "Gazelle, UK 9 — you asked for 2, we have 1" to somebody who
has just typed an address.

Both are `SECURITY INVOKER` and executable by `service_role` only. The checkout
action already reaches them through `createAdminClient()`, which bypasses RLS,
so `DEFINER` would buy nothing and would cost the trap Phase 1 was bitten by —
`current_user` resolving to the owner rather than the caller.

#### Recreating a function recreates its ACL from nothing

"Executable by `service_role` only" is a property of a *specific signature*, and
it does not travel. Two migration facts make this load-bearing:

- **Changing a function's arity creates a NEW function.** `CREATE OR REPLACE
  FUNCTION` only replaces when the argument list matches exactly; add or drop a
  parameter and Postgres keeps the old function and creates a second one beside
  it. The new one starts with the *default* ACL — `EXECUTE` granted to `PUBLIC`
  — inheriting nothing from the form it was meant to supersede. A `create_order`
  that was locked to `service_role` becomes, at its new arity, callable by
  `anon` and `authenticated` over PostgREST, silently.
- **A revoke that names roles but not `PUBLIC` revokes nothing a role holds
  *through* `PUBLIC`.** `revoke execute ... from anon, authenticated` leaves the
  default `PUBLIC` grant standing, and both roles still execute through it. The
  revoke has to name `public` (as `credit_order_coins` and friends do).

**The rule: any migration that recreates a function — new arity, new return
type, `CREATE OR REPLACE`, drop-and-recreate — must restate its grants in the
same file.** Revoke from `public, anon, authenticated`, then grant to the one
caller that needs it. Do not rely on a grant from an earlier migration; that
grant belongs to a signature this migration may have just replaced. If the
change is an arity change, also drop the old signature by its exact argument
list in the same migration, or PostgREST is left with two candidates and cannot
choose (the `drop_stale_*_overload` migrations exist because this was learned
twice).

Both halves shipped to production on 2026-08-13 and were caught by the privilege
gate, not by review: `create_order_with_stock` gained `p_coin_spend` (new arity,
default `PUBLIC` grant) and `reconcile_reviews` was revoked from the two roles
but not `PUBLIC`. `20260813010000_function_grants_close_public_execute` restated
both. `audit:security-advance` §3 now derives the live signature from the
catalog via `function_execute_audit()` rather than naming a fixed argument
shape, so the next arity change is asserted against, not walked past.

### The abandoned-order sweep

Claiming stock at order creation has a cost, and Agent E priced it: an anonymous
visitor could start a Razorpay checkout, close the tab, repeat with a fresh
cookie, and show the whole shop as sold out. No account, no payment method,
nothing to ban. `payment.failed` deliberately does not cancel — Razorpay lets a
customer retry a declined card inside the same modal, and cancelling on the
first failure restocks units out from under the second attempt — so nothing
released an order that simply stopped.

`public.release_abandoned_orders()` is the reclaim. It cancels and restocks
orders left `pending` and `unpaid` past a cutoff, and is bounded at 500 rows a
run so a tick cannot become a long transaction holding locks across the catalog.

**It used to skip orders whose `payments` row was `pending`, `captured` or
`refunded`, and that list was the bug.** `src/lib/actions/checkout.ts` writes
the payments row at **`created`**, which is not in it. So between "customer is
typing their card number" and "webhook confirms the capture", the order looked
exactly like abandonment — and for the entire period in which no live-mode
webhook existed, nothing would ever move that row off `created`, making every
paid Razorpay order certain to be cancelled and restocked.

The fix is not a longer list. A list of "statuses meaning paid" must be complete
to be safe and this one was not, so the function is narrowed instead to the set
it can decide **without asking anybody**: orders with *no `payments` row at
all*. That is pure Pay-on-Delivery abandonment, where there is genuinely nothing
to reconcile.

Every order with a payment attempt now belongs to
`/api/cron/release-abandoned-orders`, which asks Razorpay
`GET /v1/orders/{id}/payments` before deciding. Its rule is that **only a
positive "nothing was ever authorised" can cancel**: a timeout, a 5xx, a rate
limit or an unparseable response all leave the order untouched for the next
tick. Cancelling late costs stock held ten more minutes; cancelling wrongly
charges a customer and restocks goods they own, so the two are not traded off
against each other. A capture found this way is fed through `recordAndApply` —
the same seam the webhook uses, with the same derived event id — so the
reconciliation and a later webhook delivery collapse to one application.
`src/lib/payments/reconcile.ts` holds that decision as a pure function, which is
what makes it assertable without a database or a Razorpay account.

**Ten minutes** (thirty until 2026-08-13), and the number lives in exactly one
place: the `p_older_than_minutes` default. The scheduler passes no argument on
purpose, so the two cannot disagree. The longest legitimate gap between "order
written" and "money moves" is a UPI collect the customer approves on another
device, which PSPs expire in five minutes; ten is still twice the slowest honest
path, and the orders this function sweeps have no payment attempt against them
at all, so nothing honest is in flight to protect. It was shortened because an
order reserves stock before it is paid for, which makes placing orders and never
paying the cheapest way to empty the shelves — no card needed. Worst-case
reclaim latency is cutoff plus one tick, so twenty minutes.

Both halves are scheduled by **`pg_cron` inside the database**, not by Vercel
Cron. pg_cron needs no caller and no credential for the SQL half, and it keeps
running when the app does not — which matters because the leak is database state
and a route-based sweep stops exactly when the shop is already having a bad day.
The decisive reason is cheaper than either: **Vercel's Hobby plan, which this
project is on, rejects any cron expression running more than once a day at
deployment time.** Not degrades — fails the build. A ten-minute reclaim is not
available there at any price short of an upgrade.

The reconciler route therefore gets its tick from pg_cron too, via **pg_net**
posting to `https://www.footvault.in/api/cron/release-abandoned-orders` with a
bearer token read from Supabase Vault. That keeps one implementation of
`recordAndApply` in TypeScript rather than a second one in Deno inside an Edge
Function, which was the alternative and which would have put two copies of "apply
a payment to an order" in two languages.

**Two costs, stated plainly.** The schedule is invisible from the repo —
`select * from cron.job` is the only place it exists, see `docs/database.md`.
And pg_net is fire-and-forget: `trigger_order_reconciler()` returning cleanly
proves the request was *queued*, not that the route ran. Whether it ran is
answered by the webhook-liveness tile on the admin dashboard.

---

## Delivery pricing, and the money split

### Rates come from the courier; thresholds come from the owner

The instruction this section exists to enforce, given on 2026-08-08:

> "Delivery charges should be picked up from shiprocket api we will not
> hardcode anything. Min order value is decided by us or admin from admin
> panel."

So a **rate** is never written down in this codebase, and a **threshold** never
lives anywhere but `site_settings`, where the owner can change it without asking
an engineer to edit a constant.

```
src/lib/shipping/settings.ts   the numbers the shop owns — thresholds, not prices
src/lib/shipping/fee.ts        the rules, priced from a live Shiprocket quote
src/lib/payments/advance.ts    the advance/balance split. Pure, no I/O
src/lib/orders/totals.ts       computeOrderTotals() — the single authority
```

| Key in `site_settings.shipping` | What it decides |
|---|---|
| `free_above_paise` | Prepaid delivery is free at or above this. `0` disables the free tier entirely |
| `cod_enabled` | The master switch for Pay on Delivery, independent of PIN-code serviceability |
| `cod_advance_mode` | `shipping_fee`, `fixed` or `greater_of` |
| `cod_advance_minimum_paise` | The advance never falls below this. ₹99 |
| `cod_advance_fixed_paise` | Used only when the mode is `fixed` |
| `fallback_fee_paise` | Per method. Reached **only** when Shiprocket cannot be reached |

`shipping.flat_fee_paise` was **deleted rather than corrected**, so it cannot
come back. It was the cause of a real drift: the cart and the product page read
the flat fee and showed ₹199 while checkout charged a live courier rate. Orders
`FV-2026-00487` and `FV-2026-00488` carry identical ₹1,499 subtotals and
different delivery — ₹199 against ₹220 — which is what the owner reported as
"totals differ between COD and pay-online", and the checkout page displayed a
third number again.

`fallback_fee_paise` is not a price list and is not a rate. It is reached only
when the courier API is unreachable, because refusing to sell during a courier
outage is a worse outcome than mispricing a handful of orders. It is a setting
rather than a constant so the owner can correct it without a deploy.

### One function computes a total; everything else reads the answer

`computeOrderTotals()` in `src/lib/orders/totals.ts` is that function, and the
brief asked for it by name because three surfaces were computing delivery
independently. **The rule it enforces: any difference between what two payment
methods cost must be a named line item, never an artefact of two code paths that
drifted.** There is exactly one such difference — `codHandlingFee` — and it is
returned separately so it can be drawn as its own row.

`shippingFee` is the **total** charged for delivery and `codHandlingFee` says
how much of that total is the Pay-on-Delivery extra. Modelled as "total, of
which" rather than as two addends on purpose: `grandTotal` arithmetic is
identical to what it has always been, it matches `orders.shipping_fee`, and no
read site has to remember to add two columns together. `Totals` is the only
place that subtracts them apart.

Nothing here trusts the browser. The subtotal and unit count are resolved from
the caller's own cart under RLS; the postcode is the only customer-supplied
input and it only selects a courier rate. A caller who could post their own
subtotal could quote themselves free delivery.

The rules `deliveryFee()` applies, all of them the owner's:

| Case | Charged |
|---|---|
| Prepaid, at or above `free_above_paise` | Free — decided before the courier lookup, so an outage cannot cost a customer their free delivery |
| Prepaid, below it | The cheapest courier's forward rate, excluding India Post, rounded up to the nearest ₹10 |
| Pay on Delivery, any value | The forward rate **plus the return leg**. No free threshold at all |

**Why Pay on Delivery has no free tier and pays for the return.** A COD parcel
can be refused at the door; the shop then pays to send it, pays again to get it
back, and collects nothing — measured against this account, ₹205 out and ₹142
back on a single pair to Bengaluru. A free-delivery COD order that is rejected
is a pure loss of roughly ₹350, and it is precisely the large orders a threshold
would exempt that hurt most.

**The total is rounded once and then split**, rather than each leg rounded
separately. Rounding twice would quietly raise the price: ₹205 and ₹142 become
₹210 and ₹150 — ₹360 instead of ₹350. The customer pays exactly what the old
single-figure calculation charged, and the named line carries the remainder. A
missing RTO figure from Shiprocket falls back to the forward cost rather than to
zero, because a return whose cost is unknown is not a free return.

### The advance, and what the courier collects

**The advance is the full round trip — forward freight plus RTO freight —
because on a refusal the shop pays both legs.** It is then netted off what the
courier collects, so the customer never pays twice:

```
advance = forward_freight + rto_freight        quoted live, one courier entry
balance = goods_total + delivery_fee − advance
```

The customer's total is identical either way; only the timing changes. What
changes for the shop is that a refused parcel is already paid for.

Worked against real rates from this account — Proddatur 516360 → Bangalore
560001, 1 kg, ₹1,000 declared, Delhivery Surface (`rate 191.36 = freight 139.36
+ cod 52.00`, `rto_charges 142.00`):

| | Amount |
|---|---|
| Goods | ₹1,000.00 |
| Delivery fee the customer pays — the live COD rate, rounded to ₹10 | ₹200.00 |
| **Advance, online now** — freight ₹139.36 + RTO ₹142.00 | **₹281.36** |
| **Balance, collected in cash** | **₹918.64** |
| Total either way | ₹1,200.00 |

**Delivered:** the shop receives the whole ₹1,200, pays ₹139.36 freight and ₹52
COD fee, and nets ₹1,008.64. **Refused:** the shop keeps ₹281.36 and pays
₹139.36 + ₹142 = ₹281.36. Net zero, goods back on the shelf.

**Shiprocket reverses the COD fee on an RTO, which is why that fee is not in the
advance.** Recovering it would over-collect on exactly the orders the advance
exists to protect. It stays a named line on the *delivery charge*, where it is
the whole of the difference between a prepaid total and a Pay-on-Delivery one.

**What this replaced, and why.** `cod_advance_mode` — `shipping_fee`, `fixed`,
`greater_of` — is gone, along with `cod_advance_minimum_paise` and
`cod_advance_fixed_paise`. All three priced the deposit from what the *customer*
was charged for delivery, which has no relationship to what a refusal costs the
shop: under a fixed ₹99 advance against a ₹281 round trip, every refused parcel
lost ₹182 and the shop found out by reconciliation. The rule now prices the
exposure directly, and there is nothing left to configure about how the advance
is *derived* — only what bounds it.

The guard rails, each a setting the owner sets and the code enforces:

| | |
|---|---|
| `cod_minimum_order_value_paise` | Below this the method is **withdrawn**, not the advance clamped. A clamped advance means the shop is carrying a return it has not been paid for |
| `cod_advance_maximum_paise` | A ceiling on the deposit. `0` means no cap |
| `include_gst_in_advance` | Shiprocket bills freight plus 18%. On, the advance is `(forward + rto) × 1.18` |
| Razorpay's 100-paise floor | Always satisfied by this model — a courier does not carry a parcel for under a rupee — and asserted anyway, because the day it stops being true checkout breaks with no visible cause |

The advance is clamped to the grand total last, after the cap, so a cheap order
is still clamped to its own value when a cap has already bound. Applying only
one of the two would let a ₹200 cap produce a negative balance on a ₹150 order.

**Prepaid is expressed in the same two numbers** rather than with a null — its
advance is the whole order and its balance is zero. So every order answers the
same two questions, and one invariant covers both methods:

```
advance_amount + balance_due_on_delivery = grand_total
```

It is a **check constraint**, not a convention.

**Prepaid is also visibly cheaper.** Prepaid orders are refused far less often
than cash ones, and that is worth money — so `prepaid_discount` passes some of it
back, as a **named line** on the payment step beside the Pay-on-Delivery option.
Folded into `discountTotal` so `grandTotal` arithmetic is unchanged, returned
separately so it can be drawn where a customer can act on it.

**The quote is frozen with the order.** `quoted_courier_name`,
`quoted_courier_id`, `quoted_forward_paise`, `quoted_rto_paise`,
`quoted_cod_fee_paise`, `quote_taken_at` and `quote_source`. That is what makes a
variance answerable from our own data when the courier assigned at fulfilment is
not the one quoted — and `quote_source` means a fallback rate can never be read
back later as though Shiprocket had quoted it.

**Weight comes from the product.** `quoteFor` used to multiply
`shipping_defaults.weight_grams` — 900g, one number for the whole catalogue — by
the number of pairs, so a bag of boots and a bag of flip-flops quoted the same
freight. Rate bands are per half-kilogram on this account (`min_weight: 0.5`), so
that is not a rounding error: it under-recovers on every heavy order.

**Shiprocket is told the balance, never the total.** `createShipment` sets the
COD collectable from `balance_due_on_delivery` and records what it sent in
`shipments.cod_collectable_amount`, so a discrepancy is answerable from our own
data rather than from the Shiprocket panel. Passing `grand_total` would have the
courier collect, at the door, money the customer has already paid online — and
we would find out one complaint at a time. It previously passed the goods
subtotal, which was very nearly right by coincidence: under the default
`greater_of` rule the advance *is* the whole delivery charge, so the balance
equals the subtotal. Under a fixed ₹99 advance against a ₹220 delivery it
under-collects by ₹121 on every parcel. `npm run audit:shipping` asserts the
sent figure equals the balance and is neither the grand total nor the subtotal,
against a fixture built so those three numbers differ.

**Delivery time comes from the courier's own clock.** `fetchTracking` reads the
delivery timestamp out of the tracking activity list, writes it once, and mirrors
it onto the order. Shiprocket returns `YYYY-MM-DD HH:MM:SS` in IST with **no
offset**, so `new Date()` on that string reads it as the server's local time —
UTC on Vercel — putting delivery five and a half hours early and shortening
every customer's replacement window by that much. The `+05:30` is therefore
explicit. `now()` is used only when the courier gave nothing parseable, which
errs towards the customer, and the value is never rewritten: a parcel is
delivered once, and a later fetch that still says "Delivered" must not restart
the clock.

---

## Payments

### The seam, and why no provider type may cross it

`src/lib/payments/types.ts` declares `PaymentAdapter` and nothing else declares
a payment. Two methods ship — prepaid and Pay on Delivery — and the order code
must not be able to tell which one it is holding. **A `RazorpayOrder` appearing
in an order signature is the failure this interface exists to prevent**, because
the moment one leaks the state machine starts growing per-provider branches and
adding Stripe stops being a new file.

The rule is enforced in three places at once:

- `src/lib/payments/` never reads or writes `orders`. An adapter turns provider
  noise into a `PaymentOutcome` and hands it back.
- `src/lib/orders/payment-state.ts` is the only thing in the codebase that moves
  order state from a payment event.
- Everything outside `src/lib/payments/` imports from `./index` or `./types`,
  never from `./razorpay`, so a second card provider is one entry in a record.

**`cod.ts` is no longer a method with no provider.** It used to return
`kind: "none"` from `initiate()`, write the order `confirmed` with nothing paid,
and fail `verifyClientCallback` closed because there was nothing to verify. It
now delegates all four money-moving methods to `razorpayAdapter`, because the
advance *is* a Razorpay payment. That is the whole design: there is no second
payment path to keep in step, and every guarantee Phase 5 built — idempotency,
webhook-as-truth, compare-and-swap on status, the unique constraint on
`razorpay_order_id`, timing-safe signature comparison — applies to a
Pay-on-Delivery order without a line of new code. What stays distinct is the
*commercial* meaning: `orders.payment_method` is still `cod`, because what
separates these orders is not who processes the card but whether a courier is
collecting cash at the door.

`./index.ts`, `./config.ts` and — **now** — `./cod.ts` are `server-only`;
`./types.ts` deliberately is not. `cod.ts` was the exception so a render path
could import its copy without crossing the server boundary; reaching Razorpay
means reaching a key secret one import away, so that trade no longer holds and
`PaymentMethodCopy` moved to `./types` for anything that needs the words. The
checkout page needs `PAYMENT_METHODS` to render the choice and
`PaymentInitiation` to drive the modal, and a Client Component that imports a
type from a `server-only` module compiles fine today and pulls the Supabase
server client into the browser bundle one edit later. So
`availablePaymentMethods()` is called in a Server Component and its result —
plain serialisable `PaymentMethodCopy` — is passed down as a prop.

The label is part of the design, not decoration. **"Cash on Delivery" is gone**
and the rename is not cosmetic: money is due before the parcel moves, and a
label promising otherwise is the single most misleading string this site could
carry. No surface shows a bare "COD" with the advance undisclosed. The rupee
figures are deliberately absent from the static copy — the advance for a ₹1,499
order to one PIN is not the advance for a ₹17,000 order to another — so the
checkout renders them from the computed totals instead.

**There is no `NEXT_PUBLIC_RAZORPAY_KEY_ID`, and there must not be one.** The key
id is publishable, but a `NEXT_PUBLIC_` variable is inlined into every page in
the bundle including the ones that will never take a payment. The server hands
it to the browser inside `PaymentInitiation`, at the moment an order exists and
is about to be paid. Same value, a hundredth of the exposure, and rotating it
does not need a redeploy of the whole site.

Money is **integer paise in both directions**, which is what Razorpay's API
speaks too, so there is no conversion anywhere in this path and no float to
round. `assertPaise()` guards both boundaries anyway.

### The webhook is authoritative

The browser's success callback is a hint. It can be closed, lost to a dead
battery, or fabricated — anyone can POST three strings at a server action.
`/api/payments/razorpay/webhook` is what Razorpay calls server-to-server and it
is what decides payment state.

It is a Route Handler rather than a server action for the only reason that
matters: an external caller posts to it. Everything else in this phase that
looks like an API endpoint is a server action, because that is the framework
equivalent and the house idiom.

Three properties are load-bearing:

- **The signature is the entire authentication**, checked before anything else,
  over the **raw bytes** read with `request.text()`. `JSON.parse` followed by
  `JSON.stringify` reorders keys and drops whitespace, and the HMAC of that is
  not the HMAC of what arrived — every signature fails and it looks like a
  network problem. With `RAZORPAY_WEBHOOK_SECRET` unset the adapter rejects
  everything, which is the correct failure direction for an endpoint that can
  confirm orders.
- **Every rejection looks the same.** "No signature", "wrong signature" and "not
  JSON" are three pieces of information, and an attacker who can tell them apart
  knows what to change. They are all one 400 with an empty shape; the reasons go
  to our logs, never the payload.
- **The status code is a control signal.** An unhandled event type answers 200,
  because a 400 on `payment.downtime.started` puts the endpoint into retry and
  then into disabled, and every later event goes with it. A 500 is a request for
  redelivery and is only used when redelivery could help.

The verify server action (`src/lib/actions/payment.ts`) exists purely so the
confirmation page can say something true *immediately* instead of spinning. It
goes through the same seam, under a different idempotency key.

### Idempotency, and why the key is derived

Razorpay retries. Not "may": a webhook that answers slowly or with anything but
a 2xx is redelivered, and the same `payment.captured` arrives two, three, five
times, each a correctly-signed request a naive handler would act on.

The defence is an **insert-first claim** on `payment_events`, guarded by
`unique (provider, event_id)`. Two concurrent deliveries both insert; Postgres
picks a winner and the loser gets `23505` and stops. A check-then-insert is a
race, so the check is not a `select`.

The key is derived by the adapter as `<event type>:<entity id>` —
`payment.captured:pay_ABC` — and **not** taken from the `x-razorpay-event-id`
header. Two reasons, and the second is the better one:

- *Structural.* `parseWebhook(rawBody, signatureHeader)` is the published
  adapter signature and cannot see arbitrary headers. Widening it so one
  provider could reach one header would put a provider's transport detail into
  the interface every future provider implements.
- *It dedupes strictly more.* A **manual resend** from the Razorpay dashboard
  carries a *new* header id for the same state change. Keyed on the header, that
  resend is a fresh event and gets applied twice. Keyed on what happened, it
  collapses. Two genuinely different events on one payment — an authorization
  and then a capture — stay distinct, because the event type is half the key.

The provider's own event id is still logged by the route, so a support question
about a specific dashboard row can be answered.

Applying an outcome is then a **compare-and-swap** on the order row:
`.eq("status", order.status)` on the update, retried up to three times against a
fresh read. Without it, a capture landing 200ms after a cancellation produced
`confirmed` + `paid` + `stock_restored_at` — a live order whose units are
already back on the shelf. Three consecutive losses is not contention, it is
something rewriting the order in a loop, so the claim is released and the
provider's redelivery becomes the answer.

Two deliberate asymmetries in `decide()`:

- **Under-payment does not confirm.** The order stays `pending` and `unpaid`,
  the mismatch is recorded in both numbers, and a human looks. Confirming an
  order for less money than it costs ships goods that are not paid for.
- **Over-payment does confirm**, with the overpayment logged. The customer has
  paid at least what was owed and must not be stranded because we owe them
  change.

**What "under-payment" means changed, and getting it wrong would have been
silent and total.** `decide()` compares the capture against
`orders.advance_amount` — what was owed *online* — rather than against
`grand_total`. Under Pay on Delivery a capture is *supposed* to be short: ₹220
against a ₹1,719 order. Measured against the total, the guard would have fired
on the happy path and left **every** such order stranded `pending` until the
abandonment sweep cancelled it, with the customer already charged and their
order quietly gone. The fix is not a weaker guard but the right expectation —
`advance_amount` equals `grand_total` for a prepaid order, so prepaid behaviour
is unchanged, and anything short of the advance is still refused. It is read
from the order row and never from `payments.amount`, so the check cannot be
pointed at a figure that has drifted.

### Refunds run the same discipline in reverse

Batch 3. The moving parts are deliberately the same ones payments use, because
they are answering the same shape of question — *did money move, exactly once?*

- **The amount is never typed and never trusted from the browser.** The policy
  matrix (`src/lib/orders/refund-policy.ts`, a pure table over the order's
  stage) computes it server-side; the browser returns only the figure it was
  shown, which is recomputed and refused on drift.
- **The row precedes the API call.** `initiateRefund` inserts `status='created'`
  first; a partial unique index allows one in-flight row per order, so a double
  click is settled by Postgres before Razorpay can be reached twice. The row id
  travels in the provider's `notes`, which is how a create call that times out
  is later matched to what it actually did.
- **The webhook is authoritative, again.** `refund.processed` / `refund.failed`
  parse into their own verified shape (never a `PaymentOutcome` — a refund must
  not be able to move order payment state through the payment path), claim
  `payment_events` under the derived `refund.processed:rfnd_x` key, and are the
  only writers of `refunds.status = 'processed'`.
- **The ceiling is a trigger.** `refunds_guard` locks the order row and refuses
  any write taking non-failed refunds past the captured sum — for the admin,
  the webhook and the import alike. `orders.payment_status` becomes `refunded`
  only when every captured paise has gone back; partial refunds stay visible as
  rows with itemised deductions.
- **A refund the database never issued** — made in the Razorpay dashboard —
  becomes a row when its webhook lands or when the order page's "Check
  Razorpay" import runs, both through one idempotent settle path.

`npm run audit:refunds` proves the gate promises against staging: the cap, the
one-in-flight index, replay-equals-one-refund, the dashboard import, and the
timeout adoption.

---

## Returns, and a window that has to be provable

The policy is narrow and is stated the same way everywhere: **no refunds, no
online returns.** A replacement is offered for damage in shipment only, reported
within 24 hours of delivery, by contacting the shop. `site_settings.return_window_days`
is `1`, and there is deliberately no self-service path to request a
replacement — the decision is the shop's, taken by a human.

What that policy needs from the architecture is a *timestamp it can be held to*.
`orders.delivered_at` is it, taken from the courier's own tracking rather than
from `now()`: tracking is fetched when somebody opens a page, which may be hours
after the parcel arrived, so stamping `now()` would hand one customer a window
running from whenever an admin happened to look and another two extra days.
Without the column the policy is unenforceable and unprovable, which is to say
decorative.

`src/components/account/replacement-window.tsx` renders it as a **deadline
rather than as legal text** — "contact us before 4:30 PM tomorrow", not "within
24 hours of delivery", because the customer does not know when the courier
marked it delivered and should not have to work it out. It ticks, because a page
left open at 4:29 must not still promise time at 4:31, and it swaps to phone and
WhatsApp buttons once the window lapses. If contacting the shop is the only way
to claim a replacement, that contact cannot be a footer link.

The clock is a `useSyncExternalStore`, not `setState` in an effect. Time is
genuinely an external system, and the server snapshot comes out `null` — so a
component whose whole job is to disagree with the past does not produce a
hydration mismatch doing it.

`returned` still does not restock, and `inventory_movement_reason` gained
`replacement` so a replacement leaves a named row in the ledger rather than an
`admin_adjustment` nobody can interpret later.

---

## Surviving the round trip

Saving a shoe while signed out has to end with the shoe saved. The intent
travels in a short-lived httpOnly cookie (`src/lib/pending-intent.ts`), not in
the return URL — a URL that mutates on arrival mutates again on every refresh,
back button and prefetch. It is read once and deleted, and the schema is a
closed set, because the callback executes whatever it decodes to.

---

## When something throws

There are two error boundaries and they catch different things, which is not
obvious and was got wrong once.

```
src/app/global-error.tsx   replaces the whole document, including the root layout
src/app/error.tsx          a route error, rendered inside the root layout
```

A boundary only catches throws from **below** it. `src/app/error.tsx` sits
inside the root layout, so it cannot catch a root layout that fails — and until
Phase 5 it was named `GlobalError` and claimed in a comment that it could.
Production proved otherwise: with four environment variables never set in the
Vercel project, every request threw in the layout and the site returned a bare
HTTP 500 with no markup at all, because the file that would have rendered
something was inside the thing that was broken. `global-error.tsx` now exists,
with deliberately minimal imports — a boundary that itself imports the module
that is failing is not a boundary — and the route-level one is called
`RouteError`.

**One promise in the code is not kept, and it is written here so nobody relies
on it.** `isSupabaseConfigured()` in `src/lib/env.ts` says in its doc comment
that "the storefront degrades to a styled empty state rather than a stack trace"
when Supabase is not configured. It is only ever called in
`src/lib/supabase/proxy.ts`. Nothing on the render path checks it, so a missing
`NEXT_PUBLIC_SUPABASE_URL` is a throw, not an empty state. Phase 3 survived that
because its pages were statically prerendered; from Phase 4 every route is
dynamic, so the same misconfiguration became a 500 on every request.

---

## Rate limiting, and the fail-open that is not a bug

`src/lib/rate-limit.ts` **fails open on purpose.** When its counter cannot be
read, the request is allowed and the failure is logged. That is a design
decision, it is load-bearing, and it is written down here because it reads like
an oversight to anyone who meets it in the middle of a stack trace — the kind of
thing a well-meaning person tightens on a Friday.

### A limiter answers "too fast", never "allowed"

Nothing in this codebase may rely on a limit as the only thing between a caller
and an action. Every admin mutation calls `is_admin()` in the database, the
Razorpay webhook verifies its HMAC, and checkout recomputes every price server
side. The limiter exists so a caller who is *entitled* to do a thing cannot do
it ten thousand times a minute.

That is the same statement as the fail-open, from the other direction: because
it fails open it can never be security, and because it is never security it is
free to fail open. Reversing one half without the other is what breaks it.

### What failing closed would cost

The counters live in Postgres — a `consume_rate_limit` RPC, not a per-instance
`Map`, because serverless instances are created and discarded constantly and a
counter that resets on every cold start is not a counter.

So an unreachable counter means an unreachable database. Failing closed there
would mean a database blip stops orders, and — worse — that we return non-2xx to
Razorpay until it disables our webhook. That trades a small abuse risk for a
large availability one, against a database that is already the thing that is
broken.

There is a general principle underneath, and it is what makes the exception
below predictable rather than arbitrary: **every policy here bounds work against
Postgres, using a counter in Postgres.** When Postgres is gone, the guard and
the thing worth guarding disappear together. The flood cannot do damage because
its target is already down.

### The `serviceability` exception

One policy does not fit that principle, and it is the only one where the
fail-open direction genuinely exposes something.

`serviceability` guards the **Shiprocket quota** — an external, paid resource
with nothing to do with our database — and a public Server Action reaches it
from both the checkout address step and the product page. A counter outage
removes the guard and leaves the exposure fully intact.

This is not hypothetical. PostgREST reloads its schema cache on every DDL and
cannot be told not to, so an RPC can fail transiently on exactly the deploys
this shop keeps doing.

So it has a second limiter that does not depend on the database, in
`src/lib/shipping/quote.ts`:

- **600 courier calls per hour, per instance, across every caller**, counted in
  module memory.
- **Unconditional**, not "only when the counter looks broken" — knowing the
  counter is broken requires the counter. A budget consulted only in a state you
  cannot reliably detect is not a budget.
- A real shop's delivery checks are bounded by the number of people shopping; a
  scraper's are not. The line sits far above the first and far below what makes
  a scrape worth running, which is the only place it can sit while satisfying
  the rule that **no real customer may ever reach it**.

**What a trip does is the part that matters.** Exhausting the budget returns the
same verdict a courier outage returns — `source: "unknown"` — so the shop
degrades to a *labelled estimate* rather than an error. Prepaid still sells at
the settings figure, marked as an estimate; Pay on Delivery falls to the owner's
`fallback_behaviour`. A limiter that threw here would take Pay on Delivery off
the table for a real customer, which is precisely the outcome the size of the
budget exists to prevent.

Note what this is *not*: it is not a per-caller limit and cannot be one, because
module memory is per-instance and a determined caller is spread across
instances. The Postgres counter is still the real control. This is a ceiling on
total spend when the real control is unavailable.

### The same shape, once more, for error email

`src/lib/errors/report-server-error.ts` carries the other in-memory backstop, for
the same reason and with the same structure: `errorReport` (3 per fingerprint per
hour) and `errorReportTotal` (20 per hour) both fail open, and both are counters
in the database — so neither holds when *the database is the thing that is
broken*, which is the exact failure most likely to be generating the email.
`withinProcessBudget` caps it at 5 per instance per hour in memory, and past that
the log is the record.

### If you are here to fix it

The fail-open is deliberate; the two in-memory ceilings are deliberate; their
being unconditional is deliberate. What would be a real bug is a policy that
guards an **external paid resource** getting only the Postgres counter, because
that is the case the general principle does not cover. There is one such policy
today and it is `serviceability`. Adding a second — a shipping-label call, an
SMS provider, an AI endpoint — means adding a backstop beside it.

---

## Settings are classified, not inherited

RLS on `site_settings` grants `anon` and `authenticated` `select`
`using (is_public)`. **The grant is per row, not per field** — a public row
publishes its entire `value`, including keys added to it long after the flag was
set.

`shipping` is the worked example. It is public because the storefront prints the
free-delivery threshold, and it has since accumulated the Pay-on-Delivery
deposit, the advance cap, the COD minimum, the stacking ceiling and the RTO
deduction policy. **None of those was a decision to publish.** Each was a field
added to a row that already happened to be public.

That was reviewed and deliberately left alone. Nothing in the row is
exploitable: the server is authoritative on every figure in it — checkout
recomputes prices, `create_order_with_stock` re-derives the discount — and the
client cannot influence any of them. The cost of publishing it is transparency,
not security, and splitting the row would be schema plus authorisation work in
the money path.

What that reasoning does not survive is the *next* key. So the rule:

> **Every `site_settings` key is classified public or private in
> `src/lib/settings-visibility.ts`, with a reason, at the moment it is added.**
> An unclassified key is a gate failure, not a default.
>
> A genuinely sensitive value — an API identifier, a supplier's terms, an
> internal margin — **does not go inside `shipping` or any other public row.**
> It gets its own row, classified private.

`npm run audit:settings-visibility` enforces it: every key in the database must
appear in the manifest, every classification must match the row's `is_public`,
every entry must carry a reason, and no classification may refer to a key that
no longer exists.

The gate then reads the table **a second time through the anonymous client** and
compares what actually comes back. That is not redundancy. Comparing the
manifest against `is_public` alone would stay green in a world where RLS had
stopped consulting `is_public` — every classification would still agree with a
column that no longer controlled anything, while the whole table was readable.
The flag is a statement of intent; what an anonymous caller can fetch is the
fact, and the gate has to assert the fact.

---

## Audits

Everything in `scripts/audit/` runs against a production build. `npm run audit`
runs the browser and database suites; `shape-snapshot.ts` is the one that runs
in CI, because it needs neither.

| Script | What it proves |
|---|---|
| `overflow` | every route × 6 widths: no overflow, no target under 44px |
| `a11y` | axe WCAG 2.2 A/AA, including the drawer and the sign-in prompt |
| `keyboard` | the whole browse-to-size path, focus visible, no traps |
| `keyboard-checkout` | the checkout path by keyboard, to the place-order button |
| `focus-ring` | the composite focus indicator actually paints, everywhere |
| `gallery` | the product gallery's runtime behaviour |
| `hydration` | headless-Chromium console: no hydration mismatch below `<body>` |
| `interactions` | runtime-only behaviours, each with a plausible silent failure |
| `links` | every internal link, title and JSON-LD block |
| `auth-rls` | the escalation path over real HTTP |
| `cart-merge` | merge on sign-in, against the live database |
| `bag-flow` | the whole purchase path in Chromium at 390px |
| `signed-in` | the signed-in storefront: saved list, account menu, account cart |
| `checkout-orders` | checkout, orders and idempotency against the live database |
| `shipping` | Shiprocket against a mock: token cache and refresh, serviceability, the fee split, and that the COD collectable is the balance — 54 assertions |
| `totals` | the advance rule and its invariants, in isolation — 15 assertions, no database and no browser |
| `admin-security` | the admin surface: the role gate, the inventory ledger and reconciliation |
| `security-checkout` | the adversarial regression suite, through the real webhook route over HTTP |
| `lighthouse` | performance, on a local production build with device throttling |
| `screenshots` | full-page captures at all six widths, for the eye |
| `teardown` | sweeps accounts and rows the harnesses could not delete themselves |
| `settings-controls` | every control on `/admin/settings`, located by its visible label, operated, and the stored value read back |
| `customer-copy` | no internal vocabulary in customer-facing code or in a stored `customer_note` |
| `checkout-discount` | the discount is on the checkout screen, named, whole-rupee, and the printed lines sum to the printed total |

`fixtures.ts`, `routes.ts` and `states.ts` are shared helpers rather than
suites — the route list and the page states every visual check iterates over.

Two of these are worth distinguishing. `checkout-orders` calls
`applyPaymentOutcome` directly, so it proves the order code; `security-checkout`
posts to `/api/payments/razorpay/webhook` with a real HMAC it computes itself
rather than by importing `verifyHexSignature`, so it proves the two idempotency
schemes agree at the seam and that a test signing with the code under test
cannot pass by agreeing with itself.

`totals` is the one suite that needs nothing at all — no build, no browser, no
database — because `advanceFor()` takes the rule and two amounts and returns the
split. It is worth its own suite because every number in it is money a real
customer either pays online or hands to a courier, and both failure modes are
silent: an advance below Razorpay's 100-paise floor produces an order that
cannot be paid for, and an advance and balance that do not sum to the total
produce a courier collecting the wrong amount. `shipping` covers the half that
needs the Shiprocket mock, including a COD fixture built so that the balance,
the grand total and the goods subtotal are three different numbers — otherwise
the assertion would pass whichever one the code read.

### The reachability rule

> **Any owner-facing control ships with a test that locates the control by its
> visible label, changes it, and asserts the stored value changed.**
>
> Locating by `id` is allowed only where no visible label exists — and that is
> itself a defect to fix. Asserting on page text is never sufficient.

This exists because of a specific and expensive failure. For two phases a
delivery-mode selector and a Pay-on-Delivery switch were reported "Built ·
proved". Both were on `/admin/settings` the whole time — rendering, interactive,
deployed — and the owner could not find them and said so three times. Every gate
stayed green, because this was the whole of what `admin-pages.ts` asserted about
that page:

```ts
const settingsBody = await page.locator("body").innerText();
check("the settings page renders for an admin",
      settingsBody.includes("Pay on Delivery"), …);
```

`<Panel title="Delivery and Pay on Delivery">` satisfies that. Delete the
checkbox and the check still passes. Meanwhile `delivery-rules.ts` proved the
flat fee was honoured downstream — thoroughly and correctly, and with no
database and no browser, so it could not prove anybody could turn it on. The
report added the two together and called it proved.

**The gap was precise: one gate proved a value is honoured, another proved the
page renders something, and no gate anywhere asserted that a named control is on
screen, is operable, and changes the value it names.**

`scripts/audit/settings-controls.ts` is the mechanism. `getByLabel` is not an
implementation detail of it — it is the rule: the locator resolves through the
accessible name, so a control a screen reader cannot name is a control the
harness cannot find, and a label that drifts from the thing it labels fails
there rather than in somebody's hands. Coverage is asserted too: the run fails
if any control in its table was never actually operated, and an assertion only
counts once the control was successfully changed, so a read-back that happens to
match proves nothing.

**Where it does not reach yet, and this is deliberate.** The product, variant,
category, brand, media and customer CRUD actions in `src/lib/actions/admin/` are
driven by no test that operates their UI — roughly 29 actions. A wrong product
description is visible and reversible; a wrong delivery setting is neither. The
harness prints that gap at the end of every run so it cannot quietly become
coverage.

### The shape snapshot

`scripts/shape-snapshot.ts` (`npm run shapes`, `npm run shapes:write`) resolves
every `cached*` binding in `src/lib/queries/cached.ts` through the TypeScript
checker, expands its return type **structurally** — through every alias, down to
primitives — and hashes the result into `src/lib/queries/cached.shape.json`.
Expanding is the point: `typeToString` would print `ProductSummary[]` and report
no change when a field is added to `ProductSummary`, which is the exact edit that
caused the Phase 4 `variantId` bug.

Three outcomes: shapes unchanged is a pass; shapes changed with `SHAPE_VERSION`
unchanged is a **fail**, and that is the bug; `SHAPE_VERSION` bumped but the
snapshot stale is also a fail, until it is re-recorded, so the *next* change is
still caught. It runs in CI because it needs no database, no build and no
browser — only the compiler.

---

## Keeping the search engines out

`foot-vault.vercel.app` is publicly reachable throughout the build, and a store
indexed with placeholder illustrations and a half-finished checkout is a
reputation problem that outlives the deploy that caused it: Google holds a
cached copy long after the page is fixed.

`src/lib/indexing.ts` is the gate, and the default is noindex in the strong
sense — only the exact string `"true"` in `SITE_INDEXABLE` opens it, so unset,
typo'd and misconfigured all resolve to "keep them out". Two things read it and
therefore cannot disagree: `next.config.ts` `headers()` sets a site-wide
`X-Robots-Tag: noindex, nofollow, noarchive`, and `src/app/robots.ts` disallows
everything behind the same call.

The header is set in `next.config.ts` rather than in the proxy on purpose. The
proxy's matcher deliberately skips static assets and the OG-image routes, and
"site-wide" has to mean site-wide. The module is dependency-free because
`next.config.ts` is evaluated outside the app's module graph and cannot resolve
the `@/` alias.

**Going live is one environment variable and a *fresh build*, not a redeploy.**
`headers()` is evaluated at build time and its result is written into
`.next/routes-manifest.json`, which an incremental build reuses. Measured on a
preview: after setting the flag and redeploying, `robots.txt` correctly flipped
to `Allow: /` while `X-Robots-Tag: noindex` persisted from the cached manifest —
so the two layers that this design promises cannot disagree, did. A clean
rebuild emitted no header rules, correctly. The owner-facing procedure in
`docs/admin-guide.md` therefore ends with a `curl` that checks the header is
actually gone, because the failure is silent.
