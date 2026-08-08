# Phase 5 — checkout, orders and payments

Branch `feat/phase-5-checkout-payments`, branched from merge commit `608b122`.
Written for somebody who was not watching.

This is the first phase built by more than one agent. A lead plus six
specialists — visual polish, orders and migrations, payments, checkout UI, an
adversarial reviewer, and quality assurance — working against contracts
published before any of the implementations. Section 13 is an honest account of
whether that arrangement earned what it cost, because it is the most novel thing
about the phase and the easiest to be smug about.

The shape of it in numbers: **16 migrations**, **78 new files** under `src/`,
`scripts/` and `supabase/` totalling about 13,900 lines, and 27 existing files
modified (+1,194 / −484).

---

## 1 · Preflight

Five things were dealt with before any checkout code was written, because each
of them would have poisoned the work that came after.

### 1.1 The branch, and a production outage found on the way

PR #4 was merged into `main` (merge commit `608b122`), CI green, and Vercel
auto-deployed to production. Which is when we found that
**`foot-vault.vercel.app` had been returning HTTP 500 for every request since
2026-08-07 18:24** — 106 logged errors across 4 users.

*Root cause:* `NEXT_PUBLIC_SUPABASE_URL` and three other environment variables
had **never been set in the Vercel project at all.** Not wrong, not stale —
absent since the project was created. Phase 3 survived it because its pages were
statically prerendered at build time with the variables that the *build* had.
Phase 4 made every route dynamic, so the missing variable moved from build time
to request time, and merging PR #4 turned a latent misconfiguration into a
site-wide outage.

*Fix:* all ten environment variables set for Preview and Production, and the
existing Phase 4 deployment redeployed — deliberately not the work-in-progress
tree, because a fix verified against untested code proves nothing. It returns
200 with real catalog data.

Two secondary findings came out of it, and both are now written into the docs
rather than left in a log:

- **`isSupabaseConfigured()` makes a promise it does not keep.** Its doc comment
  in `src/lib/env.ts` says the storefront "degrades to a styled empty state
  rather than a stack trace". It is only ever called in
  `src/lib/supabase/proxy.ts`. Nothing on the render path checks it. The promise
  is now contradicted in `docs/architecture.md` so nobody relies on it.
- **There was no `src/app/global-error.tsx`**, so the throw produced a bare 500
  with no markup at all. See §4.4.

### 1.2 Hydration

`suppressHydrationWarning` was placed on `<body>` only, in
`src/app/layout.tsx`, with the rationale as a doc comment. It suppresses exactly
one level; children still report. The evidence that there is no *second*, real
mismatch hiding behind it is Agent F's headless-Chromium console check
(`scripts/audit/hydration.ts`).

### 1.3 A mechanism for the Phase 4 cache bug, not a reminder

Phase 4's worst bug was that `unstable_cache` keys on its key parts and never on
the code that produced the value, so adding `variantId` to `SizeAvailability`
left every cached product without one and add-to-bag quietly believed no size
had been chosen. The fix was `SHAPE_VERSION` in the key parts — and "remember to
bump it" is not a mechanism.

`scripts/shape-snapshot.ts` plus `src/lib/queries/cached.shape.json` is the
mechanism, wired to `npm run shapes` / `npm run shapes:write` and a CI step. It
resolves all **13** cached bindings through the TypeScript checker and expands
each return type **structurally** — every alias followed to primitives, with
`<circular>` for the self-referencing category tree — then hashes the result.
Expanding is the whole point: `typeToString` prints `ProductSummary[]` and
reports no change when a field is added to `ProductSummary`, which is precisely
the edit that caused the original bug.

Three outcomes: unchanged is a pass; changed with `SHAPE_VERSION` unchanged is a
fail, and that is the bug; `SHAPE_VERSION` bumped with a stale snapshot is also
a fail until it is re-recorded, so the *next* change is still caught.

**Proven, not asserted.** Adding `widthFitting` to `SizeAvailability` without
bumping the version failed with exit 1 across all four affected cached symbols,
and the windowed diff pointed straight at the added field. Both failure paths
were exercised, then reverted.

### 1.4 Keeping search engines out

`src/lib/indexing.ts`. Only the exact string `"true"` in `SITE_INDEXABLE` opens
indexing, so unset, typo'd and misconfigured all resolve to noindex — no
plausible accident opens the door.

The site-wide `X-Robots-Tag: noindex, nofollow, noarchive` is set from
`next.config.ts` `headers()` rather than from the proxy. The proxy matcher
deliberately skips static assets and the OG-image routes, and "site-wide" has to
mean site-wide. `src/app/robots.ts` disallows everything behind the same gate,
so the two cannot disagree. Lifting it is one environment variable and a
redeploy.

### 1.5 Contracts published before implementations

This is what made the parallel work possible, and it is worth naming the three:

| File | What it fixed in advance |
|---|---|
| `src/lib/orders/types.ts` | The order state machine, **as data** — `ORDER_TRANSITIONS`, `TERMINAL_ORDER_STATUSES`, `RESTOCKS_ON_ENTRY` — so `docs/architecture.md` renders the same thing the code enforces |
| `src/lib/payments/types.ts` | `PaymentAdapter`. No provider type may escape the module |
| `src/lib/validations/checkout.ts` | One Zod schema for both sides, the Indian address shape, all 36 states and union territories |

They were also where the lead's own worst bug lived. See §7.

---

## 2 · What was built

### Part A — the order domain (`src/lib/orders/`)

| File | What it is |
|---|---|
| `types.ts` | The state machine as data, the checkout signatures, the view models |
| `payment-state.ts` | `applyPaymentOutcome` — **the only thing in the codebase that moves order state from a payment event** |
| `errors.ts` | The SQLSTATE vocabulary `create_order_with_stock` refuses with, and how to read it |
| `adopt.ts` | The thin wrapper over `adopt_guest_orders()` |

`src/lib/actions/checkout.ts` is the single authority for placing an order.
Read `PlaceOrderInput` and note what the browser is *not* allowed to say: no
prices, no lines, no quantities, no totals, not even a cart id. That type is the
trust boundary, so adding a field to it is a security decision rather than a
convenience one.

`src/lib/queries/orders.ts` reads orders, and ownership is decided by the
database rather than by that file: both reads go through the RLS client, so a
`null` means "not yours, **or** no such order" and the two are indistinguishable
on purpose.

### Part B — the database (16 migrations)

Every one applied through the Supabase MCP server and verified with a follow-up
query rather than assumed. The full list, with what each does, is in
`docs/database.md`. The load-bearing pieces:

