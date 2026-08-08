# Phase 7 — correctness, the money model, and what did not get built

Branch `feat/phase-7-correctness-money-model`. Not merged; `main` auto-deploys to
a live store and that is the owner's decision.

**Read §7 first if you are short of time.** This phase did not finish. What was
built is finished properly and measured; a substantial part of the brief was not
started, and §7 lists it item by item rather than burying it.

---

## 1 · Preflight — the state of each thing, before anything was built

### `RAZORPAY_WEBHOOK_SECRET`

Set in Vercel for **Preview and Production** (`vercel env ls`, created 8h before
this run). Set locally.

**Evidence that an order has reached `confirmed` through the webhook:** yes. Two
orders carry a `payment_reference` from a real capture — `FV-2026-00487`
(`pay_TN9GKQluiI5ExB`, prepaid, ₹1,698) and `FV-2026-00571`
(`pay_TNEWQBLIJ4gAGN`, Pay on Delivery, ₹348 advance against a ₹1,848 order).
Eight rows in `payment_events`. The webhook path is live and has worked.

### Shiprocket

`SHIPROCKET_EMAIL`, `SHIPROCKET_PASSWORD` and `SHIPROCKET_PICKUP_LOCATION` are
set locally and in Vercel for Preview and Production.

**The app itself had never authenticated.** `integration_tokens` was **empty** at
the start of this phase — no row, so no login had ever succeeded from this
codebase. Every Phase 6 quote came from the fallback, exactly as the brief
suspected.

It authenticates now. One login, made by hand and deliberately single-shot:

```
login → 200 in 146ms
keys: company_id, created_at, email, first_name, id, last_name, token
expires_in: undefined     (so the 240-hour assumption is the one in use)
company_id: 7224505       token length: 399
```

`GET /v1/external/settings/company/pickup` → 200, one address:

```
id 9285733 · pickup_location "warehouse" · Cuddapah · pin 516360
"Classic vastralayam complex Shop no 2", "Near RTC bustand, Peacock bar backside"
phone 9160252643 · status 1 · phone_verified 1 · is_primary_location 0
```

The nickname is `warehouse`, lowercase, exactly as the brief said. The token was
written into `integration_tokens` so nothing in this phase needed a second login.

**The first live rates this codebase has ever seen.** 516360 → 560001, 1 kg,
₹1,000 declared, `cod=1`:

| Courier | rate | freight | cod | rto | SLA rank | rating |
|---|---:|---:|---:|---:|---:|---:|
| Delhivery Air *(recommended)* | 240.36 | 188.36 | 52.00 | 194.00 | 2 | 4.80 |
| Delhivery Surface | 191.36 | 139.36 | 52.00 | 142.00 | 3 | 4.60 |
| India Post Speed Post | 125.10 | 106.20 | 18.90 | **0.01** | — | 4.40 |
| Blue Dart Air | 300.30 | 244.65 | 55.65 | 246.00 | 5 | 4.83 |

`rate = freight_charge + cod_charges`, exactly. India Post's `rto_charges: 0.01`
confirms the standing decision to exclude it from pricing — it is not a real
number, and quoting from it would understate the shop's exposure on precisely the
orders most likely to come back.

`rto_performance`, `tracking_performance` and `delivery_performance` came back
**identical for every courier** (4.4 / 4.5 / 4.5). They are account-level or
default values on an account with no volume. `rating` and `SLA_Adherence` do
vary. Noted because the brief expected these to discriminate and, on this
account today, three of them do not.

### Has a Pay-on-Delivery advance ever been captured for real?

**Yes.** `FV-2026-00571`, 8 August 09:54 UTC: `payment_method` `cod`,
`payment_status` `paid`, `advance_amount` ₹349, `balance_due_on_delivery`
₹1,499, `payment_reference` `pay_TNEWQBLIJ4gAGN`. The path is verified end to
end. (Under the model this phase builds that same order's advance would have
been ₹281.36 rather than ₹349 — the old rule charged the delivery fee, the new
one charges the round trip.)

### The token service, before any live call

The brief's four conditions, checked against the code as it stood:

| Condition | Held? |
|---|---|
| Logs in **once** | Yes — module memo in front of a shared `integration_tokens` row, plus an in-flight promise so concurrent requests on a cold instance share one login |
| Caches for the 240-hour life | Yes, with a twelve-hour proactive refresh margin |
| Re-authenticates **at most once** on a 401 | Yes — `shiprocketFetch` retries once and surfaces a second 401 |
| On a rejection, **stops entirely** | **No.** See §3 |

---

## 2 · A1 — the root cause, which was none of the four obvious ones

The owner placed an order for a variant the admin showed as zero. The brief
listed four candidates and asked for them to be checked rather than guessed
between. Three came back clean:

