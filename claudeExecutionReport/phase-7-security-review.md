# Phase 7 — adversarial pass

Written after the feature work, against what this phase actually added — the
round-trip advance, the frozen quote, the refund policy, the credential latch,
the A1 and A7 fixes — rather than against the code as anyone remembers writing
it. Read-only on feature code; everything below was reproduced against the live
Supabase project and a real Next production build (`npm run build`, then
`next start -p 3901`) at branch `feat/phase-7-correctness-money-model`, commit
`c79dde1`. The branch moved forward twice while this pass ran; every result
below is against the final build of `c79dde1`, rebuilt after the last commit
landed.

Two new regression suites were written and committed with this review:

- **`npm run audit:actions`** (`scripts/audit/server-actions.ts`) — the forged
  Server Action test named the most valuable missing test in **two** prior
  reviews (Phase 5 §6.1, Phase 6 §6.1) and absent both times. **75 checks,
  75 pass.**
- **`npm run audit:zero-stock`** (`scripts/audit/zero-stock.ts`) — the A1
  regression the brief demands by name: a zero-stock variant ordered through the
  real checkout path, refused. **10 checks, 10 pass.**

The headline: **A7 is still not fixed.** It has now survived three consecutive
security reviews. The Phase 7 attempt closed two of the three shapes that leak
and opened the fix on a heuristic a hand-crafted request walks straight through.

---

## Findings

| # | Severity | Finding | Reproduced |
|---|---|---|---|
| **G-1** | **medium** | `/admin` still answers **200** where a missing route answers **404**, for a flight request that also sends `Accept: text/html`. Same F-2 existence oracle, third review running. | yes — one curl |
| **G-2** | **medium** | The per-customer Pay-on-Delivery block (the repeat-RTO control) does nothing: `profiles.cod_blocked_at` is read by no code and written by no admin path — and the column is customer-self-writable, so even once wired a blocked customer clears it themselves. | yes — end to end |
| **G-3** | low | Shiprocket is told a COD collectable rounded to whole rupees, so the courier collects up to ₹1 more than the stated balance. | yes — by inspection + arithmetic |
| **G-4** | low | When the **only** line in a bag sells out between add-to-bag and checkout, the customer is told "your bag is empty", not which item went. Mixed bags name it correctly. | yes |
| **G-5** | informational | The refund **mechanics** are unbuilt — `refundFor` is called nowhere, no Razorpay Refunds call, no `refund.processed`/`refund.failed` webhook, no row is ever inserted. Money-model assertions #6 and #7 are untestable at runtime. | yes — grep + build |
| **G-6** | informational | Assertion #9 (courier and both freight legs stored on the order match the quote) is unproven on live data: every one of the 8 orders has null quote-freeze columns. No real Phase-7 order has been placed. | yes — DB count |
| **G-7** | low / out-of-scope | Product and breadcrumb JSON-LD is injected with `dangerouslySetInnerHTML` over `JSON.stringify`, so an admin-authored name containing `</script>` breaks out. Pre-Phase-7, admin-only input. | by inspection |

No finding is a path for an anonymous or customer attacker to move money, read
another customer's data, or place an order they should not. G-1 discloses a
route's existence; G-2 is a control that silently fails to save the shop money.
Both matter and neither is a breach. The money split, the frozen quote, the
function grants, the refund arithmetic and the credential latch all held under
everything thrown at them — see "What held".

---

### G-1 · medium · `/admin` is still a 200-vs-404 oracle on the flight path

**Carried unfixed from Phase 5 and Phase 6 as F-2.** The brief (A7) is explicit:
*"a genuinely missing path returns 404 … Fix it, and assert the status code, not
the rendered body."* The Phase 7 fix (`src/lib/supabase/proxy.ts`, `notFound`
→ `wantsDocument`) reserves the styled 404 rewrite for requests whose `Accept`
header contains `text/html`, and returns a bare 404 to everything else. Its own
verification table records `/admin` and a missing route both answering 404 for a
document, an `RSC: 1` request, and a `?_rsc=` request.

