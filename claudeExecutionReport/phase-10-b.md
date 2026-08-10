# Phase 10 · Batch B — honest delivery estimates, and the smaller repairs

**Three of the four items are complete. Per-shipment pickup selection is
deliberately not built, and the reasoning is below rather than buried.**

Branch `batch-b/honest-delivery`, five commits, **not merged**. Two production
migrations are written and applied to staging only — under the merge policy that
stops and asks.

---

## 1 · Per-destination ETD

### What was actually wrong

Not what the brief assumed, and worth stating precisely.

The checkout was **already** showing Shiprocket's per-lane figure. The defect was
subtler: the copy said *"about 4 days **after dispatch**"* while the arithmetic
under it counted from the moment of ordering. Pickup is at 11:00, so an order
placed at 14:00 does not start its clock until tomorrow — the words were right
and the number under them was a day optimistic.

### What was built

**`src/lib/shipping/estimate.ts`** owns the arithmetic for every surface, the
same discipline `computeOrderTotals` applies to money. It returns **dates**, not
a count of days, because "4 days after dispatch" pushes the hardest part of the
question onto the customer — and that was the part being got wrong.

| Surface | Before | After |
|---|---|---|
| Checkout address step | "about N days after dispatch", counted from *now* | "Arriving Fri, 14 Aug – Sat, 15 Aug", plus why dispatch is tomorrow when it is |
| Order confirmation | nothing at all | the window, anchored to `placedAt` |
| Product page | **"Usually 3–5 working days"** whenever the lookup gave nothing | no number at all until Shiprocket gives one |
| No live quote | silence, which reads as "no information" | *"We could not reach the courier for a date just now. We will confirm it when your parcel is dispatched."* |

The confirmation is anchored to `placedAt` rather than to *now* — a customer
opening the page three days later must read the dates they were promised, not a
window that has quietly slid forward.

**Holidays and weekends are deliberately not modelled.** Shiprocket's
`estimated_delivery_days` is a calendar-day figure from the courier that will
actually carry the parcel and already reflects its working pattern. Layering a
second working-day calculation on top would be this codebase inventing a number
rather than reading one — the exact habit that produced "about 4 days". The
cutoff *is* modelled because it is the shop's operational fact, not the
courier's, and nothing else knows it.

**Migration `20260810150000`** adds `orders.quoted_estimated_days` so the
confirmation does not make a live courier call on a page a customer opens from
an email. Written **best-effort after** `create_order_with_stock` returns rather
than as a parameter of it: that function decrements stock, redeems coupons and
computes the advance in one transaction, and restating it for a *display field*
trades real risk for no correctness. A failed write leaves null, which already
renders as honest vagueness.

---

## 2 · Courier selection

Shiprocket's recommended courier scored worst of the available set on all three
metrics, on both lanes tested — and `assignAwb` was posting `{ shipment_id }`
alone, which lets Shiprocket choose. The three scores were already being parsed
into `CourierQuote` and thrown away.

**`chooseCourier()`** reads them. Three modes: `cheapest`, `shiprocket` (the
previous behaviour, kept as an explicit choice rather than an accident) and
`best_rated` — the best-scoring courier within a price tolerance.

**Built unset, failing loudly.** `best_rated` with no tolerance does not quietly
become "cheapest" and does not quietly become "any price". Both are decisions
about the shop's money that nobody made. It refuses, naming the setting.

**Every unhappy path falls back to letting Shiprocket choose, loudly.** A lane
that cannot be re-quoted, a refusal, an outage — none is a reason to leave a
paid parcel unassigned. The previous behaviour is the floor and the log says
when the shop dropped to it.

It **re-quotes the lane at AWB time** rather than reading the courier list
frozen at checkout. The price the customer was charged is frozen; who carries it
is a different question, and couriers drop off lanes between payment and packing.

