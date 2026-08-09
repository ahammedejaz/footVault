# Phase 9 · Stage 1 — Audit

Read-only. No feature code was written. One temporary browser script was created
under `scripts/audit/`, run, and deleted; the working tree is clean apart from
the brief itself.

Everything below was verified against the running system — the production
database, the live Vercel deployment, and a real browser holding a real admin
session — rather than inferred from the reports of previous phases. Where I
could only read code and not run it, the finding says so.

---

## The short version

**The two toggles the owner cannot find are on the page, visible, and working.**
I have a screenshot of them. That makes 9A a harder and more useful problem than
"somebody forgot to build it", and the process answer at the end of 9A is the
part worth reading.

**A fully refunded order can never be cancelled.** Not "is refused by a guard
that reads the wrong column" — there is no state the data could be in that would
let it through. FV-2026-00623 is sitting in production right now with its stock
still held.

**A customer who has been refunded is told their payment has not arrived yet, and
invited not to pay again.** The refunded case fell through a chain of `if`s into
the "we have not seen your payment" branch.

**The customer's order timeline prints internal engineering notes verbatim** —
including `rfnd_TNeaZX8YweRyFi`, the word *webhook*, and the raw enum
`cancelled_before_dispatch`.

| # | Finding | Severity |
|---|---|---|
| 9A.1 | The delivery-mode and Pay-on-Delivery controls exist and work; the page hides them in prose and a bold line that says they are not there | **P0** |
| 9A.2 | The gate that "proved" them asserts a panel *title*, then round-trips one unrelated field | **P0** (process) |
| 9B.1 | A fully refunded order can never be cancelled, by any path, at any time | **P0** |
| 9B.2 | FV-2026-00623's stock is still held — `stock_restored_at` is null | **P0** |
| 9C.1 | A refunded order tells the customer their payment has not settled | **P0** |
| 9C.2 | Internal notes are rendered verbatim as customer copy | **P1** |
| 9D.1 | No email is sent to anyone, ever; no owner notification exists at all | **P1** |
| 9D.2 | Customers cannot edit a saved address — and the page tells them they can | **P1** |
| 9D.3 | A server error on the live shop reaches nobody | **P1** |
| 9D.4 | `logo-original.png` is referenced nowhere; the OG image has no mark at all | **P1** |
| 9D.5 | ₹2,499 is hardcoded in two files, in the one form the literals gate cannot see | **P2** |
| 9D.6 | Add to bag: 810 ms before the bag moves, two-thirds of it spent re-rendering the layout | **P2** |
| 9D.7 | Rate limiting is **done** — this one is good news | — |

---

# 9A · Why is a built feature invisible?

## They are not invisible. They are on the page.

I promoted a throwaway account to admin on staging, opened `/admin/settings` in
Chromium with a real session, and asked the DOM what a human can see:

```
delivery-mode select exists : 1
delivery-mode visible       : true
delivery-mode value         : live
delivery-mode options       : ["Pass the courier's rate through (recommended)",
                               "Charge one flat amount everywhere"]
POD checkbox exists         : 1
POD checkbox visible        : true
POD checked                 : true
```

Both controls render. Both are interactive. Neither is behind a flag, a tab, an
accordion, or a permission.

The chain is intact end to end, and I checked every link because the previous
two phases each reported it intact:

| Link | State | Evidence |
|---|---|---|
| Settings exist in the database | ✅ | `site_settings.shipping` on **production** holds `shipping_rate_mode: "live"`, `flat_shipping_fee_paise: 0`, `cod_enabled: true` |
| Written by a migration | ✅ | `supabase/migrations/20260809110100_shipping_rate_mode_and_cod_controls.sql` |
| The page reads them | ✅ | `src/app/admin/settings/page.tsx:94-99`, `:75` |
| The form renders controls | ✅ | `settings-forms.tsx:121-140` (mode), `:244-252` (Pay on Delivery) |
| Rendered unconditionally | ✅ | `Panel` always renders children — `src/components/admin/ui.tsx:60-91` |
| Reachable from the nav | ✅ | `src/components/admin/nav.ts` — "Settings · Shop details and rules" |
| Committed to main | ✅ | `136678e`, an ancestor of `HEAD` |
| **Deployed to production** | ✅ | `dpl_8hXyJjr6ZGdATvdnNESMDUKL8qLx`, target `production`, state `READY`, commit `dd4c67b` — which contains `136678e` |

