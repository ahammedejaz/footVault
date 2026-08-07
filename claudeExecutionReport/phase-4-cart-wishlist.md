# Phase 4 — the bag, saved items, and Google sign-in

Branch `feat/phase-4-cart-wishlist`, PR #4. Written for somebody who was not
watching.

Phase 2 was folded in, because cart-merge-on-login cannot be built or tested
without auth.

---

## 1 · Preflight

### 1.1 The branch stack

PRs #1, #2 and #3 were stacked and unmerged; `main` was five commits behind
reality. Merged in order 0 → 1 → 3, retargeting each to `main` as its base
landed. `main` then typechecked, linted and built green, and Phase 4 branched
from it. No stacking from here.

### 1.2 The three live bugs

All three were reproduced before anything was changed. The homepage was
returning **HTTP 500**.

#### Bug 1 — `next/image` received both `width` and `fill`

*Symptom:* `/` returned 500.
*Root cause:* the hero's shared props object carried `fill: true` and was spread
into two `getImageProps` calls that each also supplied the `width`/`height` of
their crop. `ImageProps` declares all three as independent optionals, so this
type-checks and throws at render — on the LCP element of the busiest page on the
site, which is why it was a 500 rather than a bad-looking image.

*Fix:* `src/lib/image-layout.ts`. `ImageLayout` is a discriminated union, and
`SharedImageProps` types `fill`/`width`/`height` as `?: never`, so a layout key
cannot be written into the *shared* half at all — which is where the mistake is
actually made. Verified both bug shapes are now compile errors and both
legitimate shapes still compile:

```
error TS2322: Type 'true' is not assignable to type 'undefined'.         (fill in the shared object)
error TS2345: '{ fill: true; width: number; height: number; }' is not
              assignable to parameter of type 'ImageLayout'.             (both at the merge site)
```

*Class sweep:* every other `<Image>` in the repo (product card ×2, gallery ×3,
search panel, category grid) uses `fill` alone. None had the spread-merge shape.

#### Bug 2 — the announcement bar's inline `<script>` never executed

*Root cause:* React does not execute a `<script>` it renders. In a Client
Component it is inert markup, and React 19 warns as much. So the pre-paint
localStorage read never ran, and every returning visitor saw the strip they had
already dismissed.

*Fix:* the mechanism, not the tag. Dismissal is an httpOnly cookie read on the
server (`src/lib/announcement.ts`, `src/lib/actions/announcement.ts`,
`src/components/storefront/announcement-bar.tsx`), so the bar is absent from the
HTML for anyone who closed it. Zero flash, zero layout shift, no inline script,
no localStorage, and Safari private mode stops being a special case. The close
button is a real `<form>` bound to a Server Action, so it works with JavaScript
off.

Verified three ways against a production build:

| Request | `Store announcement` in HTML |
|---|---|
| no cookie | 1 |
| `fv_announce=k855rr` (the current key) | **0** |
| `fv_announce=deadbee` (a stale key) | 1 |

The third row is the point: the cookie holds the key of the announcement that
was dismissed, so a *new* message comes back for everyone.

*Class sweep:* the only other inline scripts are JSON-LD in `breadcrumbs.tsx`
and the product page. Both are server-rendered data rather than executable code,
and are correct as they are.

#### Bug 3 — the error boundary logged `{}`

Two separate causes, and both had to be fixed.

*Cause A — the record could not survive serialisation.* Every field could be
`undefined`, and `JSON.stringify` drops undefined keys, so the object literally
became `"{}"` in any log pipeline that serialises. (`JSON.stringify(new Error(…))`
is also `"{}"`, because `message` and `stack` are non-enumerable.)

*Cause B — the real message is not available to the client, by design.* React
strips a Server Component's error before it reaches the browser so internals
cannot leak to a customer. Verified against a production build with a deliberate
throw:

```
browser:  message: "Minified React error #441…"   digest: "676306073"
server:   ⨯ Error: Deliberate throw: verifying the storefront error boundary.
            at b (…) { digest: '676306073' }
```

So the digest is not decoration — it is the join key between the two halves of
one failure.

*Fix:* `src/lib/report-error.ts`. Every field is substituted to a present,
non-empty string; the route is added; the boundary that fired is named (both
boundaries previously logged the same label, so a log line could not tell you
whether the layout itself had failed); and the live `Error` is passed as a
separate argument so devtools keeps it expandable. The headline carries the
route and digest as plain text, so even a pipeline that drops the structured
half leaves something findable.