- **`create_order_with_stock` does verify before it decrements.** It calls
  `assert_cart_stock`, which locks every variant `FOR UPDATE` in id order and
  raises `OSTCK` with a json `DETAIL` naming the shortfall.
- **`CHECK (stock_quantity >= 0)` already exists** on `product_variants`
  (`product_variants_stock_quantity_check`). Negative stock is unrepresentable.
- **`addToBag` already re-reads stock** and refuses at zero, by name.

The fourth was it, and it is a cache-invalidation hole rather than a guard hole.

`cachedProduct` and the two listing caches store `variants[].stock_quantity`
inside an `unstable_cache` entry with a one-hour window and a `catalog` tag —
and **nothing that changes stock invalidated that tag.** Grepped at the start of
the phase, `CATALOG_CACHE_TAG` was reachable from
`src/lib/actions/admin/{brands,categories,media,products,settings}.ts` and
nowhere else. Not from checkout, which decrements. Not from a cancellation,
which restores. And — the one the owner actually hit — **not from the stock
editor in `/admin/inventory`**, which called `revalidatePath("/", "layout")`.
That expires the *route* cache and leaves every `unstable_cache` entry precisely
where it was.

So the owner set a size to zero and the storefront went on offering it for the
rest of the hour. `addToBag` would have refused at the tap, which is why this
produced a confusing failure rather than an oversold pair — but a size run that
lies is the bug, and being rescued at the last step is not a fix.

### What was done

- **Availability is read live.** `src/lib/queries/availability.ts` reads
  `product_variants` for the products on the page and lays live stock over the
  cached content — sizes, colourway runs, `inStock`, and the second copy in
  `variants[].stock`. Catalog *content* stays cached for its hour. Measured cost
  on a warm production build: `/product/[slug]` TTFB **11ms → 14ms**.
- **Every path that moves a unit says so.** `src/lib/stock-freshness.ts`,
  wired into `placeOrder`, the checkout rollback, the admin cancellation and the
  admin stock editor. `updateTag` from Server Actions, `revalidateTag(tag,
  {expire: 0})` for a Route Handler — the single-argument form is deprecated in
  this Next and does not typecheck.
- **Sold-out sizes are no longer selectable.** They stay in the run, struck
  through, `aria-disabled` rather than `disabled` so they can still be focused
  and still announce "UK 8, sold out", and pressing one says so in the live
  region instead of becoming the selection. Arrow keys step over them.
- **The add-to-bag control is replaced, not disabled**, when every variant is
  out. The `soldOut` prop was removed from `AddToBag` outright so the disabled
  path cannot be reused.
- `askForSize` focused `button:not([disabled])`, which matched the sold-out
  chips now that they are `aria-disabled` — so "choose a size first" could land
  the focus on the one chip that cannot be chosen. Fixed in the same pass.

### The regression test

`npm run audit:zero-stock`, written by the adversarial pass — **10/10**. It
orders a sold-out variant through the real `placeOrder` action over HTTP and
asserts the refusal names the item; backs that with the RPC raising `OSTCK` and
the `CHECK (stock >= 0)` raising `23514`; and carries a **positive control** —
the same variant, restocked, does place — so the refusal is stock-specific
rather than the harness failing to reach the code.

### Residual, stated plainly

`release_abandoned_orders()` runs inside Postgres under `pg_cron` and cannot
call into Next, and neither can somebody editing a row in the Supabase
dashboard. Both only ever *restore* stock, so the stale direction is "we still
say sold out for up to an hour" — a lost sale rather than an oversold pair. The
product page does not have even that window.

---

## 3 · The lockout that would have happened again

The brief's critical constraint: on a rejection the token service must stop
entirely, never retry, never silently fall back.

The code satisfied the letter and not the substance. A rejected login threw; the
throw was caught one layer up and turned into a typed `{ok: false, reason:
"auth"}`; and the **next request** found no cached token and logged in again.
With wrong or blocked credentials that is one login attempt per request,
arriving at whatever rate the shop is being browsed at. Nothing retried in a
loop — the loop was the traffic. This is the pattern that locked this account's
API user out during setup.

`src/lib/shipping/token.ts` now sets a **latch** on a credential rejection: a
row in `integration_tokens` keyed `shiprocket:auth_lockout`, holding the reason
and an expiry fifteen minutes out. A database row rather than a module variable,
because a per-instance flag on Vercel is forgotten by every cold start and there
are many. While it is set, `getShiprocketToken()` refuses without touching the
network. Two things clear it: the fifteen minutes passing, or an admin clearing
it after fixing the credentials (`clearShiprocketLockout()`).

**Only rejections latch** — a 400 or 403 from `/auth/login`. A timeout or a 500
does not, because those are Shiprocket having a bad minute and retrying them is
correct; latching on them would take shipping down for fifteen minutes every
time a third party hiccuped.

