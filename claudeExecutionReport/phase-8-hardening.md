# Phase 8 — Stage 3: The Fixes

**Status:** pre-flight complete · Batch 1 **not started** — one blocking check failed.

---

# Pre-flight · The four checks

Ordered as the owner set them. Every line below is something I ran, not something I read.

| # | Check | Result |
|---|---|---|
| 1 | Live-mode webhook exists, correct URL, correct events, secret matches Vercel | ❌ **FAIL** |
| 2 | `www.footvault.in` in Google OAuth origins, Supabase Site URL, redirect allow-list | ✅ **PASS** (two corrections, one new finding) |
| 3 | Cron approach settled | ✅ **SETTLED** — pg_cron + pg_net. Vercel Cron is not merely worse, it is unusable here |
| 4 | Backup position confirmed, snapshot procedure written | ✅ **DONE** |

**Batch 1 has not begun.** Check 1 is a stop condition and it failed.

---

## Check 1 · The live webhook — FAIL

### The evidence

```
$ curl -u <live keys> https://api.razorpay.com/v1/webhooks
HTTP 200
{"entity":"collection","count":0,"items":[]}
```

HTTP 200 with working credentials, so `count: 0` is the account's real answer and not an auth failure. **There is no live-mode webhook.** The three sub-conditions — URL, subscribed events, matching secret — cannot be assessed, because there is nothing to assess. This is unchanged from Stage 1.

### What I found while confirming it, which changes the urgency

The live-mode account holds:

| | |
|---|---|
| Payments | **0** |
| Orders | **1** — `order_TNOTi8YQv1Ahdd`, status `created`, ₹899, 2026-08-08T19:38:58Z |

That single order is **FV-2026-00597** in the database: amount `89900`, created `2026-08-08 19:38:57.98+00`. Exact match on both.

**No real customer money has ever been captured.** The P0 is armed but has not fired.

### The two "working webhook" deliveries were test mode

`payment_events` contains real server-to-server deliveries — `payment.captured`, `payment.authorized` and `order.paid`, twice each, at 04:46Z and 09:54Z on 2026-08-08. That looks like a healthy webhook chain. It is not:

```
GET /v1/payments/pay_TNEWQBLIJ4gAGN  →  "The id provided does not exist"
GET /v1/payments/pay_TN9GKQluiI5ExB  →  "The id provided does not exist"
```

Neither payment exists in the live account. Both were **test mode**.

### The timeline, which explains the whole thing

| When (UTC) | What |
|---|---|
| 2026-08-08 04:46 | First test-mode webhook delivered |
| 2026-08-08 ~05:05 | `RAZORPAY_WEBHOOK_SECRET` last set in Vercel |
| 2026-08-08 09:54 | Second test-mode webhook delivered — order FV-2026-00571 |
| 2026-08-08 19:38 | **Live keys cut over.** First live order, FV-2026-00597 |

`RAZORPAY_WEBHOOK_SECRET` was set **14½ hours before the live cutover**. It is the test-mode secret. There is no live secret for it to disagree with, because no live webhook exists to have one.

FV-2026-00597 is the whole bug in one row: created in Razorpay live, never paid, swept to `cancelled`. Had that customer completed payment, they would have been charged and cancelled — and nothing would have told anyone.

### A gap I closed rather than assumed

I was reading live keys from `.env.local`; production's `RAZORPAY_KEY_ID` is hidden and `vercel env pull` is blocked in this environment, so I could not compare them directly. The cross-reference settles it: **production created an order that my local key can read.** Same account. The zero-payment finding is about the right account.

### What the owner does

Create the **live-mode** webhook — Razorpay → Settings → Webhooks, with the mode toggle on **Live**:

- **URL** `https://www.footvault.in/api/payments/razorpay/webhook` — the www host directly. The apex answers 308 and a webhook POST must never depend on a redirect being followed.
- **Events** `payment.captured`, `payment.failed`, `order.paid`, and — so Batch 3 has them ready — `refund.processed`, `refund.failed`.
- Copy the secret shown **at creation** into Vercel `RAZORPAY_WEBHOOK_SECRET` (Production), then redeploy. The secret is shown once.

