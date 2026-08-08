# Phase 6 — the adversarial pass

Run as its own step, after the feature work, deliberately cold: the goal was to
break the panel, not to confirm it. Phase 5 established what a separate
adversarial reader is worth — E-1 was an anonymous, free, unbannable way to
empty the shop's stock, and no amount of charitable self-review would have found
it — so this phase ran the same discipline with a single agent by making the
pass a distinct piece of work with its own artefact.

The artefact is `scripts/audit/admin-security.ts`, wired to `npm run audit:admin`
and folded into `npm run audit`. **It runs over the network against the real
database with a real customer session.** Nothing is mocked, because the question
is whether the deployed policies hold, and a mock of a policy is a test of the
mock.

**Result: 1 hole found and fixed, 23 checks holding.**

---

## The premise

The brief was blunt about it and it is worth restating because every check below
follows from it:

> Middleware returning 404 is not authorization.

`src/lib/supabase/proxy.ts` 404s `/admin` for a non-admin. That protects
*navigation*. A Server Action is a POST to a route the middleware matcher does
not distinguish from any other, addressed by an opaque id that ships inside the
JavaScript bundle every visitor downloads. So the suite does not go through the
panel at all. It goes straight at PostgREST and the RPCs with a valid customer
JWT, which is where a real attacker would go.

---

## F-1 · `reconcile_inventory()` was executable by any signed-in customer

**Severity: low-to-moderate. Found on the suite's first run. Fixed.**

```
✗ HOLE  reconcile_inventory() is not executable by a customer — error=NONE
```

A signed-in customer could call the reconciliation RPC and receive every
variant's id, SKU and stock level in the shop, plus any drift between the ledger
and the counts.

**Root cause, not symptom.** `CREATE FUNCTION` grants `EXECUTE` to `PUBLIC` by
default. `anon` and `authenticated` inherit that grant; they never hold it
individually. So this:

```sql
revoke execute on function public.reconcile_inventory() from anon, authenticated;
```

revokes a grant those roles never had, leaves the `PUBLIC` grant standing, and
*reads as correct* — a revoke line sitting directly beneath the function it is
supposed to protect. Two other functions written in the same sitting,
`consume_rate_limit` and `cancel_order_with_restock`, say `from public, anon,
authenticated` and were never exposed. One line out of three was wrong.

This is the exact class of defect that survives self-review. Reading the
migration, the revoke is there and it names the roles you would think of. Only
executing it as a customer shows it does nothing.

*Fix:* `supabase/migrations/20260807233000_fix_reconcile_inventory_grant.sql`.

**Generalised rather than patched.** After fixing it, every function in `public`
was audited for a residual `PUBLIC` execute grant. Eight had one. Seven are
deliberate and are now documented as such in
`20260807233100_revoke_trigger_function_execute.sql`:

| Function | Why `PUBLIC` is correct |
|---|---|
| `catalog_query`, `color_family`, `product_is_live` | the storefront's own reads, called by `anon` |
| `is_admin`, `owns_order`, `can_access_cart` | RLS helpers; policies evaluate them as the caller, and each only ever answers a question about the caller themselves |
| `current_guest_token` | reads a header the caller sent |

The eighth, `record_inventory_movement()`, is `SECURITY DEFINER` and writes the
stock ledger, so it looks alarming in an ACL listing. **It is not exploitable,
and that was verified rather than assumed:**

```
ERROR: 0A000: trigger functions can only be called as triggers
```

Postgres refuses direct invocation regardless of who holds `EXECUTE`. Revoked
anyway, so the next person reading the ACL list does not have to re-derive it.

---

## What held

Twenty-three checks, in the four categories the brief named.

### 1 · The predicate everything rests on

| Check | Result |
|---|---|
| A plain customer is not an admin | held |
| A customer cannot promote themselves to `admin` | held — `guard_profile_role` refuses the write |

If self-promotion worked, nothing else in this document would matter.

### 2 · Admin-only data through PostgREST directly

Eight tables, read with a valid customer JWT and no panel involved:

| Table | What it would have leaked |
|---|---|
| `inventory_movements` | the stock ledger |
| `shipments` | AWBs and courier detail |
| `shipment_events` | fulfilment history |
| `payments` | money |
| `payment_events` | the webhook ledger |
| `rate_limits` | the limiter's own counters |
| `integration_tokens` | **a live Shiprocket bearer token** |
| `coupons` | unissued discount codes |

All eight returned nothing. `integration_tokens` is the one that would have
mattered most — the token in it is valid for 240 hours and authenticates against
a live logistics account that can create real parcels. It has RLS enabled, no
policies at all, and every grant revoked from `anon` and `authenticated`, so it
is reachable only by `service_role`.

### 3 · Admin RPCs invoked directly

| Attempt | Result |
|---|---|
| `adjust_variant_stock(+100)` as a customer | refused, and **the stock did not move** |
| `admin_delete_product` as a customer | refused, and the product is still live |
| `consume_rate_limit` | not executable |
| `release_abandoned_orders` | not executable |
| `reconcile_inventory` | **was executable — F-1** — now not |

`adjust_variant_stock` and `admin_delete_product` are granted to `authenticated`
*on purpose*: they check `is_admin()` inside themselves against `auth.uid()`
from the caller's own JWT. That is stronger than a grant, because it means the
authorization is enforced by Postgres rather than by whichever code path reached
the RPC. The suite proves the internal check fires, not merely that the grant
exists.

### 4 · Another customer's order