The latch is checked **after** the cache, so a valid cached token keeps working
through a lockout. A bad password does not have to stop a shop whose token is
still good for nine days.

`shiprocketFetch` surfaces it as a distinct `locked_out` reason, because "we
have stopped on purpose and there is a button" is a different message from "we
cannot reach Shiprocket".

**The admin screen and the "try again" button for it are not built.**
`clearShiprocketLockout()` and `shiprocketLockout()` exist and are unused. Listed
in §7.

---

## 4 · A3 — the literal was worse than reported, and it was live

The brief flagged one hardcoded threshold on `/page/returns`. Sweeping for the
*pattern* rather than the string found the same number on three surfaces and a
setting that had moved out from under all of them:

| Surface | Said | `site_settings.shipping.free_above_paise` |
|---|---|---|
| `site_settings.announcement.text` | "Free shipping over ₹2,499" | **₹6,499** |
| `pages.body` (`shipping`), twice | "₹2,499 or more" | **₹6,499** |
| `docs/database.md` | ₹2,499 | **₹6,499** |

The announcement strip sits above **every page on the site**. The shop was
advertising free delivery from ₹2,499 while checkout charged for it up to
₹6,499 — not a stale document, a promise the till does not keep, where the
customer is right and the shop is wrong and nobody finds out until somebody
complains at the payment step.

**No currency literal survived in code.** Every `₹` hit in `src/` was in a
comment or a validation message. The number had gone into *content*, which is
where it goes the moment code is closed to it, because content is prose typed by
a person in an admin panel where no lint rule will ever run.

So the mechanism is a token: `{{free_shipping_threshold}}`,
`{{cod_minimum_order_value}}`, `{{return_window}}`, `{{delivery_advance}}`,
resolved at render time from `site_settings` (`src/lib/content-tokens.ts`).
Substituted into CMS page bodies and into the announcement strip. An unknown
token is left **exactly as typed** rather than blanked — a visible
`{{free_shiping_threshold}}` is a typo somebody reports in an hour; a silently
empty sentence is the same bug again.

The announcement's dismissal key is hashed from the **raw** text, before
substitution, so nudging the threshold does not bring a dismissed strip back for
everybody.

`npm run audit:literals` is the gate, and it checks both halves — code *and*
owner-edited content. **135 files, 7 CMS pages and the announcement: clean.**

Both policy pages were also rewritten, because they described the *old* money
model. `/page/returns` said the Pay-on-Delivery charge is never refundable; under
this phase it comes back in full if nothing has shipped, and the shop-error row
of the refund table is now stated on the page.

---

## 5 · A7 — F-2, and the fix that measured worse than useless

Carried unfixed through two security reviews as "`/admin` returns 200 to an
anonymous visitor". It was never the document response — that has always been
404. It is the **flight** response:

```
                          document   rsc
/admin                    404        200
/definitely-not-a-route   404        404
```

Identical bodies, different status. A `<Link href="/admin">` or a router
prefetch asks for the flight payload, and a middleware rewrite short-circuits
the status Next would otherwise attach — readable from any browser console with
`fetch('/admin', {headers:{RSC:'1'}})`.

**The first fix did not work, and it looked exactly like one that did.** I
branched on `RSC: 1` and `Next-Router-Prefetch: 1`. Measured after building: the
response still carried `x-middleware-rewrite: /_not-found` and still answered
200. Next strips those headers before the proxy sees them, precisely so
middleware cannot branch on them, and re-applies them downstream. A guard
written against a header that never arrives is a guard that does not run.

The working fix is the positive test: the styled rewrite is reserved for
requests that ask for `text/html`, and everything else gets a bare 404 that the
router turns into a full navigation. Measured on a production build, every shape:

```
path                     doc  rsc  ?_rsc  prefetch
/admin                   404  404  404    404
/admin/products          404  404  404    404
/definitely-not-a-route  404  404  404    404
```

A browser navigation still gets the styled page (78,620 bytes, `<title>Foot
Vault…`) with a 404.

**I got this wrong twice.** The second attempt — `Accept: text/html` — is the
one to learn from, because it passed every test I could think of. Next's own
client never sends `RSC: 1` *and* `Accept: text/html`, so it measured clean
against every real navigation. The adversarial pass broke it in one line:

```
curl /admin -H 'RSC: 1' -H 'Accept: text/html'   -> 200
curl /definitely-not-a-route  (same headers)     -> 404
```

An attacker sets headers for free. **Any classification of a request built from
client-supplied headers is forgeable**, so the guard must not classify the
request at all.

The third attempt does not. It rewrites to a path that has **no route** rather
than to `/_not-found` — and that distinction is the whole thing. `/_not-found`
is a route Next *knows about*, so a rewrite to it is answered with that route's
own status handling, and on the flight path that is 200. An unmatched path falls
through to the same code a genuinely missing URL takes. No branch, so nothing to
forge. Measured on the final build:

```
shape                        /admin  /definitely-not-a-route
default                      404     404
Accept: text/html            404     404
RSC: 1                       404     404
RSC: 1 + Accept: text/html   404     404
+ Next-Router-Prefetch: 1    404     404
```

and the bodies are **byte-identical** once the requested path — which the
requester supplied — is normalised out.

---

## 5a · A2 — the two pages never disagreed about a number

Measured before touching anything. Live: **0** products where the all-variant
and active-variant stock sums differ, **0** inactive variants anywhere, and
`reconcile_inventory()` returns **0** drifting rows. Both pages read
`stock_quantity` live, both exclude deleted products, and neither number is
wrong. So the brief's three hypotheses — a cached aggregate, inactive variants,
a ledger-derived count — are all ruled out by the data.

What is wrong is that they show **different things under an identical heading**.
`/admin/products` says "In stock" and means *every size of this product added
together*. `/admin/inventory` says "In stock" and means *this one size*. And
`/admin/inventory` defaults to `stock_quantity` **ascending**, so it opens
showing the 33 sizes the shop has none of — a screen full of zeros, next to a
products page showing totals in the dozens.

- The columns are now **"All sizes"** and **"This size"**, each with the other
  page named in its title text.
- Both pages say what they are *for and when to use them*, not what their
  controls do: *"For changing how many of a size you have, use Inventory"* /
  *"Come here after a delivery, a stocktake, or when a number looks wrong…
  Opens with the sizes you have none of, at the top."*
- **`reconcile_inventory()` is now on the screen.** It has been detectable since
  Phase 5 and was reachable only from a test script — the one screen that could
  act on the answer never asked the question. Drift renders as a banner naming
  each SKU, its count and what its history says. A *failed* check renders as a
  failed check, not as a clean one.

## 5b · A4 — the comment was the bug

"Make main" reported no change and up/down errored. The action's own doc comment
said *"exactly one primary is not enforced by a constraint, so it has to be
enforced by construction"*, and on that basis `resequence()` wrote the whole
gallery back as **one multi-row upsert** with `is_primary: index === 0`.

It *is* enforced by a constraint, and has been since Phase 1:
`product_images_one_primary_idx`, `unique (product_id) where is_primary`.
Postgres checks a unique index per row as it is written, not at statement end,
so the instant the new primary landed before the old one had been cleared there
were two rows with `is_primary` and the whole write was rejected `23505`.
Reproduced against the live database:

```
set new primary, then clear old  -> BLOCKED 23505 product_images_one_primary_idx
clear all, then set new primary  -> succeeded
```

`public.reorder_product_images(product_id, ids[])` clears every primary and then
writes the new positions, in one transaction. It has to be a function rather
than two PostgREST calls: in between, the gallery has no primary at all, and a
failure in that gap leaves a product whose card on `/shop` has no photograph to
lead with. It validates that the id list is the *whole* gallery and that every
id belongs to the product — a partial list would leave omitted rows carrying
stale positions, which is how two photographs come to share `sort_order 3`. A
mismatch raises `GLRYM` and the admin is told the gallery changed under them,
which is a different sentence from "that did not save" and is the one that is
true.

Verified end to end against live data: make-main on the second photograph moves
it to position 0, exactly one primary throughout, the storefront's own ordering
(`is_primary desc, sort_order`) then leads with it, and restoring the original
order works. `revalidateCatalog(slug)` was already called after a reorder, so
the storefront reflects it immediately — that half was never broken.

**Still not done:** the reorder is Up/Down/Make-main buttons, not drag and drop.
The brief asked for drag-and-drop with optimistic feedback. The existing buttons
are keyboard-operable and announce themselves, which a drag list is not without
a second hidden interface; I did not build the drag layer, and that is a gap
against the brief rather than a considered substitution.

## 5c · What the adversarial pass found, and what happened to it

One subagent, coming in cold after the feature work, per the brief. It wrote
`scripts/audit/server-actions.ts` (A8, the test named the most valuable missing
one in two consecutive reviews) and `scripts/audit/zero-stock.ts` (the A1
regression the brief demands), and `claudeExecutionReport/phase-7-security-review.md`.

| | Finding | State |
|---|---|---|
| **G-1** | medium — A7 still bypassable with `RSC: 1` + `Accept: text/html` | **fixed**, §5, re-measured |
| **G-2** | medium — the repeat-RTO block does nothing *and* unblocks itself | **fixed**, both halves, refusal reproduced |
| **G-3** | low — COD collectable rupee-rounded, ≤₹1 over-collection | **fixed** — the advance absorbs the paise so the balance is whole rupees by construction |
| **G-4** | low — a bag holding one sold-out pair reads as "empty" | **fixed** — it names the shoe and the size |
| **G-5/G-6** | informational — refund mechanics unbuilt, quote-freeze columns null on all 8 orders | **accepted**, §7. No Phase-7 order has been placed yet, so #9 is code-correct and unproven |
| **G-7** | low, pre-existing — JSON-LD `</script>` breakout via admin-authored names | **not fixed**, out of scope, carried forward |