After:

```
[storefront] unhandled error at /boom-test · digest 676306073
{"boundary":"storefront","route":"/boom-test","digest":"676306073","message":…,
 "whereTheRealMessageIs":"Server log, on the line carrying digest 676306073."}
```

**This paid for itself three commits later.** It is what found the `"use server"`
bug in §3.2 — the console line gave the route and the digest, and the digest led
straight to the server line with the real message.

### 1.3 Confirming what is not a bug

The disabled cart buttons were Phase 3's deliberate design: `disabled`, with a
visible note, sized to match their live selves so nothing shifts. Confirmed
intact and not drifted. They are live now.

### 1.4 Homepage clean

`/` returns 200, and a sweep of all 11 audit routes in Chromium found **zero
console errors**. (`/search?q=…` timed out on `networkidle` — the harness flake
already documented in `scripts/audit/a11y.ts`; it serves in 184ms to curl and is
clean under `load`.)

---

## 2 · What was built

### Part A — authentication

| File | Role |
|---|---|
| `src/proxy.ts`, `src/lib/supabase/proxy.ts` | Session refresh; `/admin` 404 |
| `src/app/auth/callback/route.ts` | PKCE exchange, cart merge, pending intents |
| `src/lib/actions/auth.ts` | `signInWithGoogle`, `signOut` |
| `src/lib/auth.ts` | `getCurrentUser()`, React-cached per request |
| `src/lib/safe-redirect.ts` | Open-redirect guard |
| `src/components/storefront/sign-in.tsx`, `account-menu.tsx` | Entry points |
| `supabase/migrations/20260807150000_auth_admin_bootstrap.sql` | Role pinning, `promote_to_admin` |

Google only. No email/password, registration, reset or forgot-password — absent
rather than disabled.

### Part B — the cart

| File | Role |
|---|---|
| `src/lib/queries/cart.ts` | `getCart()` — a pure read with revalidation |
| `src/lib/actions/cart.ts` | add, set quantity, remove, acknowledge |
| `src/lib/cart/merge.ts` | Merge on sign-in |
| `src/lib/cart/token.ts` | The guest token, minted lazily |
| `src/app/api/cart/route.ts` | The same `getCart()`, as JSON, for the drawer |
| `src/components/storefront/bag-drawer.tsx`, `cart-lines.tsx`, `quantity-stepper.tsx`, `cart-notices.tsx`, `free-shipping-meter.tsx`, `coupon-field.tsx`, `merged-notice.tsx`, `add-to-bag.tsx`, `bag-announcer.tsx` | The UI |
| `src/app/(storefront)/cart/page.tsx` | The bag |
| `supabase/migrations/20260807160000_cart_price_seen.sql` | `unit_price_seen` |

### Part C — saved items

| File | Role |
|---|---|
| `src/lib/queries/wishlist.ts` | Count, saved ids, the list |
| `src/lib/actions/wishlist.ts` | `toggleSaved`, `saveProduct` |
| `src/lib/pending-intent.ts` | Intent that survives the OAuth round trip |
| `src/components/storefront/save-for-later.tsx`, `wishlist-row.tsx` | The UI |
| `src/app/(storefront)/wishlist/page.tsx` | The page |

### Part D — polish

`src/lib/toast.ts` is the one toast vocabulary: `done`, `undoable`, `withLink`,
`failed`, `note`. Every add and removal is undoable from the toast. Every
mutation is optimistic with rollback and a visible failure message.

---

## 3 · Decisions taken autonomously