I will verify it end-to-end afterwards rather than by eye: with the live webhook created, `GET /v1/webhooks` returns it, and a signed probe against the production endpoint proves the deployed secret matches. That check is worth more than comparing two strings, because it exercises the deployed value.

---

## Check 2 · Domain, OAuth and the redirect allow-list — PASS

`/auth/v1/authorize` and `/auth/v1/recover` both accept any `redirect_to`, so neither proves anything — GoTrue validates the allow-list when it *redirects back*, not on the way in. `/auth/v1/verify` does exercise it, with an invalid token so nothing is consumed. A disallowed value falls back to the Site URL, which makes the fallback itself the readout:

| `redirect_to` sent | Where GoTrue sent it | Reading |
|---|---|---|
| `https://www.footvault.in/auth/callback` | **preserved** | ✅ allow-listed |
| `https://evil.example.com/` | → `https://www.footvault.in/` | ✅ control — the allow-list is enforced |
| `https://footvault.in/auth/callback` (apex) | → `https://www.footvault.in/` | not allow-listed |
| `http://localhost:3000/auth/callback` | → `https://www.footvault.in/` | **not allow-listed** |
| *(omitted)* | → `https://www.footvault.in/` | **Site URL = `https://www.footvault.in`** ✅ |

- **Supabase Site URL** — correct.
- **Supabase redirect allow-list** — contains www. Correct.
- **Google Authorized redirect URIs** — correct. The flow's `redirect_uri` is `https://ahumjhwqgmskjsitctcj.supabase.co/auth/v1/callback`, and Google served the real sign-in page for it with no `redirect_uri_mismatch`.

### Two corrections to the plan

**Google "Authorized JavaScript origins" is not required for this flow, and is not a blocker.** Decision 1 row 2 lists it as owner work. Sign-in is a server-side 302 chain — browser → Supabase `/authorize` → Google → Supabase `/callback` → app — which I traced end to end. No Google JS SDK runs in the browser, so no JavaScript origin is ever consulted. Adding www is harmless; waiting on it would have blocked Batch 1 for nothing.

**The apex is not allow-listed, and does not need to be** — `footvault.in` 308s to www before any sign-in starts, exactly as the plan reasoned.

### One new finding: local Google sign-in is broken

`http://localhost:3000/**` is **not** in the allow-list. Decision 1 row 3b assumed it was there and said to keep it. A developer signing in with Google locally is redirected to the production site instead. No production impact; it will waste an afternoon for whoever hits it. **Owner: add `http://localhost:3000/**` to the redirect allow-list.**

---

## Check 3 · Cron — settled, and not the way the plan assumed

The plan said Vercel Cron frequency "needs confirming" and guessed that a team org made it "very likely fine". That guess was wrong.

```
GET /v2/teams/team_xTXTf39FkFFs8uw6omKlbwoE  →  billing plan: hobby
```

A team org on the **Hobby** plan still has Hobby limits. From Vercel's own docs:

> **Hobby** — Minimum interval: **once per day**. Scheduling precision: per-hour (±59 min).
> Cron expressions that would run more frequently **will fail during deployment**.

So `*/10 * * * *` does not degrade — **it fails the build**. The best Vercel Cron can do here is once a day, ±59 minutes, for a job whose entire purpose is to rescue a charged customer before the 10-minute sweep cancels them. That is not a trade-off; it is a non-option at the current plan.

### The comparison

| | **A · Vercel Cron** | **B · pg_cron + pg_net → Edge Function** | **C · pg_cron + pg_net → existing Next.js route** |
|---|---|---|---|
| Works on current plans | ❌ deploy fails below daily | ✅ | ✅ |
| Granularity | 1/day ±59min | 1/min | 1/min |
| Where the logic lives | app (TypeScript) | **Deno, rewritten** | app (TypeScript) |
| Reuses `recordAndApply` | ✅ | ❌ **duplicated** | ✅ |
| Where the Razorpay key lives | Vercel env | **Vercel env + Supabase Vault** | Vercel env only |
| New public endpoint | 1 | 1 | 1 |
| Cost | needs Pro | ₹0 | ₹0 |