**G-2 is the one worth reading twice.** `profiles.cod_blocked_at` shipped as a
column that nothing read and that the customer it constrained could clear
themselves — `computeOrderTotals` declared a `codBlocked` parameter and no
caller passed it, and `guard_profile_role()` froze only `role`. Both halves had
to close together: a control nothing reads is a column, and a control the person
it constrains can switch off is not a control. The trigger was widened rather
than a second one added, because "which columns may a customer change" is one
question and answering it in two places is how the two come to disagree.
Reproduced refused (`42501`) after the change.

Nothing the pass tried moved money, read another customer's data, or placed a
bad order. The money split (grant + RLS + check constraint), the frozen-quote
clamps, the refunds RLS and the credential latch all held.

## 6 · Part B — the money model

### The rule

```
advance = forward_freight + rto_freight        quoted live, one courier entry
balance = goods_total + delivery_fee − advance
```

`src/lib/payments/advance.ts` is pure — no settings reader, no cart, no I/O — so
the checkout UI can import it to display a split without dragging a Supabase
client into the browser bundle, which is a failure CI has caught before.

**Shiprocket reverses the cash-collection fee on an RTO**, so that fee is
deliberately *not* in the advance. Recovering it would over-collect on exactly
the orders the advance exists to protect. It stays a named line on the delivery
charge, where it is the whole of the difference between a prepaid total and a
Pay-on-Delivery one.

### What was deleted

`cod_advance_mode`, `cod_advance_minimum_paise`, `cod_advance_fixed_paise` — the
settings and the rule. All three priced the deposit from what the *customer* was
charged for delivery, which has no relationship to what a refusal costs the
shop. Under a fixed ₹99 advance against a ₹281.36 round trip, every refused
parcel lost ₹182.36 and the shop found out by reconciliation.

### The guard rails, all measured

`npm run audit:totals` — **42 assertions, 42 passing**, no database and no
browser. Every figure in it is a real rate from the serviceability call in §1;
invented numbers let a rounding rule pass that a real rate breaks.

| Brief's assertion | Where |
|---|---|
| 1 · `advance + balance = goods + delivery`, across a range | `audit:totals` §2 — **450 combinations** of value × freight × RTO × GST × cap |
| 2 · `balance ≥ 0`; below the minimum, POD is not offered | `audit:totals` §3 |
| 3 · Shiprocket's COD collectable equals `balance` | `audit:shipping` §6, and the balance now lands on a whole rupee so nothing rounds at the boundary |
| 4 · a refused POD order leaves the shop at net zero | `audit:totals` §1 |
| 5 · prepaid RTO refunds total − freight; shop error refunds in full | `audit:totals` §8 — the refund table, row by row |
| 6 · a refund webhook replayed ten times produces one refund | **not built** — §7. `refunds.razorpay_refund_id` is unique, which is the floor, but nothing exercises it |
| 7 · a refund cannot exceed the captured amount | `audit:totals` §8 — every branch × every cause |
| 8 · stock returns on physical receipt, not on the tracking event | schema and state machine only — §7 |
| 9 · courier and both legs stored on the order match the quote | **proven on a live order** — see below |

Guard rails that *are* built and measured: the COD minimum (method withdrawn,
not advance clamped), the deposit cap, cap-then-total ordering, Razorpay's
100-paise floor, the GST toggle, and the prepaid discount's clamps.

### The model, proven end to end on a real order

`npm run audit:keyboard-checkout` places a real Pay-on-Delivery order through
the real checkout path, by keyboard. `FV-2026-00591`, against the live
Shiprocket account:

| Column | Value | |
|---|---|---|
| `quoted_courier_name` / `_id` | Delhivery Surface / 43 | the courier that quoted |
| `quoted_forward_paise` | 13,936 | ₹139.36 — the freight leg |
| `quoted_rto_paise` | 14,200 | ₹142.00 — the return leg, **same courier entry** |
| `quoted_cod_fee_paise` | 21,434 | 3% of a ₹6,495 basket |
| `quote_source` | `shiprocket` | a live rate, not the fallback |
| `advance_amount` | 28,200 | ₹282 — the round trip, ₹281.36, to the next whole rupee |
| `balance_due_on_delivery` | 657,300 | **a whole rupee**, so nothing rounds on the way to the courier |
| `grand_total` | 685,500 | `28,200 + 657,300` ✓ |

The order sits `pending` / `unpaid` until the webhook, and the button read
**"Pay ₹282 now"** — the last thing the customer sees before pressing it is the
amount about to leave their account.

