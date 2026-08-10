# Six issues from live use — execution report, 2026-08-10

Everything below was driven by the owner's list of six issues from live use,
P0 first. Four pull requests are open; what merges alone and what waits for
the owner is stated per item, per the phase 9 merge policy.

| PR | Branch | Contents | Merge status |
| --- | --- | --- | --- |
| #32 | `fix/emails-wait-for-the-money` | P0: emails move to the webhook | **Held — touches payments** |
| #33 | `fix/toast-nav-doors` | Toast contrast, nav parity, reachability gate | Mergeable once battery green |
| #35 | `feat/loading-states` (stacked on #33) | Skeletons, pending states | Mergeable once battery green |
| #34 | `feat/discounts-stack` | Discount stacking + ceiling + migration | **Held — money + production migration** |

---

## P0 — emails fired before payment was confirmed

### Root cause

`placeOrder` in `src/lib/actions/checkout.ts` sent the customer's "Order
confirmed" email and the owner's new-order alert the moment
`create_order_with_stock` returned — before the Razorpay modal had even
opened. The webhook was already the sole authority for order state; the email
layer simply never inherited that. A customer who closed the modal got a
confirmation for an order the thirty-minute sweep then cancelled, and the
owner was alerted to a sale that never happened.

### The fix (PR #32)

- `src/lib/actions/checkout.ts` sends **nothing**. The email import is gone
  from the file entirely.
- `src/lib/orders/payment-state.ts` — the one function allowed to move order
  state from a payment event — now composes and sends both messages on the
  single branch that moves a pending order to confirmed. It reads the order
  row and its items back from the database, so the receipt states what was
  actually written, not what the checkout believed.
- **Pay on Delivery follows automatically**: the deposit is a Razorpay
  capture through this exact seam (`src/lib/payments/cod.ts` delegates
  everything to the Razorpay adapter), so the same trigger covers it with no
  special case.
- Idempotency is inherited, not added: the send is gated on the
  `customerNote` sentinel that only the pending→confirmed transition sets, so
  a redelivered webhook cannot email anyone twice. Proven: ten deliveries of
  one event → exactly one confirmation, one owner alert.
- The thin "Payment received" template was retired. The full confirmation now
  arrives at capture and carries the same facts; two emails in the same
  minute saying the same thing was the alternative.

### Decision: an unpaid order sends nothing at all

Not an "awaiting payment" email. The customer is looking at the payment modal
at that moment, and the order page already says awaiting payment. An email
would either duplicate the screen they are on or arrive as spam for every
abandoned modal — there is roughly one abandoned modal per real order in the
production data already.

### Other side effects hanging off order creation — audited

| Side effect at creation | Verdict |
| --- | --- |
| Stock claim | Correct by design — holds units for the payer; the sweep releases after 30 min |
| Cart conversion | Correct — released back on any cancellation |
| Coupon redemption | Already safe — `cancel_order_with_restock` releases the redemption and refunds `used_count`, idempotently (migration 20260810080200) |
| Address-book save | User-requested, harmless |
| `payments` row | Required before the modal opens so the webhook can resolve the order |
| Emails | The one wrong one. Fixed. |

### Who already received a wrong email

Resend's entire send history is nine emails. Cross-referenced against
production orders:

- **One customer, one wrong email.** `neftlix100@gmail.com` received "Order
  FV-2026-00661 confirmed" at 00:54 IST on 2026-08-10; the order was swept
  cancelled-unpaid at 01:30. Nothing was charged. The owner received the
  matching wrong new-order alert.
- FV-2026-00660 (same address) got its confirmation ~40 seconds before
  capture, but that payment settled, so the words ended up true.
- Nothing else confirmation-flavoured has ever been delivered.

### The gate

- `scripts/audit/emails.ts` §8 (pure): the checkout action **cannot
  reference the email module** — asserted against the source — and the two
  senders are called from the payment seam only, gated on the confirmed
  transition. 52 passed, 0 failed.
- `scripts/audit/checkout-orders.ts` (staging, real seam): with the console
  adapter captured, every order created-but-never-paid produced **zero**
  emails, and ten deliveries of one captured payment produced exactly one
  confirmation + one owner alert and nothing else. All checks passed.
  The harness strips `EMAIL_API_KEY` before running so a gate can never again
  email the real owner a fake order.

---

## Issue 1 — the unreadable toast

**Root cause, traced to the mechanism.** `src/components/ui/sonner.tsx`
called `useTheme()` from next-themes, but the app has no ThemeProvider — so
the toaster followed the customer's OS setting while its background stayed
pinned to the light `--popover` token. On a phone in OS dark mode, sonner
stamped `data-sonner-theme="dark"` and its own stylesheet painted the
*description* (the product name) `hsl(0,0%,91%)` — near-white on paper. The
title stayed dark because it used the pinned token, which is why only the
product name vanished. Not a regression from the optimistic-update commit;
it dated from the component's creation and surfaced with whoever first looked
in OS dark mode.