So it is not a rendering bug, not a missing form section, not a page the owner
is not looking at, and not a feature that was never wired up. It is the fifth
option, which the brief did not list because it should not happen: **the page is
built so that a person looking directly at the control does not recognise it.**

## What the owner actually sees

The screenshot is the finding. Three things in it explain three years of asking.

**1. The panel opens by telling them the thing they want is not here.**

The first element inside "Delivery and Pay on Delivery" is a bordered box whose
first words are bold:

> **Delivery rates are not set here.** What a customer pays to receive a parcel
> comes from Shiprocket, for their pin code, every time. These are the shop's own
> thresholds.

An owner who came to this page to set a flat delivery rate reads the most
prominent sentence in the panel, is told authoritatively that this page does not
do that, and stops scanning. The control that does exactly that sits about 180
pixels below it. The sentence is *true* in the sense its author meant — live
rates come from the courier — and false in the sense the reader takes it.

**2. The word "flat" is not on screen.**

In the default `live` state the select displays only *"Pass the courier's rate
through (recommended)"*. The option that says *"Charge one flat amount
everywhere"* is inside a closed dropdown. The field for the flat amount does not
exist in the DOM at all until the mode is switched — `settings-forms.tsx:142`
renders it conditionally. So an owner scanning the page for the word they have in
their head — *flat* — finds nothing, twice over.

The label above the select is "How the delivery charge is decided". That is good
prose and a poor search target.

**3. The controls are subordinate to the prose.**

Every control on this panel is followed by three to five lines of muted grey
explanation. The controls themselves are one `<select>`, three 16-pixel native
checkboxes, and six small number inputs. Visually the page is a wall of grey
paragraphs with occasional small widgets in it. "Offer Pay on Delivery" is a
plain `<input type="checkbox" className="size-4">` — not a switch, not styled,
sitting directly above a four-line paragraph that is physically larger and
darker than it.

The explanatory text was written to satisfy a real requirement — *"one line per
setting saying what it does and what happens if it is set too high or too low"*.
It succeeded at that and, unmeasured, overshot into making the settings
themselves hard to find.

## The process question: how did a gate pass on this?

This matters more than the fix, so here is the exact mechanism.

There are no unit or e2e test files in this repository. The gates are the
`scripts/audit/*.ts` harnesses. The one that covers this page is
`scripts/audit/admin-pages.ts`, and it is a real browser suite — so the category
of failure is not "nobody opened a browser". It opened one. Here is everything it
asserts about the settings page (`admin-pages.ts:237-318`):

```ts
const settingsBody = await page.locator("body").innerText();
check("the settings page renders for an admin",
      settingsBody.includes("Pay on Delivery"), …);          // ← 1
check("it says plainly that rates are not set here",
      /Delivery rates are not set here/i.test(settingsBody)); // ← 2

const freeAbove = page.locator("#free-above");               // ← 3
…
await freeAbove.fill("3111");
await page.getByRole("button", { name: /Save delivery settings/ }).click();
check("saving writes paise, not rupees",
      savedValue.free_above_paise === 311_100, …);           // ← 4
```

1. **Passes on the panel's own title.** The `<Panel title="Delivery and Pay on
   Delivery">` and the `<legend>Pay on Delivery</legend>` both put that string in
   `body.innerText`. Delete the checkbox entirely and this check still passes.
2. **Asserts the sentence that causes the problem.** The gate actively pins the
   line that tells the owner rates are not set here.
3. **The only control it ever touches is `#free-above`** — the free-delivery
   threshold, which is not either of the two features in question.
4. **The only value it round-trips is `free_above_paise`.** Nothing in the file
   ever reads `#delivery-mode`, and nothing ever locates the Pay-on-Delivery
   checkbox, which has no `id` at all.