- **`create_order_with_stock`** — locks the cart row `FOR UPDATE`, calls
  `assert_cart_stock` (which locks every variant `FOR UPDATE` **in id order** to
  avoid deadlock, and reports a shortfall by item and size as an
  `OutOfStockItem[]` json `DETAIL`), recomputes **every** unit price from the
  catalog inside the function, decrements stock, writes `orders` and the
  `order_items` snapshots, writes the first history row, and sets
  `carts.status='converted'`. All or none. **No price is ever a parameter.**
  Backstop: `CHECK (stock_quantity >= 0)`.
- **`cancel_order_with_restock`** — the reverse, restocking exactly once, guarded
  by `orders.stock_restored_at`, returning a word rather than raising.
- **`merge_guest_cart`** — Phase 4's eight-round-trip merge, moved into one
  transaction. `SECURITY INVOKER`, granted to `authenticated` only: RLS already
  shows one client both bags, so no `DEFINER` was needed.
- **`release_abandoned_orders`** + `pg_cron` — the E-1 fix. See §5.
- **`adopt_guest_orders`** — the E-3 fix. See §5.
- **`payments`** and **`payment_events`**, RLS-enabled with an admin-read policy
  and nothing else, with the write grants revoked as well as the policies
  omitted.

### Part C — payments (`src/lib/payments/`)

`fetch` and `node:crypto`. No SDK.

`signature.ts` is the entire security of the money path in one screen, which is
deliberate — it should be possible to read all of it and be sure. The HMAC is
computed **inside** the verify function (a caller who computes the expected
value separately eventually compares the wrong two things, and that bug looks
like working code), the length is checked before `timingSafeEqual`, and the
comparison is over the UTF-8 bytes of the hex string rather than decoded hex —
because decoding lets a non-hex character collapse into a shorter buffer.

`src/app/api/payments/razorpay/webhook/route.ts` reads **raw bytes** via
`request.text()`. `JSON.parse` followed by `JSON.stringify` does not reproduce
the signed bytes, and that mistake makes every signature fail while looking
exactly like a configuration problem.

Idempotency is an insert-first claim on `payment_events` with
`unique (provider, event_id)`; a `23505` means somebody else already owns the
work. The key is derived as `<event type>:<entity id>`, **not** taken from
`x-razorpay-event-id` — see decision 5 in §3.

### Part D — the checkout UI (`src/components/checkout/`, `src/app/(storefront)/`)

One page, not a wizard: `/checkout`. `/order/[orderNumber]` is the confirmation,
the receipt and the tracking page, and it renders **404** rather than "not
authorised" for a stranger. `/account`, `/account/orders`, `/account/orders/[id]`
and `/account/addresses` are the signed-in half.

### Part E — email (`src/lib/email/`)

Behind an `EmailAdapter`, with a console adapter when no provider is configured.
A missing provider never fails an order — that is the correct trade, not a
workaround. The four owner steps to wire a real provider are in the header of
`src/lib/email/index.ts` and in `docs/admin-guide.md`.

---

## 3 · Decisions taken autonomously

Each with the one line that justifies it.

1. **No `razorpay` npm package.** The brief's appended template said to install
   it. The entire provider surface is three HTTP calls and two HMACs; the
   official package is CommonJS with `any`-shaped responses, which this phase's
   lint gate forbids, and it would sit in the money path forever to save about
   forty lines. Reversible in one file, because the adapter interface already
   isolates the provider.
2. **Server actions for create and verify; a Route Handler only for the
   webhook.** The template asked for `/api/create-order` and
   `/api/verify-payment`. Server actions are the framework equivalent and the
   house idiom; the webhook has to be a Route Handler because an external caller
   posts to it, and that is the whole of the list.
3. **No `NEXT_PUBLIC_RAZORPAY_KEY_ID`.** The key id is publishable, but a
   `NEXT_PUBLIC_` variable is inlined into every page in the bundle including
   the ones that will never take a payment. The server hands it over inside
   `PaymentInitiation`, at the moment a payment is actually starting.
4. **`create_order_with_stock` is `SECURITY INVOKER`, granted to `service_role`
   only.** The checkout action already calls it through `createAdminClient()`,
   which bypasses RLS, so `DEFINER` would buy nothing and would cost the Phase 1
   `guard_profile_role()` trap.
5. **The idempotency key is derived, not taken from the header.** Structurally,
   `parseWebhook(rawBody, signatureHeader)` cannot see arbitrary headers and
   widening it would put one provider's transport detail into the interface
   every future provider implements. But the better reason is that deriving
   dedupes *strictly more*: a manual resend from the Razorpay dashboard carries
   a **new** header id for the same state change, and `payment.captured:pay_ABC`
   collapses it while the header would not.
6. **COD confirms immediately; Razorpay stays `pending` until the webhook.**
   There is nothing for a COD order to wait for, and the webhook is the only
   thing allowed to confirm a card order.
7. **Under-payment does not confirm; over-payment does.** Confirming an order
   for less money than it costs ships goods that are not paid for. Stranding a
   customer who paid *more* than they owed, because we owe them change, is the
   opposite mistake and equally wrong. `decide()` reads `orders.grand_total` and
   never `payments.amount`, so the check cannot be pointed at a drifted figure.
8. **An unknown provider status maps to `pending`, never `failed`.** Telling a
   charged customer they were not charged is the worst output this system can
   produce.
9. **An unverified webhook gets a uniform rejection shape.** "No signature",
   "wrong signature" and "not JSON" are three pieces of information, and an
   attacker who can tell them apart knows what to change.
10. **An unhandled event type answers 200.** A 400 on
    `payment.downtime.started` puts the endpoint into retry and then into
    disabled, and every later event goes with it.
11. **One checkout page, not a stepped wizard** (Agent D). A stepped checkout
    hides the total and makes fixing a typo cost two navigations.
12. **A native `<select>` for the 36 states, not a Radix listbox** (Agent D).
    One tap into the operating system's own picker on a phone.
13. **`pg_cron` inside Supabase rather than a Vercel cron route** for the
    abandoned-order sweep. Four reasons in `docs/architecture.md`; the shortest
    is that the leak is *database* state, and a route-based sweep stops exactly
    when the shop is already having a bad day. **The stated cost:** the schedule
    is invisible from the repo, and `select * from cron.job` is the only place
    it lives.