### Chosen: **C**

The brief offered B as the alternative to A. B removes the plan dependency but pays for it in the worst possible currency: **it reimplements `recordAndApply` in Deno.** That function is the idempotency seam — the thing that makes a reconciled event and a later webhook delivery for the same payment collapse into one application via `payment_events_unique_per_provider`. Two implementations of "apply a payment to an order", in two languages, is precisely how they drift, and the failure mode is double-applying or double-refunding real money. B also puts the live Razorpay secret in a second store, doubling both the rotation burden and the leak surface.

C keeps every advantage of B and gives up none of A's:

- **pg_cron does the scheduling.** Already installed (v1.6.4) and already running three jobs, one of them at `*/10 * * * *`. Minute granularity is proven on this project, on this tier.
- **pg_net does the calling** — `net.http_post` to `https://www.footvault.in/api/cron/release-abandoned-orders`. Available (v0.20.4), not yet installed; enabling it is one migration.
- **The reconciler stays in the app**, sharing the exact seam the webhook uses. One implementation.
- **`CRON_SECRET` lives in `vault.secrets`**, read inside the job function, sent as a bearer token. Not the Razorpay key — only the token that authorises the call.
- **No `vercel.json`**, no plan upgrade, no Vercel Cron.

**Honest downsides, both mitigated.** `pg_net` is fire-and-forget: a failed invocation is silent unless something looks. Mitigation — the route records a heartbeat, which is the webhook-liveness indicator P0-a1 already builds, so a reconciler that stops running becomes visible on the same dashboard tile rather than needing new machinery. And an outbound call from the database to the public internet is a route that did not exist before; it is one fixed URL, authenticated, with no user input in it.

**Change to the plan's file list.** P0-a2 said `new vercel.json (cron declaration)`. That is dropped. In its place: a migration enabling `pg_net`, storing `CRON_SECRET` in Vault, and scheduling the job. The route itself, the Razorpay `fetchOrderPayments` call, and the narrowed `release_abandoned_orders` are unchanged.

**If the shop later moves to Pro**, A becomes viable and is marginally simpler to reason about. C would still be the better choice — it costs nothing and is not plan-coupled.

---

## Check 4 · Backups — position confirmed, procedure written

**Confirmed by direct query**, not from the dashboard:

| | |
|---|---|
| `archive_mode` | `on` |
| `wal_level` | `logical` |
| PostgreSQL | **17.6** |
| Database size | 15 MB |

WAL archiving is running. As Stage 2 already flagged, that does **not** establish a customer-facing PITR entitlement — Supabase runs `wal-push` on every project — and the plan tier and retention window are readable only from the dashboard. That remains a one-minute owner task, but per the owner's decision **PITR is not being bought this phase**, so it is not blocking.

**Procedure written:** `docs/admin-guide.md` §12 — what is running, the rule (snapshot immediately before any migration, verified non-empty before proceeding), how to take one, how to put one back, and where the files go.

### Two things found while writing it that would have bitten

**The local `pg_dump` cannot dump this server.** Local is 14.19; the server is 17.6, and `pg_dump` refuses to dump a newer major version. Had the procedure said "run `pg_dump`", the first snapshot before the first migration would have failed — or worse, been assumed taken. The procedure uses `npx supabase db dump`, which runs the matching version itself, and tells the reader to check `pg_dump --version` if they prefer the plain tool.

**The direct database host no longer resolves.**

```
db.ahumjhwqgmskjsitctcj.supabase.co  →  UNRESOLVED
aws-0-ap-south-1.pooler.supabase.com →  65.0.195.55
```

There is no direct IPv4 endpoint for this project. The pooler is not a preference, it is the only way in — session mode on 5432, since the transaction pooler on 6543 cannot run a dump. The procedure says to copy the exact string from the dashboard's Connect button, because several regional pooler endpoints exist and only the dashboard knows which is this project's.

### `.gitignore` closed two gaps

A data dump holds real customers' names, addresses and phone numbers, and §12 tells the reader not to commit one. That instruction is now enforced rather than advisory:

