# Phase 6 (revised) — adversarial pass

Written after the feature work, against what this phase actually added rather
than against the code as I remembered writing it. This supersedes the review of
the same name from the first Phase 6 run, which is in git history at `996f0b2`
and remains accurate about that run's findings — including **F-2**, which is
still unfixed and repeated below.

The brief names five attempts specifically. Each is answered below with what was
tried and what happened, followed by what this pass could **not** reach.

---

## 0 · What this phase added to attack

Part 0 introduced two columns that decide money: `orders.advance_amount` (what
is taken online) and `orders.balance_due_on_delivery` (what a courier collects
in cash). If either can be moved from a browser, the shop ships goods for a
rupee and finds out by reconciliation, weeks later.

It also added a settings row that decides the advance rule, a quote row that
decides the delivery fee, and — via the admin panel — roughly forty new server
actions.

---

## 1 · Altering `advance_amount` or `balance_due_on_delivery` from the client

**The brief's headline attempt.** `npm run audit:security-advance`, thirteen
attempts, every one refused. Each is made with a real signed-in customer's JWT
against the real PostgREST endpoint — not anonymously, and not through the
application's own code. That is the actual threat: somebody who legitimately has
an account, has read the JavaScript bundle, and is now talking to the database.

| Attempt | Result |
|---|---|
| Rewrite another customer's `advance_amount` | refused, row unchanged |
| Rewrite their `balance_due_on_delivery` | refused |
| Rewrite both at once, preserving the sum | refused |
| Rewrite `grand_total` | refused |
| Stamp `cash_collected_at` | refused |
| Set `payment_status` to `paid` | refused |
| The same, on an order they **do** own | refused — owning an order is not permission to decide what you owe on it |
| Call `create_order_with_stock` with a chosen `p_advance_amount` | refused (`42501`) |
| Read anybody's stored `shipping_quotes` row | refused |
| Insert a free-delivery quote for themselves | refused |
| Lower `cod_advance_minimum_paise` in `site_settings` | refused |
| Invent a shipment collecting nothing | refused |
| Forge a line on the order timeline | refused |

The load-bearing control is the grant, not the policy: `create_order_with_stock`
is `service_role` only. Worth stating because **I removed and re-created that
function in this phase**, which drops its privileges — the re-grant is in the
same migration and was verified afterwards by reading `proacl`, and
`audit:checkout` independently asserts `anon cannot call create_order_with_stock`.

The database-side backstop is the check constraint
`advance_amount + balance_due_on_delivery = grand_total`. Even a successful
write of one column alone would be rejected.

## 2 · Calling admin server actions as a plain customer

Covered by `audit:admin` (23 held, 0 holes), unchanged from the first run and
re-run here. `adminAction` re-checks `is_admin()` **against the database** —
`profiles.role` for `auth.uid()`, not a JWT claim — before anything runs, and
`eslint-rules/admin-actions-must-guard.mjs` fails the build on any export under
`src/lib/actions/admin/` that skips it.

That rule earned its place twice in this phase. It caught an action of mine that
did no work but would still have been a POST endpoint in the bundle, and the
roughly forty actions the subagents added all went through the wrapper because
skipping it does not compile.

**New this phase, and verified in a browser:** `audit:admin-pages` signs in as a
plain customer and opens `/admin/settings` and `/admin/orders/[id]`. Neither
renders any of its content.

## 3 · Escalating through a crafted form payload

Every admin action validates with Zod before acting, and the settings action
merges over the stored object rather than replacing it — so a payload naming a
key the form does not edit cannot drop `currency` or `regions`. Asserted:
"saving preserves the keys the form does not edit".

Self-promotion is refused by the `guard_profile_role` trigger, asserted in
`audit:admin` ("a customer cannot promote themselves to admin").

## 4 · Reading admin-only data through PostgREST

`shipping_quotes` returns nothing to a customer (§1). `payments` and
`payment_events` return zero rows, asserted in `audit:checkout`. Shipments are
readable only through `owns_order(order_id)` — which is what makes the new
customer-facing tracking safe: it reads through the caller's own RLS client and
does not re-implement the ownership rule.

## 5 · Mutating another customer's order

Refused at every column tried (§1), and `audit:admin` separately asserts a
customer cannot read, mark delivered, forge a timeline line for, or invent a
shipment against an order that is not theirs.

---

## 6 · What this pass could not reach

Stated plainly, because a security review that only lists what it checked is
half a review.

1. **No test drives a Next Server Action endpoint over HTTP with a forged
   payload.** Actions re-check authorization inside `adminAction`, and the RPCs
   they depend on are covered directly — but nothing posts an action id from
   outside the app. This was named as the most valuable missing test in the
   previous review and it is still missing. It is the one gap I would close
   first.
2. **The Razorpay webhook was not attacked in this phase.** Phase 5 covered
   signature verification and idempotency and nothing here changed that path —
   but the *meaning* of a capture changed, and a forged short capture against a
   Pay-on-Delivery order is now a more interesting attack than it was. The
   expectation is `advance_amount` and a short capture is still refused with
   `illegal_transition`, which is unit-covered; it is not covered end to end.
3. **Storage was not attacked.** The admin panel now uploads to Supabase
   Storage, in one case via a signed upload URL minted by a guarded action. The
   grant was read, the flow was not adversarially tested.
4. **Rate limits were not exhausted deliberately.** They are configured and
   exercised incidentally; nobody tried to run one dry.

---

## 7 · Findings carried forward

**F-2 (unfixed, from the first run).** `/admin` returns **200** to an anonymous
visitor, rendering the not-found body, while a genuinely missing path returns
404. Nothing leaks, but the status difference discloses that the route exists —
the one thing the guard was written to hide. Same Next.js behaviour as the API
soft-404 fixed in that run.

**F-3 (new, low).** `site_settings.contact` appears to hold placeholder values.
Not a vulnerability, but the returns policy makes contacting the shop the only
route to a replacement claim, so wrong details make a published policy
unclaimable. Flagged to the owner.

---

## 8 · Verdict

Everything the brief asked to be attempted was attempted, and none of it worked.
The money split is defended at three layers that would each have to fail
independently: the grant on the function that writes it, the RLS policies on the
columns, and a check constraint that rejects an inconsistent pair outright.

The residual risk is not in what was tested but in §6 — principally that no test
posts to a Server Action endpoint from outside the application.