| Decision | Why |
|---|---|
| **Every route became dynamic** | The brief's cookie mechanism requires it. Independently correct: Supabase's own guidance says ISR plus session refresh can serve one customer's `Set-Cookie` to the next. Phase 4's live badge and per-customer hearts would have forced it anyway. |
| **`unstable_cache` over every LCP-path read** | Dynamic rendering must not mean a database round trip. Warm TTFB 8–15ms vs 111ms cold. |
| **`/shop` and `/search` deliberately not cached** | Query-string filters give unbounded cache keys, and both were already dynamic. |
| **Guest token minted lazily, on first add** | Minting in the proxy puts a `Set-Cookie` on every response, including to crawlers. |
| **Adding does not reserve stock** | An abandoned bag would hold real stock hostage; the seed runs to single figures in some sizes. The unit is claimed at checkout in Phase 5. Documented in `docs/architecture.md`. |
| **Added `cart_items.unit_price_seen`** | "Say so if the price changed" needs a before as well as an after. Never used in a calculation. |
| **`getCart()` is a pure read; "Got it" is the write** | It runs during render, and a render that mutates cannot be retried. |
| **Deleted the persisted Zustand counts** | A second copy of a number the `carts` table owns can only ever be wrong. PROJECT_BRIEF §2 said localStorage; the Phase 4 brief countermanded it. Recorded in the brief. |
| **`private.promote_to_admin` in a non-exposed schema** | Postgres grants `EXECUTE` to `PUBLIC` by default; a `SECURITY DEFINER` function in `public` is a self-service escalation endpoint unless every grant is remembered. |
| **Kept `/admin` as a placeholder page** | A missing route 404s on its own, so a working guard and a broken one would look identical. The guard could not otherwise be proved. |
| **Intent in a cookie, not the return URL** | A URL that mutates on arrival mutates again on every refresh, back button and prefetch. |
| **`saved` is a prop, never a field on `ProductDetail`** | The product is read through a cross-request cache; a per-customer flag inside a shared entry shows one person's wishlist to the next. |
| **Extracted `src/lib/cart-types.ts`** | Client components were importing types from `server-only` modules, which the CI boundary guard rejects — correctly. |
| **Coupon field visibly disabled rather than hidden** | The brief allowed either. A bag with no coupon field reads as a shop that does not do offers, and the space is part of the layout Phase 8 lands into. |
| **Checkout button links to `/checkout` (which 404s)** | A bag whose only button is dead reads as a shop that cannot take money. Phase 5 fills it in. |

---

## 4 · Bugs found and fixed during the phase

Beyond the three in the preflight.

### 4.1 `quality: 82` was silently ignored (latent, from Phase 3)

Next 16 defaults `images.qualities` to `[75]` and answers **HTTP 400** for
anything else. The hero asked for 82; the optimiser clamped the emitted srcset
back to 75 while the code claimed otherwise. Confirmed by requesting `q=82`
directly (400) and `q=75` (200). Named `qualities: [75, 82]` in `next.config.ts`
so the number in the code is the number that ships.

### 4.2 `A "use server" file can only export async functions, found object`

`src/lib/actions/auth.ts` exported a `SIGN_IN_IDLE` constant. **Typecheck, lint
and build all passed.** The action 500s the first time a customer presses the
button. Found by driving a real browser, via the digest from §1.2.

Fixed by moving the constant to the form, and CI now greps for the shape —
validated against the original line, which it catches.

### 4.3 `unstable_cache` does not key on the code that produced the value

Adding `variantId` to `SizeAvailability` did not invalidate cached products, so
every cached entry was missing it and add-to-bag believed no size had been
chosen — it silently did nothing, and the page looked correct. Cache keys now
carry `SHAPE_VERSION`.

**This is the most dangerous bug in the phase**, because a deploy would
reproduce it in production with no error anywhere.

### 4.4 The announcement dismissal never persisted

The close button hid the strip by returning `null`, which removed the `<form>`
from the tree while its own submission was in flight. The action never reached
the server. Now hidden rather than unmounted.

Caught by `audit:interactions` only after that audit was rewritten to assert the
new mechanism — the old assertions checked the localStorage attribute and would
have passed forever.

### 4.5 `aria-hidden-focus` on the mobile sticky bar

The bar was `aria-hidden` while off-screen, which was fine when its button was
`disabled`. With a live Add to bag, a keyboard user could tab to a button screen
readers had been told did not exist. `inert` removes it from both at once.
Found by axe.

### 4.6 A `<form>` inside a Radix `DropdownMenuItem` loses its submit

Anticipated rather than shipped: Radix selects the item and unmounts the menu
before the browser submits. The sign-out form sits outside the menu and is
submitted by it. (§4.4 is the same bug in the wild, which is what makes this
worth recording.)

### 4.7 Fourteen dropped `error` bindings in the new audit scripts

CI runs `eslint .`; I had been running `eslint src/`. In a harness this is worse
than in production code: an RLS denial and a genuinely empty table both arrive
as zero rows, so "customer reads zero rows of another customer's profile" would
have passed just as happily if the query had been rejected for an unrelated
reason. Now routed through the app's own `run`/`rows`/`maybeRow`, which throw.

---

## 5 · Measurements

