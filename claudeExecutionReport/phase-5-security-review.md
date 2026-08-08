# Phase 5 — adversarial security review

**Agent E.** Branch `feat/phase-5-checkout-payments`. Reviewed at commit `608b122` + the
uncommitted Phase 5 working tree (Agents B, C and D landed; A still editing UI).

Read-only on feature code. Everything below was reproduced against the live Supabase project
and against a real Next production server (`next start -p 3491`, built from `npm run build`)
with `RAZORPAY_WEBHOOK_SECRET` set to a sentinel value in the process environment only —
never written to `.env.local`.

Regression suite: **`scripts/audit/security-checkout.ts`**, wired as `npm run audit:security`.
121 checks: **117 pass, 4 fail, 0 skipped** — one failure per reproducible finding, and each
turns green when that finding is fixed. It sweeps everything it creates and proves the sweep with
a count query. A check that cannot run prints `SKIP` and still fails the suite, so "I could not
test this" can never read as a pass.

```
RAZORPAY_WEBHOOK_SECRET=<value the server was started with> \
FV_BASE_URL=http://localhost:3491 \
npm run audit:security
```

---

## Findings

| # | Severity | Finding | Reproduced |
|---|---|---|---|
| **E-1** | **high** | Any anonymous visitor can take every unit in the shop out of stock, for free, by starting a Razorpay checkout and closing the tab. Nothing ever gives the units back. | yes — and five of Agent D's abandoned test orders were holding five units when I looked |
| **E-2** | **medium** | Lost update: a capture landing while an order is being cancelled produces a **confirmed, paid order whose stock has already been returned to the catalog**, via the illegal transition `cancelled → confirmed`. | yes — deterministically, at a 200–225 ms offset |
| **E-3** | **medium** | A guest who accepts the confirmation page's own invitation to create an account **permanently loses access to the order they just paid for**. | yes — end to end, `/order/<number>` returns 404 afterwards |
| **E-4** | **low** | The webhook's currency guard checks the payment entity's currency but takes the amount from the order entity, so an `order.paid` naming a non-INR order settles at INR parity — the exact confusion the guard was written to stop. | yes — order confirmed from a `USD` payload |
| **E-5** | **low** | Two distinct idempotency keys describe one capture (`payment.captured:pay_X` and `order.paid:order_Y`). Delivered concurrently, both confirm, and the customer's timeline shows "Confirmed" twice. | yes |
| **E-6** | **informational** | With `RAZORPAY_WEBHOOK_SECRET` unset — the current production state — every online payment whose browser callback does not return leaves a paid customer on a `pending` order, with no reconciliation path. | by inspection + config |
| **E-7** | **informational** | Five `SECURITY DEFINER` functions are executable by `anon`. All five are correct as written; recording the reasoning so the Supabase advisor warning is not re-litigated every phase. | verified against `pg_proc` and the advisor |
| **E-8** | **informational** | `abandonUnpaidOrder` is exported from a `"use server"` module but reaches no client, so Turbopack never registered it. It is dead today and its safety has never been exercised. | verified against `server-reference-manifest.json` |

**No high finding is exploitable for money or data.** E-1 is a denial of inventory, not a
theft. Every attempt to pay less than the price, to read another customer's order, to forge a
webhook, or to write to a money table was refused. Details under "What held" below.

---

### E-1 · high · Anyone can empty the shop's stock for free, anonymously

**What happens.** `create_order_with_stock` decrements stock in the same transaction as the
order write, so a `pending` Razorpay order is already holding its units. `applyPaymentOutcome`
deliberately does not cancel on `payment.failed` (correct — Razorpay lets the customer retry in
the same modal). Nothing else ever cancels a stale order: there is no `pg_cron` extension
installed, no `vercel.json` cron, no scheduled route, and no sweep function anywhere in
`supabase/migrations/**` or `src/lib/**`.

**Reproduction.** No account, no payment method, no cost.

1. As a guest, add the last unit of anything to the bag.
2. Check out with **Pay online**. The order row is written, stock is decremented, the cart is
   converted, `orders.status = 'pending'`.
3. Close the tab. Never open the Razorpay modal.
4. Repeat with a fresh browser profile (a new `fv_guest` cookie) for the next item.

`scripts/audit/security-checkout.ts` §15 does exactly this, backdates `placed_at` by six hours
so no plausible cutoff could still be protecting it, and asks for a release mechanism:

```
FAIL  a six-hour-old unpaid order gives its unit back to the catalog
      — no release mechanism exists (HTTP 404 from rpc/release_abandoned_orders)
        — the unit is still held, 7 -> 6
```

**It is already happening by accident.** While I was working, five of Agent D's Razorpay test
orders (`FV-2026-00021` … `FV-2026-00025`, placed 19:47–19:53) were sitting `pending`/`unpaid`
and holding five units, twenty-five minutes later, with nothing scheduled to release them.
That is the bug demonstrating itself without an attacker.

