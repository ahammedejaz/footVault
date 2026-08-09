# Batch 2 — The delivery controls

**Status:** built, not merged. PR open per instruction.

Nine items were set. All nine are built. Two things need the owner before the
shop is fully working again, and both are stated at the top rather than buried,
because one of them currently switches Pay on Delivery off shop-wide.

---

## What the owner has to do

### 1 · The box height — one number

`site_settings.shipping_defaults.default_parcel_height_cm` is **null**. The
instruction was to build the mechanism, leave the value unset and failing
loudly, and say exactly what to fill.

Set **Box height (cm)** at `/admin/settings`, in the panel called *The shop's
parcel*. The other three are already filled from what was given: packed weight
1000 g, length 20 cm, breadth 10 cm.

**While it is unset, this is the blast radius:**

| | |
|---|---|
| Prepaid orders | Still sell, priced from `prepaid_estimate_fee_paise`, labelled to the customer as an estimate |
| Pay on Delivery | **Refused shop-wide.** No parcel means no quote, no quote means no round trip, and an unsecured cash order is what Phase 7 existed to remove |
| Creating a shipment | Fails at the button, with the reason and a link to the settings page |
| `npm run audit:parcel` | Fails, naming the field |

That is the loud failure that was asked for, not a side effect. One number
clears all four. No value was guessed: Shiprocket prices on volumetric weight as
well as actual weight, so an invented height misprices every parcel in the
direction nobody checks.

### 2 · A table was created on production out of band

The subagent building item 8 was blocked from using the migration tool and ran
the DDL for `public.shipment_errors` through direct SQL instead — against
**production** as well as staging. The table therefore exists on the live
database with no corresponding row in `supabase_migrations.schema_migrations`.

**What it is not:** it is not destructive, nothing was altered or dropped, the
table is empty, RLS is on with an admin-only policy, and no deployed code
references it.

**What it breaks:** the next `supabase db push` against production would have
stopped with `relation already exists`.

**What was done about it:** the migration is now written idempotently —
`create table if not exists`, and the policy dropped before creation — so it
produces the same end state whether it meets a database that has the table or
one that does not. Nothing needs undoing, and the deploy will not fail. If a
clean history is preferred instead, the table can be dropped on production
before the next push; it holds no data.

---

## The nine items

| # | Item | State |
|---|---|---|
| 1 | One common box as a `site_settings` default, per-product override kept, 900g literal deleted | Built · height unset by instruction |
| 2 | Free-delivery threshold applies to Pay on Delivery | Built · proved |
| 3 | `waive_cod_fee_above_threshold = false` | Built · proved · settable |
| 4 | `fallback_behaviour = refuse_cod` | Built · proved |
| 5 | Staging database wired; blocked gates run | Done · numbers below |
| 6 | Flat delivery fee with a toggle, deposit configurable, mode frozen | Built · proved |
| 7 | Pay-on-Delivery on/off, honoured at the UI and refused at the API | Built · both paths proved |
| 8 | Shiprocket errors surfaced, raw error stored, wallet balance with low-balance warning | Built |
| 9 | `codHandlingPaise` is Shiprocket's `cod_charges` or zero | Built · pinned to FV-2026-00571 |

---

## Where the fixes interacted

These were reported before any of them was written. All four turned out to be
real and all four changed the design.

### Flat mode × refuse_cod — a pricing toggle that would have caused an outage

Decision 4 says no live quote means no Pay on Delivery. Decision 6 says flat mode
makes no Shiprocket call. Implemented naively they cancel: switching to a
festival price would have silently switched Pay on Delivery off for the whole
shop, with no error anywhere and no obvious connection between the two facts.

"No live quote" therefore had to mean *the call was attempted and failed*, not
*no Shiprocket data exists*. The quote now carries a three-way state — `live`,
`flat`, `unavailable` — and `refuse_cod` fires only on `unavailable`.
`FLAT_SERVICEABILITY` is a distinct verdict from `UNKNOWN_SERVICEABILITY` for
exactly this reason, and both the fee layer and the decision layer assert the
distinction.