### Lighthouse — mobile, local production build, `--throttling-method=devtools`

| Route | Perf | A11y | Best practices | SEO | LCP | CLS | TBT |
|---|---:|---:|---:|---:|---:|---:|---:|
| `/` | 99 | 100 | 100 | 100 | 1.7 s | 0 | 20 ms |
| `/shop` | 99 | 100 | 100 | 100 | 1.9 s | 0 | 40 ms |
| `/product/nike-air-max-90-mens` | 99 | 100 | 100 | 100 | 1.6 s | 0.002 | 20 ms |
| `/cart` | 99 | 100 | 100 | **63** | 1.6 s | 0.001 | 0 ms |

**`/cart` SEO is 63 and that is correct.** The only failing audit is "Page is
blocked from indexing", weight 4.04 of the category. The cart is deliberately
`noindex` — letting a search engine index customers' bag pages would be the
defect. Every other route clears 90 in every category with room to spare.

**This was measured on localhost, not a Vercel preview, which deviates from the
brief.** There is no `footvault` project in the Vercel account, so PR #4 has no
preview URL. Raised with the owner, who chose to ship on the localhost numbers.
The consequence: the simulated-vs-real discrepancy from Phase 3 is still not
settled on real infrastructure, and these numbers do not include real network
latency to Supabase. See §8.

### The audit suite — all green against a production build

| Suite | Result |
|---|---|
| `audit:a11y` | No WCAG 2.2 A/AA violations, 16 routes × 390px and 1440px, including the bag drawer and sign-in prompt |
| `audit:overflow` | 16 routes × 6 widths — no overflow, no target under 44px, no input under 16px |
| `audit:keyboard` | home → department → filter → product → size, focus visible at every stop, no traps |
| `audit:interactions` | Dismissal persists, filter sheet survives a tap, search forgives a misspelling, swatch changes gallery and URL, sticky bar waits |
| `audit:links` | 122 pages, 1833 unique internal links, none broken, no missing titles, JSON-LD well formed |
| `audit:auth` | 9 pass, 4 skip (see §8) |
| `audit:cart` | 10 pass |
| `audit:bag` | 16 pass |
| `audit:signedin` | 10 pass — the signed-in storefront in a browser |

### Merge on sign-in — the phase's headline behaviour

Against the live database, RLS in force, **no elevated key**:

```
PASS  a guest can create a cart with only a token
PASS  another guest token reads zero of those lines       0 rows
PASS  every guest line merged                             merged 4, dropped 0
PASS  the guest cart was consumed
PASS  all four lines are in the account bag               4 lines
PASS  a guest-only line kept its quantity                 qty 2
PASS  the line in both bags summed                        1 + 2 -> 3
PASS  the guest cart no longer exists                     0 rows
PASS  a summed quantity is capped at available stock      3 + 3 -> 3 (stock 3)
```

### The purchase path, in Chromium at 390px

```
PASS  three items added from three product pages   UK 7, UK 7, UK 6
PASS  the header badge counts them                 3
PASS  the guest token is an httpOnly cookie        httpOnly=true
PASS  the bag is not in localStorage               []
PASS  the bag survived closing the browser         3
PASS  the drawer lists all three lines             3 rows
PASS  the stepper adds a unit                      4
PASS  removing offers an undo, and undo works      4
PASS  the coupon field is present and not live
PASS  checkout is reachable
PASS  no console errors anywhere in the flow
```

"Closing the browser" is a fresh context carrying only cookies — no memory, no
storage — which is what surviving a restart actually means.

### Role escalation, over real HTTP

```
PASS  handle_new_user ignores a role in the provider payload   role = customer
PASS  customer cannot set their own role over PostgREST        42501: Only an admin can change a profile role
PASS  is_admin() returns false for a customer                  false
PASS  /admin is 404 for an anonymous visitor                   HTTP 404
PASS  /admin is 404 for a signed-in customer                   HTTP 404
PASS  /admin does not redirect                                 HTTP 404
```

`docs/rls-tests.md` §6b is marked resolved in §6b.1.

### Server timing

| Route | Cold TTFB | Warm TTFB |
|---|---:|---:|
| `/` | 111 ms | 12–15 ms |
| `/product/[slug]` | 15 ms | 8–9 ms |
| `/page/[slug]` | 8 ms | 7 ms |

---

## 6 · What I got wrong and caught in self-review

