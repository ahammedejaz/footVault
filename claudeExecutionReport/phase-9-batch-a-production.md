# Phase 9 · Batch A — in production, 2026-08-09

**Status: applied, deployed, verified. The stranded pair on FV-2026-00623 is
back on the shelf and the ledger reconciles to zero drift.**

Every figure below was read back from the live system after the fact, not
inferred from the command that caused it. Where a check did not prove what I
wanted it to prove, that is said rather than smoothed over — §2 and §5 both
contain one.

---

## 1 · The snapshot

```
backup-20260809-2015-schema.sql   141 KB
backup-20260809-2015-data.sql     508 KB
```

Taken with `npx supabase db dump` over the session pooler, immediately before
the push, per `docs/admin-guide.md` §12. The local `pg_dump` is 14.19 and the
server is 17.6, so the plain tool would have refused — the CLI runs the matching
version itself, which is the whole reason §12 specifies it.

Verified **by content**, not by existence:

| | |
|---|---|
| Schema half | 31 tables, 58 policies, 29 functions, 59 indexes |
| Data half | 2,058 rows across 33 tables |
| `auth` schema | **included** — 11 users, 11 identities, 12 sessions |
| Per-table counts vs. live | **all 33 identical**, diffed rather than sampled |
| Newest order in the file | FV-2026-00623 present |
| Load-bearing functions | `create_order_with_stock`, `cancel_order_with_restock`, `reconcile_inventory`, `restock_rto_order`, `release_abandoned_orders` all present |
| Integrity | file ends `RESET ALL;` — not truncated |

This is stronger than Phase 8's snapshot, which was a service-role data export
and could not reach `auth.users` at all.

---

## 2 · The compatibility check, and the part of it that failed

Two migrations drop and recreate load-bearing functions. The deployed build was
confirmed first: production was serving `dpl_8hXyJjr6ZGdATvdnNESMDUKL8qLx`,
commit **`dd4c67b`**, identical to `main` — so reading `git show HEAD:` was
reading the live code.

**Would a DROP miss and leave two overloads?** This is the Phase 8 failure that
needed `drop_stale_cancel_order_overload`, so it was asked of Postgres rather
than matched by eye: `to_regprocedure()` resolved **both** drop targets exactly,
and production carried exactly **one** overload of each.

**Would the deployed call still resolve against the new signature?** Tested, by
POSTing the exact deployed argument sets at staging, which already had all five
migrations:

| Deployed call site | Sent | Result |
|---|---|---|
| `checkout.ts` → `create_order_with_stock` | 22 named, no `p_prepaid_discount` | `CNVRT / cart_unavailable` — body ran |
| `transition.ts` → `cancel_order_with_restock` | 6 named | `not_found` — body ran |
| cron route → `cancel_order_with_restock` | 5 named, no `p_changed_by` | `not_found` — body ran |
| `rto.ts` → `restock_rto_order` | 2 named | `not_found` — signature unchanged |
| pg_cron → `release_abandoned_orders()` | 0 args | `0` — signature unchanged |

**The new columns.** No `select("*")` on `orders` or `order_status_history`
anywhere in the deployed code — the only two wildcards are on `shipments` and
`shipment_errors`, untouched. No Zod `.strict()` anywhere, so an unexpected
column cannot throw. No direct inserts into `orders` at all; all four
`order_status_history` inserts omit `customer_note`, which is nullable. The new
CHECK was validated against live data before it was added: all 16 orders had
`discount_total` min 0, max 0, **zero rows would violate**.

### The check that did not work

I tried to characterise the window between the migration landing and PostgREST's
schema cache reloading, and **could not**. `pgrst_ddl_watch` and
`pgrst_drop_watch` are enabled on both databases and reload the cache
automatically on DDL; the attempt to disable them on staging to force a genuinely
stale cache returned `must be owner of event trigger`. A probe function —
created with a two-parameter shape, cache warmed, then dropped and recreated with
a third defaulted parameter and called with the old two-argument shape — returned
`NEW:1:2:y`, so the *resolution* behaviour is right. But I cannot claim the cache
was actually stale when it ran, so that test does not prove what I built it to
prove.

What followed from it is a real change to the sequence rather than a shrug. The
hazard is the **opposite** ordering: had the deploy landed before the cache knew
`p_prepaid_discount`, a checkout sending it would either be rejected or, worse,
have the argument silently dropped and write `prepaid_discount = 0` while
charging the customer the discounted total. I could not force that state to find
out which. So the reload became a **checked precondition of deploying** rather
than a step that merely happens first — §3, gate A.

---

## 3 · The five migrations

A `--dry-run` first confirmed exactly five pending and nothing else.