14. **The reclaim window is 30 minutes, defined in exactly one place** — the
    `p_older_than_minutes` default. The cron job passes no argument, so the two
    cannot disagree. The longest legitimate gap between "order written" and
    "money moves" is a UPI collect approved on another device, which PSPs expire
    in five minutes; thirty is about six times the slowest honest path.
    Worst-case reclaim latency is cutoff plus one tick — 40 minutes.

---

## 4 · Bugs found and fixed

Root causes, not symptoms.

### 4.1 `--state-low` was a dead token, and three things silently stopped working

*Symptom:* nothing. That is the point.

*Root cause:* the token was cut from `docs/design-system.md` §7 and never
removed from seven call sites. A CSS custom property that does not exist
resolves to nothing, and Tailwind's arbitrary-value syntax has no way to
complain. Three consequences, all silent:

- the sign-in `role="alert"` error rendered in body colour, so an error looked
  like copy;
- the "choose a size" validation ring on the product page and the wishlist
  **never drew at all**;
- the "your bag changed" notice had no border colour and no tint.

*Fix (lead):* `sign-in.tsx`, `product-viewer.tsx` (×2), `cart-notices.tsx`,
`wishlist-row.tsx` (×3).

### 4.2 The focus ring never painted, anywhere on the site

*Root cause:* `button.tsx` and `input.tsx` carried Tailwind's `outline-none`.
That utility lands in `@layer utilities`, which outranks the global
`:focus-visible` rule in `@layer base` — so the 2px orange half of the composite
focus indicator was overridden on every button and every input in the
application. Measured `outline-style: none` on the header buttons.

*Fix (lead):* removed from both. The reason is now written into `button.tsx`,
`input.tsx` **and** `select.tsx`, so a future `shadcn` sync that reintroduces it
is obviously wrong rather than merely new.

### 4.3 The `line2` contract contradiction — the lead's own bug

*Root cause:* `ShippingAddress.line2` is declared `string | null`, and the Zod
field validating it was `.optional()`. `.optional()` accepts `undefined` and
**rejects `null`**. So any caller obeying the published contract — which is what
a contract is for — got `invalid_input` on a perfectly valid address.

Two agents hit it independently, which is how it was found and also how bad it
was: the contract was published first precisely so that nobody would have to
guess, and it told both of them something untrue.

*Fix (lead):* `.nullish()` on `line2`, and on `customerNote` for the same
reason. All four shapes — present, `null`, `undefined`, absent — verified to
normalise.

### 4.4 `src/app/error.tsx` could not catch what it claimed to catch

*Root cause:* the file was named `GlobalError` and its comment claimed it caught
a failing root layout. **It cannot.** A React error boundary only catches throws
from *below* it, and that file sits inside the root layout. Production proved it
during the outage in §1.1: the throw produced a bare HTTP 500 with no markup at
all, because the thing that would have rendered something was inside the thing
that was broken.

*Fix (lead):* added the real `src/app/global-error.tsx` with deliberately
minimal imports — a boundary that itself imports the failing module is not a
boundary — renamed the old one `RouteError`, and corrected its comment.

### 4.5 The Razorpay modal was unmounted mid-payment

Found by Agent D, and only a real browser would have shown it.

*Root cause:* `placeOrder` calls `revalidatePath("/", "layout")`, because the
bag has just been converted and the header badge is stale everywhere. The
`/checkout` **page** was a Server Component that branched on an empty cart. So
the revalidation re-rendered `/checkout`, the cart was now `converted` and
therefore empty, the empty-bag branch rendered — and it **unmounted the client
component that was hosting the open Razorpay modal**, taking the order number
and the only resume affordance with it, while the customer was mid-payment.

*Fix:* the empty-bag branch moved inside `CheckoutFlow`, which stays mounted
across the revalidation. The reasoning is written above the render in both
files, because the correct-looking version of this code is the broken one.

### 4.6 The currency guard was checking the wrong entity (E-4)

*Root cause:* a single check above the webhook's event `switch`, reading
`payment?.currency ?? order?.currency`. That looks equivalent to checking each
arm and is not: `order.paid` takes its amount from the **order's**
`amount_paid`, so a payload with a `USD` order entity and an `INR` payment
entity passed a check on the payment and then spent the order's number as though
it were paise. Agent E landed a correctly-signed `order.paid` through it.

*Fix (Agent C):* the guard now lives **inside** each function that reads a raw
provider amount, validating the currency of the same entity the amount came
from, and returning `null` rather than an outcome when it does not like the
answer. The pre-switch check is gone entirely. The lesson recorded in the code
is not "add the missing case" — it is that **a guard placed anywhere other than
beside the value it guards can be bypassed by the next event type somebody
adds.** There is now no way to obtain a `PaymentOutcome` from that module
without passing one of them.

### 4.7 Two modules both claimed the same idempotency row, so no order could ever confirm

Caught by Agent B while integrating against Agent C's module. **It would have
silently prevented every Razorpay order from ever confirming** — a captured
payment, a 200 in the log, and an order left in `pending` forever with no error
anywhere.

*Root cause:* both halves of the seam independently implemented the same correct
pattern. Agent C's `recordAndApply` inserts the claim row into `payment_events`
and *then* calls Agent B's `applyPaymentOutcome` — which **also** did an
insert-first claim. The second insert hit the `unique (provider, event_id)`
constraint that its own request had satisfied three lines earlier, got `23505`,
and read that as "somebody else is already handling this event". Every genuine
webhook would therefore have returned `duplicate`, the route would have answered
200, and nothing would have moved.

Neither module was wrong on its own. "Insert first, treat a unique violation as
a duplicate" is exactly the right shape, and it is the right shape in both
files. What was missing was an owner for the seam **between** them, and the
failure mode of getting that wrong is the worst one available here: no
exception, no non-2xx, no red line, just paid orders that stay `pending`.

*Fix (Agent B):* the inner claim now **resolves** the `23505` instead of
assuming what it means. It reads the existing row back — a row with a
`processed_at` is genuinely handled and returns `duplicate`; a row without one
is *adopted*, and this call finishes it. Adoption is not a loophole, it is the
supported shape: `recordAndApply` claims first on purpose, so that the ledger
write happens before anything reads an order, and leaves `order_id`,
`processed_at` and `result` to the order code.

The inner claim was kept rather than deleted, which is the right call. It costs
one insert, and it is what makes `applyPaymentOutcome` safe to call from
anywhere that is *not* the webhook route — including its own harness, which is
how `audit:checkout` exercises it.

### 4.8 Lifting `noindex` needs a fresh build, not a redeploy

*Symptom:* the owner flips the switch, the deploy succeeds, and the store stays
invisible to search engines with no error anywhere. This is exactly the failure
shape this codebase fears most, and every document in the repo described the
broken procedure.