- **I ran `eslint src/` instead of `npm run lint`.** CI runs `eslint .`. Fourteen
  real lint errors in the new audit scripts went unseen until the first push
  failed CI. (§4.7)
- **I broke the CI client/server boundary guard** by importing `Cart` from
  `server-only` modules into three client components. Caught by running the
  guard by hand before pushing; fixed by extracting `src/lib/cart-types.ts`.
- **My first source-level test of "does the trigger read a role from metadata?"
  was wrong.** The regex `role.*raw_user_meta_data` matched across the column
  list and reported a false positive. Replaced with a behavioural test that
  creates an account whose metadata claims `role: "admin"` and checks the row.
- **I initially wrote the drawer's fetch as an effect**, which the React Compiler
  lint rejected. It was right — opening the drawer is an event, and fetching in
  the event that caused it is both correct and simpler. Moved into the store.
- **I put a `<form>` inside a Radix `DropdownMenuItem`.** Restructured before it
  shipped; the same bug then appeared for real in the announcement strip (§4.4),
  which is why it is recorded rather than quietly fixed.
- **My first `bag-flow` harness clicked a colourway swatch instead of a size**,
  then reported "add to bag does nothing". The product was fine; the test was
  wrong. Worth recording because it nearly sent me chasing a non-bug.
- **The `qualities` docblock landed mid-comment** in `next.config.ts`, splitting
  the SVG explanation from `dangerouslyAllowSVG`. Reseated.

---

## 7 · Known imperfections

Honestly, the things I am least confident about.

1. **Lighthouse was not measured on real infrastructure.** Localhost has no
   network latency to Supabase. Every route is dynamic now, so a slow database
   round trip lands directly in TTFB in a way localhost cannot show. The cached
   reads should absorb it, but "should" is doing work in that sentence.

2. **The Google round trip itself has never been run.** The provider is not
   enabled, so no real consent-screen redirect has happened. What *is* covered:
   `npm run audit:signedin` drives the whole signed-in storefront in a browser
   with a real session — the saved list, move-to-bag, the account menu, and that
   adding to the bag while signed in uses the account cart rather than minting a
   guest token. The merge is covered by `audit:cart` against the live database.
   What remains untested is specifically the PKCE exchange in
   `/auth/callback` and the pending-intent completion that hangs off it, because
   both need a real code from Google. **This is the largest untested surface in
   the phase**, and it shrinks to nothing the moment §8.1 is done.

3. **The cart merge is not transactional.** It writes line by line; a failure
   halfway leaves some lines merged and the guest cart intact, and the next
   sign-in re-merges — which double-counts the lines that already moved, up to
   the stock cap. The cap bounds the damage but does not prevent it. A
   `SECURITY DEFINER` function doing the whole merge in one statement would be
   correct; I chose to keep it in TypeScript under RLS instead, and this is the
   price. Worth revisiting in Phase 5.

4. **`acknowledgeCartChanges` is O(lines) round trips.** One `readSellable` per
   line. Fine for a bag of five, wasteful for a bag of thirty.

5. **The price-change notice can be shown twice** if a customer has the bag open
   in two tabs and acknowledges in one. Harmless, but not airtight.

6. **The drawer refetches on every mutation while open**, including for a change
   it made itself and already knows the outcome of. One redundant round trip per
   quantity tap.

7. **`SHAPE_VERSION` is a manual discipline.** Nothing enforces bumping it. The
   next person to add a field to a cached type will hit §4.3 exactly as I did,
   unless they read the comment.

8. **The `/checkout` link 404s.** Deliberate, but it is a dead end in the live UI
   until Phase 5.

9. **`getCartCount()` and `getCart()` both query on the cart page**, since the
   header and the page do not share a read. One extra query per cart render.

10. **No test covers a variant going inactive while it sits in a bag.** The code
    path exists and drops the line with a notice; it is untested.

11. **The harnesses cannot clean up after themselves without a service-role
    key.** `audit:cart` and `audit:signedin` create real accounts and leave them
    behind; deleting a user needs the admin API. I swept them by hand at the end
    of this phase — the database is back to 0 users, 0 carts, 0 saved items and
    the 35 seeded products — but the next person to run the suite will
    accumulate rows again until §8.2 is done. The teardown SQL is in
    `docs/rls-tests.md` §8.

---

## 8 · Blocked on the owner

### 8.1 Google OAuth is not enabled — sign-in cannot work until it is

