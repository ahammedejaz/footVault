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