That table does not test the one combination that matters: **a flight request
that also asks for `text/html`.** A flight request (`RSC: 1`) makes Next serve a
component response; `Accept: text/html` makes the proxy take the *rewrite*
branch rather than the bare-404 branch; and the rewrite to `/_not-found`, served
as flight, comes back **200**.

**Reproduction**, against the production build:

```
$ curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3901/admin \
    -H 'RSC: 1' -H 'Accept: text/html'
200
$ curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3901/definitely-not-a-route \
    -H 'RSC: 1' -H 'Accept: text/html'
404
```

The full matrix, so the boundary is unambiguous:

```
shape                                     /admin   /missing
document (Accept: text/html)              404      404      ok
RSC:1  (default Accept: */*)              404      404      ok
?_rsc=x + Accept: */*                     404      404      ok
RSC:1  + Accept: text/html               200      404      <-- LEAK
RSC:1  + Next-Router-Prefetch:1 + html   200      404      <-- LEAK
```

The 200 carries `x-middleware-rewrite: /_not-found` and a `text/x-component`
body; the 404 does not. An attacker enumerating `/admin/*` reads
`fetch('/admin',{headers:{RSC:'1',Accept:'text/html'}}).then(r=>r.status)` — 200
means the route exists, 404 means it never did. That is precisely the bit the
guard was written to withhold.

**Why the fix missed it.** The comment argues `Accept: text/html` is a reliable
"is this a document" signal because "a browser navigation always asks for
text/html" and "a flight fetch … gets the bare 404". Both halves are true of the
*framework's own* client — `fetchServerResponse` in
`node_modules/next/dist/client/.../fetch-server-response.js` sets `RSC: 1` and no
`Accept`, so the real router never trips this. But the guard is defending
against a *hand-crafted* request, and nothing stops one carrying both headers.
The discriminator is attacker-controlled.

**Not caught by the suite.** `audit:auth` §5 asserts `/admin` is 404 for an
anonymous visitor, but with a default `fetch` (`Accept: */*`), which is one of
the shapes that *does* answer 404. The leaking shape is untested.

**Fix direction** (feature side, not mine to write): the branch cannot be
decided on a request header the client controls. Either drop the styled-rewrite
branch entirely and always return a bare 404 for a blocked `/admin` (a flight
non-OK already triggers a full-navigation fallback that renders the styled page,
so the UX is preserved), or key the "document" decision on `request.method` +
the absence of `RSC` rather than on `Accept`. Then extend `audit:auth` §5 to
assert the pair `(admin, missing)` across all five shapes above.

---

### G-2 · medium · The repeat-RTO Pay-on-Delivery block does nothing, and unblocks itself

The brief adds this control deliberately: *"flag phone numbers or emails with
more than one refusal, and let the owner disable Pay-on-Delivery for a specific
customer. The tail is where losses concentrate."* Migration
`20260808140200_rto_columns_and_cod_block.sql` adds `profiles.cod_blocked_at`
and `cod_blocked_reason`, and `computeOrderTotals` grew a `codBlocked` parameter
that withholds COD when true. That is the whole of it. **Two gaps, each fatal on
its own:**

**(a) It is wired on neither side.** `computeOrderTotals` is called from exactly
two places — `src/lib/actions/checkout.ts:191` and
`src/lib/actions/shipping-quote.ts:92` — and **neither passes `codBlocked`**.
Nothing anywhere reads `profiles.cod_blocked_at`; nothing anywhere writes it
(no admin action, no admin UI). Grep for the column outside the generated types
returns two lines, both the unused parameter in `totals.ts`:

```
src/lib/orders/totals.ts:64:  codBlocked?: boolean;
src/lib/orders/totals.ts:161:    !settings.codEnabled || input.codBlocked
```