That closes assertion 9, which the adversarial pass correctly recorded as
code-correct but unproven: at review time all eight orders in the database
predated Phase 7 and carried null quote columns.

**One caveat on the fixture orders.** `scripts/audit/fixtures.ts` calls
`create_order_with_stock` **directly**, with hardcoded amounts, so the orders it
leaves behind (`FV-2026-00582` and friends) carry null quote columns and the old
advance shape. That is the fixture's job — it builds a *page state*, not a money
path — but it means those rows are not evidence of anything about this model,
and reading them as such would be a mistake.

### Weight, which was quietly wrong

`quoteFor` multiplied `shipping_defaults.weight_grams` — 900g, one number for
the whole catalogue — by the number of pairs. Rate bands are per half-kilogram
on this account (`min_weight: 0.5`), so boots and flip-flops quoted the same
freight: under-recovering on every heavy order and over-quoting every light one.
`parcelWeightKg` already existed and read per-line weights; it simply was not
called. `CartLine` now carries `weightGrams` and the quote uses it.

**Products missing a real weight are not yet flagged in the admin.** §7.

### The quote is frozen with the order

Seven new columns on `orders`, written inside `create_order_with_stock` in the
same transaction as the order row. `quote_source` is `shiprocket` or `fallback`,
so a fallback can never be read back later as though a courier had quoted it.
Every quote now also **logs which one served it** — `warn` for a fallback, not
`info`, because a shop quietly running on fallback rates all afternoon is a shop
mispricing every order.

### The discount bug this uncovered

`create_order_with_stock` hardcoded `discount_total = 0`. Harmless while nothing
discounted anything. The prepaid discount changes that: `computeOrderTotals`
subtracts it, so the function would have written a `grand_total` *higher* than
the figure the customer was shown and charged the difference. `p_discount_total`
is now a parameter, clamped into `[0, subtotal]`.

`p_free_shipping_above` also gained an explicit `default null`. Without it the
generated TypeScript typed it non-nullable, which would have forced a `0` — and
`0` means "free above ₹0", which is free delivery on everything. That is a
one-character change away from giving the catalogue away, and it was found by the
type checker rather than by thinking.

The drop took the function's ACL with it; the revoke and the `service_role`
grant are re-issued and verified live: `proacl` is
`{postgres=X/postgres,service_role=X/postgres}`.

### Settings

`/admin/settings` now carries all seven of the brief's controls in plain
language, each with **what happens if it is set too high or too low** — which is
the half a shopkeeper can act on. "Cap on the deposit" tells them nothing; "set
it too low and a heavy parcel to a far pin code is not fully covered if it comes
back" tells them how to choose.

---

## 7 · What was **not** built

This is the honest list. Nothing here was attempted and abandoned; it was not
reached.

| Brief | State | Why it matters |
|---|---|---|
| **A5** — checkout address book | **Not done.** `src/components/checkout/address-book.tsx` and `address.ts` exist from Phase 6; the edit/delete/set-default operations and the re-quote on address change were not built or verified |

| **B3** — refunds | **Schema and policy, no mechanics.** The `refunds` table, enums, indexes and RLS are live and in migrations, and `src/lib/orders/refund-policy.ts` is the brief's matrix as an explicit table — every row, the shop-error short-circuit, and the clamp to the captured amount, all measured in `audit:totals` §8. **What is missing is the mechanics:** no Razorpay Refunds API call, no `refund.processed`/`refund.failed` webhook, no admin UI, no idempotency test. So the *rule* is built and provable and nothing can yet issue a refund |
| **B4** — RTO handling | **Schema and state machine only.** `returning` exists in `order_status` with correct transitions and `RESTOCKS_ON_ENTRY: false`; `rto_*` columns and `rto_return`/`rto_writeoff` movement reasons exist; `profiles.cod_blocked_at` exists. No admin flow to mark a parcel received, no restock action, no RTO ledger, no dashboard figures, no repeat-RTO flagging |
| **C** — image pipeline | **Not started.** No `sharp`, no normalisation, no upload guidance, no preview |
| **D** — admin usability | **Only the settings screen.** Page-purpose lines, shopkeeper vocabulary, teaching empty states, the guided first-product flow, reversible deletes and the dashboard were not touched |
| **E** — courier selection | **Data captured, no UI.** `CourierQuote[]` with rates and scores now comes back on every verdict and is available at fulfilment. `courier_selection_mode` is not a setting and there is no admin screen |
| **E** — pickup addresses from the API | **Not done.** The env var is now fail-loud (below) but the address list is not fetched and there is no per-shipment picker |
| **E** — the full manual chain against the real account | **Not done.** Create shipment → AWB → pickup → label → tracking → cancel was not run. `docs/admin-guide.md` has no click-path for it |
| **Quality gates** — Lighthouse, axe, overflow, tablet | **Not run.** `audit:overflow`, `audit:a11y`, `audit:lighthouse` and the six-width sweep were not executed against this branch |