**Migration `20260810160000`** records `courier_selection_mode` and
`courier_selection_reason` on the shipment. The reason is the selector's own
sentence — it captures the tolerance and the score in force, neither recoverable
from the mode alone once the setting changes. **Neither is backfilled:** a
guessed mode is fabricated evidence in the one table meant to answer whether the
change helped.

Both settings are owner-editable at `/admin/settings`, and the reasoning is
visible on the AWB step so a choice is not indistinguishable from the old
behaviour.

Zero tolerance stores as **null**, because a zero tolerance is `cheapest` said a
longer way, and two controls that do the same thing eventually disagree about
which is in force.

---

## 3 · Pickup addresses

Verified against the live account **before** writing the parser:
`/settings/company/pickup` returns `data.shipping_address[]` with
`pickup_location`, `pin_code`, `city`, `state`. One address — `warehouse`,
516360, Cuddapah.

`checkPickupConfiguration()` answers two questions that fail very differently,
and both are now on `/admin/health`:

**A nickname that matches nothing** stops shipping loudly, at the counter, on an
order somebody has already paid for. `config.ts` already made an *unset*
variable fail early; a variable that is **set and wrong** was still invisible —
and a rename in the Shiprocket panel is a change nobody makes in this repository.

**A pin code that disagrees** stops nothing. `shipping_defaults.pickup_postcode`
is what every quote is taken from; the nickname sent at shipment time is a
separate value in an environment variable, and **nothing has ever asserted the
two describe the same building.** If they diverge the shop quotes one lane and
ships another, charging every customer for a journey the parcel does not make,
with both values individually looking correct.

### Why per-shipment selection is not built

The brief asks for it, conditioned on *"if a second address is ever added in a
different city"*. There is one address. The pickup PIN determines the rate, so a
picker that changes which lane is quoted is **a change to the money path** — the
one area this phase was explicitly told to leave alone — built speculatively, for
a second address that does not exist, and impossible to test meaningfully against
an account with one.

What was built instead is the part that pays off today: the shop now notices when
its two copies of the pickup address stop agreeing. **Recorded as deferred, with
the trigger: the day a second pickup address is added.** At that point the picker
must land *before* the quote is taken, not after.

---

## 4 · The focus-ring pass

Diagnosed rather than guessed. The search bar's computed focus style was a **4px
navy halo (`rgb(10, 21, 38)`) with `outline-style: none`** — `outline-none`
deletes the orange half of the composite indicator and leaves the dark halo
alone. That is exactly the "hard black box" reported. The `/search` page's own
input was worse: **no indicator at all**.

Both are bespoke inputs rather than `ui/input`, which is why `audit:focus` passed
throughout — it proved the primitives, and neither search box is one. Three admin
controls had also swapped the composite indicator for a bare ring; they now
inherit the global one. Nothing had its focus styling removed.

The gate grows two ways: it tabs to the `/search` input, and it **fails on any
component that switches the outline off without a named reason**. Three
exemptions, each with a reason — dropdown items and the dialog panel show focus
another way, and the checkout alert is announced rather than operated.

Comments are stripped before matching, which is not a nicety: `button.tsx`,
`input.tsx` and `select.tsx` each carry a comment saying *"no `outline-none`, and
it must stay that way"*. The first version of the rule flagged all three. **A
gate that fails on its own documentation teaches people to delete the
documentation.**

---

## Verification

| Gate | Result |
|---|---|
| `audit:delivery-estimate` | **23 checks, all green** (new) |
| `audit:courier-choice` | **14 checks, all green** (new) |
| `audit:focus` | green, including the two search inputs and the source rule |
| `audit:settings-controls` | **41 passed, 0 failed** — 34 controls |
| `audit:shipping` | **110 passed, 0 failed** |
| `audit:delivery` | **59 passed, 0 failed** |
| `audit:totals` | **48 passed, 0 failed** |
| `audit:checkout` | all checks passed |
| `audit:transitions` | 0 failing |
| `audit:images` · `audit:settings-visibility` · `audit:literals` | 47 · 14 · green |
| `audit:reachability` | PASS, both widths |
| `tsc --noEmit` · `lint` | clean |