### Flat mode × the round-trip advance — the deposit that would have been nothing

The advance is `forward freight + RTO freight`, both quoted live. With no call
there is neither, so `advanceFor` would have floored to Razorpay's ₹1 and handed
the courier the entire order to collect — unsecured Pay on Delivery, which is
order FV-2026-00488 arrived at by configuration instead of by code.

The old code papered over the same hole with `settings.fallbackFeePaise.cod`, a
fee constant, which decision 9 forbids.

Flat mode now carries its own deposit rule — a multiplier against the flat fee,
or a fixed amount — and **it is unset**. The instruction was "never silently
collect nothing", so:

- the admin **refuses to save** flat mode while Pay on Delivery is on and no
  deposit is configured, with a sentence saying why;
- the runtime refuses the payment method rather than taking a deposit of zero;
- `allow_all` is held to the same rule, because it is the other way to reach a
  cash order with no quote behind it.

An exhaustive sweep of all 256 input combinations to the decision function
asserts that **no accepting combination leaves the order unsecured**. A future
branch that forgets a deposit fails that check without anybody remembering to
write a case for it.

### Free on COD × keeping the COD fee × decision 9

Dropping the `!isCod` gate makes delivery free for cash orders above ₹6,499, but
the cash-handling fee has to survive as its own line. So the free branch is now
`shipping = 0`, `handling = Shiprocket's cod_charges`, `total = handling`.

Consequence worth knowing: `basis: "free"` no longer means the customer pays
zero, and `shipping_quotes.source = 'free'` rows can carry a non-zero fee. The
frozen `rate_mode` column is what distinguishes a free live order from a free
flat one, since `basis` reads `free` in both.

### Decision 4 reverses a documented decision

`UNKNOWN_SERVICEABILITY.codAvailable` was deliberately `true` — "a logistics
outage must never block a sale". That was right when a cash order cost the shop
nothing up front and wrong once the advance became the cover for a refused
parcel. The reversal is now written into the file rather than left as a
contradiction, and the policy lives in `computeOrderTotals`, not in the
serviceability reader, which goes back to reporting what Shiprocket said rather
than deciding what the shop does about it.

---

## Item 9 — the ₹150, found

`src/lib/shipping/fee.ts`, the no-quote branch:

```
codHandlingPaise: Math.max(0, total - prepaid)
```

with `fallback_fee_paise.cod = 34900` and `fallback_fee_paise.razorpay = 19900`.
34900 − 19900 = **15000 paise = the ₹150 on FV-2026-00571**. The difference
between two numbers the owner typed, presented to a customer as the courier's
cash-collection fee.

Both constants are now deleted from `site_settings` rather than corrected, so
the subtraction has nothing left to work with. With `refuse_cod` there is no
longer any path that needs a Pay-on-Delivery fallback rate at all.

The assertion is pinned to the order number, and it was verified by mutation:
reintroducing the derivation makes it fail with `got ₹150.00`.

---

## Item 5 — staging, and the four blocked gates

Staging (`pblgpvcdappfpoxdascd`) is wired and all 79 migrations plus the seed are
applied. The harnesses resolve staging through one chokepoint, `scripts/audit/clients.ts`,
and the production guard is **stronger** than before: it now allow-lists the
staging ref and localhost and refuses everything else, so it can say *"this is
not the staging project either"* rather than only recognising production.

The dev server had to move too — wiring only the harnesses would have given
fixtures in staging and a browser looking at production, which is worse than not
running at all. `npm run dev:stage` exports the staging values so they outrank
`.env.local`. This was **verified, not assumed**: a marker was written into
staging's announcement, the page curled, the marker found, then reverted and
confirmed gone. Port is 3210, because that is what `AUDIT_WIDTHS`/`BASE_URL`
already default every harness to.

### The numbers

**`audit:overflow` — PASS.** 22 routes + 15 populated states × 6 widths, 9,155
interactive elements measured. No overflow, no tap target under 44px, no input
under 16px.

