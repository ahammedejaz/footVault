# Batch 3 — Refunds and repair

**Status: built and proven on staging. Nothing has touched production, and one
owner action is required before anything can.**

---

## What the owner has to do — one SQL statement

The brief's first correction — *drop `public.shipment_errors` from production,
then let the migration create it on the next push* — hit a permission block:
the environment's classifier denied the `DROP TABLE` (and then a follow-up
read-only schema query). Standing rule 1 is explicit that a blocked tool means
stop and report, never a second route to the same effect, and Batch 2's report
shows exactly why that rule exists. So the drop is yours:

```sql
-- In the Supabase SQL editor, on production (ahumjhwqgmskjsitctcj):
drop table public.shipment_errors;
```

What was verified before the block, so you are not taking this on faith: the
table has **0 rows**, no entry in `supabase_migrations.schema_migrations`, no
inbound foreign keys, and no dependent views. Dropping it loses nothing, and
migration `20260809120000` recreates it — with its RLS policy — on the next
push.

**Order matters.** Run the drop *before* the migrations are pushed. The
migration is written `if not exists`, so pushing first would not fail — but the
table would then survive with whatever definition the out-of-band DDL gave it,
which is precisely the drift you asked to end.

**Everything behind this is queued on it**, in order: production snapshot →
push migrations → merge PR #13 → verify the Vercel deployment → confirm the
parcel settings and Pay on Delivery → smoke check. All of it was held rather
than half-done, because pushing migrations before the drop defeats the drop,
and merging without the migrations deploys code against a database missing its
columns.

---

## The decisions and corrections, status

| Instruction | State |
|---|---|
| Box height 10 cm, parcel 20 × 10 × 10 at 1000 g | **Done for every future database** — `20260809150000_parcel_box_height.sql` writes it, staging carries it, `audit:parcel` 12/12. **Production pending** the blocked sequence above |
| Drop `shipment_errors` from production | **Blocked — owner action above** |
| Merge PR #13 once CI is green | CI is green (verified: Typecheck/lint/build ✓, service-role guard ✓, mergeable). **Held** behind the drop, for the ordering reason above |

---

## Batch 3.2 — the fresh-build defects. There were four, not three

Proven by `npm run rebuild:stage`: staging was rebuilt from an empty database,
twice, and the second run came back entirely green:

```
all 82 migrations recorded          PASS
cancel_order_with_restock: 1 form   PASS
all four cron jobs scheduled        PASS
shipping row carries required keys  PASS
no deleted settings key came back   PASS
parcel complete: 20/10/10/1000      PASS
catalog: 35 products, 409 variants  PASS
```

The rebuilt database then served the real storefront: `/`, `/shop`, a product
page, `/cart`, `/checkout` all 200, `/admin` 404 anonymous.

The fixes, each in the file that had the defect:

1. **`pg_cron` used before it existed** — `20260807224044` now creates the
   extension it schedules on. Editing an applied migration is inert for every
   database that already ran it; a replay gets the prerequisite stated instead
   of inherited from production's dashboard history.
2. **The resurrected overload** — `20260809130000` drops the five-argument
   `cancel_order_with_restock` at the end of the sequence. One migration
   repairs all three database shapes at once: production (no-op), staging
   (had both overloads), any fresh replay (transiently has both, ends with one).
3. **The seed un-migrating `site_settings.shipping`** — the seed no longer
   contains a `shipping` entry at all. `20260809140000` creates the row where
   it is missing, with your confirmed numbers (₹6,499 threshold, ₹199 estimate
   fee, Pay on Delivery on) — one writer for that row, and it is the migration
   directory.
4. **The one the brief did not know about.** `20260807141500` revokes execute
   on `public.rls_auto_enable()` — a function **no migration creates**. It and
   its `ensure_rls` event trigger were made by hand before Phase 5, so every
   replay from empty died at migration 21 of 82. Batch 2's staging build never
   hit it because that build worked around the earlier failures by hand and the
   function came into existence the same way. The migration now creates
   exactly what production carries — the definition read back live via
   `pg_get_functiondef`, not reconstructed from memory — then revokes as
   before. This is the strongest argument the batch produced for the brief's
   own rule: the disaster-recovery path failed on a defect *nobody had listed*,
   and only running the rebuild for real found it.