```
20260809180000_order_history_customer_note.sql
20260809180100_orders_prepaid_discount.sql
20260809180200_create_order_records_discount_split.sql
20260809180300_cancel_guard_net_outstanding.sql
20260809180400_history_customer_notes_in_sql.sql
```

Ledger **84 → 89**, matching staging. Then `notify pgrst, 'reload schema'`.

| Check | Result |
|---|---|
| `orders.prepaid_discount` | `bigint`, NOT NULL, default `0` |
| `order_status_history.customer_note` | `text`, nullable |
| CHECK | `prepaid_discount >= 0 AND prepaid_discount <= discount_total` |
| Overloads after the drop | **exactly one each** |
| ACLs after the drop | `postgres=X, service_role=X` — identical to before |
| Guard bodies | net-outstanding logic present; `release_abandoned_orders` carries its customer sentence |

**Production diffed against staging**, which `rebuild:stage` had built from the
repo that day — the Batch 3 standard, and this time the answer is *identical*
rather than *identical except for the pending migrations*:

```
columns:     prod=352  stage=352   IDENTICAL
functions:   prod=27   stage=27    IDENTICAL
constraints: prod=134  stage=134   IDENTICAL
```

**The four gates run against production before deploying.** Each used a
nonexistent cart or order id, so each raised before writing; no rows were
created.

| Gate | Sent | Result |
|---|---|---|
| A — cache knows the new parameter | new shape incl. `p_prepaid_discount` | `CNVRT` — **PostgREST accepts it** |
| B — live code still works | deployed 22-arg shape | `CNVRT` — resolves |
| C — both cancel shapes | 6-arg and 5-arg | `not_found`, `not_found` |
| D — anon still refused | anon key | `PGRST202` — function invisible |

Gate A is the one that had to pass before step 4, and did. Gate B is the one that
proves the shop was safe during the window, running old code against the new
schema.

---

## 4 · The merge and the deploy

`typecheck`, `lint`, `shapes` (16 shapes at v4) and `build` all clean on the tree
that shipped. 53 files as `3d86593`; both backup files correctly `.gitignore`d
and excluded. PR **#16** merged as **`b5006a9`**.

```
dpl_3Pp6mtuFNvjrqJEiaQ4XNwaoxehX
  state: READY     target: production     aliasError: null
  commit: b5006a9bc2dfce5c05ab7fa257b6daef70b03558
  alias: www.footvault.in, footvault.in
```

**Smoke check — both hostnames:** `/`, `/shop`, `/product/skechers-go-walk-7-mens`,
`/cart`, `/checkout` all **200**; `/admin` anonymous **404**. Reconciler cron
scheduled `*/10 * * * *`, active, last three runs `succeeded`.

### Proving the code is serving, which took three attempts

READY is a build state — Batch 1 wrote that down after learning it. Two of my
three discriminators were wrong, and both failure modes are worth keeping:

1. **`"Paying online"` — invalid.** It already existed in `dd4c67b`. Finding it
   in a live chunk proved nothing. A string that *appears* in a diff as an added
   line may simply have moved.
2. **Chunk-set comparison against the `*.vercel.app` deployment URLs — invalid.**
   Those sit behind Vercel SSO; old and new both returned the same *Vercel login
   page*, so the two "builds" I was comparing were the same interstitial.
3. **`prepaidDiscountPaise` — holds.** Present in 2 files in `b5006a9`, **0** in
   `dd4c67b`, and one of them is `checkout-flow.tsx`, a `"use client"` component.
   It is in the chunk `www.footvault.in` serves at
   `/_next/static/immutable/chunks/1imvf9e4mujk3.js` (33,929 bytes). It cannot be
   there unless the live build is Batch A.

`footvault.in` briefly appeared to be serving the old build. It was not — the
apex is a redirect host to `www`, and the chunk fetch was not following
redirects, so it received a 15-byte stub. Followed properly it resolves to the
identical 33,929-byte chunk.

---

## 5 · FV-2026-00623 — the stranded pair

Cancelled by the owner through the **Mark Cancelled** button, not by hand. That
mattered: a manual `UPDATE` moves stock without writing an `inventory_movements`
row, and an unreasoned stock write records as `unspecified`, which is exactly
what `reconcile_inventory` exists to catch.

The three numbers asked for:

| | Baseline | After | |
|---|---|---|---|
| `FV-CAMPUS-KIDSSNEA-BLUE-1` stock | 7 | **8** | ✅ |
| `reconcile_inventory()` | 0 rows | **0 rows** | ✅ |
| Restock movement | none | **one row** | ✅ |