So an owner who "disables Pay on Delivery" for a repeat-refuser changes nothing:
the customer is still offered COD at checkout, and keeps refusing parcels the
shop pays both legs on. The mechanism is a column and an unused argument.

**(b) Even once wired, the customer clears it themselves.** `profiles` carries a
`customers update their own profile` RLS policy (`id = auth.uid()` in both
`USING` and `WITH CHECK`), and the `guard_profile_role` trigger guards only the
`role` column — nothing guards `cod_blocked_at`. A signed-in customer can PATCH
their own profile over PostgREST and lift the block:

```
owner blocks (service role):  cod_blocked_at = 2026-08-08T13:16:23Z, reason "two RTOs"
customer PATCH /rest/v1/profiles?id=eq.<self>  {"cod_blocked_at":null}  -> 200
after (service view):         cod_blocked_at = null
>>> the customer cleared their own COD block
```

The same request attempting `role = 'admin'` is refused 403 by the trigger — so
the RLS write path is real, it just does not defend the new column. Reproduced
end to end; the role-escalation control alongside it confirms the PATCH channel
is live.

**Fix direction.** Wire `codBlocked` from both callers
(`profiles.cod_blocked_at is not null` for the signed-in user), add the admin
setter, and either move `cod_blocked_at` out of the customer-writable column set
(a trigger like `guard_profile_role`, or a column-scoped policy) or set it only
through a `service_role` RPC. (a) and (b) must land together: fixing enforcement
without fixing the RLS gap ships a block the customer switches off.

---

### G-3 · low · The courier is told a rupee-rounded collectable

`src/lib/shipping/fulfilment.ts` sends `sub_total = Math.round(balance / 100)`
to Shiprocket for a COD parcel — Shiprocket's API speaks whole rupees, and this
is the boundary where paise stop. A ₹916.80 balance is sent as ₹917. The stored
`shipments.cod_collectable_amount` keeps the exact paise (91680), so assertion
#3 ("COD collectable equals `balance`, not the total") holds to the rupee and is
asserted green in `audit:shipping` §6 — but the courier physically collects up
to ₹1 more than the balance the customer was shown. Inherent to the rupee API,
worth one line in the report rather than a fix; if it is ever fixed, `floor`
rather than `round` errs toward the customer.

---

### G-4 · low · A sole sold-out line reads as "empty bag", not "this sold out"

