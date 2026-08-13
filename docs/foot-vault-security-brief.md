# Foot Vault — Security Hardening

**Six areas. Audit first, report, then fix in severity order.**

> Save as `docs/SECURITY_HARDENING.md` and tell Claude Code: *"Read docs/SECURITY_HARDENING.md and begin Stage 1. No fixes until I have the findings."*

---

## How to run this

**Stage 1 — audit all six areas, fix nothing.** Report at `claudeExecutionReport/security-hardening-audit.md`, with a severity per finding: **P0 exploitable now**, **P1 exploitable under a plausible condition**, **P2 defence in depth**, **P3 hygiene**. Evidence, not assertion — a curl response, a query result, a file path and line, a grep count. Then stop.

**Stage 2 — fix in severity order**, reporting between groups.

**Do not fix while auditing.** A fix folded into an audit hides the finding, and this list is more valuable than any individual patch.

---

## Standing rules

**The shop is live with real Razorpay and Shiprocket credentials.** Every change stops and asks if it touches money, payments, refunds, auth, RLS, admin authorisation, or applies a production migration.

**A blocked tool means stop and report.** Never switch tools to achieve the same effect. This binds subagents.

**Verification must be able to fail.** This project has repeatedly found checks that could not discriminate — a `PGRST202` read as "refused", a dry run reporting "would process 0", an assertion matching a lookalike element. For every security check you write or trust, state what a broken system would look like. If the answer is "the same", it is not a check.

**No production migration is applied by you.** Write it, dry-run it against staging, and put it on my list.

> **One exception has been granted, and it does not generalise.**
>
> On **2026-08-13** the owner overruled this line for **`20260813150000_shorten_abandoned_order_window.sql`, and for that migration only**, after being shown the line and asked to decide explicitly.
>
> Their reasoning, recorded verbatim in intent: `create or replace` at the **same arity** so the ACL survives; **one integer default** changed (`p_older_than_minutes` 30 → 10) and nothing else; verified on staging first; and the pre-change snapshot provably captured `DEFAULT 30`, so **the rollback is one statement**.
>
> **This is not a precedent.** The owner asked specifically that it be written down as per-migration so that a future session cannot read "the owner overruled line 27 once" as licence. The rule above stands, unchanged, for every other production migration. If you are reading this because you want to apply one: the answer is still no — show the owner the line and let them decide, which is what produced this exception in the first place.
>
> Note also what the exception was *not* about. It was not "the migration is small so the rule is silly". It was the owner exercising a judgement that is theirs to exercise, on a specific change, with the rollback path already proven. Absent that conversation, the rule binds.

---

## What is already known — start here, do not rediscover it

Some of this is settled and deliberate. Confirm each is still true rather than re-litigating it.

- **Rate limiting exists**: nine policies, all consumed, none declared-but-dead. It **fails open by design** — eight policies protect the database using the database, so guard and risk vanish together. Only `serviceability` is the dangerous shape, guarding Shiprocket's paid external quota with a database counter, and it has its own in-memory backstop. Documented in `docs/architecture.md`.
- **Unprotected surfaces as last audited**: `cart.ts`, `wishlist.ts`, `address.ts`, `announcement.ts`, and `auth.ts` — the last only exposes an OAuth redirect and sign-out. Cart writes were later bounded at 90/min keyed on IP, not guest token, because a caller who drops the cookie mints a fresh token and a fresh cart row per request. **CGNAT is common on Indian mobile networks, so IP keying means real customers share a bucket** — that is the failure mode if legitimate users report being blocked.
- **Auth is Google-only.** Email signup was found enabled with autoconfirm on production and has been disabled; staging keeps it because the browser fixtures depend on it. There is no password login, no password reset, and no signup form. **Rate limiting login and password reset is therefore not applicable here** — confirm that rather than building for routes that do not exist.
- **A live privilege regression was found and closed on 13 August**: a migration changed `create_order_with_stock`'s arity, a new arity is a new function, and a new function inherits no ACL — so it defaulted to `PUBLIC` execute and anon could invoke order creation with caller-chosen fee and discount arguments. Closed by `20260813010000`. `security-advance` now derives the signature from the catalogue instead of naming one.
- **Zod validation is used throughout** — one schema shared client and server for forms and admin actions. The audit's job is to find where it is **not**, not to add it where it is.
- **`.env.local`, `backup-*.sql` and `.env.staging` are gitignored** — the last two were added after being found missing.
- **Secrets in use**: Razorpay key ID and secret, Razorpay webhook secret, Supabase anon and service-role keys, Supabase DB password, Resend API key (full access, because the inbound route reads received mail), Shiprocket email and password, `CRON_SECRET`.

---

# STAGE 1 — THE AUDIT

## 1 · Rate limiting

The nine existing policies are documented. What to establish:

- **Which endpoints have no limit at all**, and what each one costs if hammered — money, database load, third-party quota, or nothing. Rank by cost, not by count.
- **The review endpoint**, new in Phase 11, and whether it is covered.
- **The webhook routes** — Razorpay's and Resend's. A flood there is someone else's retry storm, not necessarily an attack, and the limit must not cause a legitimate webhook to be dropped. Say what happens today if Razorpay retries hard.
- **The cron route.** It is `CRON_SECRET`-guarded; confirm the secret is checked before any work and that a wrong secret is cheap to reject.
- **Are thresholds configurable or hardcoded?** The brief asks for configurable. Say where each number lives.
- **Backoff versus hard block.** With no password auth there is little to brute-force, but state what happens today when a limit trips: refuse-and-recover, or something a real customer would read as the shop being broken.
- **Whether IP is the right key anywhere it is used**, given CGNAT.