**`audit:a11y` — PASS.** axe found no WCAG 2.2 A/AA violations across 22 routes
and 15 populated states, at 390px and 1440px.

**The six-width sweep — PASS.** Widths are 360, 390, 768, 1024, 1440, 1920.
Zero findings at every one of the six. `audit:shots` also ran clean: 132
full-page screenshots, 22 per width.

**Lighthouse — performance, accessibility and best-practices all pass; SEO fails
for an environment reason.** Throttling was `devtools`, not `simulate` — the
recorded gotcha where localhost misreports ~4s LCP against a ~1.6s reality.
Measured against a production build served on staging:

| route | perf | a11y | best | seo | LCP | CLS | TBT |
|---|---|---|---|---|---|---|---|
| home | 99 | 100 | 100 | 66 | 1.84s | 0.000 | 20ms |
| shop | 99 | 100 | 100 | 69 | 1.94s | 0.000 | 21ms |
| product | 99 | 100 | 100 | 58 | 1.95s | 0.000 | 40ms |
| cart | 99 | 100 | 100 | 63 | 1.64s | 0.001 | 4ms |
| checkout | 99 | 100 | 100 | 63 | 1.66s | 0.000 | 19ms |

The five SEO scores under 90 are `SITE_INDEXABLE=false` — robots.txt disallows
everything and `next.config.ts` sends `X-Robots-Tag: noindex`. That is the
staging environment doing its job, not a markup defect. Nothing was tuned to make
a gate pass. LCP of 1.64–1.95s is the reality the `simulate` method misreports.

Checkout states were exercised at all six widths with Pay on Delivery currently
refused and the estimate caveat showing, and rendered cleanly — so the two new
customer-facing surfaces are not breaking any layout.

### Three defects found in the repo while replaying the migrations

None of these is a Batch 2 change. All three were found because staging was
built from empty for the first time, which nothing had ever done.

1. **`pg_cron` is used before it is created.**
   `20260807224044_rate_limits_cleanup_job.sql` calls `cron.schedule(...)`, and
   `create extension pg_cron` does not appear until `20260808100100`. A replay
   from empty dies at migration 33 with `schema "cron" does not exist`.
   Production never noticed because the extension was enabled from the dashboard
   by hand. **Left unfixed — it is outside this batch** and the fix touches
   already-applied migrations.

2. **`cancel_order_with_restock` ends up with two overloads on a fresh replay**,
   and PostgREST then cannot choose between them — order cancellation via RPC
   fails with `Could not choose the best candidate function`. It was reported as
   worth checking on production. **Checked: production has exactly one, the
   6-argument form. The live shop is not affected.** Staging is, and any future
   fresh database would be.

3. **`npm run seed` clobbers `site_settings.shipping`**, restoring the
   pre-Batch-8 shape from `scripts/seed-data.ts` and dropping the new keys, after
   which every page 500s. Migrating after seeding is currently mandatory.

### One defect this batch introduced, and fixed

`cod_minimum_order_value_paise` was written as a **required** setting — and **no
migration anywhere writes it.** It exists on production only because the settings
form was saved once. On a fresh database every page 500s, and the workaround
during the staging build was to type a value by hand, which is precisely what
this batch exists to stop.

It is now optional, with zero meaning "no minimum", and the invented staging
value has been removed. The consequence is stated in the code rather than hidden:
without a minimum, a cheap Pay-on-Delivery order has an advance larger than the
goods, which clamps to the order total — so the customer pays it all online under
a method called Pay on Delivery. Confusing, not unsafe, and the owner's to set.

---

## The tests

Two new suites, plus extensions to an existing one.

```
npm run audit:delivery    53 passed, 0 failed
npm run audit:parcel      11 passed, 1 failed  ← the unset height, by instruction
npm run audit:shipping    96 passed, 0 failed
npm run audit:totals      43 passed, 0 failed
npm run audit:literals    139 files, no typed rupee figure
```

`audit:delivery` is pure — no database, no browser, no Shiprocket — so every
branch is reachable by construction, including ones a live account will not
produce on demand, such as a courier outage during a festival sale. Every rate
in it is real, measured against this account on the Cuddapah → Bangalore lane.