1. Google Cloud Console → *APIs & Services* → *Credentials* → **Create OAuth
   client ID** → *Web application*.
2. Authorised redirect URI:
   `https://ahumjhwqgmskjsitctcj.supabase.co/auth/v1/callback`
3. Supabase dashboard → *Authentication* → *Providers* → **Google**: paste the
   client ID and secret, enable.
4. Supabase → *Authentication* → *URL Configuration* → **Redirect URLs**:
   - `http://localhost:3000/auth/callback`
   - `https://<production-domain>/auth/callback`
   - `https://*-<team>.vercel.app/auth/callback`

Then re-run `npm run audit:auth` and sign in by hand to close imperfection §7.2.

### 8.2 `SUPABASE_SERVICE_ROLE_KEY` is empty in `.env.local`

The name is present with no value, which looks configured at a glance. Supabase
dashboard → *Project Settings* → *API* → **service_role**. This unblocks
`npm run seed` and the four SKIPs in `npm run audit:auth`.

### 8.3 Make yourself an admin

After signing in once with Google, run in the Supabase SQL editor:

```sql
select private.promote_to_admin('your-email@example.com');
```

Full walkthrough in `docs/admin-guide.md`.

### 8.4 Vercel — no project exists

There is no `footvault` project in the Vercel account, so PR #4 has no preview
deployment and PROJECT_BRIEF §10's "automatic preview deployments per PR" is not
in effect. Connect the GitHub repo in the Vercel dashboard and set
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and
`NEXT_PUBLIC_SITE_URL` for Preview and Production separately. Then re-run
Lighthouse against the preview to settle §7.1.

---

## 9 · Deliberately deferred

| Thing | Phase | Note |
|---|---|---|
| Checkout, orders, stock decrement | 5 | The `/checkout` link exists and 404s |
| Razorpay | 5 | Nothing here assumes a gateway; the cart never computes a final total, only a subtotal |
| Admin panel | 6–7 | `/admin` is a placeholder proving the 404 guard |
| Coupon validation | 8 | Field present, visibly disabled, with the reason next to it |
| Reviews | 8 | |
| `testimonials` / `rich_text` homepage sections | 7 | Render nothing rather than throwing |

### What Phase 5 will need from this

- `getCart()` returns live prices and clamped quantities — checkout should
  **recompute from scratch** rather than trusting it, since it is a render-time
  read with no lock.
- The reservation model is optimistic by design (§3). Checkout must decrement in
  a transaction and fail cleanly, naming the item that went out of stock.
- `carts.status` has `converted` and `abandoned` values that nothing sets yet.
- `orders`/`order_items` already snapshot everything an order needs.
- `next_order_number()` exists and is revoked from clients; the checkout action
  must call it through the service role.
- The merge is not transactional (§7.3) — worth hardening before checkout leans
  on cart state.

---

## 10 · Migrations

| File | Applied | What |
|---|---|---|
| `20260807150000_auth_admin_bootstrap.sql` | yes | `handle_new_user()` pins `role = 'customer'`; `private` schema; `promote_to_admin` |
| `20260807160000_cart_price_seen.sql` | yes | `cart_items.unit_price_seen` |

Types regenerated into `src/lib/database.types.ts`.

Supabase security advisors after the migrations report five
`SECURITY DEFINER`-executable warnings, all pre-existing RLS policy helpers.
They are load-bearing: an RLS policy expression is evaluated with the querying
role's privileges, so revoking `EXECUTE` would break the policies that call
them. Each answers a question about the caller or about already-public data.
Reasoned through in `docs/database.md`. `promote_to_admin` and
`handle_new_user` are **absent** from the advisor output, which is the outcome
the `private` schema and the revokes were for.

---

## 11 · Documentation updated

| File | Change |
|---|---|
| `PROJECT_BRIEF.md` | Standing rules added as §0.1; §2 corrected — guest carts are rows, not localStorage |
| `README.md` | Google-only sign-in, new scripts, blocked items, layout, build status |
| `.env.example` | Why `NEXT_PUBLIC_SITE_URL` is not the OAuth origin; where Google credentials go |
| `docs/architecture.md` | **New.** Rendering, caching, the boundary, auth, the bag |
| `docs/database.md` | **New.** Every table, policy counts, functions and grants |
| `docs/admin-guide.md` | **New.** For the owner |
| `docs/rls-tests.md` | §6b resolved in §6b.1; Phase 4 teardown added |