The brief (A1): *"If stock runs out between add-to-bag and checkout, the customer
is told exactly which item and size, with the rest of the bag intact."*
`getCart()` (`src/lib/queries/cart.ts`) moves a now-zero-stock line into
`adjustments` (kind `gone`) and drops it from `lines`. For a **mixed** bag this
is correct and the refusal names the item: the sold-out line is still a
`cart_items` row, so `create_order_with_stock` sees it and raises `OSTCK` naming
it — proven in `audit:zero-stock` §1. But when the sold-out line is the **only**
line, `lines` is empty and `placeOrder` returns `empty_cart` ("Your bag is
empty") before it reaches the stock guard. No oversell, no wrong charge — the
customer is refused either way — but the message is the wrong one, and the
checkout page's own `adjustments` banner ("… is no longer available") is the
honest surface here rather than the action's reason.

---

### G-5 · informational · The refund mechanics are unbuilt

`src/lib/orders/refund-policy.ts` (`refundFor`) is a clean, exhaustively-tested
pure function — `audit:totals` §8 exercises every row of the brief's table,
including the clamp to captured and the shop-error short-circuit, 42/42 green.
The `refunds` table and its RLS exist and are correct (see "What held"). But the
*mechanics* named in the brief are absent: `refundFor` is imported by nothing,
no code calls the Razorpay Refunds API, there is no `refund.processed` or
`refund.failed` webhook branch, and nothing ever inserts a `refunds` row. The
commit message says as much ("the refund rule is built and provable; the
mechanics are not"). Consequences for the brief's assertions:

- **#6 (a refund webhook replayed ten times produces one refund)** — untestable;
  there is no refund webhook. The `razorpay_refund_id unique` constraint is the
  only idempotency piece present.
- **#7 (a refund cannot exceed the captured amount)** — enforced *inside*
  `refundFor` (the `clamp`), but there is no runtime guard against the *sum* of
  several partial refunds exceeding the capture, because there is no runtime
  refund at all.

Deferred, not broken — but the money-model is not closed until this ships, and a
reviewer signing off on "refunds" would be signing off on a table and a
calculator.

---

### G-6 · informational · Assertion #9 is unproven on live data

Every one of the 8 orders in the database has `quote_source`,
`quoted_forward_paise`, `quoted_rto_paise` and `quoted_courier_id` **null**:

```
orders_total=8  with_quote_source=0  with_forward=0  with_rto=0  with_courier_id=0
```

`create_order_with_stock` writes those columns from the frozen quote, and
`checkout.ts` passes them, so the *code* freezes the quote — but no order has
ever exercised it, which is consistent with the preflight reality that no real
Pay-on-Delivery advance has been captured and no live Shiprocket rate has
reached an order. Assertion #9 ("courier and both freight legs stored on the
order match what was quoted") is therefore verified only in the unit arithmetic
(`audit:totals`) and the mock (`audit:shipping`), never end to end. `audit:totals`
says so itself in its closing note.

---

### G-7 · low · JSON-LD `</script>` breakout (pre-existing, out of scope)

`src/app/(storefront)/product/[slug]/page.tsx:136` and
`src/components/storefront/breadcrumbs.tsx:37` render structured data with
`dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}`. `JSON.stringify`
escapes quotes but not `<` or `/`, so a product name containing
`</script><script>…` breaks out of the tag. The input is admin-authored (only an
admin creates products) and this predates Phase 7, so it is noted rather than
rated against this phase. The `page/[slug]` CMS body, by contrast, is rendered
as text paragraphs (§ content-tokens below), so it does not share the flaw.

---

## What held — every Phase 7 attack surface, item by item

**Forged Server Action posts (Task 1 · A8).** `audit:actions`, 75 checks, all
pass. It parses the 40-hex action ids out of `.next/static/chunks`
(`createServerReference("<id>",…,"<name>")`), keeps the 34 whose export name is
an admin action, reads each one's owning `/admin` route from
`server-reference-manifest.json`, and posts a forged fetch-action payload —
`Next-Action: <id>`, `text/plain` body `[{}]` — over HTTP as (a) a plain
signed-in customer and (b) no session. **Every one refuses.** The negative is
proven properly: driven with a real **admin** session, the same machinery elicits
a *successful* shape (`loadMovements` returns `ok:true`; an invalid payload
returns `reason:"invalid"` from *inside* the work function, i.e. past the
`is_admin()` gate) — so a customer's refusal means "the guard held", not "the
request never arrived". Anatomy of the defence, confirmed against the emitted
runtime:

- A customer or anonymous POST to any `/admin/*` route is **404'd by the proxy**
  before the action runs — the admin actions are registered only on `/admin`
  workers.
- Posting an admin id to a customer-reachable route (`/`) makes Next *forward*
  it to the `/admin` worker via an internal fetch, which re-enters the proxy and
  is 404'd; the outer handler returns `{}`. No write. Tested for both identities.
- The `adminAction` wrapper (`src/lib/admin/guard.ts`) re-checks `is_admin()`
  against the database before any work runs, so the guard holds even if the
  proxy is bypassed — which the admin positive control proves is the layer an
  admin passes *through*.
- No order was mutated by any of the 68 forged posts (asserted).

**Aiming the new `create_order_with_stock` params from PostgREST (Task 2).** A
real signed-in customer calling the RPC with `p_advance_amount: 1`,
`p_discount_total: 999999999`, chosen `p_quoted_*` and `p_quote_source` is
refused `42501` — the function is `service_role` only, the grant re-issued in
the same migration that drops and recreates it. The clamps behind that grant are
sound anyway: `p_discount_total` is clamped to `[0, subtotal]`, the COD fee to
`[0, shipping]`, the advance to `[0, total]`, and the balance is *derived*
(`total − advance`) rather than accepted, so the check constraint
`advance + balance = grand_total` cannot be broken from outside.

**The `refunds` table and its RLS (Task 2).** A customer `SELECT` returns `[]`
(the `admins read refunds` policy yields nothing to a non-admin); a customer
`INSERT` is refused `42501` (insert/update/delete revoked from `authenticated`).
`anon` is revoked entirely. The advisor confirms the table has a policy — it is
not in the `rls_enabled_no_policy` list.

**The credential-rejection latch (`src/lib/shipping/token.ts`, Task 2).** The
latch row lives in `integration_tokens`, which has RLS enabled, **no policy**,
and `EXECUTE`/table grants revoked from `anon` and `authenticated`. A customer
cannot read the cached token or the latch (`42501`), cannot write a latch row to
take shipping down (`42501`), and cannot delete the token to force a re-login
(`42501`). The latch can only be set by a real `403/400` from Shiprocket's
`/auth/login`, which is reached only with the env credentials — nothing an
attacker supplies flows into it — so it cannot be tripped remotely. A `403`
lockout message (which names the admin remediation path) is thrown server-side
and, on the customer quote path, is swallowed into a generic "We could not check
delivery just now" (`shipping-quote.ts` catch), so it does not leak. The design
choice that a *valid cached token keeps working through a lockout* is correct and
means a bad password cannot strand a shop whose token is still good.

**A1 — zero stock through the real checkout path (Task 2).** `audit:zero-stock`,
10 checks, all pass. It drives the real `placeOrder` Server Action over HTTP with
a guest's own `fv_guest` cookie: a bag holding an in-stock line plus one that
**sells out after add-to-bag** is refused with `out_of_stock`, the sold-out item
named, no order row written, stock never negative. Behind it: the RPC raises
`OSTCK` on the same cart; a forced `stock_quantity = -1` is rejected by
`CHECK (stock_quantity >= 0)` (`23514`); and a positive control (restock →
places cleanly → cancel-restock) proves the refusal is stock-specific, leaving
the catalog and the ledger exactly as found.

**A7 RSC parity (Task 2).** Two of three shapes now match — see G-1 for the one
that does not.

**Content-token substitution (`src/lib/content-tokens.ts`, Task 2).** No
injection and no disclosure path. `fillTokens` matches only
`{{[a-z0-9_]+}}` and substitutes from a **closed** map of four tokens, each
resolving to a `formatPaise` string or a fixed phrase — all public policy
numbers, no secret and no way to name an arbitrary setting; an unknown token is
left visible rather than blanked. The two render sites (`page/[slug]`, the
announcement bar) emit the result as **text**, not `dangerouslySetInnerHTML`, so
even the admin-authored prose around a token cannot inject script.

**Self-promotion, ledger integrity, advisor.** A customer still cannot write
`profiles.role` (`guard_profile_role`, `42501`). `reconcile_inventory()` returns
zero drift after this pass (the transient `unspecified` rows this review's own
direct stock edits created were swept — `audit:zero-stock` now cleans them in a
`finally`, and `audit:admin` is 23/23). The security advisor flags nothing new
for Phase 7: `refunds` is policied; `integration_tokens`/`shipping_quotes` are
deny-by-default by design; the `anon`/`authenticated`-executable
`SECURITY DEFINER` set is unchanged from the list Phase 5 §E-7 cleared.

---

## Quality gates — actual numbers

| Gate | Result |
|---|---|
| `npm run typecheck` | **pass** (0 errors) |
| `npm run lint` | **pass** (0 errors, 0 warnings) |
| `npm run shapes` | **pass** — 16 cached shapes unchanged at v3 |
| `npm run audit:literals` | **pass** — 136 component files, 7 CMS pages, announcement strip; no rupee literal |
| `npm run audit:totals` | **42 / 42** |
| `npm run audit:shipping` | **57 / 57** (Shiprocket mock; the mock still works) |
| `npm run audit:admin` | **23 / 23** |
| `npm run audit:actions` *(new)* | **75 / 75** |
| `npm run audit:zero-stock` *(new)* | **10 / 10** |

**Money-model assertions the brief lists as not covered by `audit:totals`:**

- **#3 (Shiprocket's COD collectable equals `balance`)** — **held.**
  `audit:shipping` §6 asserts the sent `sub_total` and stored
  `cod_collectable_amount` are the balance and are neither `grand_total` nor the
  goods subtotal, against a fixture built so all three differ.
  `fulfilment.ts:203`/`:252` derive both from `balanceDueOnDelivery`. Caveat
  G-3: the sent figure is rupee-rounded.
- **#9 (courier and both freight legs stored on the order match the quote)** —
  **code-correct, unproven on live data** (G-6). The freeze path is written and
  the arithmetic is covered by `audit:totals`/`audit:shipping`, but no order in
  the database has non-null quote-freeze columns, so it has never run for real.

---

## What this pass could NOT reach

Stated plainly, because a review that lists only what it checked is half a
review.

1. **No live Pay-on-Delivery advance has ever been captured, and no live
   Shiprocket rate has ever reached an order.** Every `audit:shipping` result is
   against the mock; every order in the database has null quote-freeze columns.
   The round-trip advance, the frozen quote and the balance-as-COD-collectable
   are proven in unit tests and the mock, and are internally consistent, but the
   end-to-end path from a real Shiprocket serviceability response to a stored,
   frozen order quote to a courier collecting the balance has not been
   exercised once. This is the single largest residual risk and it is a
   preflight fact, not a code defect.

2. **The refund path does not exist to be attacked** (G-5). Idempotency under
   webhook replay (#6) and the over-refund guard across multiple partials (#7)
   are untested because there is nothing to test yet.

3. **The Razorpay webhook was not re-attacked.** Phase 5 covered signature
   verification and idempotency; nothing in Phase 7 changed that route. A forged
   short capture against a Pay-on-Delivery order — now a more interesting attack,
   since a capture is *supposed* to be short — is unit-reasoned in
   `architecture.md` (compare against `advance_amount`, not `grand_total`) but
   was not driven end to end this pass.

4. **The image pipeline (Part C) and storage uploads were not attacked.** The
   signed-upload-slot action refuses a non-admin (`audit:actions`), but the
   `sharp` normalisation path, EXIF stripping and the upload URL's own scope
   were not adversarially tested.

5. **G-1 was found but not fixed here** — this pass does not write feature code.
   The reproduction and fix direction are above; the assertion to add to
   `audit:auth` §5 is named.

---

## Verdict

The money model itself is well defended: the split is enforced at the grant on
the function that writes it, the RLS on the columns, and a check constraint that
rejects an inconsistent pair — three layers that would each have to fail
independently, and none did. The forged-Server-Action gap that two reviews
called the most valuable missing test is now closed, green, and proven able to
tell a refusal from a request that never arrived. A1 is fixed and has a
regression that drives the real checkout path.

Against that, **A7 is still open** (G-1) — the same existence oracle, third
review, now behind a header heuristic an attacker sets for free — and the
**repeat-RTO COD block is a control that does nothing and unblocks itself**
(G-2), which is exactly the loss-concentrating tail the brief built it for. Both
are the shop's money and reputation rather than a customer breach, and both have
a short, specific fix. The refund mechanics and the whole live-Shiprocket path
remain unproven because they have never run, which is the honest state of the
phase, not a thing this review can close.