### Gates proven to fail first

- **`audit:delivery-estimate`** — with the cutoff removed *and* IST days swapped
  for UTC days, **7 of 23 checks fail**, including the 00:30-IST case that a
  midday-only fixture would never catch.
- **`audit:focus`** — reintroducing `focus-visible:outline-none` into
  `table.tsx` fails the run; removing it passes.

---

## What I got wrong and caught in self-review

**My focus probe would have looked identical either way.** After removing
`outline-none` I probed with programmatic `.focus()` and read "still broken" —
but `.focus()` does not match `:focus-visible`, which is what the global rule
keys on. The probe reported the same thing before and after the fix. Re-run with
a real Tab, it showed the full composite indicator. This is the third time the
standing habit has caught a verification that could not distinguish success from
failure, and it is becoming the most useful question I ask.

**The gate's own coverage assertion caught me.** Adding two settings controls
without adding their driving code failed `audit:settings-controls` immediately —
`courier-selection-mode, courier-price-tolerance` named in the failure. That is
the harness working exactly as designed, and it is worth recording that it
worked on somebody who knew about it and still forgot.

**A copy bug from joining two sentences.** `describeEstimate` ends its uncertain
answers with a full stop and its confident one without — "Arriving Fri, 14 Aug"
is a label, not a sentence. The product page joined them blindly and produced
"…dispatched.. Pay on Delivery…". Caught by printing both branches rather than
one.

---

## Known imperfections

**`audit:admin-pages` has a latent dependency on residue.** Its Pay-on-Delivery
check reads an existing order out of the database rather than creating one, so it
passes or fails depending on whether an *unrelated* earlier suite happened to
leave a COD order behind. Staging currently has **zero orders** — `audit:checkout`
cleans up after itself — so the check fails with "none found" while nothing is
wrong.

I confirmed this is not a regression from Batch B by querying the table directly
rather than assuming. **It is a gate whose result is not a function of the code**,
which is the same class of problem as the vacuous assertions found in Batch A,
and it should build its own fixture. Not fixed here: it is a different gate, and
changing it under a Batch B branch would hide the finding.

**Best-rated has never chosen a real courier.** `chooseCourier` is proven against
a fixture built to the observed shape, and `assignAwb` is wired — but no real AWB
has been assigned through it, because that costs money and creates a real parcel.
The first live assignment should be watched, and the `courier_selection_reason`
on that shipment read.

**The estimate is a courier's median, widened by one day.** The padding is a
judgement, not a measurement. Once real orders accumulate, `delivered_at` minus
`placed_at` against `quoted_estimated_days` is the query that would replace the
judgement with evidence.

**`quoted_estimated_days` is null on all 21 existing production orders** and is
not backfilled. They render honest vagueness. Inventing a figure for them would
be the "about 4 days" this batch removed.

---

## Blocked on the owner

**1 · Two production migrations**, applied to staging and **not** to production:

- `20260810150000_orders_quoted_estimated_days.sql` — additive, nullable, checked.
- `20260810160000_shipments_courier_selection.sql` — two additive nullable
  columns with a CHECK on the mode.

Neither touches an existing value. The standing procedure applies: snapshot,
content-verify, dry-run, push, confirm PostgREST serves the new columns before
deploying code that writes them.

**2 · Two business numbers, both currently unset and both failing loudly by
design:**

- **`courier_selection_mode`** is `shiprocket` — the previous behaviour. Changing
  it to `best_rated` is what acts on the finding that the recommendation scored
  worst on both lanes measured.
- **`courier_price_tolerance_percent`** is unset. Until it is set, `best_rated`
  refuses and falls back. **This is the number that decides how much more the
  shop will pay for a courier that actually delivers**, and it is yours.

**3 · Confirm per-shipment pickup selection stays deferred** until a second
address exists.