```
created_at    2026-08-09 16:11:42.143939+00
reason        cancellation
delta         +1
balance_after 8
actor         bb19f079… — admin, neftlix100@gmail.com
reference_id  8c4ae4d2… — FV-2026-00623
note          Restocked from FV-2026-00623: Cancelled by an admin
```

The actor is the **same admin account that initiated the refund**, so the
cancellation and the money it follows are attributable to one person.

Surrounding invariants: exactly **one** `order` (−1) and **one** `cancellation`
(+1) against this order — they sum to zero, and the guard's restock-once
behaviour held. Order is `cancelled` / `refunded` with `stock_restored_at`
stamped at the same instant as the movement, i.e. the same transaction.
`cart_id` was not released, which is correct — `transition.ts` passes
`p_release_cart: false`. Shop-wide: **0** drifting variants, **0** unspecified
movements, across 709 movements.

**The new column did nothing here, by design.** The cancel wrote
`customer_note = NULL` — decision 4 in the Batch A report: what the customer
needs to know (is money coming back) is derived from payment status in one
place, rather than frozen into a row that cannot know whether a refund settles
later. Null renders as the status label alone. So `customer_note` remains at 0
populated rows across all 34 history rows; its first real value will be written
by the abandonment sweep or an RTO, not by this.

---

## 6 · Three things recorded so they are not later mistaken for problems

### a · The next real order will be FV-2026-00660

`order_number_seq.last_value` is **659**; the highest real order is
**FV-2026-00623**. Numbers **624–659** were consumed by QA orders that created
and then deleted themselves. Nothing is wrong and nothing needs resetting — a
sequence is allowed to have holes, and closing one by hand risks reissuing a
number that appears in a customer's email.

### b · Movement notes name orders that no longer exist

`inventory_movements.note` is free text and carries strings like
`Order FV-2026-00641`. **159 distinct order numbers in that column have no
matching row in `orders`**, and they run from **FV-2026-00489 to FV-2026-00659**
— so this predates today's runs and spans several phases of QA.

**It is broader than the note text, and that is the part worth knowing.**
`reference_id` dangles too. There is **no foreign key** on it — only `actor` and
`variant_id` have one — so deleting an order leaves the reference pointing at
nothing, by design:

| reason | movements | reference resolves | net delta |
|---|---|---|---|
| `opening_balance` | 370 | 0 (no reference) | +2,725 |
| `order` | 171 | 12 | −179 |
| `cancellation` | 156 | 6 | +164 |
| `sweep` | 12 | 3 | +12 |

So of the 339 movements that name an order, **21 resolve**. The ledger is
unaffected and still reconciles to zero, because `reconcile_inventory` compares
each variant's `stock_quantity` against the sum of its deltas and never asks
whether the order still exists. But anyone reconciling stock by reading order
numbers — out of the note *or* by joining on `reference_id` — will chase ghosts.
The reliable question is the one the ledger already answers.

### c · Six QA guest carts are being left in place, deliberately

Six carts, one item each, created 13:10:19–13:12:15 UTC on 2026-08-09, all
guest-token with `user_id` null, all `active`. They are the residue of the audit
harnesses that were writing to the live shop (Batch A report §0). **The owner's
decision is to leave them**, so they are recorded here rather than deleted:
they are not real abandoned carts and should not be read as customer intent.

Zero orders survive from that window and the 72 inventory movements in it sum to
**exactly 0**.

---

## 7 · Final state

| | |
|---|---|
| Migration ledger | 89 |
| Orders | 16 (12 cancelled) |
| Inventory movements | 709 |
| Drifting variants | **0** |
| `unspecified` movements | **0** |
| Carts | 198 |
| History rows | 34, of which 0 carry a customer note |

---

## 8 · Still open, carried to Batch B

- **`npm run audit` cannot go green end to end on a developer's machine.**
  `audit:hydration` exits non-zero on four dev-only `next/image` LCP warnings,
  and the suite cannot be run against a production build either, because
  `src/lib/cart/token.ts` sets the guest cookie `secure` when
  `NODE_ENV === "production"` and a `next start` on plain-http localhost drops
  `fv_guest`. Both predate Batch A. It matters because the merge policy says
  "merge without asking when every gate is green", and that phrase currently has
  no state in which it is true locally.
- **The ~29 product, variant, category, brand, media and customer CRUD actions**
  in `src/lib/actions/admin/` are still reached by no harness that drives their
  UI. `audit:settings-controls` prints this at the end of every run so it cannot
  read as coverage.
- **The PostgREST stale-cache window is uncharacterised** (§2). It did not bite,
  and the ordering now used makes it unreachable, but it is not the same as
  having been measured.