## 2 · Input validation

- **Every server action, route handler and RPC**: does the input have a schema, is it validated **server-side**, and does it reject rather than coerce? A client-side schema with no server counterpart is the finding that matters.
- **Every field that reaches money**: quantities, coupon codes, coin spend, PIN codes, addresses. Anything a client sends that is not recomputed server-side is a P0 by definition. This project already shipped an endpoint accepting a client-supplied amount once.
- **Length and shape limits.** Review bodies, delivery notes, product descriptions, admin copy fields. Unbounded text is a denial-of-service surface and a rendering hazard.
- **The `is_admin()` check is inside every admin action**, not merely in middleware — middleware returning 404 protects page navigation, not server actions. Verify by calling actions directly, as `audit:actions` does.
- **JSONB payloads** — homepage sections, crop parameters, settings rows. These bypass column typing entirely. Say which are schema-validated on write and which are not.
- **Numeric bounds.** Negative quantities, zero, absurd values, integer overflow on paise arithmetic.

## 3 · Secrets

- **Grep the built client bundle**, not the source, for every secret named above. Source greps have produced false confidence before.
- **Git history**, not just the working tree. A secret committed and later removed is still in the history and still leaked. If anything is found, say so plainly and I will rotate it.
- **`NEXT_PUBLIC_` variables** — confirm every one is genuinely public and nothing sensitive acquired the prefix.
- **Server-only enforcement**: which modules import `server-only`, and whether any server client can be reached from a client component. The `service_role` guard covers this — confirm it is running and green, since it was silently red on `main` for two days in August.
- **Log output.** Confirm no payment payload, webhook secret, token or password can reach a log. The error-reporting path emails me; confirm what it includes.
- **The repo-tracked `.claude/settings.json`** enables a third-party plugin deliberately. Note it; do not change it.

## 4 · Dependencies

- `npm audit`, with severity and reachability. **Say which vulnerabilities are actually reachable in this application** — a high-severity advisory in a dev-only transitive dependency is not a P0, and treating it as one trains people to ignore the list.
- Anything unmaintained or superseded.
- **Do not bulk-update.** Propose specific upgrades with their risk, and treat any major version bump as its own change.

## 5 · Error handling and information leakage

- **What a customer sees** when checkout fails, a payment fails, Shiprocket refuses, or a server component throws. Stack traces, file paths, raw Postgres errors, Supabase error codes — anywhere any of these reach a browser.
- **What the error emails contain.** They come to me, so detail is right — but confirm they carry no secrets and cannot be triggered in volume by an attacker.
- **Error digests.** Production strips messages and leaves a digest; confirm the full detail reaches somewhere I can retrieve it, or the digest is useless.
- **Enumeration.** `/order/[orderNumber]` returning byte-identical bodies is deliberate anti-enumeration and must stay. Check the same discipline elsewhere: coupon validation, review submission, address lookup, `/admin`. Where a message could reveal what exists, it should be generic.
- **The 522s and 500s** seen during the August incident — confirm nothing in that path leaks internals.

## 6 · File upload safety

The image pipeline is the main surface, plus the video bucket.

- **Content validation, not extension.** Confirm the uploaded bytes are decoded and checked, not trusted by MIME type or filename. `sharp` decoding is a real check; a MIME string is not.
- **Size limits** enforced server-side as well as client-side. Bucket limits: images 5MB, video 10MB.
- **Bucket policies** — who can write to `product-images`, `category-images`, `site-assets`, `site-video`. Confirm write is admin-only and read is deliberate.
- **Path construction.** Paths are content-hashed; confirm no user-supplied string reaches a storage path, and no traversal is possible.
- **SVG specifically.** SVG is executable in a browser context. Confirm it cannot be uploaded, or that it is neutralised — the seed placeholders are SVG, so the distinction between first-party assets and uploads must be clean.
- **What a malicious file can do.** Storage is object storage, so execution is unlikely — say so plainly if it is not a real risk here rather than asserting a mitigation that does nothing. The realistic risks are decompression bombs consuming a function's memory, and a file that renders as something other than what it claims.
- **The video path**, which accepts a much larger file and is served directly to every visitor.

---

# STAGE 2 — FIXES

In severity order, reporting between groups. For each:

- The fix, and the test that proves it — a test that fails on the unfixed code first.
- Whether it needs a production migration or a dashboard change by me.
- Whether it could break a legitimate customer. A rate limit that blocks real buyers is worse than the attack it prevents.

**Add the gate coverage as you go.** Every fix that can regress silently gets an assertion, and every assertion states what a broken system would look like.

---

## Quality gates

- `npm run audit` green end to end, including `shapes`.
- `audit:build-smoke` before any deploy.
- New security assertions proven to fail on the unfixed tree before they pass.
- No secret in the built client bundle — grepped from the build output.
- Every admin action refuses a forged Server Action post, with and without a session.
- Anon cannot execute any function it should not, derived from the catalogue rather than named.

---

## Done when

I have a list of what was actually wrong, what was fixed, what was deliberately left and why — and every fix carries a test that would have caught the problem in the first place.