Meanwhile the *other* gate, `scripts/audit/delivery-rules.ts`, proves decision 6
("a flat delivery fee with a toggle") thoroughly and correctly — and its own
docstring says what it is: *"Pure: no database, no browser, no Shiprocket."* It
calls `deliveryFee()` with constructed settings objects. It proves the flat fee
is honoured downstream. It cannot prove anybody can turn it on.

**So the gap is precisely this: one gate proved the value is honoured, another
proved the page renders *something*, and the report added those two together and
called it "Built · proved".** No gate anywhere in this repository asserts that a
named control is on screen, is operable by a human, and changes the value it
names. That assertion has never existed.

That is also why the ₹2,499 incident recurred four times and why this is the
third phase for these toggles: the project's gates are strong on money
correctness and weak on reachability. The money is genuinely proven. The
usability is genuinely unproven, and has been reported as proven.

## What else is in the same state?

I checked rather than assumed. Batch 3's claimed admin UI is genuinely wired —
each of these is imported *and* rendered in `src/app/admin/orders/[id]/page.tsx`:

| Component | Rendered |
|---|---|
| `RefundPanel` | ✅ |
| `RtoPanel` | ✅ |
| `ShippingPanel` | ✅ |
| `ShipmentError` | ✅ |
| `OrderActions` | ✅ |

So Batch 3 did not repeat Batch 2's pattern structurally. But none of those five
panels has a gate asserting a human can see and operate it either — they are
covered by the same `admin-pages.ts`, which drives the order page for *Assign
AWB* and *Add note* only. They are reachable; whether they are *usable* is
unproven by anything except this audit having laid eyes on the code.

The honest summary: **nothing else is broken in the way Batch 2 was, and nothing
else is proven not to be.**

---

# 9B · Cancel is blocked on a fully refunded order

## The guard

The admin's "Mark Cancelled" runs `transitionOrder`
(`src/lib/orders/transition.ts:114-141`), which delegates to the SQL function
with `p_require_unpaid: true`. The refusal comes from
`cancel_order_with_restock`. This is its live definition, read from production:

```sql
if p_require_unpaid and (
     v_payment <> 'unpaid'
     or exists (select 1 from public.payments pm
                 where pm.order_id = p_order_id
                   and pm.status in ('captured', 'refunded'))
   ) then
  return 'already_paid';
end if;
```

The brief's guess was that it compares *captured* rather than *net outstanding*.
That is right, and it understates it. There are two independent limbs and **both
fire on a fully refunded order**:

- `v_payment <> 'unpaid'` — after a refund `orders.payment_status` is
  `'refunded'`, which is not `'unpaid'`. Fires.
- The `exists` — **`'refunded'` is explicitly in the list.** A payment that has
  been fully returned is counted as a reason not to cancel. Fires.

Net outstanding is never computed. Nothing anywhere subtracts refunds from
captures. And because the second limb names `'refunded'` on purpose, there is no
value the data could take that would let a refunded order through: fixing the
`payment_status` would not help, and marking the payment row `refunded` would not
help either. **A refunded order is permanently uncancellable by design, not by
accident.**

## The real numbers, from production

`FV-2026-00623`:

| | |
|---|---|
| `status` | `confirmed` |
| `payment_status` | `refunded` |
| `advance_amount` | 13500 paise (₹135) |
| `grand_total` | 13500 paise (₹135) |
| `stock_restored_at` | **null** |
| `payments` row | `captured`, 13500, `pay_TNeXHYc0x69NUo` |
| `refunds` row | `processed`, 13500, `rfnd_TNeaZX8YweRyFi`, `cancelled_before_dispatch` |

Captured ₹135. Refunded ₹135. **Net outstanding ₹0.** The order is
paid-and-returned in full and cannot be closed.

Two consequences beyond the owner's irritation:

1. **The stock is stranded.** `stock_restored_at` is null, so the pair on that
   order is still deducted from sellable inventory. The only path that restocks
   is the cancel that is refused. This is live, in production, now.
2. **The `payments` row was never moved to `refunded`.** It still reads
   `captured` even though the refund is `processed` and webhook-confirmed. That
   is a second, separate bookkeeping gap — the refund is recorded in `refunds`
   and on the order, but not on the payment.

## Every caller that shares the condition

`p_require_unpaid: true` is passed by four callers:

| Caller | Correct? |
|---|---|
| `src/lib/orders/transition.ts:116` — admin *Mark Cancelled* | ❌ **This is the bug.** Needs net outstanding |
| `src/lib/actions/checkout.ts:764` — `cancelWithRestock` | ✅ Targets unpaid orders |
| `src/app/api/cron/release-abandoned-orders/route.ts:178` | ✅ Only reached when Razorpay confirms nothing was authorised |
| `20260809030000_narrow_release_abandoned_orders.sql:67` | ✅ Sweeps unpaid abandoned orders |

The three sweep paths are right to refuse a paid order. Only the admin path needs
to reason about what is still outstanding. Any fix must not loosen the other
three — that guard is what stopped the Phase 8 incident where the sweep cancelled
paid orders.

## Anywhere else that reasons about "has this order been paid"

`refundInstruction` (`transition.ts:233-280`) is the message shown when the guard
fires, and it has the same blind spot from the other direction: it tells the
owner to refund `advance_amount` without checking whether that has already
happened. On FV-2026-00623 it currently instructs the owner to refund ₹135 that
has already been refunded. `scripts/audit/refund-message.ts` pins this sentence
and asserts it names the advance and not the grand total — correct as far as it
goes, and it never constructs an already-refunded order.

---

# 9C · The customer order page contradicts itself

## 1 · The condition

`whatHappensNext` in `src/components/checkout/order-format.ts:114-146`:

```ts
if (order.status === "cancelled") return …;
if (order.status === "returned")  return …;
if (order.paymentMethod === "cod") { … }
if (order.paymentStatus === "paid") {
  return "Your payment has gone through. …";
}
return "We have not seen your payment settle yet. This can take a minute — "
     + "reload this page rather than paying again, …";   // ← line 145
```

`PaymentStatus` is `unpaid | paid | refunded` (`order-format.ts:100-104`). The
chain handles `paid`. **It has no branch for `refunded`**, so a refunded order
falls off the end into a sentence written for an order that was never paid.

FV-2026-00623 is `confirmed` / `razorpay` / `refunded`, so it takes exactly that
path. The page shows "Refunded" in one place and "we have not seen your payment
settle yet" in another, from two different functions reading the same row.

This is worse than a contradiction. The final clause — *"reload this page rather
than paying again"* — is advice for a customer whose payment is in flight. Shown
to a customer whose money has just been sent back, it reads as an instruction to
wait for a payment that is never coming.

**What it should be:** an explicit `refunded` branch, before the fallback, saying
something like *"₹135 is on its way back to you. Refunds usually reach your
account in 5–7 working days."* The fallback should then only be reachable by a
genuinely unpaid order. Because the union has exactly three members, an
exhaustive `switch` here would have made this a compile error rather than a
customer-facing one.

## 2 · Internal vocabulary in customer copy

The brief quotes *"It is complete when Razorpay's webhook confirms it."* That
string is real and it is customer-facing, but not because someone wrote it into a
component. The mechanism is worse and more general:

- `src/lib/orders/refunds.ts:522-529` writes it as an **audit note** into
  `order_status_history`.
- `src/lib/queries/orders.ts:158-170` (`toTimeline`) copies `row.note` through
  **unfiltered**.
- `src/components/checkout/order-timeline.tsx:66-70` renders `entry.note`
  verbatim to the customer.

`order_status_history.note` is a single field serving two audiences — an
engineer's audit trail and a customer's status page — and nothing in between
translates. Rewriting the strings would fix today's instances and not the cause.

This is what the customer of FV-2026-00623 sees on their order page right now,
read from production:

| Timeline entry | Problem |
|---|---|
| `Order placed` | fine |
| `Payment captured` | *captured* is a payments term |
| `Refund of ₹135 sent to Razorpay (rfnd_TNeaZX8YweRyFi, cancelled_before_dispatch). It is complete when Razorpay's webhook confirms it.` | **webhook**; an internal refund id; a raw database enum |
| `Refund of ₹135 confirmed by Razorpay (rfnd_TNeaZX8YweRyFi).` | internal refund id |

### The rest of the sweep

Searching every customer-facing directory for *webhook, capture, reconcile,
sweep, RPC, idempotent, paise, server action, revalidate*, the rendered-copy
instances are:

| Where | Text | Note |
|---|---|---|
| `order_status_history.note` → timeline | the four rows above | **the main one**, systemic |
| `checkout-failure.tsx:386` | mentions "the thirty-minute sweep" | needs reading in context; *sweep* is internal |
| `order-format.ts:64` | "confirms as soon as the payment settles" | *settles* is borderline — a customer reads it, but it is the mildest of these |

Everything else the grep found is in comments, identifiers, or code — not
rendered. In particular `src/app/admin/orders/[id]/page.tsx:197` and
`refund-panel.tsx:245` both say *webhook* but are **admin-facing**, where the
vocabulary is arguably correct. I flag them because the owner may have been
reading one of those when they raised this; they are not customer copy and I
would not change them without asking.

---

# 9D · Everything else

## Address editing — the page claims a feature that does not exist

`src/lib/actions/address.ts` exports exactly three actions:

| Action | Line |
|---|---|
| `saveAddress` | 45 |
| `deleteAddress` | 116 |
| `setDefaultAddress` | 194 |

There is **no update path**. `saveAddress` looks up an existing row only to
decide whether the new one becomes the default (`address.ts:59-68`); it never
takes an id to edit. `address-book.tsx` offers "Remove" (line 230) and set-default
(line 134) and no edit affordance at all.

So a customer can add an address, delete it, and choose a default — and cannot
correct a typo in one. The workaround is delete-and-retype.

Worse, `/account/addresses` currently tells them otherwise:

> "The default is the one checkout preselects. **Editing anything here** never
> changes an order already placed — what ships is a copy taken at the time."

That sentence describes editing as though it were available. A5 has been open
since Phase 7; this is the first time the copy has been noted as actively
misleading.

When editing is built, the brief's point stands and matters: changing the PIN
must re-trigger the delivery quote, because the PIN sets the rate.

## Email — the interface is good, nothing has ever been sent

| Piece | State |
|---|---|
| `src/lib/email/types.ts` | `EmailAdapter` interface — exists |
| `src/lib/email/console-adapter.ts` | logs a line, returns `{ok:true, via:"console"}`; `isConfigured()` returns **false** on purpose |
| `src/lib/email/order-confirmation.ts` | builds a real message |
| `src/lib/email/index.ts` | selects the adapter; only ever returns the console one |
| Call sites | **one** — `src/lib/actions/checkout.ts:833` |

So: the abstraction is already the right shape, failure is already soft, and
exactly one of the seven messages the brief asks for exists (customer order
placed) — and even that one goes to a log line rather than an inbox.

**Missing entirely:** payment captured, shipped with tracking, delivered,
refunded, and — the one the brief calls out as the reason the shop cannot open —
**any notification to the owner that an order has arrived**. There is no owner
email path at all, not a stubbed one.

**Owner task, already documented** in `src/lib/email/index.ts:24-45`, and it is
accurate: pick a provider (Resend is least work on Vercel), verify the sending
domain with SPF and DKIM, set `EMAIL_API_KEY` and `EMAIL_FROM` in Vercel for
Preview and Production separately, then add one adapter file. Neither variable is
in `.env.example` yet.

## The logo — `logo-original.png` is used nowhere

`public/brand/logo-original.png` is **referenced by no file in the repository.**
The owner's supplied logo has never been rendered. Every surface draws
`TreadMark`, a vector redrawn by hand from it (`src/components/brand/logo.tsx:5-7`
says so explicitly).

| Surface | What renders today | Uses the PNG |
|---|---|---|
| Storefront header | `<Logo />` — `site-header.tsx:106` | ✗ |
| Storefront footer | `<Logo showTagline />` — `site-footer.tsx:63` | ✗ |
| Mobile nav | `<Logo />` — `mobile-nav-panel.tsx:69` | ✗ |
| Error pages ×3, 404 ×2, style guide | `<TreadMark />` | ✗ |
| **Favicon** | `src/app/icon.svg` — the tread path **hand-copied**, not importing `TreadMark` | ✗ |
| **OG / social preview** | `(storefront)/opengraph-image.tsx` — **text only, no mark at all** | ✗ |
| **Admin** | plain text "Foot Vault admin" — `shell.tsx:109`, `:162` | ✗ |
| Email templates | text only | ✗ |
| PDF / label output | does not exist | — |