*Root cause:* `next.config.ts`'s `headers()` is evaluated **at build time**, and
its result is written into `.next/routes-manifest.json`. An incremental build
reuses that manifest. So `isIndexable()` is re-read for `robots.ts`, which is a
runtime route — but *not* for the header rule, which was baked in when the
noindex build ran.

*Measured, not reasoned about:* after setting the flag on Preview and
redeploying, `robots.txt` correctly flipped to `Allow: /` while
`X-Robots-Tag: noindex` **persisted from the cached manifest**. The two layers
that `robots.ts` promises "cannot disagree" had disagreed. A clean rebuild
emitted zero header rules, correctly.

*Fix:* documentation, in `README.md`, `.env.example` and `docs/admin-guide.md` —
the instruction now says to trigger a fresh build with the build cache
**unchecked**, and adds a verification step, because a procedure whose failure
is silent needs one:

```bash
curl -I https://foot-vault.vercel.app/ | grep -i x-robots-tag   # must print nothing
curl https://foot-vault.vercel.app/robots.txt                   # must show Allow: /
```

### 4.9 `/account/orders` had no route from the site chrome

*Root cause:* the pages were built and linked to each other, and nothing in the
header or the account menu linked *in*. The keyboard path the quality gate
requires was therefore unreachable.

*Fix (lead):* "Your orders" added to the account menu.

---

## 5 · The adversarial review

Agent E reviewed the finished code with no obligation to be kind to it. The
findings file is
[`claudeExecutionReport/phase-5-security-review.md`](phase-5-security-review.md);
the regression suite is `scripts/audit/security-checkout.ts`
(`npm run audit:security`).

| # | Severity | Finding | State |
|---|---|---|---|
| E-1 | **high** | Any anonymous visitor can empty the shop's stock, free. Start a Razorpay checkout, close the tab, repeat with a fresh cookie | **fixed** (B) |
| E-2 | medium | Lost update in `applyPaymentOutcome` — no compare-and-swap. A capture landing 200–225 ms after a cancellation yields `confirmed` + `paid` + `stock_restored_at` | **fixed** (B) |
| E-3 | medium | A guest who accepts the confirmation page's own "create an account" offer loses the order permanently | **fixed** (B) |
| E-4 | low | `order.paid` took its amount from the order and its currency from the payment (§4.6) | **fixed** (C) |
| E-5 | low | Three idempotency keys for one capture produced a duplicate "Confirmed" timeline row | **fixed** (B, same CAS) |
| E-6 | info | With `RAZORPAY_WEBHOOK_SECRET` unset, a customer whose browser never returns is charged and left `pending` with no reconciliation | **open — owner task** |
| E-7 | info | The `SECURITY DEFINER` surface, verified independently from `pg_proc` | documented |
| E-8 | info | `abandonUnpaidOrder` is exported but tree-shaken — unregistered dead code | **open** |

### E-1 in full, because it is the one that mattered

Stock is claimed when the order row is written, so a `pending` Razorpay order
holds its units from the instant it exists. `payment.failed` deliberately does
not cancel — Razorpay lets a customer retry a declined card inside the same
modal, and cancelling on the first failure would restock units out from under
the second attempt. That reasoning still holds. What was missing was the other
end: **nothing ever released an order that simply stopped.**

No account needed, no payment method needed, no cost, and nothing to ban.

The fix is `public.release_abandoned_orders()` on a `pg_cron` schedule. It
cancels and restocks orders left `pending` and `unpaid` past the cutoff, skips
any order with a `payments` row in `pending`, `captured` or `refunded` —
authorised-but-unsettled is real money, committed, just not moved — and is
bounded at 500 rows per run so a tick cannot become a long transaction holding
locks across the catalog.

**Verified independently by the lead against the live database:** job 1,
`*/10 * * * *`, `select public.release_abandoned_orders()`, active, 2 runs, 0
failures — and it had already auto-released **6 real leaked orders** that the
phase's own testing had created and abandoned.

### E-1 and E-2 had to be fixed together

This is the most interesting single fact in the review. **Fixing E-1 without E-2
would have turned E-2 on**, because a sweep *is* a cancellation racing in-flight
captures, and before the compare-and-swap a capture landing in that gap
overwrote `cancelled` with `confirmed` — producing a live order whose units were
already back on the shelf and whose customer had been charged.

`.eq("status", order.status)` on the update is the whole of the fix: the row has
to still be the one the decision was made from, or the update matches zero rows
and the loop re-reads and re-decides, up to three times. Three consecutive
losses is not contention — it is something rewriting the order in a loop — so
the claim is released and the provider's own redelivery becomes the answer.

The same swap fixes E-5 for free: a second capture under a different idempotency
key loses the swap, re-reads `confirmed`, and writes no second timeline entry.

### E-3, and why `adopt_guest_orders` is `SECURITY DEFINER`

The confirmation page invites a guest to create an account. Before the fix,
accepting cost them the order: the cart merge reports a converted cart as
"spent", `/auth/callback` drops the guest cookie on the strength of that, and
nothing ever moved the order onto the new account. `orders.user_id` stayed null
and `orders.guest_token` kept a token no browser held any more — unreadable by
the guest policy, unreadable by the customer policy, unreachable by anybody,
permanently.

`public.adopt_guest_orders()` is the missing half. It is `SECURITY DEFINER` and
**takes zero arguments**, is wired into `/auth/callback` before
`clearGuestToken()`, and **vetoes the token clear if adoption fails**.

The justification, given that Phase 1 was bitten by exactly this: `authenticated`
has no UPDATE policy on `orders` and must not get one. The user comes from
`auth.uid()` and the token from `current_guest_token()` — both *request* facts,
which `DEFINER` does not change. That is precisely the difference from
`guard_profile_role()`, which read `current_user`, a *role* fact, and went
silently inert. `and user_id is null` means it can never take an order off an
existing account.

**Verified independently by the lead:** `prosecdef = true`, `pronargs = 0`,
`search_path = ""`, granted to `authenticated` and `service_role` only — not
`anon`, no `PUBLIC`.

### What held under attack

Amount tampering including direct writes to `unit_price_seen`; 10× webhook
replay; 8 signature forgeries; a variant going inactive mid-flow in both
directions; a 5-way race on the last unit; cross-customer order reads through
**both** the API and the page; order-number enumeration; the coupon field;
secrets in the built bundle; and 8 direct writes to the money tables — reprice,
restock, self-issue an order, forge history, forge a payment, pre-process a
ledger row, self-promote to admin. All refused.

