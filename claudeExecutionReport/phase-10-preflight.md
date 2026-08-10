# Phase 10 · Preflight — execution report

The two items the Phase 9 plan listed in its findings table and never assigned a
batch number. Both were **outstanding**; neither had been done.

The headline is that P-1 was larger than the brief knew. The two hardcoded
fallbacks were real and are gone, but they were hiding a third thing: on any
database rebuilt from migrations, the storefront could not read the shipping
settings at all and had been silently running on the ₹2,499 constant. Removing
the constant is what made that visible.

---

## P-1 · The ₹2,499 fallbacks

### Confirmed outstanding

Both literals were present exactly where the brief said:

| Site | Line |
|---|---|
| `src/app/(storefront)/product/[slug]/page.tsx` | `82` |
| `src/lib/queries/cart.ts` | `109` |

Both were the third argument to `setting<ShippingSettings>(settings, "shipping", …)`
— a fallback object containing `free_above_paise: 249900`.

### What was actually wrong with them

**The production row says `159900`.** Not ₹2,499 — ₹1,599. The fallback and the
live value had already diverged, and nothing surfaced it, because a fallback only
runs when the real value is unavailable, which is the one moment nobody is
watching.

That is the whole failure mode in one sentence, and it is why "fail loudly" is the
right instruction rather than "correct the constant".

### What was built

**`publicShippingSettings(settings)`** in `src/lib/queries/content.ts` replaces
both call sites. It throws — naming the field — when the row is missing, is not
an object, or has no numeric `free_above_paise`. It is the storefront twin of
`shippingSettings()` in `src/lib/shipping/settings.ts`, which already had exactly
this discipline and whose own comment names the ₹2,499 incident. This closes the
half of that lesson that had been left on the public path.

**The public `ShippingSettings` type lost two fields.** It carried `currency` and
`regions` beside the threshold. Neither is read by any code in the repository,
and neither exists on the production row — so they existed *only* as invented
defaults inside the two fallback objects being deleted. A field no caller reads
cannot be wrong in a way anyone notices, which makes it a good hiding place for a
guess. The type is now one field.

**Files:** `src/lib/queries/content.ts`,
`src/app/(storefront)/product/[slug]/page.tsx`, `src/lib/queries/cart.ts`,
`src/lib/actions/admin/settings.ts` (a comment that cited `currency`/`regions` as
the fields worth preserving — it now cites fields that exist).

### The extended gate

`scripts/audit/literals.ts` gains a second section: **no nonzero numeric literal
assigned to a paise-named identifier**, anywhere in `src/`, `.ts` and `.tsx`.
Section numbering shifted, so owner-edited content is now section 3.

Each half of the rule earns its place:

- *Assigned* — so `capturedPaise === 0` and `refundPaise <= 0` are untouched. A
  comparison reads a number, it does not invent one. `[:=]` matches one
  character, so `===`, `!==`, `<=` and `>=` fall out without special-casing.
- *Numeric literal, as the whole right-hand side* — so
  `optionalPaise(partial.x, 0)` and `minOrderPaise: Math.round(Number(v) * 100)`
  are untouched. A value computed from an input came from somewhere.
- *Nonzero* — zero is not a price. `balanceDuePaise: 0` is an empty accumulator
  or an explicit absence, a distinction `src/lib/shipping/settings.ts:222-226`
  already reasons about carefully.

**Proof it fails before it passes**, as required. The two source fixes were
stashed and the gate run against the pre-fix tree:

```
2 · no paise literal in code
  ✗ src/app/(storefront)/product/[slug]/page.tsx:82
      free_above_paise: 249900,  ← resolve free_above_paise from site_settings
  ✗ src/lib/queries/cart.ts:109
      free_above_paise: 249900,  ← resolve free_above_paise from site_settings
  308 files scanned

2 literals found.
```

Restored, the same run reports `308 files, no typed paise figure (3 named
constants allowed)` and the whole gate passes.

### Autonomous decisions

| Decision | Rationale |
|---|---|
| Gate covers **all of `src/`**, not "`src/` outside `lib/`" as the brief scoped it | One of the two offenders the gate was commissioned to catch is `src/lib/queries/cart.ts`. The narrower scope would have missed half of its own purpose — this file's header calls that "a gate that proves you fixed them" |
| Three `lib/` constants allowlisted **by identifier, with a reason**, rather than by excluding `lib/` | Stricter than the brief's scope: they stay visible, each says why, and a fourth cannot appear without somebody writing down why. `RUPEE_IN_PAISE` (the unit itself), `MIN_CHARGEABLE_PAISE` (Razorpay's floor), `ROUND_UP_TO_PAISE` (fee granularity) |
| The **currency-symbol** check was *not* widened from `.tsx` to all of `src/` | It would flag six admin validation messages that legitimately describe boundaries — *"A flat delivery charge of ₹0 means free delivery on every order."* Noise that creates pressure to weaken a working rule |
| Public `ShippingSettings` narrowed to one field | See above — the other two were read by nothing and existed only as guesses |