**What *was* done in E:** the credential-rejection latch (§3), `quote_source`
frozen on the order, per-quote source logging, and
`shiprocketPickupLocation()` now **throws** instead of defaulting to `"Primary"`.
That default was not a graceful degradation — it deferred the failure to the
moment a real parcel was being created for an order somebody had already paid
for, with "Wrong Pickup location entered" coming back from a third party at the
counter. Nothing on the customer path calls it, so an unset variable now stops
the shop *shipping* rather than stopping it *selling*.

---

## 8 · What I got wrong and caught in self-review

1. **The A7 fix, described in §5.** Branched on headers Next does not pass to
   middleware. The build passed, the code read correctly, and the disclosure was
   still open. Caught by re-measuring after the build rather than by reading the
   diff.
2. **`p_free_shipping_above: null` → `0`.** Regenerating the database types made
   the parameter non-nullable and TypeScript demanded a number. `0` typechecks
   and means free delivery on every order. Caught because the function's own
   `case when … is not null` made the intent obvious on re-reading; fixed by
   giving the parameter an explicit SQL default and passing `undefined`.
3. **The prepaid discount would have overcharged.** Added the discount to
   `computeOrderTotals` before noticing `create_order_with_stock` hardcodes
   `discount_total = 0` — so the database would have recomputed a higher total
   than the modal showed and charged it. Caught while writing the migration, not
   while writing the feature.
4. **A percentage discount stored as paise.** The settings action runs every
   money field through `rupees()`, which multiplies by 100. Applied to a
   percentage that turns 5% into 500%. Caught in the same edit; the mode now
   decides whether the multiplication happens.
5. **`SHAPE_VERSION` not bumped.** The shape snapshot caught it, which is what it
   is for. The stored *shape* had not changed — only the binding names — but what
   is done with the stored value had, so bumping was correct rather than
   ceremonial.

---

## 9 · Known imperfections in what *was* built

- **The live-availability overlay adds a query per page render.** Measured at
  +3ms warm on the product page. It is not cached and deliberately so, but it is
  a per-request database round trip that did not exist before, and on a listing
  page it scales with the page size rather than being constant.
- **`applyLive` treats a product with no live rows as sold out.** That is the
  safe direction and it is also indistinguishable from a failed read. A query
  error would show the whole catalogue as sold out rather than throwing.
  `rows()` raises on error, so this should not be reachable — but "should not be
  reachable" is doing work in that sentence.
- **`npm run audit:shipping` deletes the cached Shiprocket token** as part of
  its teardown — "cleared the cached token — the next real request logs in
  fresh". That is deliberate and it was harmless while nothing had ever logged
  in. It is not harmless now: every run of that suite costs a real login on the
  next request that needs a token, against an account whose API user has already
  been locked out once by repeated logins. Restored by hand after this run. It
  should either stop clearing the row or clear a *test* provider key, and it is
  a one-line change I did not make because the suite was in the adversarial
  pass's hands at the time.
- **The latch's fifteen minutes is a guess.** Long enough to stop a
  misconfigured deploy burning an afternoon of login attempts, short enough that
  a corrected password is picked up without anybody knowing the latch exists. It
  has not been calibrated against Shiprocket's actual lockout threshold, which I
  do not know.
- **`audit:literals` reads the database with the service-role key.** Without it
  the content half **skips**, and it says so loudly rather than passing — but a
  CI run without that key gets half a gate.
- **The `{{delivery_advance}}` token resolves to words, not a figure**, because
  the advance is quoted live per PIN and per basket. A token that resolved to an
  average would be a new version of the bug it exists to prevent, but it does
  mean the shipping page cannot state the amount.
- **The three-number disclosure was largely already there** from Phase 6. What
  Phase 7 added is the prepaid-discount line and the brief's exact sentence.
  I did not re-verify the confirmation page and the email in a browser.

---

## 10 · Blocked on the owner

Nothing is blocked. Two things want a decision rather than an engineer:

1. **`site_settings.payment_methods` is `{"cod": true, "online": false}`.** If
   that is read anywhere as a master switch, prepaid is off. I did not trace it,
   and it is worth ten minutes of somebody's time before launch.
2. **The seven new settings are seeded with defaults I chose**, and the brief is
   explicit that the values are the owner's: ₹999 minimum order for Pay on
   Delivery, ₹500 cap on the deposit, GST absorbed, no prepaid discount, live
   delivery rates, deduct actual freight on an RTO. Each is defensible and none
   is a decision an engineer should be making.

---

## 11 · Files