**Fix.** `theme="light"`, pinned — the site has exactly one design.
`next-themes` removed; sonner was its only importer. Sweep found no other
OS-theme follower anywhere in `src`.

**Measured after the fix** (rendered, real browser, add-to-bag toast):
title 17.81:1, description 10.25:1, action 17.81:1 — identical in OS-light
and OS-dark. The AA floor is 4.5:1.

**Gate.** No harness had ever raised a toast — a toast exists for 3.5 s after
an interaction no scanner performs, which is why every contrast gate stayed
green. `scripts/audit/a11y.ts` now adds the size to a real bag through the
real page in an OS-light context and an OS-dark one, and measures the
rendered contrast of every text node in the toast against 4.5:1.

---

## Issue 2 — coupon and prepaid discount combine (PR #34, held)

- Both apply, **additive on the original goods subtotal**, never compounding,
  goods only — delivery untouched. Two named lines everywhere: the `Totals`
  component and the confirmation email already drew each part independently,
  so stacked orders render right by construction.
- New setting **`max_total_discount_percent`** caps the pair as a share of
  the goods total. The coupon keeps its full value first; the prepaid part
  absorbs the clamp — the coupon is the number the customer was promised by
  name. Set it at /admin/settings under "Discount for paying online".
- **Built unset, failing loudly.** Unset: stacking is withheld — the customer
  gets the larger single discount and the server log names the missing
  setting. And `create_order_with_stock` refuses a stacked pair outright
  (errcode `DCUNS`) when no ceiling reaches it, so the TypeScript fallback
  and the SQL authority cannot drift apart. **Until you set the number, live
  behaviour is exactly what it was yesterday.**
- Migration `20260810120000_discounts_stack_under_ceiling.sql` restates the
  function; the ceiling is re-applied on the subtotal computed under the row
  lock, in basis points. Staging rebuilt from empty: 96 migrations, every
  check green.

**Gates updated** (the old ones asserted larger-of-two):
`audit:coupons` §3 now proves — against staging — the combination written to
both columns, `discount_total` = sum of parts, the exact ceiling arithmetic
(worked example: coupon ₹455.00 whole + prepaid clamped to ₹90.88, together
exactly on a 12% ceiling of ₹545.88), the `DCUNS` refusal, and that a coupon
alone still needs no ceiling. `audit:settings-controls` operates the new
field by its visible label and proves an empty box stores **null**, never
zero.

**Held for the owner** because it changes money computation and carries a
production migration. After approval: snapshot, dry-run push, PostgREST
gates, then merge — the documented procedure.

---

## Issue 3 — mobile nav parity

The drawer's utility list held only "Saved items". Desktop's account menu
also offered "Your orders". Fixed, and the parity check went further — see
issue 4, because the two turned out to be the same defect.

The drawer now carries: **Your orders**, **Addresses**, **Saved items**, and
the signed-in identity opens the account overview. The desktop menu gains
**Addresses** and the same identity-as-door.

---

## Issue 4 — "address editing is still not there"

**It was built, deployed, and working the whole time.** Commit 60d287e
("the address book learns to edit") shipped last night; the Edit control is
live in `AddressBook` on `/account/addresses`, and `audit:address-book`
operates it and passes. The answer to "not deployed, not reachable, or built
somewhere I'm not looking" is: **not reachable**. `/account/addresses` had
zero inbound links anywhere on the site. So did `/account`, the only page
that links to it. A page with no door does not exist for a customer.

**The process question, answered plainly.** The operate-and-assert gate
covers admin only. `audit:settings-controls` and `audit:admin-pages` prove
the 31 admin controls are on screen and operable; on the customer side,
`audit:address-book` operates the edit control *after navigating directly to
the URL* — proving the control works, never that a human can arrive at it —
and `audit:links` crawls outward from the home page, which is structurally
incapable of finding an orphan. Every gate was green while the feature was
unreachable.

**The extension.** New gate `audit:reachability`
(`scripts/audit/customer-reachability.ts`):

- The page list is **derived from the filesystem** — every `page.tsx` under
  `src/app/(storefront)` — so a page added next month is expected the moment
  it exists, with no registry to forget.
- The crawl plays the customer: signed in, starting at `/`, following only
  visible links, and **operating** the mobile drawer and the account menu —
  both mount their contents only when opened, so a DOM-only harvest is blind
  to exactly the surface that failed.
- Run at 390 px and 1440 px separately, because "reachable on a laptop,
  orphaned on the phone" is precisely how My Orders shipped.