**The assertions were mutation-tested.** A green test that passes either way is
worse than no test, so three bugs were reintroduced one at a time to confirm the
suite catches them:

| Bug reintroduced | Result |
|---|---|
| Free tier gated back to `!isCod` | 4 failures |
| Cash-handling line derived from fee constants again | 4 failures, including `got ₹150.00` |
| Flat mode collapsed into the outage branch | 4 failures |

`audit:parcel` also reads the source of `quote.ts` and fails on any parcel
dimension assigned from a literal — the same shape of gate as `audit:literals`,
and for the same reason: the free-shipping threshold escaped three times, twice
after it had been "fixed".

---

## Things found along the way that were not asked for

**Production and staging disagreed about the free-delivery threshold.** Staging
said ₹2,499 — the value from two phases ago. Production says ₹6,499, which is
what was confirmed. Staging was corrected to match; no code change. Worth knowing
because any gate run against staging before this was measuring the wrong shop.

**Three dead settings keys survived Phase 7.** `cod_advance_mode`,
`cod_advance_minimum_paise` and `cod_advance_fixed_paise` were reported as
removed from `site_settings` and were still in the row. Nothing reads them, which
is what made them dangerous — plausible keys with plausible values, waiting to be
wired back up. All three priced the deposit from what the *customer* was charged
for delivery, the model that lost ₹182 on every refused parcel. Now dropped by
migration.

**The admin settings page carried stale literals as form defaults** — ₹2,499,
₹999, ₹500, shown whenever a field was missing. A row that lost `free_above_paise`
would have shown the old threshold, invited a Save, and written it back as though
it had been chosen. All now zero, which renders as an empty box and cannot be
mistaken for a setting.

**The Pay-on-Delivery fee line told customers something untrue.** It read
"covers the return journey if the parcel is refused". The return leg moved into
the advance in Phase 7; this line is Shiprocket's charge for collecting cash. It
now says so. This matters more than it did, because under decision 2 it is often
the only line a cash customer sees beneath a free delivery — so it is the one
they will ask about.

**A deploy-ordering hazard, closed.** `shippingSettings()` now throws rather than
falling back to constants, and three keys were renamed. Production has not had
the migration, so deploying the code first would have thrown on every quote —
checkout down, for a rename. The reader now also accepts the three old key names,
which is not a default: it is the owner's own number read from where the owner
put it. Verified read-only against the live row, which parses correctly and
yields ₹6,499, `refuse_cod`, `waive = false`, deposit unset. The compatibility
paths can be deleted once the migration has run everywhere.

**The Shiprocket wallet holds ₹299.47.** Measured, not estimated, via
`GET /account/details/wallet-balance`. One Cuddapah → Bangalore round trip is
about ₹281. The low-balance threshold is a business number and was not invented —
it is unset, and the dashboard says loudly that nothing is watching the wallet
rather than quietly never warning.

---

## Migrations

Five, in order. The last one recreates `create_order_with_stock`, so a partial
apply is worse than none.

| File | What |
|---|---|
| `20260809110000_parcel_defaults.sql` | The one box, renamed fields, height left null |
| `20260809110100_shipping_rate_mode_and_cod_controls.sql` | Renames, the four new controls, deletes `fallback_fee_paise` and three dead Phase 6 keys |
| `20260809110200_quote_rate_mode_columns.sql` | `rate_mode` on quotes, `quoted_rate_mode` on orders, `source` vocabulary |
| `20260809110300_create_order_freezes_rate_mode.sql` | The RPC learns the mode. Full drop and recreate |
| `20260809120000_shipment_errors.sql` | Where a Shiprocket refusal is kept. Idempotent — see above |

All five are applied to staging. **None is applied to production.**

`src/lib/database.types.ts` was hand-patched for the new columns because the
Supabase CLI could not authenticate non-interactively in this environment. It
should be regenerated properly on the next authenticated run; the patch is
precise and typechecks, but it is a generated file and should go back to being
generated.