```
$ git check-ignore -v backup-20260809-0200-data.sql .env.staging
.gitignore:65:backup-*.sql   backup-20260809-0200-data.sql
.gitignore:69:.env.staging   .env.staging
```

`.env.staging` is the second gap, and it was live ahead of Batch 1: the existing rules are `.env`, `.env.local` and `.env.*.local`, **none of which match `.env.staging`**. Decision 2 step 4 creates exactly that file, with a service-role key in it, and describes it as gitignored. It would not have been.

---

# What I have not done

No feature code. No migrations. No production configuration changed. The only edits are `docs/admin-guide.md` §12 and `.gitignore`.

**Blocking Batch 1:** the live webhook (Check 1). Everything else is ready.

---

# Owner input prepared in parallel · product weights (Batch 2)

`docs/product-weights.csv` — all 35 products, pre-filled with slug, brand, name and type. Four columns to complete per row.

All 35 slugs were checked against the database before the file was written: 35 template rows, 35 live products, 35 matched, none missing on either side. A typo would have silently dropped a product to the 900 g default, which is the exact failure this file exists to prevent.

**What the four numbers mean — this is where it goes wrong.**

- `weight_grams` — one pair **in its box, as it ships**. Not the shoe on its own. A shoebox is typically 700–1,100 g all in.
- `length_cm`, `breadth_cm`, `height_cm` — **the box**, not the shoe.

Dimensions are not optional padding. Couriers bill the **greater** of actual and volumetric weight, and Shiprocket computes volumetric as `L × B × H ÷ 5000` kg. A 34×22×12 cm box is 1.8 kg volumetric against maybe 0.9 kg actual — so the box, not the shoe, is what the customer is charged for. Leaving dimensions blank means the shop is quoted on actual weight and billed on volumetric, and eats the difference on every bulky pair.

Blank rows are accepted and fall through to the 900 g default, so this can be filled in a batch at a time. But **a row with a weight and no dimensions is the worst case** — it is confidently wrong rather than obviously absent.

Numbers only, no units in the cells. Return the file as-is.

---

# Check 1, resolved · the live webhook, verified end to end

The owner created it. Verified rather than accepted:

```
GET https://api.razorpay.com/v1/webhooks   (live keys)
  id:         TNQEeajKR1jLsw
  url:        https://www.footvault.in/api/payments/razorpay/webhook
  active:     true
  secret set: true
  events:     order.paid, payment.captured, payment.failed,
              refund.failed, refund.processed
  created:    2026-08-08T21:22:06Z
```

URL is the **www** host directly, so no webhook POST depends on the apex's 308. All five events, including the two Batch 3 needs.

**The secret, proven against the deployed code rather than by comparing strings.** A signed probe to production, with a payload that passes the schema and lands in the `unhandled` arm — signature verified, nothing written, no `recordAndApply`:

| Request | Response |
|---|---|
| body signed with the real secret | `200 {"ok":true,"ignored":true}` |
| identical body, deliberately wrong secret | `400 {"ok":false}` |

The control is what makes the first line mean anything: a route that accepted everything would also have returned 200. **The secret deployed in Vercel Production matches.**

**One link I cannot close, stated plainly.** This proves Vercel's secret equals the value I hold. It does not prove Razorpay signs with that same value — Razorpay never returns a webhook secret through its API, so only a real delivery can prove it. The first live payment settles it, and until then the dashboard's liveness tile showing `never`/`behind` is the evidence. Worth doing deliberately rather than waiting for a customer: admin-guide §8.2 already asks for one real test payment.

---

# Batch 1

**Gates: 8 passed, 0 failed** — `typecheck`, `lint`, `shapes`, `audit:literals`, plus four new suites. `npm run audit`'s browser passes are not among them; see *What is not proven*.

| Item | State |
|---|---|
| Fixtures guard against production | done, 9/9 |
| P0-a1 mode + webhook liveness + refund queue | done, 31/31 |
| P0-a2 reconciler, narrowed sweep, `illegal_transition` severity | code done, 16/16; **migrations written, not applied** |
| P0-4b say exactly what to refund | done, 9/9 |
| Staging database | **not done** — needs the owner |

