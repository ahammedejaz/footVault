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
settled. A COD order is `confirmed` the moment it is placed, because there is
nothing to wait for. A Razorpay order stays `pending` until the webhook says
captured, and the webhook is the only thing allowed to confirm it.

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

### One transaction, split across two functions

Placing an order is `public.create_order_with_stock()`: lock the cart row, prove
the bag can be filled while holding every variant, recompute every unit price
from the catalog, decrement stock, write `orders` and the `order_items`
snapshots, write the first history row, mark the cart `converted`. All of it or
none of it. Split across two round trips, two customers buying the last pair
both succeed and the shop owes a shoe it does not have.

**No price is an argument.** The only money that goes in is the shipping
*policy* — the flat fee and the free-above threshold, read from `site_settings`
by the server — and it is applied to a subtotal the function computed itself. A
price parameter is a price an attacker eventually supplies.

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

### The abandoned-order sweep

Claiming stock at order creation has a cost, and Agent E priced it: an anonymous
visitor could start a Razorpay checkout, close the tab, repeat with a fresh
cookie, and show the whole shop as sold out. No account, no payment method,
nothing to ban. `payment.failed` deliberately does not cancel — Razorpay lets a
customer retry a declined card inside the same modal, and cancelling on the
first failure restocks units out from under the second attempt — so nothing
released an order that simply stopped.

`public.release_abandoned_orders()` is the reclaim. It cancels and restocks
orders left `pending` and `unpaid` past a cutoff, skips any order with a
`payments` row in `pending`, `captured` or `refunded` (authorised-but-unsettled
is real money, committed, just not moved), and is bounded at 500 rows a run so a
tick cannot become a long transaction holding locks across the catalog.

**Thirty minutes**, and the number lives in exactly one place: the
`p_older_than_minutes` default. The scheduler passes no argument on purpose, so
the two cannot disagree. The longest legitimate gap between "order written" and
"money moves" is a UPI collect the customer approves on another device, which
PSPs expire in five minutes; thirty is about six times the slowest honest path.
Worst-case reclaim latency is cutoff plus one tick, so forty minutes.

It is scheduled by **`pg_cron` inside the database**, not by a Vercel cron route.
A cron route is a public URL that has to authenticate a shared secret on every
request; pg_cron needs no caller and no credential. It also keeps running when
the app does not, which matters because the leak is database state and a
route-based sweep stops exactly when the shop is already having a bad day. And
Vercel's Hobby plan runs a cron at most once a day, which is not a reclaim for a
thirty-minute window. **The cost, stated plainly:** the schedule is invisible
from the repo. `select * from cron.job` is the only place it exists — see
`docs/database.md`.

---

## Payments

### The seam, and why no provider type may cross it

`src/lib/payments/types.ts` declares `PaymentAdapter` and nothing else declares
a payment. Two methods ship — Cash on Delivery and Razorpay — and the order code
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

`./index.ts` and `./config.ts` are `server-only`; `./types.ts` and `./cod.ts`
deliberately are not. The checkout page needs `PAYMENT_METHODS` to render the
choice and `PaymentInitiation` to drive the modal, and a Client Component that
imports a type from a `server-only` module compiles fine today and pulls the
Supabase server client into the browser bundle one edit later. So
`availablePaymentMethods()` is called in a Server Component and its result —
plain serialisable `PaymentMethodCopy` — is passed down as a prop.

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

`decide()` reads `orders.grand_total`, never `payments.amount`, so the check
cannot be pointed at a figure that has drifted.

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
| `security-checkout` | the adversarial regression suite, through the real webhook route over HTTP |
| `lighthouse` | performance, on a local production build with device throttling |
| `screenshots` | full-page captures at all six widths, for the eye |
| `teardown` | sweeps accounts and rows the harnesses could not delete themselves |

`fixtures.ts`, `routes.ts` and `states.ts` are shared helpers rather than
suites — the route list and the page states every visual check iterates over.

Two of these are worth distinguishing. `checkout-orders` calls
`applyPaymentOutcome` directly, so it proves the order code; `security-checkout`
posts to `/api/payments/razorpay/webhook` with a real HMAC it computes itself
rather than by importing `verifyHexSignature`, so it proves the two idempotency
schemes agree at the seam and that a test signing with the code under test
cannot pass by agreeing with itself.

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

Going live is one environment variable and a redeploy.