### Agent E's own verdict on where the code is weakest, findings aside

Quoted because it is more useful than anything we would have written about
ourselves:

> `orders.status` has four writers and only two of them lock; stock is a single
> mutable integer with no movements ledger, so a wrong count leaves no trace;
> and nothing on the site is rate-limited.

---

## 6 · Measurements

Every number here was produced by running the thing. Where a figure is a ceiling
rather than a forecast, it says so.

### 6.1 Static gates

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | succeeded |
| `npm run shapes` | **13 cached shapes unchanged at `v2`** |

### 6.2 The suites this phase wrote

| Suite | Result |
|---|---|
| `npm run audit:security` | **121 pass / 0 fail / 0 skip** — 117 pass / 4 fail before the E-1…E-5 fixes |
| `npm run audit:checkout` | **45 checks, all passed** — 32 before; 13 new for E-1, E-2 and E-3 |
| `npm run audit:cart` | **12 pass** |
| Agent C's payment suite | **174 assertions green** |

### 6.3 The browser and database gate

Measured in-tree against a production build on `:3210`.

| Suite | Result |
|---|---|
| `audit:overflow` | **22 routes + 15 populated states × 6 widths, 9,085 interactive elements measured.** No overflow, no tap target under 44px, no input under 16px |
| `audit:a11y` | **Clean** — no WCAG 2.2 A/AA violations across 22 routes and 15 populated states, at 390px and 1440px |
| `audit:focus` | **30 of 30.** `outline-width: 2px`, `outline-color: rgb(254, 147, 1)`, halo `rgb(10, 21, 38) 0 0 0 4px` |
| `audit:keyboard` | clean |
| `audit:keyboard-checkout` | **13 of 13.** A cash-on-delivery order — `FV-2026-00369` — was placed **by keyboard alone** and then found in the account history. Escape returns focus to the header bag |
| `audit:interactions` | clean |
| `audit:links` | **122 pages, 1,833 unique internal links.** No broken link, no missing title, no malformed JSON-LD |
| `audit:hydration` | **0 hydration warnings and 0 other console messages** |
| `audit:gallery` | 0px sliver at 360px and 390px; each slide exactly one viewport wide |
| `audit:auth`, `audit:bag`, `audit:signedin` | all passed |

`audit:focus` is worth pausing on, because it is the suite that exists *because
of* §4.2. Before the fix, every one of those 30 elements would have reported
`outline-style: none`. Measuring the computed outline rather than asserting that
a class is present is the difference between a test that catches that bug and a
test that agrees with it.

### 6.4 Checkout UI (Agent D)

- **54 overflow and tap-target checks** — 9 states × 6 widths — **0 failures**.
- **14 axe scans**, **0 violations**.
- **12 tab stops** from page load to the place-order button, **0 traps**, **0
  stops without a visible focus indicator**.

### 6.5 Visual (Agent A)

| Measurement | Before | After |
|---|---|---|
| Brand ink delta across renders | — | **≤ 0.02px** |
| Absolutely-positioned children in card media | — | **0** |
| Ink-width spread | 100px | **38px** |
| Cart dead zone | 562px | **24px** |
| Column mismatch | 480px | **0** |

### 6.6 Lighthouse, and the question that has been open since Phase 3

Phase 4 recorded, as its first known imperfection, that Lighthouse had never
been measured on real infrastructure — localhost has no network latency to
Supabase, and every route being dynamic means a slow database round trip lands
directly in TTFB in a way localhost cannot show. That is now settled. Both sets
of numbers are below, because each answers a different question and neither
answers both.

**On the Vercel preview** — `foot-vault-git-feat-phase-5-checkout-payments`,
mobile, `--throttling-method=devtools`, warmed. **These are the realistic
numbers**: real CDN, real cold starts, real round trips to Supabase.

| Route | Perf | A11y | Best practices | SEO | LCP | CLS | TBT |
|---|---:|---:|---:|---:|---:|---:|---:|
| home | 93 | 100 | 100 | 58 | 2.61s | 0.000 | 47ms |
| shop | 94 | 100 | 100 | 61 | 2.57s | 0.000 | 33ms |
| product | 91 | 100 | 100 | 61 | 2.95s | 0.000 | 43ms |
| cart | 96 | 100 | 100 | 54 | 2.26s | 0.001 | 11ms |
| checkout | 94 | 100 | 100 | 54 | 2.53s | 0.000 | 12ms |

Performance, accessibility and best practices meet the gate on all five routes.
CLS is **0.000** on four of them and 0.001 on the fifth, which is the Phase 3
and Phase 4 layout work holding under a real network.

**SEO does not meet the gate on the preview, and it cannot.** Vercel injects
`x-robots-tag: noindex` into every preview deployment, regardless of what the
application says. This was proved rather than assumed: setting
`SITE_INDEXABLE=true` on Preview and redeploying made *our own*
`noindex, nofollow, noarchive` header disappear and flipped `robots.txt` to
`Allow: /` — and a plain `x-robots-tag: noindex` **remained**. That header is
Vercel's. Production, which has no such header from us, returns none at all. So
**SEO ≥ 90 is not measurable on any Vercel preview deployment, by anyone,
ever.** It is not a defect in this codebase and no amount of work here would
move it.

**Locally, clean build, `SITE_INDEXABLE=true`** — run specifically to isolate
the markup from Vercel's preview policy:

| Route | Perf | A11y | Best practices | SEO | LCP |
|---|---:|---:|---:|---:|---:|
| home | 99 | 100 | 100 | **100** | 1.69s |
| shop | 99 | 100 | 100 | **100** | 1.96s |
| product | 99 | 100 | 100 | **100** | 1.92s |
| cart | 99 | 100 | 100 | 63 | 1.70s |
| checkout | 99 | 100 | 100 | 63 | 1.62s |

The three public routes score **99 / 100 / 100 / 100** — a clean sweep of all
four categories.

**The honest caveat on those local numbers:** a production build served from the
same machine as the browser has no CDN, no cold start and no real round-trip
time. 99 is a ceiling, not a forecast. The preview numbers — 91 to 96 — are the
ones to plan against, and they are the ones a customer will experience.

#### `/cart` and `/checkout` score 63 on SEO, and that is correct

Say this plainly rather than reporting a pass: **the brief's quality gate is
internally contradictory on these two routes.**