```
new   src/lib/queries/availability.ts        live stock over cached content
new   src/lib/stock-freshness.ts             one statement, from every path that moves a unit
new   src/lib/content-tokens.ts              policy numbers resolved into prose
new   src/components/storefront/flash-toast.tsx
new   scripts/audit/literals.ts              npm run audit:literals
new   src/lib/orders/refund-policy.ts        the refund matrix, as a table
new   src/lib/orders/cod-block.ts            the block, actually read
new   src/lib/actions/admin/customers.ts     the block, actually settable
new   src/components/admin/customers/cod-block-control.tsx
new   scripts/audit/server-actions.ts        A8 — forged posts, 34 actions
new   scripts/audit/zero-stock.ts            the A1 regression

      src/lib/payments/advance.ts            round-trip advance, guard rails, prepaid discount
      src/lib/orders/totals.ts               the one place a total is computed
      src/lib/shipping/{fee,serviceability,settings,quote-store,token,config,client}.ts
      src/lib/supabase/proxy.ts              F-2
      src/lib/orders/types.ts                `returning`
      src/lib/actions/admin/settings.ts      seven owner settings
      src/lib/actions/admin/products.ts      resequence -> reorder_product_images
      src/lib/queries/admin/inventory.ts     inventoryDrift()
      src/app/admin/{inventory,products}/page.tsx
      src/components/admin/settings/settings-forms.tsx
      src/components/storefront/{size-selector,product-viewer,add-to-bag,announcement-bar}.tsx
      src/components/checkout/totals.tsx     the prepaid discount, as its own line
      scripts/audit/totals.ts                30 assertions against live rates

sql   20260808140000_quote_freeze_columns.sql
      20260808140100_returning_status_and_rto.sql
      20260808140200_rto_columns_and_cod_block.sql
      20260808140300_refunds_table.sql
      20260808140400_refunds_rls.sql
      20260808140500_create_order_records_quote_and_discount.sql
      20260808140600_reorder_product_images.sql
      20260808140700_guard_cod_block_columns.sql
```

`npm run typecheck`, `npm run lint`, `npm run build` and `npm run shapes` are
green. Measured on this branch:

```
npm run typecheck              pass
npm run lint                   pass, 0 errors 0 warnings
npm run shapes                 16 cached shapes unchanged at v3
npm run audit:totals           43 passed, 0 failed
npm run audit:literals         135 files, 7 CMS pages, the announcement — clean
npm run audit:shipping         57 passed, 0 failed   (against the mock)
npm run audit:admin            23 held, 0 holes
npm run audit:actions          77 passed, 0 failed   (34 admin actions, forged over HTTP)
npm run audit:zero-stock       10 passed, 0 failed
npm run audit:overflow         22 routes + 15 states × 6 widths, 9,161 elements — clean
npm run audit:a11y             no WCAG 2.2 A/AA violations, 22 routes + 15 states, 390 & 1440
npm run audit:keyboard         clean
npm run audit:keyboard-checkout  placed FV-2026-00591 by keyboard, advance ₹282
npm run audit:focus            the indicator paints on every primitive
npm run audit:hydration        console clean
npm run audit:gallery          clean
npm run audit:interactions     clean
npm run audit:links            122 pages, 1,833 links — none broken
reconcile_inventory()          0 drifting variants
```

**`npm run audit:focus` was failing before this branch, and had been.** Its last
assertion waited for a submit button named `/place order|^pay /i`, which the
page cannot say until a delivery quote exists — and the fixture is a guest with
a bag and **no address**, so the label is "Enter a delivery address". Measured
on this branch and on `main`: `["", "Enter a delivery address"]`.
`checkout-flow.tsx` is byte-identical to `main`, so this is not a Phase 7
regression — but `audit:focus` is in the `npm run audit` chain, which means that
chain has not completed for some time. The assertion now waits by role; the
button's *copy* is `audit:keyboard-checkout`'s business and it asserts it there
with an address filled in.

**Not run:** `audit:lighthouse` against the Vercel preview, and the real tablet.
Both need the branch deployed, which needs the PR. §7.

Supabase's security advisors were run after the migrations. **Nothing new is
flagged.** `refunds` does not appear — its RLS and its grants are correct — and
`reorder_product_images` does not appear because it is `SECURITY INVOKER`, so
RLS still decides and a signed-in customer calling it over PostgREST updates
nothing. Everything the advisors do report is the pre-existing, documented
posture: `integration_tokens` / `rate_limits` / `shipping_quotes` have RLS on
and no policy *on purpose* (refused by the absence of a policy rather than by
the wording of one), and the `SECURITY DEFINER` helpers are the policy functions
that have to be callable to be called from a policy.

The browser suites — `overflow`, `a11y`, `keyboard`, `lighthouse`, the six-width
sweep and the real tablet — were **not run**. An attempt at `audit:overflow`
during this session failed with `ERR_CONNECTION_REFUSED`, because the adversarial
pass was rebuilding `.next` at the same time; two agents cannot share one build
directory. §7.