- Two exclusions, reasons stated in the file: `/style-guide` (internal), and
  `/order/[orderNumber]` (reached by completing checkout; proven by
  `audit:checkout` and `audit:bag`).

**It caught a real orphan on its first run**: after the menu fixes believed
complete, `/account` itself was still unreachable. That is the gate doing on
day one what it exists for. Now green: 14 of 14 pages reachable by clicking
at both widths.

---

## Issue 5 — the site feels slow: measurements (production, no fixes applied)

**The region check you asked for first is the whole story.**

| Component | Region |
| --- | --- |
| Vercel edge (customer-facing) | `bom1` — Mumbai |
| **Vercel functions (all SSR)** | **`iad1` — Washington DC** |
| Supabase production database | `ap-south-1` — Mumbai |

Every response carries `x-vercel-id: bom1::iad1::…` — request arrives in
Mumbai, crosses to Washington to render, and every database query crosses
back to Mumbai and returns. One Mumbai↔Washington round trip is ~190–230 ms;
a page render pays one for the request itself plus one per sequential wave of
queries.

**Server response times, production, warm** (TTFB over 5 samples each, curl
from the same network that reports the site slow):

| Route | TTFB range | Median total | HTML size |
| --- | --- | --- | --- |
| `/` | 0.66–1.20 s | ~1.19 s | 209 KB |
| `/shop` | 0.60–0.95 s | ~1.00 s | 275 KB |
| `/product/[slug]` | 0.57–1.03 s | ~0.85 s | 173 KB |
| `/cart` | 0.58–0.64 s | ~0.64 s | 82 KB |

First hit after idle: 3.23 s TTFB on `/` (cold function + cache MISS).
Apex → www adds a 308 redirect (~120 ms) before any of this.

**Queries per page.** The catalogue reads are cached (`unstable_cache`,
1 hour): category tree, brands, homepage sections, product row. What every
page pays per request is the personal wave — auth user, bag count, saved
count (run in parallel in `SiteHeader`) — plus the page's own dynamic reads
(cart: the bag; product: settings + saved state, then related + saved state —
two waves). No classic N+1 was found; the pages batch with `Promise.all`
correctly. The problem is not query count — it is that **each wave costs a
continent** instead of 2–5 ms.

**Cold starts** are real but secondary: one 3.2 s outlier against a dozen
sub-1.2 s warm samples on Fluid Compute.

**Why staging Lighthouse says 99 while the live site crawls:** staging runs
the server on localhost next to a Mumbai database measured from India — no
transcontinental hop exists in that setup, so it cannot see the one that
dominates production. Both measurements are honest about different systems.

### The fix I am asking to apply (not yet applied — you said measure first)

Pin the function region to `bom1` (one `vercel.json` with
`"regions": ["bom1"]`, or the dashboard setting). Expected effect: the
request-path detour disappears and every query wave drops from ~200 ms to
single digits — warm TTFB should land around 0.2–0.4 s. This is a
config-only deploy, reversible by reverting the commit. Loading states
(issue 6) were built independently and are worth keeping either way.

---

## Issue 6 — loading states (PR #35, after the measurements as instructed)

- `loading.tsx` for the eight dynamic routes that streamed a blank viewport:
  cart, checkout, wishlist, account overview / orders / order detail /
  addresses, and the guest order page. Every skeleton is built from the real
  page's own measurements — same containers, same `23rem` money column, same
  grid gaps — so nothing shifts when data lands. Listing/product/search
  skeletons already existed; the set is now complete.
- Complete route-level fallbacks are also the route-transition indicator:
  navigation swaps to the destination's skeleton instantly, which is the
  approach this Next version's docs explicitly prefer over a progress bar.
  If you want a top bar as well, say so — it is an hour, not a project.
- Pending states: a sweep found one gap — the drawer's sign-out button now
  shows "Signing out…" and disables. Everything else that triggers work
  (add-to-bag, steppers, coupon field, delivery check, place order, admin
  saves) already held one.

---

## Autonomous decisions, listed

1. Unpaid orders email nothing (P0) — reasons under P0.
2. The "Payment received" template was retired rather than kept alongside
   the moved confirmation — same minute, same facts, twice.
3. Confirmation email copy: "Your order is placed" → "Your order is
   confirmed" — at capture time, that is now the truth.
4. Toast pinned to light theme rather than given a dark variant — the site
   has one design; a dark toast on a light page is a third design.
5. Stacking clamp order: coupon keeps its value, prepaid absorbs — the
   coupon is the number the customer was told by name. Reversible by one
   line in SQL and one in TS if you want proportional instead.
6. Ceiling scope: it governs the **combination** only. A coupon alone is
   still bounded by its own `max_discount`; the prepaid discount alone by
   its own setting. A lone 50%-off code is not silently cut to the ceiling.