---

## The thing the brief did not know about

### A rebuilt database could not read the shipping settings at all

RLS on `site_settings` grants `anon` and `authenticated` `select` `using
(is_public)`, and `getSiteSettings()` filters the same way.

- **Production:** `shipping` is `is_public = true`, and has been since before the
  migration that creates it.
- **A replay from empty:** `20260809140000_shipping_settings_row_exists.sql`
  inserts the row with **`is_public = false`**. It inserts `where not exists`, so
  on production it correctly did nothing — which is why the two never had to
  agree.
- `saveShippingSettings` issues an `update` of `value` alone and never touches
  the column, so nothing in the application reconciles them.

**So on any rebuilt database the storefront could not see the shipping row**, and
before this preflight it did not fail — it quietly served ₹2,499 from the
constant while production served ₹1,599. A second live instance of exactly the
bug class P-1 exists to end, found only because removing the constant turned a
silent divergence into a loud one.

It also means the "staging rebuilds from migrations and seed, from empty" gate
would now 500 on every product page and on the bag — the failure mode
`src/lib/shipping/settings.ts:238-255` already recorded once.

### The fix

**`supabase/migrations/20260810130000_shipping_settings_public_on_rebuild.sql`**

```sql
update public.site_settings
   set is_public = true
 where key = 'shipping'
   and is_public is distinct from true;
```

A new migration rather than an edit to the applied one: editing a migration that
has already run changes what a fresh replay produces while changing nothing about
any database that ran it, which is how two databases drift further apart rather
than closer.

**It is a no-op on production by construction** — the row is already `true`, so
the guard matches nothing there. It has not been applied anywhere yet; see
*Blocked on the owner*.

---

## P-2 · The rate-limit fail-open

### Confirmed outstanding

`docs/architecture.md` had no mention of rate limiting at all. The reasoning
existed only in source comments — good ones, in `src/lib/rate-limit.ts` and
`src/lib/shipping/quote.ts:208-250` — which is not where someone lands when they
meet a fail-open in a stack trace.

### What was written

A new section, **"Rate limiting, and the fail-open that is not a bug"**, placed
between *When something throws* and *Audits*. It records:

- A limiter answers "too fast", never "allowed" — and why that is the same
  statement as the fail-open seen from the other side, so reversing one half
  without the other breaks it.
- The general principle: **every policy bounds work against Postgres using a
  counter in Postgres**, so when Postgres is gone the guard and the thing worth
  guarding disappear together.
- **The `serviceability` exception**, which is the one policy that principle does
  not cover: it guards the Shiprocket quota, an external paid resource reached by
  a public Server Action, so a counter outage removes the guard and leaves the
  exposure intact. Not hypothetical — PostgREST reloads its schema cache on every
  DDL and cannot be told not to.
- Its **in-memory backstop**: 600 courier calls per hour per instance, in
  `src/lib/shipping/quote.ts`, unconditional (knowing the counter is broken
  requires the counter), and degrading to `source: "unknown"` — a *labelled
  estimate* rather than an error, because a limiter that threw would take Pay on
  Delivery off the table for a real customer.
- What it is **not**: not a per-caller limit, and it cannot be one, because
  module memory is per-instance.
- The same shape once more in `report-server-error.ts` — `withinProcessBudget`,
  5 per instance per hour, the only ceiling that holds when the database is
  itself the thing generating the errors.
- A closing note for whoever arrives to "fix" it, naming the one condition that
  *would* be a real bug: a policy guarding an external paid resource with only
  the Postgres counter behind it.

---

## Documentation

| File | Change |
|---|---|
| `docs/architecture.md` | The new rate-limiting section (P-2) |
| `docs/database.md` | The `site_settings.shipping` table's column header said **Live value** over figures that are two phases stale and three of whose keys were later deleted. Now **Value then**, with a note that the row is the only authority on current values |
| `docs/admin-guide.md` | *"above ₹2,499 the delivery is free"* — a line written for the owner to **say to a customer on the phone**, quoting a number the shop does not honour. Rewritten to point at `/admin/settings` |

`docs/staging.md:318` also mentions ₹2,499; left alone deliberately — it is
historical narrative about the incident and is accurate as history.

`README.md`, `.env.example` and `docs/rls-tests.md` needed no change.

---

## Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run lint` | clean |
| `audit:literals` on the **pre-fix** tree | **fails**, 2 literals, both named lines |
| `audit:literals` on the fixed tree | passes — 156 files (currency), 308 files (paise), 3 constants allowed, 5 content tables |
| `/cart` against production data | `200` |
| `/product/puma-suede-classic-mens` | `200` |
| `/product/nike-air-max-90-mens` | `200` |
| Threshold rendered, production data | **`Free over ₹1,599`** — the live value; `2,499` appears nowhere in the response |

Verified by HTTP against a dev server, not by inference.

### The rebuild from empty — the check that mattered

`npm run rebuild:stage`, with the new migration in the sequence:

```
PASS  all 97 migrations recorded
PASS  cancel_order_with_restock has exactly one form
PASS  all four cron jobs scheduled
PASS  shipping settings row carries its required keys
PASS  no deleted settings key has come back
PASS  the parcel is complete: 20 × 10 × 10 cm at 1000 g
PASS  catalog seeded: 35 products
PASS  variants seeded (409)

Staging rebuilt from empty: migrations, seed and every check green.
```

Then, against that freshly built database:

| Check | Result |
|---|---|
| `site_settings.shipping.is_public` | **`true`** — it would have been `false` without the new migration |
| Readable by an **anonymous** client, as the storefront reads it | **yes** — `announcement, business_hours, contact, payment_methods, return_window_days, shipping, social, store_name, store_tagline` |
| `/cart` on `:3210` | `200` |
| `/product/adidas-gazelle-womens` | `200` |
| Threshold rendered | **`Free over ₹6,499`** — staging's own seeded figure |

This is the exact scenario that would have returned 500 without the migration,
and that silently printed ₹2,499 before P-1. Both halves are now closed and
observed rather than argued.

---

## What I got wrong and caught in self-review

**I nearly shipped a change that 500s every product page on a rebuilt database.**
Having made `publicShippingSettings` throw, I went looking for whether the seed
or migrations actually write the field — prompted by the comment at
`src/lib/shipping/settings.ts:238-255`, which records that exact failure
happening once before. That is the only reason the `is_public` divergence was
found. Had I stopped at "typecheck passes and production works", the change would
have been correct on production and broken on every rebuild, and the phase gate
that would have caught it runs later.

**The success line in the new gate section printed unconditionally.** First
version ended with `✓ no typed paise figure` regardless of whether anything had
been reported, because it reused the shared `failed` counter without snapshotting
it. Section 1 handles this correctly and I did not copy that part. Caught before
running it; fixed with a section-local `paiseFailedBefore`.

**My first draft of the gate widened the currency check to `.ts` as well**, on the
reasoning that more coverage is better. Running it first showed six admin
validation messages that are legitimately about boundaries. Reverted — a gate
that cries wolf is a gate someone disables.

---

## Known imperfections

**The `shipping` settings row is anon-readable in full.** `is_public` grants
`select` on the **whole jsonb value**, not on one field. Any anonymous visitor
with the publishable key can read the Pay-on-Delivery deposit and advance cap,
the COD minimum, the 30% stacking ceiling, the prepaid discount rate and the RTO
deduction policy — alongside the free-delivery threshold the product page prints
anyway.

This is true of production today. The new migration neither widens nor narrows
it; it only makes a rebuilt database match. Narrowing means splitting the public
threshold into its own row, which is a schema change *and* an authorisation
decision — so under the merge policy it is the owner's, not mine. **Recorded, not
taken.** Most of the blob is customer-visible at checkout anyway; the fields I
would not choose to publish are `wallet_low_balance_paise`,
`rto_deduction_flat_paise` and `max_total_discount_percent`.

**The new gate matches identifiers, not meanings.** A policy number stored in a
variable that is not paise-named — `const threshold = 159900` — is invisible to
it. The naming convention is consistent across this codebase today, so the rule
holds in practice, but it is a convention rather than a guarantee.

**`publicShippingSettings` throwing makes the bag and the product page hard-fail
on unreadable settings.** That is the instruction and I believe it is right, but
it is a real behaviour change: previously those surfaces degraded, and now they
500. The blast radius is bounded by the fact that the row is present and public
on production, and the new migration makes that true on rebuilds too.

**The staging rebuild proves the fix but not the failure.** The rebuild below was
run *with* the new migration in place, so it demonstrates that a fresh database
now comes up correct. I did not run a second rebuild with the migration removed
to watch the product page 500 — the divergence itself is evidenced by reading
`20260809140000` (`is_public = false`), the production row (`true`) and the RLS
policy (`using (is_public)`), not by observation. I am confident in the diagnosis;
it is one step less direct than the gate-fails-first proof used for P-1.

---

## Deferred

Nothing from the preflight itself. The exposure question above is deferred to the
owner rather than to a batch.

---

## Blocked on the owner

**1 · Apply `20260810130000_shipping_settings_public_on_rebuild.sql`.**

**Applied and verified on staging. Not applied to production.** Under the merge
policy a change that applies a production migration stops and asks, so it is
stopping and asking — even though this one changes nothing on production.

Steps 1 and 2 of the standing procedure are **done** (see *The rebuild from
empty* above). What remains:

1. Content-verified snapshot of production (URL-encode the password).
2. Dry-run push against production; confirm the diff is the single `update`.
3. Push. Verify with
   `select key, is_public from site_settings where key = 'shipping';` — expect
   `true`, unchanged.

Expected production effect: **none.** The row is already `true`; the guard
matches nothing. If it reports a row updated, stop — that means production was
not in the state this report describes.

**2 · The `is_public` exposure decision**, described under *Known imperfections*.
A yes/no on whether the operational shipping figures should stay anon-readable.
If no, it becomes a schema change and belongs in a batch of its own.