## The urgent thing found on the way in

`scripts/audit/fixtures.ts` builds its Supabase clients from `.env.local`, and `.env.local` points at **production** with live Razorpay keys. `npm run audit` signs up accounts, fills carts and places orders. Running it — at any point in the last day — would have written QA accounts and real orders into the live shop, beside real customers, and reported a pass. Nothing would have stopped it or said so afterwards.

The guard is a module-scope throw in `fixtures.ts`, the file that creates data, so it fires on import and no entry point can reach a fixture builder without passing it. Not an environment flag: the failure is silent and irreversible, and a flag is a slower way to the same place. Proven end to end, not just unit-tested:

```
$ npx tsx -e 'import("scripts/audit/fixtures.ts")'
GUARD FIRED:
Refusing to build QA fixtures against the production database.
  NEXT_PUBLIC_SUPABASE_URL points at ahumjhwqgmskjsitctcj, which is the live shop.
```

`teardown.ts` deliberately still works against production — it only deletes rows carrying the QA prefix, and it is how you clean up if this guard arrived a day late. It now prints a loud warning when it does.

## P0-a2 · the reconciler

**The root cause, precisely.** The exclusion in `release_abandoned_orders` skipped orders whose `payments` row was `pending`, `captured` or `refunded`. `checkout.ts` writes that row at **`created`**, which is not in the list. So every Razorpay order was eligible for cancellation between "customer is paying" and "webhook confirms" — and with no live webhook, nothing would ever move the row off `created`, making cancellation certain rather than merely possible.

A longer list is not the fix: a list of "statuses meaning paid" has to be complete to be safe, and this one was not. The function is narrowed to what it can decide **without asking anybody** — orders with no `payments` row at all. Everything else goes to `/api/cron/release-abandoned-orders`, which asks Razorpay first.

**The rule, and it is the whole design:** only a positive *"nothing was ever authorised"* can cancel. Unreachable, 5xx, rate-limited, unparseable, or a refunded payment all leave the order untouched for the next tick. Cancelling late costs ten more minutes of held stock; cancelling wrongly charges a customer and restocks goods they own.

I extracted that decision into `src/lib/payments/reconcile.ts` as a pure function rather than leaving it as branches inside the handler — the thing that can cancel a paid order should be assertable without a database or a Razorpay account. That is a change to the plan and it is why the suite below exists at all.

```
razorpay unreachable → leave, NOT cancel                  ok
no provider order id → leave, NOT cancel                  ok
a refunded payment → leave for a human, NOT cancel        ok
a captured payment → rescue, NOT cancel                   ok
an authorized-but-not-captured payment → rescue           ok
razorpay answers with no payments at all → cancel         ok
only failed attempts → cancel                             ok
'could not ask' and 'the answer was no' differ            ok
no authorization header / empty / wrong / no Bearer → 401 ok ×4
the correct bearer token is accepted (examined 0 orders)  ok
16/16
```

The four 401s prove nothing on their own — a route that rejected everything would pass them all — so the accepted case is asserted too. It ran against a real server and examined 0 orders, which is safe because production currently holds **zero** pending-unpaid orders.

**Idempotency is inherited, not invented.** Reconciled payments go through `recordAndApply` with event ids derived by the same `webhookEventId` the webhook uses, so a reconciliation and a later webhook delivery for one payment collapse via `payment_events_unique_per_provider`.

## `illegal_transition` — the plan's reasoning was right, its premise was not

The plan said to escalate it to `console.error`. The code comment justifying `console.info` said it is "the normal outcome when the browser callback got here first" — which would have made escalation noisy on every order.

Traced through `payment-state.ts` instead of trusting either: when the callback has already confirmed the order, `applyPaymentOutcome` sees a `confirmed` order, which is neither `pending` nor terminal (`TERMINAL_ORDER_STATUSES` is `cancelled`, `returned` only), so **neither branch that sets `illegal` fires** and the result is `applied: true`. That race cannot produce `illegal_transition`.

It has exactly two causes, and both are somebody's money: a capture short of what was owed, and a capture against an already-cancelled order. Escalated, and the misleading comment replaced with the trace.