7. Region fix held, per "measure first, report before fixing".
8. Route-transition indicator implemented as complete route-level skeletons,
   not a progress bar — the framework's own recommendation.

## Known imperfections

- The reachability crawl operates the header menus on the home page only
  (they are identical on every route); a page reachable *only* from a menu
  on some other page would need the harvest widened.
- `audit:reachability` runs signed-in; a signed-out-only orphan (e.g. a
  sign-in pitch page) would not be caught. No such page exists today.
- The email wiring gate greps source text; a sufficiently creative indirect
  import would evade it. The behavioural half in `audit:checkout` would
  still catch the outcome.
- Cold-start frequency is characterised from samples, not from function
  logs over days.
- The home page has no `loading.tsx` on purpose: its sections are cached
  and render fast; a skeleton there would flash on every visit for nothing.

## What needs the owner

1. **Merge approval for PR #32** (P0 — payments) and **PR #34** (discount
   stacking — money + production migration). #33 and #35 merge on the green
   battery under the standing policy unless you want them held too.
2. **The ceiling number**: `max_total_discount_percent` at /admin/settings.
   Until set, discounts do not stack (larger single discount applies).
3. **The region fix go-ahead** (issue 5). One config deploy.
4. Optional: whether FV-2026-00661's customer deserves a follow-up note;
   the order page already told them it was cancelled with nothing charged.

---

# Postscript — the merges, executed and verified (2026-08-10, morning)

The owner returned with three PRs unmerged and one correction: FV-2026-00662's
emails had fired at creation. Correct — #32 had been held for approval, so the
old wiring was still live. The wrong-email count therefore rose before the fix
landed: **one customer (neftlix100@gmail.com), two wrong confirmations**
(FV-2026-00661 and FV-2026-00662, both later swept cancelled-unpaid), plus the
two matching wrong owner alerts. Nothing was charged on either.

## Merge order, as executed

**1. PR #32 (P0 emails) — merged first.** No migration; stops the live harm.
Deployment `dpl_5ET9fTkzTVctxZyM7kY3mqgWY5yb` verified via the Vercel API:
READY, target production, aliased to www.footvault.in, commit = the merge SHA.
Smoke check green (storefront 200s, /admin 404 anonymous).

*Verified on production, as instructed:* a real guest order was placed through
the live UI — product page, size chip, checkout form, Razorpay window opened —
and abandoned. FV-2026-00663 existed `pending/unpaid` at 04:14:26 IST and
**Resend's send log did not move**: zero emails for an order that was created
and never paid. Under the old code both emails left within one second of
creation. The probe order was then cancelled through
`cancel_order_with_restock` (stock restored, verdict `cancelled`).

**2. PR #34 (discount stacking) — second, migration before code.**
- Snapshot first: `backup-20260810-0947-schema.sql` (157 KB, contains the
  function) and `backup-20260810-0947-data.sql` (532 KB), content-verified.
- `supabase db push --dry-run` named exactly one pending migration,
  `20260810120000_discounts_stack_under_ceiling.sql`; pushed; production's
  migration history now records it.
- PostgREST gate: the RPC called over REST **with** `p_max_total_discount_bps`
  answered with the function's own `CNVRT cart_unavailable` — schema cache
  reloaded, new signature live, old code unaffected (the parameter defaults).
- Then the code merged. Deployment `dpl_JDHTxc3z4PZVbB3FxS7YhM5rAAWg` verified
  via the API (READY, production, merge SHA 648f7da) and smoke-checked.
- One process stumble, recorded honestly: the first dry-run reported "up to
  date" because it ran from `main`, which did not yet contain the unmerged
  migration file. Caught by checking the production migration history and the
  live function signature directly before believing it.

**3. PR #36 (this report) — last.** Docs only.

## The ceiling, set, and the before/after the owner asked for

`max_total_discount_percent` was set to **30** after #34 deployed. The demo
basket, driven through the real production checkout both times — Samba OG
(`adidas-samba-og-mens`, ₹9,999), code NEW10 (a 5% coupon), prepaid discount
20%, delivery free above ₹1,599, PIN 560001, paying online:

| | Before #34 | After #34 + ceiling 30% |
| --- | --- | --- |
| Subtotal | ₹9,999 | ₹9,999 |
| Shipping | Free | Free |
| Paying online | **−₹2,000** | **−₹2,000** |
| Coupon NEW10 | — (lost to the larger discount) | **−₹500** |
| **Total / button** | **₹7,999** | **₹7,499** |

The pair (₹2,500) sits well under the 30% ceiling (₹2,999.70 on this basket),
so both discounts apply whole. The bag's own preview said "about ₹500 off at
checkout" in both runs and is now the truth on the next page rather than a
promise the larger discount overrode.