Two things beyond "the PNG is unused": the OG image — the thing that appears when
anyone shares the shop on WhatsApp — carries **no logo whatsoever**, and the
favicon duplicates the tread geometry as literal SVG path data, so it and
`TreadMark` can silently drift apart.

There is no `apple-icon` and no web manifest.

## Add to cart — measured

Measured with Playwright against the staging database, five runs, warm (run 1
discarded as cold compile):

```
run 2: action 813ms · count 827ms   [Bag, 1 item -> Bag, 2 items]
run 3: action 810ms · count 825ms
run 4: action 803ms · count 815ms
run 5: action 803ms · count 814ms

median action 810ms · median count 822ms
```

The owner's "1–2 seconds" is real. **Median 822 ms** from click to the bag count
changing, on a local server with no network latency to Vercel; from Cuddapah to a
Vercel region with a Supabase round trip on top, 1–2 s is exactly what this
becomes.

The server log decomposes it precisely:

```
POST /product/puma-velocity-nitro-3-mens 200 in 524ms (application-code: 519ms)
  └─ ƒ addToBag(…) in 182ms
```

| Segment | Time |
|---|---|
| `addToBag` — rate limit, cart write | **182–238 ms** |
| The rest of the server's work | **~340 ms** |
| Client + transport | ~250 ms |
| **Total to visible change** | **~810 ms** |

So roughly **two-thirds of the wait is not the cart write.** It is the layout
re-render triggered by `revalidatePath("/", "layout")` at
`src/lib/actions/cart.ts:168`, which invalidates the entire root layout — forcing
the header to re-run all five of its parallel queries (`site-header.tsx:83`: nav,
popular products, user, bag count, saved count) before the response returns.

Three compounding causes, in the order I would fix them:

1. **No optimistic update.** `add-to-bag.tsx:51-102` awaits the server action and
   only then updates anything; the button reads "Adding…" for the full 810 ms.
   The codebase already does this correctly elsewhere — `cart-lines.tsx:86-91`
   and `save-for-later.tsx:39-43` both keep optimistic state and roll back. The
   add button is the one place that does not.
2. **`revalidatePath("/", "layout")` is the heaviest available hammer** for a
   number that lives in one header badge.
3. **`refreshBag()` cannot help.** `src/lib/stores/bag.ts` makes `refresh()` a
   **no-op while the drawer is closed**, which it is on a product page. So the
   `void refreshBag()` at `add-to-bag.tsx:77` does nothing there, and the count
   moves only because the layout was revalidated.

## Rate limiting — this one is done

Contrary to the brief's expectation, this is complete and real. Nine policies in
`src/lib/rate-limit.ts:41-79`, and I confirmed the backing function
`consume_rate_limit(p_bucket, p_limit, p_window_seconds)` **exists in the
production database** rather than trusting the call site.

| Surface | Policy | Where |
|---|---|---|
| Checkout / place order | `checkout` 10/60, per customer | `actions/checkout.ts:125` |
| Customer abandoning an order | `orderCancel` 20/60 | `actions/checkout.ts:562` |
| Razorpay webhook | `webhook` 300/60 | `webhook/route.ts:98` |
| Payment verify | `paymentVerify` 20/60 | `actions/payment.ts:105` |
| All admin mutations | `adminMutation` / `adminBulk` / `fulfilment` | `admin/guard.ts:133` |
| Serviceability, delivery check | `serviceability` 60/60 | `shipping-quote.ts:92`, `delivery-check.ts:59` |
| Cron route | bearer `CRON_SECRET`, denies when unset | `cron/release-abandoned-orders/route.ts:238-247` |

The cron route is protected by a secret rather than a limiter, which is the right
control for that surface.

One property worth stating out loud because it is a deliberate choice and not
obviously right: `consumeRateLimit` **fails open** — if the counter errors or
returns no row it logs and returns `allowed: true` (`rate-limit.ts:88-92`,
`:108-131`). A database wobble therefore removes all rate limiting silently. For a
shop this size that is the correct trade, but it should be a decision the owner
knows about rather than a detail in a helper.