**The one command** is `npm run rebuild:stage` (`scripts/db-rebuild.ts`):
clean → replay all migrations → seed → verify, refusing by construction to aim
anywhere but staging. A CI job was considered and deliberately not added — the
brief offered "a CI job, or a documented command", and the command is
documented in `docs/staging.md` §3 and required by the gates of every future
batch, which is the same regression net without a second Postgres-in-CI
harness to maintain. Recorded under imperfections regardless.

Found while building it: `supabase db reset --db-url` (CLI 2.113.0) is a
legacy path that replays migrations into a **dirty** database — it died on
`create sequence` eleven statements in. The script's explicit clean step exists
because of that, and its header documents what the CLI would not do.

---

## Batch 3.1 — refunds. The last money hole, closed

The policy matrix existed (`src/lib/orders/refund-policy.ts`); this batch
built what moves the money, so that the dangerous states are unreachable
rather than discouraged:

| Piece | Where | The property it enforces |
|---|---|---|
| Provider calls | `src/lib/payments/razorpay.ts` — `createRazorpayRefund`, `fetchPaymentRefunds` | Amount always explicit (Razorpay's omitted-amount default is "everything"); a timeout is a distinct `unknown` state no caller can flatten into "failed" |
| Webhook arms | same file, `refund.processed` / `refund.failed` | Parse into their own verified shape, never a `PaymentOutcome` — a refund event structurally cannot move order payment state |
| Orchestration | `src/lib/orders/refunds.ts` | Row inserted `created` **before** the API call; `notes.refund_row_id` threads recovery; the webhook is the only writer of `processed` |
| DB guards | `supabase/migrations/20260809160000_refund_guards.sql` | One in-flight refund per order (partial unique index — the double click loses to Postgres); `refunds_guard` trigger with a row lock makes over-refunding impossible for every writer |
| Route dispatch | `src/app/api/payments/razorpay/webhook/route.ts` | Same status-code contract as payments: 500 only when redelivery helps |
| Admin actions | `src/lib/actions/admin/refunds.ts` | `adminAction`-guarded; the browser sends only the figure it was shown, recomputed and refused on drift |
| The panel | `src/components/admin/orders/refund-panel.tsx`, mounted in the order page | Cause is the one chosen input; amount, deductions and explanation are computed; two presses to fire |
| Dashboard-refund import | `importRefundsForOrder` + "Check Razorpay" button | Hand-issued refunds — including any from before this existed — become rows; idempotent by `rfnd_` uniqueness |
| Cancel path | `src/lib/orders/transition.ts` | Points at the panel now, still naming the advance and the `pay_` id, still never the grand total (`audit:refund-message` 9/9) |

**The proof** — `npm run audit:refunds`, **23/23 on staging**, no Razorpay API
call anywhere in it (the provider is simulated at exactly the seam the route
uses). The three gate promises verbatim:

- *A refund cannot exceed the captured amount*: the trigger refused one paise
  over, and refused a full-amount refund after a partial one.
- *A double-clicked button cannot issue two refunds*: the second insert lost
  to the index with `23505`.
- *A replayed refund webhook produces one refund*: second delivery
  short-circuited `duplicate`; exactly one row, `processed`, timestamped.

Plus: a dashboard refund the database had never seen became its own row; full
coverage flipped `payment_status` to `refunded`; and the timeout scare — a
`failed`-marked attempt that actually went through at Razorpay — was adopted
back onto its own row by the note, ending with one refund, not two.

Interactions declared before writing (standing rule 7):

- **Refunds × RTO**: `freightFor()` prefers `rto_actual_charge_paise` (recorded
  by the 3.3 flow) over the frozen quote — so recording the actual return
  charge changes the computed refund, by design. Until an actual is recorded,
  the quoted legs are used and labelled.
- **Refunds × cancellation**: cancelling a paid order still refuses and
  explains; the refund is a decision on the panel, never a side effect of the
  cancel button — the same stance `cancel_order_with_restock` documents.
- **Partial refunds × the matrix**: the ceiling passed to the matrix is what
  *remains* (captured − processed − in flight), so a second partial computes
  against reality and the clamp cannot promise money already returned.

---

## Batch 3.3 — RTO handling

Built by a subagent against a written interface contract (standing rule 6:
interfaces before implementations, one writer per file); integrated, reviewed
and mounted by the lead. **35/35 checks on staging.**

The lifecycle, each step refusing to be skipped:

1. **Detection.** A tracking refresh whose status says RTO (any casing) moves
   the order `shipped → returning`, stamps `orders.rto_at` and
   `shipments.rto_at`, and writes the history line "Courier reported RTO: …".
   Compare-and-swap with three attempts, so two concurrent polls produce one
   transition; calling it twice was proven to yield one history line. **No
   restock happens here** — the `returning` interval exists because parcels
   are lost and damaged on the way back.
2. **Receipt and inspection.** An admin marks the box physically in hand,
   condition `ok` or `damaged` — damaged requires a note (the write-off
   record). Transition-first, stamp-second, so a half-failed press converges
   on retry.
3. **Restock, exactly once.** `restock_rto_order` (new RPC,
   `20260809170000`): locks the order row, refuses unless `returned` +
   received + inspected `ok` + not yet restocked (verdicts name which guard
   said no), then one stock update joining `order_items` so the movement
   trigger writes one `inventory_movements` row per item, reason `rto_return`,
   actor attributed. Proven: stock 5→7 with exactly two movements naming the
   actor; second press answered `already_restocked` with stock unchanged.
4. **Damaged never restocks.** No inventory movement is written for a
   write-off — the units left the ledger at sale and never re-enter, so the
   ledger reconciles without a row. Asserted with exact stock counts.
5. **The actual charge.** The admin types what Shiprocket actually billed for
   the return, stored in `orders.rto_actual_charge_paise` beside the frozen
   quote. Declared interaction: `freightFor()` in the refund module prefers
   this actual over the quote, so recording it changes the computed refund —
   by design, and said in a comment at the recording site.
6. **The view.** `/admin/rto` ("Returns to origin" in the nav): which orders
   came back, from which PIN codes (read from the checkout address snapshot's
   `postalCode`, not guessed), quoted versus actual cost totals, and phone
   numbers on ≥2 RTO orders flagged — the candidates for the per-customer
   Pay-on-Delivery block that already exists on `profiles`.

Subagent conduct under standing rule 1: **no tool was blocked and no
workaround was attempted** — a clean run, worth recording opposite Batch 2's
defect. Two integration fixes were the lead's: the audit's first run left four
`opening_balance` ledger rows behind (the new-variant trigger writes them; the
subagent found and swept both the code path and the strays), and the lead's
own `audit:refunds` cleanup block carried five `no-unchecked-supabase-error`
lint errors — written after the last lint run, caught by the subagent's
verification, rewritten to check every delete.

---

## The gates

All against staging (`pblgpvcdappfpoxdascd`). The database and pure gates ran
against the live staging schema; the browser gates ran against a production
build (`next build` + `next start`, staged) — see "what I got wrong" for the
day this cost.

| Gate | Result |
|---|---|
| `audit:literals` | PASS — no typed rupee figure, code and CMS content |
| `audit:fixtures-guard` | PASS 9/9 — resolved target is staging |
| `audit:refund-message` | PASS 9/9 |
| `audit:refunds` | **PASS 23/23** — the cap, the double-click index, replay = one refund, dashboard import, timeout adoption |
| `audit:rto` | **PASS 35/35** — detection idempotency, receive guards, restock exactly once with the ledger asserted, repeat-phone flag |
| `audit:reconciler` | PASS 15/15 |
| `audit:payment-health` | PASS 31/31 |
| `audit:totals` | PASS 43/43 — advance + balance = total across modes |
| `audit:delivery` | PASS 53/53 — live/flat × free-tier × refuse_cod, all 256 decision inputs leave no order unsecured |
| `audit:shipping` | PASS 96/96 — COD collectable equals the balance |
| `audit:parcel` | **PASS 12/12** — the height is no longer the one deliberate failure |
| `audit:cart` | PASS — merge under RLS |
| `audit:bag` | PASS — the whole purchase path at 390px |
| `audit:checkout` | PASS — checkout, orders, webhook idempotency on the live DB |
| `audit:security-advance` | PASS — a customer cannot lower the minimum advance |
| `inventory_movements` reconciliation | **zero drift** — `reconcile_inventory()` returns no drifting variant |
| `npm run shapes` | PASS (in CI on every push) |
| `npm run rebuild:stage` | **PASS** — staging from empty, one command, every check green |
| `audit:overflow` | **PASS** — 22 routes + 15 populated states × 6 widths (360/390/768/1024/1440/1920), 9,197 interactive elements: no overflow, no tap target under 44px, no input under 16px |
| `audit:a11y` | **PASS** — axe, WCAG 2.2 A/AA, 22 routes + 15 states at 390 and 1440, zero violations |
| `audit:keyboard` | PASS |
| `audit:keyboard-checkout` | **PASS 17/17** — browse → bag → checkout → Pay-on-Delivery order (FV-2026-00062) → history, keyboard only, after the harness learned to press Space (below) |
| `audit:focus` / `audit:gallery` / `audit:hydration` / `audit:links` / `audit:interactions` | PASS — interactions after its colourway wait was fixed (below) |
| `audit:auth` | **PASS 11/11** — including "/admin is 200 for an admin", the check that exposed the six-harness find |
| `audit:signedin` / `audit:admin` / `audit:admin-pages` | PASS / PASS / **PASS 56/56** — all re-run after the repoint, since their prior passes partly described the wrong database |
| `audit:actions` | **PASS 89/89** — every admin action refuses customers and anonymous callers; the positive control runs |
| `audit:security` | <!-- SECURITY --> |
| Lighthouse (mobile, devtools throttling) | <!-- LIGHTHOUSE -->

---

## Six harnesses were quietly testing the live shop

The most serious find of the batch, and it was found by a *failing positive
control*, which is why positive controls exist.

`audit:auth` failed one check — "/admin is 200 for an admin" — while every
refusal check passed. The trail: the promoted admin was real, `is_admin()`
said true over PostgREST, yet the app 404'd the session. The session cookie
named the wrong project. **Six harnesses — `auth-rls`, `signed-in`,
`admin-pages`, `admin-security`, `security-checkout`, `server-actions` — never
went through `scripts/audit/clients.ts`**: each read `.env.local` itself and
took `NEXT_PUBLIC_SUPABASE_URL` at its word, which is production. Batch 2
wired the fixture harnesses through the staging chokepoint and these six were
missed — so every run since has been creating QA users on the **live shop's**
auth, promoting one to admin on the **production** database, exercising RLS
there, and deleting them afterwards, while the app under test pointed at
staging.

Checked immediately on production: **no `fv-test-` or `fv-qa.` user exists** —
every run's cleanup completed, including today's. Nothing was left behind.
But the exposure was real: a harness crash between "promote" and "delete"
would have left an admin account with a password printed in this repository
on the live shop. The reason it was never caught is exactly the reason it was
caught today: with production and the app on the *same* project the straddle
is invisible and every check passes; the staging split made the two halves
disagree, and the positive control was the disagreement.

The fix is one line per file — `import "./clients"` before anything reads
`process.env` — which routes them through the same staging resolution and
production guard as every other harness. `audit:auth` then passes 11/11
against staging end to end, admin 200 included. The gates that "passed"
before the fix (`audit:admin` among them) were re-run after it, since what
they had previously proven was partly a statement about the wrong database.

## Autonomous decisions, with rationale

1. **Held the entire merge/production sequence behind the blocked drop** rather
   than merging PR #13 first. Merging deploys code whose checkout RPC and
   quote columns do not exist on production yet — checkout down for the gap.
   The safe order is drop → snapshot → push → merge → verify → smoke, and only
   the first step is blocked, so everything queued.
2. **Edited two applied migrations** (`20260807224044`, `20260807141500`)
   rather than adding backdated files. Applied databases never re-run them, so
   the edits are inert there; backdating new files is the exact mechanism that
   produced the overload defect.
3. **The seed lost its `shipping` entry instead of learning the new shape.**
   Two writers for one row is how the drift happened; the migration is now the
   only writer, and the seed cannot regress it again.
4. **Owner numbers written into a migration** (`20260809140000`, ₹6,499/₹199;
   `20260809150000`, the 10 cm). Both are numbers you stated — the brief for
   the height, the confirmed production row for the thresholds — recorded so a
   rebuilt database opens as your shop. No value was invented.
5. **`payment_status` gains no `partially_refunded` value.** The enum stays
   three words; `refunded` means every captured paise returned, and partial
   refunds are visible as rows with deductions on the order page. An enum
   migration on the money path for a display distinction was not worth it.
6. **Refund events got their own parse variant** instead of widening
   `PaymentOutcome`, so no future code path can feed a refund into the
   machinery that confirms orders.
7. **`importRefundsForOrder` is per-order, on a button** — not a cron. The
   population it exists for (refunds issued by hand) is small and known to
   you; a cron sweeping every payment's refunds would spend API quota to
   discover nothing, forever.

## What I got wrong and caught

- **First rebuild attempt used `supabase db reset --db-url` on the CLI's word.**
  It replays into a dirty database. Caught on the first run, replaced with an
  explicit clean; the script header records it so nobody trusts that flag
  again.
- **The first refunds fixture violated `orders_advance_balance_sums`** — I
  forgot the money identity the schema itself enforces (advance + balance =
  total). The constraint did its job; the fixture now states the identity.
- **The first full gate run was driven against `next dev`, and its failures
  were the server's, not the shop's.** The chain died at `audit:overflow` with
  two states timing out at all six widths; both passed in isolation minutes
  later, and a second run failed a *different* state at one width. Meanwhile
  `audit:actions`' positive control 404'd because it posts action ids read
  from the build manifest at a dev server that mints its own. The README had
  said all along that the browser gates need `npm run build && npm start`;
  the browser and action gates were then rerun against a staged production
  build, which is what the numbers above are from. Lesson recorded here
  because it cost the better part of an hour: a gate flaking on `next dev` is
  telling you about `next dev`.
- **The refund history line initially typed `status` as `string`** and the
  compiler refused the enum column. Typed at the load boundary instead.

## Known imperfections

- **No CI job replays the migrations.** The one command exists and the gates
  require it per batch, but nothing runs it on every PR. A
  `supabase db start`-based job is the natural next step.
- **`docs/database.md` still opens with "29 tables"** and per-table counts from
  Phase 6; the Batch 2/3 tables are documented in their sections but the
  header table was not recounted.
- **The forward freight in a refund deduction is the frozen quote**, not
  Shiprocket's invoiced actual — no column holds the actual forward charge
  yet. The breakdown labels it; an "actual forward" column is future work.
- **`refunds_one_in_flight_per_order` serialises per order, not per shop** — 
  deliberate, but it means two admins refunding two different orders
  concurrently both proceed while two admins on one order get one refund. The
  second admin's message says a refund is in progress, which is true but may
  read as an error.
- **`src/lib/database.types.ts` remains hand-patched** (Batch 2's note stands):
  the CLI still cannot authenticate non-interactively here to regenerate it.
- **The refund suite was not mutation-tested to completion.** Batch 2's
  practice is to reintroduce each bug and watch the suite fail. The first
  mutation (treating a duplicate webhook claim as fresh) was written, and the
  environment's permission classifier refused to run the tests against it —
  reasonably, since it is deliberately broken money code. Standing rule 1
  says a block ends the attempt, so the mutation was reverted (verified: the
  working tree is byte-identical to the commit) and the practice stands
  incomplete here. Mitigation, not proof: every assertion in `audit:refunds`
  checks a specific database error code or row state, the shapes that cannot
  pass vacuously.
- **The refund panel's UI was not exercised by a browser gate this batch** —
  the flow is proven at the seam (`audit:refunds`) and the page renders, but
  no Playwright script presses the actual button against a staging order end
  to end.

---

## Migrations this batch

| File | What |
|---|---|
| `20260807224044` *(edited)* | States its own prerequisite: `create extension if not exists pg_cron` |
| `20260807141500` *(edited)* | Creates `rls_auto_enable` + `ensure_rls` before revoking — production's own definition |
| `20260809130000_drop_stale_cancel_order_overload.sql` | One `cancel_order_with_restock`, on every database shape |
| `20260809140000_shipping_settings_row_exists.sql` | The `shipping` row exists after a replay, owner's numbers |
| `20260809150000_parcel_box_height.sql` | The owner's 10 cm; the parcel is complete |
| `20260809160000_refund_guards.sql` | The one-in-flight index and the captured-amount trigger |
| `20260809170000_restock_rto_order.sql` | The stock from a returned parcel, back exactly once, through five guards |

All applied to staging. **None applied to production** — queued behind the
owner's drop, above.