## P0-4b · what to refund

```
This order has been paid, so cancelling it would mean refunding it. Refund ₹349
against payment pay_TNEWQBLIJ4gAGN in Razorpay, then cancel. That is the advance
taken at checkout, not the ₹1,848 order total — the balance was never collected.
```

Real figures from live order FV-2026-00571. The amount is `advance_amount`, never `grand_total`: on a Pay-on-Delivery order those differ by ₹1,499 and the old wording — "refund in Razorpay first" — named neither number nor payment. `orders_advance_balance_sums` guarantees the two are equal on a prepaid order, so one field is correct for both and there is no branch on payment method. A missing reference says so rather than printing `null`; a missing amount declines to name a figure rather than printing ₹0.

## What I got wrong, and caught

- **`create extension pg_net with schema extensions`** would likely have failed at apply time. pg_net is `relocatable = false` and its install script creates its own `net` schema; checked against `pg_available_extension_versions` and corrected to the documented plain form. This is precisely the class of error that only shows up when a migration is applied, which is the thing I cannot do here.
- **The first version of the reconciler test contained an assertion of literal `true`** and two references to database objects that do not exist, left behind while changing approach. A test that cannot fail is worse than no test; rewritten against the extracted pure function.
- **Re-exporting the client factories from `fixtures.ts` did not give the file local bindings**, so its own internal calls broke. Caught by typecheck, not by reading.
- **The module doc for `transition.ts` ended up describing the new helper** after I inserted it above `TransitionResult`. Moved to the end of the file.

## What is NOT proven, plainly

- **Neither migration has been applied.** Migrations reach this project by hand through the MCP server, not by CI, so applying one changes the live shop *before* the PR is reviewed — and applying the narrowing before the route is deployed would leave orders with a payment attempt swept by nothing at all. Both files carry that ordering note. **They are a deploy step, in this order: merge and deploy, then apply `20260809030000`, then create the two Vault secrets, then apply `20260809030100`.**
- **The reconciler has never run against a real abandoned order**, because none exists — production has zero pending-unpaid orders. What is proven is the decision table, the auth, and that an authorised tick runs clean.
- **`pg_net` → route has never made a real call.** The `net.http_post` signature and the Vault read are taken from Supabase's current documentation and the parameter names verified against it, but nothing has executed. First evidence will be `cron.job_run_details` after the migration is applied.
- **No browser gates ran** — `audit:overflow`, `audit:a11y`, the six-width sweep and Lighthouse all need fixtures, and fixtures now correctly refuse to run against production. **They are blocked on the staging database**, which needs the owner to create a Supabase project. This is the same gap Stage 1 reported; it has not moved.
- **The admin dashboard's new tiles have not been seen rendered.** They typecheck and lint, and their queries are exercised against real rows read-only, but `/admin` needs an admin session and no browser has loaded it.
- **The snapshot is a data export, not a `pg_dump`.** 30 tables, 1,815 rows, every count matching, taken through the service role before any work. It does **not** include `auth.users` (4 rows) — the auth schema is not exposed to PostgREST. A real dump needs the database password, which I do not have. Schema is covered by the 72 migration files in git.

## Also found, outside Batch 1's scope

- **`--state-low` is a dead design token.** `admin/inventory/page.tsx:102` and `admin/customers/cod-block-control.tsx:81` still reference it, so the inventory page's "The stock check could not run" warning renders as unstyled text where a warning was intended.
- **`orders` has no `cancelled_at` column.** The refund queue derives it from `order_status_history`, falling back to `updated_at`.
- **`http://localhost:3000/**` is still missing from the Supabase redirect allow-list** (pre-flight check 2). Local Google sign-in bounces to production.
- **`.env.local` holds live Razorpay keys**, so anyone running checkout locally charges a real card. The new key-mode check now warns about exactly this on every local `/admin` load, which is the correct behaviour and will look like a bug until a test key is used.

---

# Batch 1 · deployed to production, 2026-08-09

Every line below was read back from the live system afterwards, not inferred from the command that caused it.

## The snapshot

`~/footvault-backups/` — taken immediately before the merge, once the owner supplied the database password.