## Production error reporting — nowhere

There is **no error reporting of any kind**. No Sentry, no `instrumentation.ts`,
no `onRequestError`, no alerting, no dead-letter path. The only artefact is
`src/app/global-error.tsx`, which is a UI fallback shown to the *customer* — it
reports nothing to anyone.

So today: a server error on the live shop becomes a `console.error` in Vercel's
runtime logs, where it is visible only if someone opens the dashboard and looks,
and ages out with the plan's retention. Every failure path this codebase writes so
carefully — the "loud, but not fatal" comments in `refunds.ts:511-517`, the
history-write failure at `transition.ts:195`, the rate-limit fail-open — logs to a
place nobody watches. **The care taken to log well is currently wasted.**

## The settings page, as a shopkeeper

Assessed against the brief's own standard. What is genuinely good: every control
has a consequence line, money is in rupees with a ₹ prefix, and the page never
shows a stale default (the zero-fallback reasoning at `page.tsx:64-73` is
correct and worth keeping).

What a shopkeeper hits:

| Problem | Detail |
|---|---|
| The page denies its own contents | The bold "Delivery rates are not set here" is the first thing in the panel — see 9A |
| Prose outweighs controls | Every setting carries 3–5 grey lines; the widgets are visually secondary |
| No grouping a shopkeeper would name | One tall column: delivery charge, Pay on Delivery, prepaid discount, RTO, outage, wallet. The brief asks for *Delivery & rates, Cash on delivery, Returns, Store details, Appearance* |
| Jargon remains | "RTO" is avoided in customer copy but "Shiprocket" appears throughout; "Recover the 18% GST on delivery in the upfront amount" is a sentence for an accountant |
| Toggles are not toggles | Three 16-px native checkboxes, unstyled |
| Progressive disclosure hides features | The flat-fee field and the flat deposit block do not exist until the mode is switched, so their existence is undiscoverable |
| Two unset values fail silently to the eye | `flat_cod_deposit_mode` and `wallet_low_balance_paise` are null in production and render as "Not chosen yet" / ₹0 |

## Still hardcoded

The literals gate (`scripts/audit/literals.ts`) is a good gate whose docstring
records this same number escaping **three** times. It has escaped a fourth, into
the one shape the gate cannot see:

```
src/app/(storefront)/product/[slug]/page.tsx:82   free_above_paise: 249900,
src/lib/queries/cart.ts:96                        free_above_paise: 249900,
```

₹2,499, in code, on the product page and in the cart, while production says
₹6,499.

The gate scans for `/₹\s*\d/` and `/\bRs\.?\s*\d/` (`literals.ts:69-71`). These are
bare integers in a TypeScript object literal that only *become* "₹2,499" after
`formatPaise()` renders them. No rupee sign is ever typed, so the regex cannot
match, and the gate reports clean.

**Severity is P2, not P1, and the reason matters:** these are fallbacks, reached
only if `site_settings.shipping` is missing or unreadable. Production has the row,
so nothing is wrong on screen today. But this is precisely the failure that
already shipped once — a page promising a threshold checkout does not honour —
and it is now armed in two more places with the gate blind to it.

The content half of the gate (reading `pages.body`, the announcement, and every
owner-editable text column including inside jsonb) is genuinely thorough and I
found no problem with it.

---

## What I got wrong and caught

**I nearly reported the toggles as missing.** After confirming the settings
existed in the database and the form passed them in, my working hypothesis was a
stale production deployment — the tidy answer. I checked it: production is
`dd4c67b`, which contains Batch 2's `136678e`. Then I nearly reported "the code
renders them unconditionally, therefore they are visible", which is a
code-reading conclusion of exactly the kind that produced this bug in the first
place. Given that the whole plan turns on this answer, I promoted an admin
account and took the screenshot. The screenshot is what turned a plausible story
into the actual one — and it changed the fix from "build the toggles" to
"rewrite the page's information design", which is a completely different piece of
work.