It asks for Lighthouse SEO ≥ 90 on `/cart` and `/checkout`. `src/app/robots.ts`
**deliberately disallows** both, along with `/wishlist`, `/search`, `/account`,
`/admin` and `/order` — they are per-visitor or infinite, none of them is worth
a crawl budget, and each carries `robots: noindex` in its own metadata as well.
That is ordinary, correct e-commerce practice, and it predates this phase.

You cannot ask a crawler to stay out of a page and then score that page on how
crawlable it is. Lighthouse is reporting the disallow, accurately. Three of the
four categories pass on those routes; the fourth fails **by design**, and the
design is right. The gate is what needs amending, not `robots.ts`.

### 6.7 The abandoned-order sweep, in production

`pg_cron` job 1, `*/10 * * * *`, active. **4 runs — 20:30, 20:40, 20:50, 21:00 —
all `succeeded`, exactly on the ten-minute tick.** Verified directly against
`cron.job` and `cron.job_run_details` rather than read off a log. Between them
those runs auto-released **6 real leaked orders** that the phase's own testing
had created and abandoned, which is the E-1 fix doing its job on live data
before anyone asked it to.

### 6.8 Teardown, verified rather than assumed

The harnesses write real orders, real payment rows and real accounts, so the
sweep afterwards is part of the measurement:

- **restocked 22**, deleted **22 orders**, **23 carts**, **16 accounts**;
- final state: **0** `fv-%@example.com` accounts, **0** rows in
  `payment_events`, **0** variants with negative stock, and every variant back
  to its seeded level less whatever outstanding orders still hold.

**Four orders remain**, and deliberately so: they belong to the owner's own real
account, and the teardown refuses to sweep on a pattern match that could catch a
real customer. A cleanup script that deletes real orders because they resemble
test data is a worse bug than the mess it tidies.

---

## 7 · What we got wrong and caught in self-review

The list is longer than we would like, which is the correct length for it to be.

- **The lead published a contract that was wrong, and two agents built against
  it.** `ShippingAddress.line2` was `string | null` while its Zod field was
  `.optional()`, which rejects `null`. The entire argument for publishing
  contracts first is that nobody should have to guess — and this one told two
  agents something untrue, independently. (§4.3)

- **The lead broke its own one-writer-per-file rule.** The `+91` prefill fix in
  the Razorpay adapter is a file Agent C owns, and the lead edited it directly
  rather than asking. C reviewed the change and kept it, so nothing was lost —
  but the rule existed because concurrent edits to one file are how a multi-agent
  build corrupts itself, and the person who wrote the rule is the worst possible
  person to break it.

- **An earlier version of the comment at the top of `payment-state.ts` was
  wrong about its own concurrency.** It claimed that "adoption" of a
  pre-claimed `payment_events` row let two simultaneous deliveries both proceed.
  Agent E's review established that it does not: through the webhook route the
  inner claim always loses to the row `recordAndApply` inserted three lines
  earlier, always finds `processed_at` null, and always adopts, so it is a
  lookup of this request's own row rather than a gate. The real hazard was never
  the claim — it was the `orders` row between the read and the write, which is
  E-2. The comment now says so, and says that it used to say otherwise.

- **The currency guard was written in the wrong place and looked right.** (§4.6)
  A single check above the switch is the natural way to write it and is subtly
  wrong the moment a second event type reads its amount from a different entity.

- **We classified E-1 as a known imperfection rather than a vulnerability.** The
  agents who wrote the ordering code and the payment code had both independently
  written down "abandoned pending orders hold their stock" as a limitation to
  note in the report. It took an agent whose only job was to attack the code to
  point out that this is not a limitation, it is a free, anonymous,
  un-attributable denial of inventory against the entire shop. That is the
  single strongest argument in this report for the adversarial review being a
  separate role. (§13)

- **The empty-bag branch was on the wrong side of the client boundary**, and it
  read as obviously correct there. Only driving a real browser through a real
  payment surfaced it. (§4.5)

- **`abandonUnpaidOrder` was written, exported, and never wired to anything.**
  We did not notice; Agent E did, by reading
  `.next/server/server-reference-manifest.json` and finding 13 registered
  actions, none of them this one. Writing a server action nobody imports is
  writing dead code with a security surface.

- **`.env.example` described the webhook secret as something Razorpay generates
  for you.** It is not — you invent it and paste it into both places. The
  documentation agent caught it while checking the file against
  `src/lib/payments/config.ts`, which had it right. A wrong setup instruction in
  the one file an owner copies is worse than no instruction.

- **The header comment on `payment-state.ts` said the sweep did not ship.** It
  read "see the note in the report about the sweep this phase does not ship" —
  written before E-1 was fixed, and never revisited when
  `release_abandoned_orders()` landed. So the file that implements the most
  security-sensitive logic in the phase told its next reader the opposite of the
  truth about the highest-severity finding in it. Found during the documentation
  pass, by reading the code against the handoff instead of trusting either.
  Corrected to name the function, the `pg_cron` job and the window.

- **The launch-day instruction for lifting `noindex` was wrong, and wrong in the
  silent direction.** "Set `SITE_INDEXABLE=true` and redeploy" is what three
  documents said, and a plain redeploy does not do it. See §4.8 — this was
  caught by measuring the deployed headers rather than by reasoning about the
  config.

---

## 8 · Known imperfections

Honestly, the things we are least confident about.

1. **`RAZORPAY_WEBHOOK_SECRET` is not set** (owner task, §9.1). Until it is, the
   webhook rejects everything with a 400. That is the correct failure direction
   — the alternative is an endpoint that will confirm any order it is asked to —
   but it means a customer whose browser never comes back is charged and left
   `pending` with nothing to reconcile it.

2. **No real Razorpay payment has ever completed.** Every branch *around* it is
   proven — dismissal, blocked script, resume, webhook capture, signature
   forgery, replay — but the actual test-card → callback → confirmation round
   trip needs a human typing into Razorpay's own iframe. **This is the largest
   untested surface in the phase**, and it is an owner verification step before
   launch.

3. **`abandonUnpaidOrder` is unregistered dead code** (E-8). Safe to wire now
   that E-2 is fixed, but it has never run end to end.

4. **There is no movements ledger for stock.** `product_variants.stock_quantity`
   is a single mutable integer, so a wrong count leaves no trace of how it got
   wrong.

5. **Nothing is rate-limited.** Not the webhook, not the verify action, not
   checkout.

6. **`verifyRazorpayPayment` has no session check.** Anyone holding a valid
   `(order id, payment id, signature)` triple can call it, and the result is an
   idempotent no-op. Adding an ownership check would break guest checkout, and
   the triple is already sitting in that person's own browser — so this is
   recorded rather than fixed, deliberately.