| Attempt | Result |
|---|---|
| Read an order that is not theirs | returns null — indistinguishable from "no such order" |
| Mark it `delivered` and `paid` | refused; status unchanged |
| Forge a line on its `order_status_history` | refused |
| Invent a `shipments` row for it | refused |

The last one matters more than it looks: a forged shipment row is how you would
make an order display a tracking number you control.

### 5 · The ledger's integrity

| Check | Result |
|---|---|
| A customer cannot insert an `inventory_movements` row | held — no role holds `INSERT` |
| After every attempt above, the ledger still reconciles | held — **0 drifting variants** |

The reconciliation is the real assertion. The ledger is written by exactly one
trigger and no role can write it directly, so if any attempt above had partially
succeeded, `sum(delta)` would no longer equal `stock_quantity`.

---

## The design decisions that made most of this uneventful

Three, and they were made before the attack pass rather than in response to it.

**The panel runs on the caller's own client, not the service role.** Phase 1
already created `admins manage …` RLS policies on every table, so
`adminAction()` hands the action the *caller's* Supabase client and the database
re-checks `is_admin()` on every row. `elevated` — the service-role client — is a
separate, deliberately awkward second parameter, used only where RLS genuinely
cannot express the rule. The consequence is that the panel's authorization does
not depend on `src/lib/admin/guard.ts` being correct. A bug there still hits a
closed door in Postgres.

**`footvault/admin-actions-must-guard`.** A lint rule that fails the build on any
exported function under `src/lib/actions/admin/` that does not go through
`adminAction()`. One forgotten guard is a full compromise of the panel, and it
would look completely fine in review: the function is in an admin folder,
imported by an admin page, named `deleteProduct`. Nothing about reading it says
"public endpoint". Proven to fire before being relied on — a probe file with one
guarded and one unguarded export reported exactly one violation, and a file
missing its `"use server"` directive reported that too.

**Rate limiting is applied after the authorization check, not before.** Keying
the admin limiter by IP would let an unauthenticated attacker exhaust a real
admin's allowance by hammering an action. It is keyed by `admin:<actor id>`,
which is only known once `is_admin()` has already passed.

---

## What this pass did not cover, and should have

Named because the value of an adversarial pass is partly in its own gaps.

1. **No test drives the actual Server Action endpoints over HTTP.** The suite
   attacks the database layer, which is where authorization lives — but the
   proposition "an unguarded action is callable by a customer" is proven by the
   lint rule and by reasoning, not by a POST to an action id harvested from a
   bundle. Doing that properly needs the built manifest and a real browser
   session. It is the single most valuable thing to add next.

2. **The admin UI routes were not attacked**, because most of them do not exist
   yet (see the execution report). The two that do — `/admin`, `/admin/orders`,
   `/admin/inventory` — are covered only by the layout guard and the middleware,
   both of which were verified by reasoning rather than by a request.

3. **No CSRF consideration.** Next's Server Actions carry origin checks by
   default, and nothing here overrides them, but that was assumed rather than
   tested.

4. **The Shiprocket integration was attacked only through its database
   surface.** `integration_tokens` is unreachable, which is the important part.
   Whether an admin could be induced to fulfil an order they did not intend to —
   a confused-deputy shape — was not explored.

5. **No timing analysis.** `owns_order()` returning false for both "not yours"
   and "does not exist" is asserted structurally; whether the two take
   measurably different times was not measured.

---

## Supabase's own advisor, and why five of its warnings are correct behaviour

`get_advisors(security)` reports 16 findings. None is acted on, and each is
either pre-existing or deliberate. Listed rather than ignored, because "the
linter is noisy" is what people say right before it is right.

**Two INFO — `rls_enabled_no_policy` on `integration_tokens` and
`rate_limits`.** RLS enabled with no policies is deny-all, which is precisely
the intent: neither table has any grant to `anon` or `authenticated`, and only
`service_role` — which bypasses RLS — reaches them. The advisor cannot tell
"forgot to write a policy" from "wrote none on purpose". §2 of this suite proves
which one it is: both tables return nothing to a customer.

**Nine WARN — `SECURITY DEFINER` functions executable by `anon` or
`authenticated`.** Seven are pre-existing storefront and RLS helpers, covered in
F-1's table above. The two new ones are the interesting case:

`adjust_variant_stock` and `admin_delete_product` are granted to `authenticated`
**on purpose**, and the advisor is right that this looks wrong. The reasoning:
each checks `is_admin()` *inside itself*, against `auth.uid()` from the caller's
own JWT. Granting them to `service_role` instead would mean `auth.uid()` is null
and the internal check could never pass — so the authorization would have to move
into TypeScript, where a bug in one action bypasses it. Keeping the grant and
checking inside puts the decision in Postgres. §3 proves the check fires: a
customer calling `adjust_variant_stock(+100)` is refused **and the stock does not
move**.

**One WARN — leaked-password protection disabled.** Pre-existing, and still
Phase 5 §9.5's open owner task. Low relevance while sign-in is Google-only, and
free to turn on.

---

## Verdict

The one hole found was real, was in code written this phase, and was found by
executing the thing rather than by reading it — which is the argument for the
pass existing. It was also *low* severity, and that is worth being honest about
rather than dressing up: it leaked stock levels that a determined person could
largely reconstruct from the storefront anyway.

The more significant result is negative: twenty-three attempts to reach admin
data or mutate another customer's order through the database all failed, and
they failed because of policies Phase 1 wrote and this phase chose to rely on
rather than route around. The decision to run the panel on the caller's own
client — rather than on the service role with a TypeScript check in front — is
what makes that true, and it is the decision this phase would defend hardest.