**I attributed the webhook sentence to the wrong place.** My first grep found
*"It is done when the webhook confirms it"* in the **admin** refund panel and I
was ready to report that the brief had mislabelled an admin string as customer
copy. It had not. The real instance reaches the customer through
`order_status_history.note`, which I only found by grepping for the sentence in
`src/lib/` rather than in the component tree. Had I stopped at the first match I
would have reported a systemic problem as a non-issue.

**I assumed rate limiting would be missing** because the brief said it had never
been confirmed. It is complete. I then nearly recorded it as done on the strength
of the call sites alone — which is the 9A mistake again — so I checked that
`consume_rate_limit` actually exists in the production database. It does.

---

## What this audit does not prove

- **The screenshot is staging, not production.** Staging and production hold the
  same `shipping_rate_mode` and the same deployed commit, so I am confident the
  rendering is identical — but I did not photograph production's admin.
- **The add-to-cart numbers are from a local dev server** (Turbopack, no
  production build) against staging. The *ratio* — ~180 ms of cart work against
  ~340 ms of layout re-render — is the reliable part. The absolute 810 ms will
  differ in production, plausibly upward once real network latency is added.
- **I did not run the full gate suite.** The `npm run audit` chain writes to
  staging and this stage is read-only; findings about the gates come from reading
  them, not from running them.
- **I did not verify Batch 3's five order-page panels are *operable*** — only
  that they are imported and rendered. That is the same weaker claim I am
  criticising, and I am flagging it rather than hiding it.
- **`checkout-failure.tsx:386`** mentions "the thirty-minute sweep"; I did not
  read enough surrounding context to be certain whether it is rendered copy or a
  comment. It needs one look before the copy sweep.
- **I did not audit `payments.status` not being moved to `refunded`** beyond
  noticing it on this one order. Whether that is systematic needs a query across
  all refunded orders.

---

## What needs the owner

1. **Contact details.** Production currently holds phone `+91 91602 52643`,
   WhatsApp `+91 98450 22001`, email `hello@footvault.in`, address *Classic
   Vastralayam Complex, Cuddapah 516360*. The address matches the real pickup PIN
   (516360), so it is plausibly correct — but the WhatsApp number is a Bengaluru
   series against a Cuddapah shop, and `instagram.com/footvault` /
   `facebook.com/footvault` look like placeholders. **Contacting the shop is the
   only route to a replacement claim**, so each of these needs a yes/no from the
   owner rather than a guess from me.
2. **An email provider** — the four steps above. Nothing ships to any customer
   until this is done.
3. **Real product photography** — unchanged as the largest blocker to opening.
4. **The flat-mode Pay-on-Delivery deposit** (`flat_cod_deposit_mode`) is null in
   production, by design. Until the owner sets it, flat mode cannot offer Pay on
   Delivery. Correct behaviour, still an unmade decision.
5. **The wallet low-balance threshold** is null, so the dashboard warns at
   nothing.
6. **The no-refunds-except-replacement position** still deserves a look from
   someone who knows Indian consumer law, as flagged in earlier phases.

---

## Recommended shape for Stage 2

Not the plan — Stage 2 is a separate document and a separate gate. But the audit
points somewhere specific and it is worth saying before the detail fades:

The single highest-value change in this phase is **not any of the individual
bugs.** It is a gate that asserts a named control is on screen and changes the
value it names. Without it, Batch A's toggle work will be reported green by the
same mechanism that reported Batch 2's green. Every other fix here is
conventional; that one is what stops the phase repeating.

The two P0 code defects (9B's guard, 9C's missing `refunded` branch) are both
small, both well-understood, and both need a test that constructs the
already-refunded state — which no existing harness does.

They also interact, and the brief asks for interactions to be named before
either is written: **fixing 9B changes what 9C must say.** Once a refunded order
can be cancelled, its status becomes `cancelled` and `whatHappensNext` returns at
line 120 on the `cancelled` branch — never reaching the `refunded` branch that
9C adds. So the refunded copy has to be correct for a refunded order that is
*still confirmed* (today's FV-2026-00623) **and** for one that has since been
cancelled, and the cancelled blurb — *"This order was cancelled and the pairs
went back on the shelf"* — currently says nothing about the money. Writing either
fix without the other produces a page that is still wrong, in a new way.