7. **`payments` holds one row per provider order**, so failed retries live in
   `payment_events` rather than as sibling `payments` rows, and a mismatched
   *received* amount goes into `payment_events.result` as free text rather than
   into its own column.

8. **COD's `isAvailable()` is unconditionally true.** No PIN-code gate, no
   cart-value floor. That is a business rule and it belongs to the owner; the
   hook for it is described in `src/lib/payments/cod.ts`.

9. **`payment.refunded` and the `refund.*` events are unhandled.** Phase 8.

10. **Migration filenames do not match the versions recorded by the MCP server.**
    Pre-existing and repo-wide, not new to this phase. The relative order is
    identical, so nothing replays out of sequence; what it costs is that
    matching a file to its recorded application is a manual step.

11. **Agent A removed the colourway caption from product cards** along with the
    baked-in text it was cleaning up. That is information removed rather than
    relocated. The judgement was that "Peacoat Navy" under a thumbnail is
    glossary noise; it is recorded here because it was a judgement and not an
    oversight.

12. **Below `lg` the rail still shows a peek card at rest**, and that peek is the
    only affordance telling a touch user it scrolls.

13. **`isSupabaseConfigured()` promises graceful degradation that the render path
    does not deliver.** (§1.1) The comment is now contradicted in
    `docs/architecture.md`, which is a documentation fix for a code problem.

14. **Agent E's §14 checks still assert pre-fix guest-merge behaviour in
    isolation**, because they call `merge_guest_cart` directly and never touch
    `/auth/callback` — so they do not see the adoption step. Agent B's
    `audit:checkout` §9 covers the actual fix. Two suites disagreeing about the
    same behaviour is a thing to fix rather than explain, and it is not fixed.

15. **`.env.local` holds a `SHIPROCKET_API_KEY` that no code reads and that is
    not in `.env.example`.** Presumably the owner's groundwork for a shipping
    integration. It is named here rather than left to be discovered, because an
    unused secret in an environment is still a secret in an environment: it has
    to be rotated when anything else is, it will be copied into Vercel by
    somebody following the setup, and the first person to find it will have to
    work out from scratch whether it is live. Either wire it or remove it.

---

## 9 · Blocked on the owner

Nothing in the code can do any of these. The same four are written for a
non-developer in [`docs/admin-guide.md`](../docs/admin-guide.md).

### 9.1 Create the Razorpay webhook secret

1. Generate it yourself: `openssl rand -hex 32`. **Razorpay does not generate
   this for you** — this is the single most common thing to get wrong here, and
   it is a *different* string from `RAZORPAY_KEY_SECRET`.
2. Razorpay Dashboard → **Account & Settings** → *Website and app settings* →
   **Webhooks** → **Add New Webhook**.
3. URL: `https://<domain>/api/payments/razorpay/webhook`. Public HTTPS only —
   Razorpay cannot reach `localhost`.
4. Paste the secret into the dashboard's *Secret* field.
5. Subscribe to exactly: `payment.captured`, `payment.failed`,
   `payment.authorized`, `order.paid`.
6. Set the same string in Vercel as `RAZORPAY_WEBHOOK_SECRET`, **for Preview and
   Production separately, with a different secret for each**, then redeploy.

Full reasoning is in `src/lib/payments/config.ts`.

### 9.2 Make one real test-mode payment

See imperfection 2. Once, in test mode, before a real order is taken.

### 9.3 Connect an email provider

Verify a sending domain (SPF + DKIM) — skipping this is what puts order
confirmations in spam — then set `EMAIL_API_KEY` and `EMAIL_FROM` in Vercel per
environment. A developer then adds `src/lib/email/<provider>-adapter.ts` and
returns it from `getEmailAdapter()`. Nothing else changes.

### 9.4 Go live with indexing — and do not just redeploy

Three steps, and the third is not optional. See §4.8 for why.

1. Set `SITE_INDEXABLE=true` in Vercel, **Production only**, so previews stay
   hidden. Only the exact string `true` opens it.
2. Trigger a **fresh build** — push a commit, or redeploy with *Use existing
   Build Cache* **unchecked**. A plain redeploy reuses the build output, and the
   `X-Robots-Tag: noindex` header is baked into it. It will not lift.
3. **Verify**, because this procedure fails silently:

   ```bash
   curl -I https://foot-vault.vercel.app/ | grep -i x-robots-tag   # must print nothing
   curl https://foot-vault.vercel.app/robots.txt                   # must show Allow: /
   ```

### 9.5 Optional

Enable leaked-password protection in Supabase Auth. **Verified disabled** —
Supabase's own security advisor reports `auth_leaked_password_protection` as
off. Low relevance while sign-in is Google-only, and free to turn on.

**Phase 4's two blockers are cleared.** Google OAuth is enabled and real accounts
have been created through it, and `SUPABASE_SERVICE_ROLE_KEY` now has a value —
which matters more than it did, because checkout runs its order transaction
through the admin client and does not work without it.

---

## 10 · Deliberately deferred

| Deferred | Owned by | Note |
|---|---|---|
| Admin panel for orders | Phases 6–7 | Orders are visible through `/account` and the Supabase table editor only |
| Coupon validation | Phase 8 | Nothing typed in the coupon field can reach a total: **no parameter carries it into `create_order_with_stock`** |
| Reviews | Phase 8 | |
| **Refunds** | Phase 8 | See below |
| A stock movements ledger | unassigned | Imperfection 4 |
| Rate limiting | unassigned | Imperfection 5 |

**What refunds will need**, so the next phase does not rediscover it:
`payment.refunded` and `refund.*` webhook handling; a `refunded` transition on
the payment side; a restock decision *per line* rather than per order; and a
`payments` row shape that can hold more than one row per provider order.

---

## 11 · Migrations