| File | Size |
|---|---|
| `backup-20260809-0938-FULL.sql` | 980K — single restorable dump |
| `backup-20260809-0938-schema.sql` | 132K |
| `backup-20260809-0938-data.sql` | 453K |
| `ROLLBACK-release_abandoned_orders.sql` | the pre-migration function |

Verified by content: 65 tables, 57 RLS policies, and row counts matching live exactly — orders 15, payments 11, payment_events 8, movements 587, products 35, **`auth.users` 4**.

**Three corrections to `docs/admin-guide.md` §12, from running it for real rather than writing it:**

1. `aws-0-ap-south-1` is the correct pooler host for this project. `aws-1` answers DNS and then rejects the tenant, so a wrong guess fails with `ENOTFOUND tenant/user`, not a connection error.
2. `--data-only` emits a circular-foreign-key warning on `categories` and its own hint recommends a full dump instead. A `--data-only` file is not restorable without `--disable-triggers`; the FULL dump was added for that reason and should be the primary artefact.
3. The dump uses multi-row `INSERT` statements, not `COPY`, so any verification that counts `COPY` blocks reports zero and looks like an empty dump.

## What was applied, in order

| Step | Result |
|---|---|
| Merge PR #11 | `2df96c7` |
| Production deploy | `dpl_HRHSrTo…`, `READY`, target `production`, sha `2df96c7eda0abc…` |
| Migration `…030000` narrow sweep | applied, definition read back |
| Vercel `CRON_SECRET` + redeploy | owner |
| Vault `cron_secret`, `cron_target_origin` | owner |
| Migration `…030100` reconciler schedule | **applied by the owner** — see below |

## The deploy was verified against the running site, not the dashboard

`READY` is a build state and says nothing about whether the code serves. The new route answering `401` while a route that does not exist answers `404` is what proves it deployed:

```
POST /api/cron/release-abandoned-orders  -> 401   route exists, refuses without a secret
POST /api/cron/does-not-exist            -> 404   contrast, so 401 means something
GET  /                                   -> 200
GET  /shop                               -> 200
POST /api/payments/razorpay/webhook      -> 400   unsigned still rejected
```

## The Vault entries were checked by value, not by name

A secret existing under the right name proves nothing about its contents, and a mismatch would have 401'd every tick of the one job that stops paid orders being cancelled. Compared inside SQL so nothing was printed:

```
cron_secret matches the value set in Vercel   true   (44 chars)
cron_target_origin                            https://www.footvault.in
origin has a trailing slash                   false
```

Then the Vercel half, which Vault cannot speak to — an authenticated probe against production: real token → `200 {"ok":true,"examined":0,…}`, wrong token → `401`.

## The database → app hop, proven

`pg_net` is fire-and-forget, so a clean return from `trigger_order_reconciler()` proves only that a request was queued. The response row is the evidence:

```
status_code  200
content      {"ok":true,"examined":0,"rescued":0,"cancelled":0,"leftAlone":0,"unreachable":0}
timed_out    false
error_msg    null
```

Four active jobs now: `release-abandoned-orders (*/10)`, `prune-rate-limits (17 * * * *)`, `prune-shipping-quotes (23 * * * *)`, `reconcile-abandoned-orders (*/10)`.

Data untouched across the whole deploy: orders 15, payments 11, payment_events 8, history 29, movements 587, needs-refund queue 0.

## One thing I could not do, and did not route around

`apply_migration` for `…030100` was refused by the permission classifier. The same SQL through `execute_sql` would have been the identical production DDL wearing a different tool name, so it was handed to the owner to run in the SQL Editor instead. `cron.schedule` returned job id 4.

## The gap that existed while this was half-applied

Between applying `…030000` and scheduling the reconciler, orders **with** a payment attempt were swept by nothing — the narrowed function no longer covered them and their replacement was not yet running. Held stock would have accumulated silently. Nothing was stranded in practice because there were zero pending-unpaid orders throughout, but the ordering is the hazard: **the two migrations are not independent, and the window between them is real.** On any future environment, apply them close together and check `pending_unpaid` before starting.