**Consequence.** Stock. A shop with a few hundred units can be shown as sold out in a couple of
minutes by one person with a script, at zero cost and with no identity to ban. Every genuine
customer then sees "Sold out" on every product. Recovery is manual: somebody has to find the
stale orders and cancel each one.

**Agent B declared this** in `src/lib/orders/payment-state.ts:56-59` ("abandoned `pending`
orders hold their stock until something cancels them — see the note in the report about the
sweep this phase does not ship"). Declared is not mitigated. I am rating it on reachability and
consequence, not on whether it was a surprise.

**Suggested fix** (Agent B). A `release_abandoned_orders(p_older_than_minutes int)` function
that, for every order with `status = 'pending' and payment_status = 'unpaid'` older than the
cutoff and with no `payments` row in `('pending','captured','refunded')`, calls the existing
`cancel_order_with_restock(..., p_require_unpaid => true)`. `service_role` only, same grants as
its neighbours. Then either a `pg_cron` job every ten minutes or a Vercel cron route hitting an
authenticated endpoint. Thirty minutes is a reasonable cutoff — long enough for a slow UPI
collect, short enough that the attack costs the attacker a sustained loop rather than one pass.
The regression test in §15 turns green the moment the RPC exists and restocks; rename it freely
and change the one line that calls it.

A cheaper partial mitigation, if the sweep slips: cap concurrent `pending` unpaid orders per
guest token, which raises the cost of the loop without fixing the leak. Not a substitute.

---

### E-2 · medium · A capture landing during a cancellation resurrects the order after its stock is returned

**What happens.** `applyPaymentOutcome` reads the order, then writes it, with a round trip to
`payments` in between — and the write has no guard on what it read:

`src/lib/orders/payment-state.ts:305`
```ts
const orderError = (await admin.from("orders").update(orderPatch).eq("id", order.id)).error;
```

There is no `.eq("status", order.status)`. If anything else commits a status change in the gap,
this update silently overwrites it. `cancel_order_with_restock` is that something else: it locks
the row `for update`, restocks, and sets `status = 'cancelled'`, `stock_restored_at = now()`.

**Reproduction** (`scripts/audit/security-checkout.ts` §13, aimed sweep). For each delay,
POST a correctly-signed `payment.captured` to the webhook, wait, then call
`cancel_order_with_restock(..., p_require_unpaid => true)`:

```
 40ms:cancelled/paid+restocked    150ms:cancelled/paid+restocked
 80ms:cancelled/paid+restocked    175ms:cancelled/paid+restocked
120ms:cancelled/paid+restocked    200ms:confirmed/paid+restocked   <-- lost update
                                  225ms:confirmed/paid+restocked   <-- lost update
                                  250ms:confirmed/paid   (webhook won cleanly, cancel refused)
[FV-2026-00189 timeline: pending -> cancelled -> confirmed]
```

At 200–225 ms the cancellation commits between the webhook's `SELECT` on `orders` and its
`UPDATE`. The result is an order that is **`confirmed`, `payment_status = 'paid'`, and carries
`stock_restored_at`** — a live order, headed for packing, whose units are back on the shelf. Its
history reads `pending → cancelled → confirmed`, which `ORDER_TRANSITIONS` says is impossible:
`cancelled` is terminal.

The window is one Supabase round trip wide and reproduces on every run.

**Consequence.** Stock and money. The units are sold twice — once to the customer holding the
confirmed order and once to whoever buys them off the shelf afterwards. `stock_restored_at`
being set also means the order can never restock again, so cancelling it later leaks the units
permanently in the other direction. And a terminal state was left.

**Reachability today: none from a browser.** The only caller of `cancel_order_with_restock`
outside checkout's own rollback is `abandonUnpaidOrder`, and that action is not registered —
see E-8. It becomes reachable the moment any of the following lands:

- a "cancel this order" or "I closed the payment window" button wired to `abandonUnpaidOrder`
  (which is what the action was written for — `src/lib/actions/checkout.ts:269-281`);
- the admin panel in Phase 6/7 — the `admins update orders` policy already allows an admin to
  `PATCH` `orders.status` over PostgREST today, which races the same way;
- the abandoned-order sweep that E-1 asks for, which is exactly a cancellation running
  concurrently with whatever payments are still in flight. **Fixing E-1 without fixing E-2
  turns E-2 on.**

That last point is why this is worth doing in the same cycle even though it is a medium.

**Suggested fix** (Agent B, `src/lib/orders/payment-state.ts`). Make the order write a
compare-and-swap on the status it read:

```ts
const { data: updated } = await admin
  .from("orders")
  .update(orderPatch)
  .eq("id", order.id)
  .eq("status", order.status)          // the row must still be what we decided from
  .select("id");
if (updated?.length !== 1) { /* re-read and re-decide, or release the claim and 500 */ }
```

Zero rows means somebody moved the order underneath us; the right response is to release the
event claim and return retryable so Razorpay redelivers and the whole decision is remade
against the new state. That also covers the admin-panel race for free.

---

### E-3 · medium · Signing in loses a guest their own order, permanently

**What happens.** The guest confirmation page offers "Create an account" with
`next=/order/<number>` (`src/app/(storefront)/order/[orderNumber]/page.tsx:114`). The customer
accepts. In `/auth/callback`:

- `merge_guest_cart` looks for a cart with `status = 'active'` and that token. A checked-out
  cart is `converted`, so it finds nothing — and returns `guest_cart_consumed = true`
  (`supabase/migrations/20260808090700_merge_guest_cart.sql`: "A token with no bag behind it is
  a stale cookie. Say it is spent so the caller stops sending it.").
- `src/app/auth/callback/route.ts:77` therefore calls `clearGuestToken()`.
- Nothing attaches the order to the new account: `orders.user_id` stays null and
  `orders.guest_token` keeps the token that has just been deleted from the browser.

The order is now readable by nobody. The RLS guest policy needs the `x-guest-token` header
(gone), and the customer policy needs `user_id = auth.uid()` (null).

**Reproduction** (`scripts/audit/security-checkout.ts` §14) — every link checked separately:

```
PASS  the guest can read their order while they hold the cookie
PASS  merge_guest_cart succeeds for a token whose only cart is converted
PASS  and reports guest_cart_consumed  — {"merged":0,"dropped":0,"guest_cart_consumed":true}
PASS  the guest order is NOT attached to the account that just signed in  — 0 orders
PASS  page — /order/<number> now 404s for the customer who placed and paid for it
PASS  the row still carries only the guest token nobody holds any more
```

(These print PASS because each one asserts the broken behaviour, so the chain is documented
rather than assumed. The finding is the chain, not any single line.)

**Consequence.** Data access. A customer who has paid loses their receipt, their tracking, and
their order number the moment they do the thing the page asks them to do. `/account/orders` will
never show it. Support can find it; the customer cannot. Nothing is exposed to anyone else — this
is a loss of access, not a leak.

**Suggested fix** (Agent B — this is order code, not payment code). In `/auth/callback`, after
the session exists and before the token is cleared, adopt the guest's orders:

```sql
update public.orders
   set user_id = auth.uid(), guest_token = null
 where guest_token = public.current_guest_token()
   and user_id is null;
```

as a `service_role` RPC that derives both values from `auth.uid()` and the request header — never
from a parameter — with the same shape as `merge_guest_cart`. Then the copy on the confirmation
page can honestly say "we will link this order", which the comment at
`order/[orderNumber]/page.tsx:100-107` already anticipates.

If adoption is deferred, the minimum is to **stop clearing the cookie when the token still names
an order**: change `clearGuestToken()` to be conditional on there being no `orders` row for that
token. That keeps the customer's access, at the cost of a cookie that outlives its cart.

---

### E-4 · low · The currency guard checks one entity and reads the amount from another

**What happens.** `src/lib/payments/razorpay.ts:540`

```ts
const foreignCurrency = payment?.currency ?? order?.currency;
if (foreignCurrency !== undefined && foreignCurrency !== "INR") { /* drop */ }
```

The guard prefers the **payment** entity's currency. But for `order.paid`,
`outcomeFromPaidOrder` takes the amount from the **order** entity (`order.amount_paid`). An
`order.paid` whose order entity is `USD` and whose payment entity is `INR` passes the guard and
is then compared, integer for integer, against a rupee total.

**Reproduction** (`scripts/audit/security-checkout.ts` §12). A correctly-signed `order.paid`
with `order.currency = "USD"`, `order.amount_paid = <the order's paise total>`, and a payment
entity marked `INR`:

```
FAIL  order.paid naming a USD order is dropped too, not settled at INR parity
      — status 200, order confirmed
```

The same file confirms the guard *does* work for `payment.captured`: a `USD` payment entity is
dropped with 400 and the order does not move.

**Consequence.** In principle, a ₹4,499 order settled by $44.99 — a 100× under-payment. In
practice, nothing: the payload must be signed with `RAZORPAY_WEBHOOK_SECRET`, and anyone holding
that can already confirm any order they know the `provider_order_id` of by sending a plain INR
capture. So the marginal gain to an attacker is zero, and this is **low**.

It is still worth fixing, because the comment above the guard states its purpose precisely
("199900 yen would settle a ₹1,999 order") and the guard does not achieve it on the one path that
reads a raw amount from a different entity than the one it validates. A control that does not do
what its comment says is worse than an absent one — the next reader will trust it.

**Suggested fix** (Agent C). Validate the currency of whichever entity the amount comes from,
inside each `case`, rather than once above the switch:

- `payment.*` → require `payment.currency === "INR"`;
- `order.paid` → require `order.currency === "INR"`, and if a payment entity is present require
  it to agree.

---

### E-5 · low · Two idempotency keys for one capture, so a concurrent pair double-writes the timeline

**What happens.** One settlement produces up to three distinct event ids:
`payment.captured:pay_X` (webhook), `order.paid:order_Y` (webhook — Razorpay sends both when the
dashboard subscribes both), and `callback:pay_X` (`src/lib/actions/payment.ts:107`). They are
deliberately distinct so none is swallowed. Each therefore passes `recordAndApply`'s pre-claim
independently, and each runs a full read-decide-write against the same order with no
compare-and-swap (same root cause as E-2).

Sequentially this is fine: the second one reads `confirmed`, `nextStatus === order.status`, and
no history row is written. Concurrently, both read `pending` and both insert.

**Reproduction** (`scripts/audit/security-checkout.ts` §11):

```
PASS  both event types answer 200
PASS  the order is confirmed and paid exactly once
FAIL  one 'confirmed' history row despite two distinct event ids for one capture  — 2 rows
```

Note what *did* hold, in the same section: **ten simultaneous deliveries of one event produce
exactly one ledger row, one confirmation and one payment row.** The pre-claim in
`recordAndApply` is a real gate and the adoption inside `applyPaymentOutcome` does not undo it —
see "The double-claim seam" below.

**Consequence.** Data quality. The customer's order timeline on `/order/<number>` and
`/account/orders/[id]` shows "Confirmed" twice, seconds apart. No money moves twice, no stock
moves at all (stock moves at order creation, never on a payment event — proved in §2), and the
payment row is claimed once.

**Suggested fix** (Agent B). The compare-and-swap from E-2 fixes this too: the loser's update
matches zero rows, it re-reads, sees `confirmed`, and writes no history. One fix, two findings.

---

### E-6 · informational · With no webhook secret, a customer whose browser does not come back is stranded

`isRazorpayConfigured()` deliberately excludes `RAZORPAY_WEBHOOK_SECRET`
(`src/lib/payments/config.ts:83`), so **Pay online** is offered whenever the API keys exist. With
the webhook secret unset — the state in `.env.local` today, and presumably in Vercel — the route
rejects every delivery (verified: the adapter logs "RAZORPAY_WEBHOOK_SECRET is not set" and
returns 400).

Payments still confirm, via `verifyRazorpayPayment` from the browser. What is lost is every case
where the browser does not return: a closed laptop, a dead battery, a UPI collect approved on a
phone after the desktop tab was closed. Those customers are charged and their order stays
`pending`/`unpaid` forever, because there is no reconciliation and — per E-1 — no sweep either.

This is a documented, deliberate trade ("a degraded shop, not a closed one") and I agree with the
direction. It needs to be on the owner's checklist rather than in a code comment:

**Owner action.** Razorpay dashboard → Settings → Webhooks → add
`https://<domain>/api/payments/razorpay/webhook`, subscribe `payment.captured`, `payment.failed`
and `order.paid`, copy the secret, and set `RAZORPAY_WEBHOOK_SECRET` in Vercel for **Preview and
Production separately**. Until then, either accept the stranded-payment case knowingly or hide
**Pay online**.

---

### E-7 · informational · The `SECURITY DEFINER` surface, verified independently

I did not take the lead's earlier check on trust. Queried `pg_proc` directly, and cross-checked
against Supabase's own advisor. **Phase 5 added no new `SECURITY DEFINER` function.** It modified
one: `owns_order(uuid)`, in `20260808090400_rls_guest_orders.sql`, widened to accept a guest
token as well as `auth.uid()`. `create or replace` preserves grants, so it kept the Phase 1 ACL.

Every definer function in `public`, its owner, its `search_path`, and who may execute it:

| Function | Owner | `search_path` | `anon` may execute |
|---|---|---|---|
| `can_access_cart(uuid)` | postgres | `""` (pinned) | yes |
| `owns_order(uuid)` | postgres | `""` (pinned) | yes |
| `is_admin()` | postgres | `""` (pinned) | yes |
| `product_is_live(uuid)` | postgres | `""` (pinned) | yes |
| `discontinued_product_hint(text)` | postgres | `""` (pinned) | yes |
| `handle_new_user()` | postgres | `""` (pinned) | no (postgres + service_role) |
| `rls_auto_enable()` | postgres | `pg_catalog` | no (postgres + service_role) |

The five `anon`-executable ones are all flagged by the Supabase advisor
(`anon_security_definer_function_executable`). **All five are correct as written and the grant is
load-bearing**: the first four are called from RLS policies, which are evaluated as the calling
role, so revoking `EXECUTE` would break every cart, order and product read for anonymous
visitors. Each answers a boolean about the caller and nothing about anyone else — I confirmed
behaviourally that `owns_order()` returns `false` for another guest's order and `true` only for
the token that placed it, and that `is_admin()` returns `false` for `anon` and for a fresh
account that has just tried to `PATCH` its own `profiles.role`.

Every non-definer Phase 5 function has `EXECUTE` revoked from `public`, `anon` and
`authenticated`, and granted only to `service_role`. Verified live (`42501` on all four):
`create_order_with_stock`, `assert_cart_stock`, `cancel_order_with_restock`,
`next_order_number`. `merge_guest_cart` is `authenticated`-only and correctly refuses a
`p_guest_token` that does not match the request header — parameter spoofing returns `42501` and
the victim's cart is untouched.

This table should go in `docs/rls-tests.md` so the advisor warning stops being re-investigated
every phase (Agent G).

---

### E-8 · informational · `abandonUnpaidOrder` is dead code and has never been exercised

`abandonUnpaidOrder` is exported from `src/lib/actions/checkout.ts`, but no client component
imports it, so Turbopack tree-shook it. `.next/server/server-reference-manifest.json` registers
13 actions; the checkout page's are `placeOrder` and `verifyRazorpayPayment` only.

Consequences, both worth knowing:

- It is currently **not callable from a browser**, which is the only thing holding E-2 to medium.
- Its logic — the RLS ownership read, the `pending`-only guard, the `already_paid` branch — has
  never run outside a unit read. When Agent D or a later phase wires the "I closed the payment
  window" path to it, both E-2 and this action's own behaviour need a real test.

Either wire it with the E-2 fix in place, or delete it and re-add it when the button exists. An
exported server action that nothing calls is a surface with no owner.

---

## What held — the checklist, item by item

Every item has a verdict. Where I could not test something, it says so and says why.

**1 · Tamper with the amount client-side.** *Held.* The only price-shaped column a customer can
write is `cart_items.unit_price_seen` — RLS grants a guest `ALL` on their own cart lines, and I
confirmed the write succeeds. The order's subtotal came out at the catalog price regardless
(`1999800` both sides), and `grand_total = subtotal + shipping` recomputed inside
`create_order_with_stock`. `checkoutSchema` strips every smuggled field: a payload carrying
`grandTotal`, `subtotal`, `shippingFee`, `amount`, `amountPaise`, `discountTotal`, `coupon`,
`couponCode`, `cartId` and `lines` parsed down to
`address, contactEmail, customerNote, paymentMethod, saveAddress`. `anon` calling
`create_order_with_stock` with its own `p_shipping_flat_fee: 0` is refused with `42501`.
The function takes no price argument at all, only the shipping policy.

**2 · Replay a captured webhook ten times.** *Held.* Ten sequential deliveries through the real
route: all 200, first `{"ok":true}`, nine `{"ok":true,"duplicate":true}`, one ledger row, one
`confirmed` history row, one payment row with the payment id claimed once. **Stock did not move
at all** (7 → 7) — it moves at order creation, never on a payment event, which is the structural
reason ten deliveries cannot decrement ten times.

**3 · Forge a webhook signature.** *Held.* Eight variants, all 400, none wrote a ledger row and
none moved the order: no header, empty header, 64 zeroes, the signature of a different body, a
body swapped after signing, the correct signature upper-cased, the correct signature one
character short, and an HMAC computed with `RAZORPAY_KEY_SECRET` instead of the webhook secret.
A correctly signed but unhandled event type (`payment.downtime.started`) is ignored with 200,
which is right — a 400 there would put the endpoint into retry and then into disabled.
`verifyHexSignature` was separately checked against ten vectors this file computed itself with
`node:crypto` rather than by importing the implementation (§17).

**4 · Variant goes inactive mid-flow.** *Held, both directions.* Withdrawn before checkout:
`OSTCK`, with the item named and `"available": 0` rather than its stock count, no stock moved,
and the bag left `active` so the customer can fix it. Withdrawn after the order exists: the
`order_items` snapshot (`product_name`, `unit_price`, `sku`) is byte-identical before and after.

**5 · Concurrent checkouts on the last unit.** *Held.* Five simultaneous checkouts on one unit:
exactly one wins, four get `OSTCK` naming the item and size, stock lands on exactly `0` and never
goes negative (`product_variants_stock_quantity_check` is a second floor under the row lock), and
exactly one order line exists for the unit.

**6 · Customer A's order requested by customer B — API and page.** *Held, both.* Over PostgREST,
another guest reads zero rows by order number, by id, for the items and for the history; an
anonymous caller with no token reads zero; a signed-in stranger reads zero by number and by id
while A still reads their own. B cannot reassign A's order to themselves and cannot mark any
order paid. Over HTTP: the owner gets 200 with the order number rendered in 111 KB of HTML, a
guest with a different token gets 404, no cookie gets 404, and `/account/orders/<A's id>` gets
404 for a stranger.

**7 · Guest order by guessing the number.** *Held, and the premise is confirmed.* Order numbers
are a padded sequence (`FV-2026-00033`), so neighbours are predictable — I generated ±3 and
walked them. Zero rows over the API and 404 on every page, **including the one that exists**, and
a real order is indistinguishable from `FV-1999-99999`. No stranger can select `guest_token` from
any row. The token is 122 bits from `crypto.randomUUID()` in an `httpOnly` cookie; the number
gates nothing.

**8 · Coupon field.** *Held.* `discount_total` is `0` and `coupon_code` is `null` on every placed
order. `checkoutSchema` has no coupon field and drops `coupon`/`couponCode`/`discountTotal` from
the payload. The `coupons` table returns zero rows to a client. `src/components/storefront/coupon-field.tsx`
is a bare `<Input>` with no action, no state and no submit — it is a layout placeholder, and it
says so.

**9 · Secrets in the client bundle.** *Held.* I ran `npm run build` twice: once as-is, and once
with `RAZORPAY_WEBHOOK_SECRET` set to a sentinel value so the blank one could be searched for
too. Grepping the built output for the literal values:

| Value | `.next/static` | all of `.next` |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | 0 files | 0 files |
| `RAZORPAY_KEY_SECRET` | 0 files | 0 files |
| `RAZORPAY_WEBHOOK_SECRET` (sentinel) | 0 files | 0 files |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 1 file | — (expected and correct) |

No client chunk even contains the *names* `SUPABASE_SERVICE_ROLE_KEY`, `RAZORPAY_KEY_SECRET` or
`RAZORPAY_WEBHOOK_SECRET`. The decision not to create a `NEXT_PUBLIC_RAZORPAY_KEY_ID` is worth
keeping: the key id reaches the browser only inside `PaymentInitiation`, at the moment an order
exists. The build passed both times; no file I do not own broke it. The service-role key
grepped for is the real one from `.env.local` — no secret value appears anywhere in this file.

**10 · `SECURITY DEFINER` functions.** *Verified independently — see E-7.* Zero new ones. One
modified. Five executable by `anon`, all correctly so, all with `search_path` pinned to `""` and
owned by `postgres`.

**Direct writes to the money tables** (not on the checklist, and the highest-value thing left).
Every table below is granted to `anon`/`authenticated` at the SQL level, so RLS is the only thing
between a customer and the price of a shoe. All eight attempts refused, with nothing changed:
set a product's `base_price` to 1 paisa; set a variant's `price_override` to 1 paisa; give
oneself 999 units of stock; insert one's own `confirmed`/`paid` order row; insert a forged
`confirmed` row into somebody's order history; insert a captured `payments` row; insert a
pre-`processed_at` `payment_events` row to swallow a real webhook; and `PATCH`
`profiles.role = 'admin'`.

---

## The double-claim seam — the lead's first hard question

**Agent B's stated cost is not reachable through the webhook route, and the route is safe.**

`recordAndApply` claims the event, then calls `applyPaymentOutcome`, which claims it again.
The second claim always loses with `23505` (the first one just inserted the row), always finds
`processed_at is null`, and always adopts. So in production the inner `claimEvent` is never a
gate — it is a lookup of the row the same request created three lines earlier.

That sounds alarming and is not, because the **outer** claim is exclusive. Two simultaneous
deliveries of one event both try `claimPaymentEvent`; one gets the row and the other gets `23505`
and returns `duplicate` before touching an order. The inner adoption can therefore only ever
adopt a row belonging to the same in-flight request. Ten concurrent POSTs of one signed event
produced exactly one ledger row, one `confirmed` history row and one payment row (§11).

The "two genuinely simultaneous deliveries both proceed" cost B described would require a second
writer to reach `applyPaymentOutcome` without going through `recordAndApply`. Nothing in
`src/**` does; the only direct caller is `scripts/audit/checkout-orders.ts`, which is a test.

**Where the seam does bite is one layer up, and it is not the claim — it is the key.** Three
different keys describe one capture (E-5), so the pre-claim, which is per-key, does not serialise
them. That produced a duplicate history row and nothing worse, because the transition is idempotent
and stock never moves on a payment event. The same missing compare-and-swap is what makes E-2
dangerous when the *other* writer is a cancellation rather than a second capture.

So: the idempotency scheme is sound and the double claim is redundant rather than broken. The
thing neither agent owns is not the claim — it is **the `orders` row between the read and the
write**. One `.eq("status", order.status)` closes E-2 and E-5 together.

Worth saying plainly: the inner `claimEvent` should not be deleted as "dead". It is what makes
`applyPaymentOutcome` safe to call from anywhere, including B's own harness. It just should not
be counted as a second line of defence against concurrency, and the comment at
`payment-state.ts:41-45` should be corrected to say the pre-claim is what serialises deliveries.

---

## Amount mismatch — the lead's second hard question

**I could not get an order confirmed for less than it costs.** Both directions behave as B
documented, and I attacked four routes to a shortfall:

- **Under-payment.** A signed `payment.captured` for `grand_total - 100` leaves the order
  `pending`/`unpaid`, records the attempt as `captured` on the `payments` row for a human to
  reconcile, answers 200 (no retry storm), and writes
  `amount_mismatch:expected=1149900,received=1149800` into the ledger. A correct capture
  afterwards still confirms the order, so a mismatch is not a permanent denial of service against
  the customer.
- **Over-payment.** Confirms, marks paid, logs `amount_mismatch:...` and writes
  `"Payment captured; 100 paise overpaid"` into the timeline. I agree with this: a customer who
  has paid at least what was owed must not be stranded because we owe them change.
- **Manipulating the Razorpay order amount.** Not reachable. `initiate()` takes the amount from
  the checkout action's `context`, which comes from `create_order_with_stock`'s return value; the
  adapter then re-checks Razorpay's echoed `amount` and `currency` and throws on disagreement;
  and `recordProviderOrder` writes the same number into `payments.amount`, which is what the
  webhook compares against. There is no field on the wire an attacker can fill in.
- **Racing a price change between initiation and capture.** Not reachable. The order's
  `grand_total` and the `payments.amount` are both frozen inside the same request, before the
  modal opens. A later catalog edit cannot move either.
- **Currency substitution.** Blocked on `payment.*` (400, order does not move). **Not blocked on
  `order.paid`** — that is E-4, and it needs the webhook secret to reach, which is why it is low.

The one structural observation: `payments.amount` is the sole source of truth for "what this
order costs" at capture time, and it is written by a separate statement from the order itself
(`recordProviderOrder`, `src/lib/actions/checkout.ts:415`). If that insert ever wrote a different
number from `orders.grand_total`, the mismatch check would compare against the wrong figure and
notice nothing. It cannot today — both come from the same `grandTotal` local — but a database
constraint (`payments.amount = orders.grand_total` for `provider = 'razorpay'`, or simply reading
`orders.grand_total` in `applyPaymentOutcome` instead of `payments.amount`) would make it
unable to drift. Not a finding; a cheap hardening.

---

## What I could not test, and why

- **The `placeOrder` server action over real HTTP with a hand-built payload.** I attacked the
  trust boundary directly — `checkoutSchema` and `create_order_with_stock` — rather than driving
  the action through its `Next-Action` id. The schema strips every money field and the SQL
  function accepts no price, so the action has nothing left to be tricked with; but I have not
  proved that by POSTing to `/checkout`. If the lead wants that closed, it is a half-hour of
  extracting the action id from `.next/static` and replaying the RSC POST format.
- **`verifyRazorpayPayment` against a genuine Razorpay payment.** It needs a real card journey
  through the hosted modal, which I cannot drive headlessly against Razorpay's test environment
  from here. I verified the primitive it depends on (`verifyHexSignature`, ten vectors) and read
  the flow closely: parse → HMAC → read back from the Payments API → apply through the same seam
  as the webhook. The read-back is the part that matters and it is present. **Untested end to
  end.** Someone should do one manual test-card payment before launch and confirm exactly one
  order, one payment row, and one stock decrement — that is the phase's own "done when".
- **`abandonUnpaidOrder`'s ownership check.** Not registered as a server action (E-8), so there
  is nothing to POST to. Reviewed by reading: it reads the order through the RLS client by
  `order_number` first, so a forged number finds nothing rather than somebody else's order. That
  is the right shape, and it is untested.
- **Behaviour under real Razorpay webhook delivery.** Every webhook in this review was
  synthesised and signed by me. The envelope shape matches Razorpay's documented one and the
  adapter's Zod schema accepts it, but I have not seen a real delivery — nobody has, because the
  webhook secret does not exist yet (E-6).
- **Anything about Agent A's UI work**, which was still landing. Nothing I ran touches it.

---

## Database and account cleanup

Everything this review created has been removed, and the sweep is proved by count rather than
asserted. The harness sweeps from a `finally` block, so a mid-run throw still cleans up — that
was added after the first run crashed in section 13 and left fourteen orders behind, which I then
removed by hand.

**Final state, queried after the last run:**

| | |
|---|---|
| Orders with my marker (`security-audit@example.com`) | **0** |
| `payment_events` rows in the whole table | **0** |
| Accounts matching `fv-sec-%@example.com` | **0** |
| Variants left inactive | **0** |
| Carts created by me and left behind | **0** |
| Variants below the seed baseline of 8 | **4**, every one of them held down by another agent's live order (`FV-2026-00018/20/27/139/166/167/168`), none by mine |

**Per-run sweep** (last full run): 27 orders created / 0 left, 32 carts / 0 left, 22
`payment_events` / 0 left, 5 accounts created / 5 deleted, 0 cleanup errors.

**Done by hand, after the crashed first run:** 14 orders cancelled (restocking their units) and
deleted, 14 carts deleted, 10 ledger rows deleted, 3 accounts deleted through the admin API, and
`FV-ADIDAS-SAMBAOGM-CLOUDW-7` (`95d0fc77-…`) restored from `1` to its baseline `8` — it had been
pinned to 1 for the concurrency test and the crash skipped the restore.

**Order numbers burned: `order_number_seq` was at `24` when I started and `195` when I
finished — so the range `FV-2026-00025` … `FV-2026-00195` is spent.** Most of it is mine (five
suite runs at ~27 orders each, plus one crashed run). Agent D was placing orders in the same
window, so the range is shared: `FV-2026-00139` and `FV-2026-00166` … `FV-2026-00168` are theirs,
not mine. Nothing depends on the numbers being contiguous.

**Left behind by others, reported not touched** — deleting another agent's fixtures mid-run would
break them:

- Five `pending`/`unpaid` Razorpay orders from Agent D (`FV-2026-00021` … `FV-2026-00025`, placed
  19:47–19:53) holding five units of stock. These are E-1 demonstrating itself.
- One `pending`/`unpaid` Razorpay order, `FV-2026-00139`, against a real Gmail address — Agent D's
  browser test.
- 25 active guest carts and a number of `fv-agentd.*` / `fv-checkout.*` accounts from B's and D's
  harnesses.

**Also changed, and worth the lead knowing:** `.next` now holds a build made with
`RAZORPAY_WEBHOOK_SECRET=fvsentinel_wh_9f3a2b1c7d4e` in the environment. The value is not in the
output (that was the point of the test) and is not in `.env.local`, but the build artefact is
mine rather than a clean one. Re-run `npm run build` before measuring anything. The server I
started on port 3491 has been stopped; the servers on 3000, 3210 and 3254 are other agents' and
were left alone.

**Files I wrote:** `scripts/audit/security-checkout.ts` (new), this file (new), and one line in
`package.json` (`"audit:security"`). No feature code was touched. `npx eslint` and
`npx tsc --noEmit` are both clean on the new file, including
`footvault/no-unchecked-supabase-error` and the no-`any` rule.

---

## Where this code is weakest, findings aside

Three things, in order of how much they worry me.

**1 · `orders.status` has four writers and no lock.** `create_order_with_stock` and
`cancel_order_with_restock` both take `for update` on the row and are single transactions.
`applyPaymentOutcome` does not — it reads over one HTTP round trip and writes over another,
through PostgREST, with no transaction and no compare-and-swap. The `admins update orders` policy
adds a fourth writer that is a raw `PATCH`. E-2 and E-5 are both symptoms of that one gap, and
the next one will be too. The state machine is written down beautifully in
`src/lib/orders/types.ts` and enforced by exactly one caller reading a value it then discards.
**If one thing gets fixed from this review, make it the compare-and-swap** — it is two lines and
it closes the class, not the instance.

**2 · The stock ledger is a single mutable integer.** `product_variants.stock_quantity` is
decremented at order creation and incremented at cancellation, guarded by a boolean-ish marker
(`stock_restored_at`) and a `>= 0` check. There is no movements table, so there is no way to ask
"why is this variant at 3?" after the fact, no way to detect a double restock that happened last
week, and no way to reconcile against orders. E-2 produces a wrong count with no trace beyond an
odd timeline. A `stock_movements` append-only table — order id, variant, delta, reason — would
make every one of these findings self-detecting rather than requiring a race to be caught in the
act. That is Phase 6/7 work, but the longer it waits the less anyone can trust the number.

**3 · The webhook route does unbounded database work for any correctly-signed payload, and there
is no rate limit anywhere on the site.** An event for an order we do not have costs an insert, a
select, a delete and a 200 — and the claim is deliberately released so the same payload can be
replayed forever. Without the secret this is one HMAC and cheap. With it, or if the secret ever
leaks, it is an amplifier. Similarly, `verifyRazorpayPayment` calls Razorpay's Payments API
*before* the idempotency claim, so a customer replaying their own valid triple makes us hammer our
own Razorpay rate limit. Neither is a finding today; both are the kind of thing that becomes one
the first time somebody points a tool at the site.

One more, smaller: the code is unusually well commented, and the comments are load-bearing —
readers will trust them. Two are now wrong. `payment-state.ts:41-45` says two simultaneous
deliveries both proceed (they do not; the pre-claim stops them), and `razorpay.ts:536-539` says
the currency guard stops a foreign amount settling an INR order (it does not, on `order.paid`).
Both should be corrected with the fixes, or the next reader will believe the wrong thing about
the two places that matter most.