Sixteen, listed with what each does in
[`docs/database.md`](../docs/database.md#phase-5-migrations). Two notes worth
repeating here because they cost real time.

**The MCP migration channel truncates a payload over roughly 5KB, silently.**
Not with an error — the migration reports success and what lands is the first
few kilobytes of what was sent. That is why the checkout transaction is
`assert_cart_stock` plus `create_order_with_stock` rather than one function, why
`20260808090750` recreated the body without its inline commentary, and why
`20260808090510` is named in a database comment as the annotated file to read
first. The split was placed where it reads as a sentence rather than wherever
the byte count fell, so the constraint ended up costing nothing structural.

**`20260808090750` drops and recreates rather than replacing.** `supabase gen
types` cannot express parameter nullability — every `uuid` argument comes out as
`string`, never `string | null` — so under `strict` there was no type-clean way
for the checkout action to say "this is a guest, there is no user id". The
choices were a cast, hand-editing a generated file that the next regeneration
would silently revert, or making the SQL say what is actually true. Changing
parameter names and order produces an **overload** rather than a replacement,
and two functions differing only in argument order is a live ambiguity waiting
for a caller to trip on — hence the drop.

---

## 12 · Documentation updated

Standing rule 2: no phase is done until the docs match the code. What changed,
and what was found stale rather than merely missing:

| File | Corrected |
|---|---|
| `README.md` | "the whole quality gate, all eight below" → the real list of 18 `audit:*` scripts, plus `shapes`. Both "what is blocked" items were **false** — Google OAuth is enabled and the service-role key has a value. Added the env-var table, the Razorpay test-mode setup, how to run checkout locally, and the note that the webhook cannot reach localhost |
| `.env.example` | The webhook-secret instruction said Razorpay generates it. **You invent it.** Also corrected the dashboard path, added the two email names the code asks for, and replaced "redeploy" with the fresh-build-plus-verify procedure |
| `docs/architecture.md` | "The unit is claimed at checkout (Phase 5)" was in the future tense. "The callback does three things" was four. The merge description was Phase 4's line-by-line version. Added the state machine, the payment seam, webhook authority, idempotency, the sweep, error boundaries, the shape snapshot and the indexing gate |
| `docs/database.md` | Said **21 tables**; there are **23**. `orders` was listed with 19 columns and 3 policies; it has 23 and 4. The Functions table predated every Phase 5 function and was also missing the pre-existing `rls_auto_enable` and `color_family`. Added the new tables, enums, columns, grants, policies and `pg_cron` |
| `docs/rls-tests.md` | Coverage table said 21 of 21. §6b.1's "Google is not enabled" and "the service-role key is empty" caveats were both stale. Added §9: the guest-order access model, the payment tables, and E-7's `SECURITY DEFINER` table including `adopt_guest_orders` |
| `docs/admin-guide.md` | Still said checkout "leads to a page that does not exist yet". Added the whole orders section — statuses, changing one by hand, why cancelling restocks and returning does not, the self-cancelling sweep, COD — and the four owner tasks, with the go-live procedure rewritten around §4.8 and given a `curl` that proves it worked |
| `src/lib/orders/payment-state.ts` | Not a doc, but a comment that had become a lie: it said the abandoned-order sweep "this phase does not ship". Corrected by its owner to name `release_abandoned_orders()`, `pg_cron` job 1, the thirty-minute window and the migration |

---

## 13 · Did the multi-agent structure earn its cost?

Yes, and the evidence is specific rather than general. It is worth being precise
about *which* parts paid, because not all of them did equally.

### What it cost

Real coordination overhead. A contract-publishing step before any
implementation. A one-writer-per-file rule (which the lead then broke, §7). A
handoff document written specifically so the documentation agent would not have
to reconstruct the phase from commits. Two suites that now disagree about guest
merge because they were written by different agents against different surfaces
(imperfection 14). And a bug — the `line2` contradiction — that exists *only*
because the contract was published ahead of the implementations, and which a
single agent writing both halves would never have hit.

### What it returned

**1. Agent B caught an integration break in Agent C's code** (§4.7). It would
have silently prevented **every** Razorpay order from ever confirming — no
exception, no failed request, no red line in a log, just paid orders that sit in
`pending` forever.

It is worth being precise about what this proves, because the honest reading
cuts both ways. The bug was *caused* by the division of labour: two agents
independently implemented the same correct idempotency pattern, and a single
author writing both halves would almost certainly not have written it twice. But
it was also *caught* by the division of labour, before it shipped, because an
agent integrating against somebody else's module has to test the seam between
them — whereas an agent who wrote both sides tests what they meant by both,
which is the same assumption checked twice.

So the fair claim is not "multi-agent prevented a bug". It is that **splitting
the work changes which bugs you get, and this split traded a class of bug that
is invisible for a class of bug that surfaces at the boundary.** A silent
never-confirms is the worst failure this system can produce; a seam that two
agents disagree about is the loudest. Trading the first for the second is a good
trade even when the second is more frequent.

**2. Agent E found a high-severity vulnerability that both implementing agents
had classified as a known imperfection.** Agent B and Agent C had each
independently written down "abandoned pending orders hold their stock" as a
limitation to mention in the report. Neither noticed that it is a free,
anonymous, unattributable way to show the entire shop as sold out. This is not a
knowledge gap — both of them understood the mechanism perfectly, and both had
written it down. It is a *stance* gap. The person who built a thing is
structurally the wrong person to ask "how would I abuse this", because they have
spent hours reasoning about how it is meant to be used. Giving that stance to a
separate agent with no code to defend is what turned a paragraph in a report
into `release_abandoned_orders()` on a ten-minute schedule.

**3. E-1 and E-2 interlock, and only a reviewer holding both would have seen
it.** Fixing the stock leak without the compare-and-swap would have *activated*
a dormant race, because the sweep is a cancellation racing in-flight captures.
An agent fixing E-1 in isolation ships a worse system than the one it started
with.

**4. Agent D found a bug that only exists in a browser.** The unmounted payment
modal (§4.5) is invisible to types, to lint, to unit tests and to code review.
It required somebody whose job was to drive the real UI.

### The honest counter-argument

The `line2` bug is a genuine cost of the structure, not an accident within it —
publish an interface ahead of its implementations and you can publish a wrong
one. And the two disagreeing test suites are a coordination failure that a
single author would not have produced.

Set against E-1, that trade is not close. A contract bug is loud: two agents hit
it within the hour and it was fixed the same day. The vulnerability was silent
and had already been written down and accepted by the two people best placed to
find it.

### What we would keep and what we would change

**Keep:** contracts before implementations; the adversarial reviewer as a
separate role with no code to defend; a browser-driving agent.

**Change:** three things.

*Contracts should be exercised before they are published.* The `line2` bug dies
instantly against four round-trip cases through the schema, and we wrote those
cases only after two agents had already been misled by the contract that was
supposed to stop exactly that.

*Every seam needs a named owner, not just every file.* §4.7 happened because
`payment_events` had two writers and no owner — one-writer-per-*file* is not the
same rule as one-writer-per-*invariant*, and idempotency is an invariant that
spans two modules. The file rule would not have caught it and did not.

*The one-writer-per-file rule needs an escalation path cheaper than breaking
it,* because the lead broke it rather than wait (§7).
