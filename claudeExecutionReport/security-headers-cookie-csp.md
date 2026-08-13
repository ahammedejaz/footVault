# Security Headers, Session Cookie, and the Report-Only CSP

**Date:** 2026-08-13
**Scope:** four launch-checklist items the Stage 1/2 security audit did not cover, then the
implementation of the two that were actionable, then a production deploy attempt.
**Status:** **DEPLOYED 2026-08-13.** `www.footvault.in` serves commit `261e5a0` via
`dpl_84iLi2robdZMArRJfv6sJ9FXpTvx`. Migration `20260813150000` applied to production.
`CSP_MODE` is still `report-only` and must stay there until the owner's test payment is clean —
see [§10](#10-deploy-record--2026-08-13).

---

## 1 · What was asked

Four things a launch checklist covers that the security audit did not:

1. **Security headers on production** — what `www.footvault.in` actually returns, and a
   proposed CSP if absent, accounting for Razorpay checkout, Supabase storage and the hero
   video, plus the risk of getting it wrong.
2. **Session cookie flags** — `httpOnly`, `Secure`, `SameSite` on the Supabase auth cookies
   and the guest cart cookie, **measured from a real response** rather than read from config.
3. **Encryption** — what Supabase encrypts at rest by default, and whether anything stored
   warrants column-level encryption. A recommendation, not a hedge.
4. **Bot protection** — realistic abuse for a shop this size, and whether anything is worth
   adding now.

---

## 2 · Findings

### 2.1 Security headers — four of six missing

Measured on production:

```
strict-transport-security: max-age=63072000
x-robots-tag: noindex, nofollow, noarchive
x-powered-by: Next.js
```

| Header | Present before | Source |
|---|---|---|
| `Strict-Transport-Security` | yes — `max-age=63072000` | Vercel default; no `includeSubDomains`, no `preload` |
| `Content-Security-Policy` | **no** | — |
| `X-Frame-Options` | **no** | — |
| `X-Content-Type-Options` | **no** | — |
| `Referrer-Policy` | **no** | — |
| `Permissions-Policy` | **no** | — |

**Correction to the premise of the request.** The brief said CSP had become the load-bearing
control on `dangerouslyAllowSVG`. That control *is* present and working — it is a different
CSP from the missing one. `images.contentSecurityPolicy` applies to optimiser responses, and
it was verified on a real 200:

```
GET /_next/image?url=%2F_next%2Fstatic%2F…%2Flogo.png&w=32&q=75  →  200
content-security-policy: default-src 'self'; script-src 'none'; sandbox;
content-disposition: attachment; filename="logo.png"
```

The SVG containment argument in `next.config.ts` holds. The gap was the **document** CSP,
protecting a different thing.

### 2.2 Session cookie flags — one gap, one that cannot be closed

Both measured from real `Set-Cookie` headers.

**Guest cart cookie — correct, measured on production** by adding one item to a bag as an
anonymous visitor:

```
fv_guest=…; Path=/; Expires=Fri, 13 Aug 2027; Max-Age=31536000; Secure; HttpOnly; SameSite=lax
```

The bag was emptied afterwards; `/api/cart` confirmed `lines: 0`.

**Supabase auth cookie — missing both flags.** Measured by minting a session, backdating its
stored expiry so `getClaims()` was forced to refresh, and reading what the app emitted:

```
sb-<ref>-auth-token; Path=/; Max-Age=34560000; SameSite=lax
```

No `HttpOnly`. No `Secure`. Max-Age **400 days**.

Measured against staging, but it transfers to production: the string `secure` appears
**nowhere** in `@supabase/ssr`'s dist, the app passed no `cookieOptions` at either
`createServerClient` site, and Next adds no cookie attributes of its own. Nothing here is
environment-gated, unlike `fv_guest`'s `secure: NODE_ENV === "production"`.

**`httpOnly: false` cannot be fixed.** It is `@supabase/ssr`'s design —
`createBrowserClient` reads the session from `document.cookie`. Five components depend on it,
four of them admin upload panels that talk to Supabase Storage with the caller's session:

```
src/components/admin/products/image-upload-panel.tsx
src/components/admin/products/recrop-dialog.tsx
src/components/admin/appearance/hero-video-uploader.tsx
src/components/admin/media/media-uploader.tsx
src/app/(storefront)/product/[slug]/not-found.tsx
```

Setting `httpOnly: true` would make those authenticate as `anon` and be refused by RLS.

**Consequence, stated plainly:** the session cookie is XSS-reachable by design. The usual
sentence — "XSS is contained, the session is httpOnly" — is not available to this
architecture. **The CSP is the first layer here, not the second.**

Two comments in the codebase claimed the guest bag had "the same security properties as a
session cookie". That was false in the flattering direction; the bag is the better-protected
of the two. Both corrected.

### 2.3 Encryption — recommendation: do not add column-level encryption

**What Supabase gives by default:** all data on disk encrypted with AES-256, transparently,
no configuration. TLS in transit. Backups inherit it.

**Personal data stored:**

| Table | Columns |
|---|---|
| `profiles` | `full_name`, `phone` |
| `addresses` | `recipient_name`, `phone`, `line1`, `line2`, `city`, `state`, `postal_code` |
| `orders` | `shipping_address` (jsonb snapshot), `contact_email`, `contact_phone` |

No card data anywhere — Razorpay holds it, the shop stores `razorpay_payment_id` and
`razorpay_signature`. That keeps PCI scope minimal and is the single biggest thing already
right.

**Why not to add it:**

- **The threat model does not close.** Column encryption defends against an attacker who
  reaches the data but not the key. The app decrypts `shipping_address` on essentially every
  order render, so the key must live where the app can reach it. The two realistic breach
  paths — a leaked `service_role` key, and an RLS hole — both go through a client that can
  decrypt.
- **Supabase is dismantling the mechanism.** `pgsodium` is pending deprecation and Supabase
  explicitly recommends against new usage, citing operational complexity and misconfiguration
  risk. Transparent Column Encryption was pulled from the table editor and is SQL-only. A lost
  key means unrecoverable data loss, which for `addresses` means customers cannot get orders.
- **Concrete cost.** `addresses` is indexed on `user_id` and read at every checkout;
  encrypting forfeits indexing and comparison. `shipping_address` renders on every order page,
  admin order view and packing slip.
- **It does not buy compliance.** India's DPDP Act 2023 requires "reasonable security
  safeguards", not column encryption. AES-256 at rest, TLS, and RLS on every table are a
  defensible posture.

**Do instead, in descending value per unit of effort:**

1. A **retention policy on order PII** — `contact_phone`, `contact_email` and the
   `shipping_address` snapshot persist forever. Data no longer held cannot leak. Worth more
   than encrypting data kept indefinitely. *(Deferred at the owner's instruction.)*
2. Treat the `service_role` key as the crown jewel — it bypasses every RLS policy.
3. Add `Secure` to the auth cookie. *(Done — see [§3](#3-group-1--shipped-to-the-working-tree).)*

### 2.4 Bot protection — narrow, and tied to the `SITE_INDEXABLE` flip

No CAPTCHA, Turnstile, BotID or `@vercel/firewall` anywhere. Rate limiting is the only
ceiling, and by its own documented design it "answers *is this caller going too fast*, never
*is this caller allowed*", and fails open.

Ranked by what is actually reachable:

1. **Inventory denial — the real one, and it needs no card.** Placing an order reserves stock
   *before* payment. `checkout` is capped at `[10, 60]` per signed-in customer or per IP for a
   guest, and guest checkout is open. Ten orders/minute/IP, each holding stock for the reclaim
   window, from a rotating IP pool, with no payment attempted. Costs the attacker nothing.
2. **Card testing** — real, but Razorpay carries most of it. Every attempt needs a server-side
   order from a real cart, their risk engine sits in front of authorisation, and card data
   never touches the shop. **COD does not open a hole** — `cod.ts` requires a Razorpay advance,
   so there is no zero-payment order path.
3. **Coupon brute-forcing** — `couponCheck: [10, 60]` per IP. Codes are human-chosen and
   guessable; a hit is a permanent discount leak with no alert.
4. **Scraping — near zero today.** Production returns `x-robots-tag: noindex, nofollow,
   noarchive`, so there is no crawler traffic. Prices and stock are the catalogue.
5. **Fake accounts — already solved.** Sign-in is Google OAuth only (`signInWithOAuth`; no
   password or magic-link path exists in the app). Creating an account requires a Google
   account.

**Recommendation:** Vercel BotID at `checkLevel: 'basic'` on the **checkout and coupon-check
actions only** — nothing on browse paths. Not premature, but the trigger is the
`SITE_INDEXABLE` flip, not today. *(Deferred to Group 3.)*

Independent of bots: the reclaim window was **30 minutes**, far longer than anything
legitimate needs. Shortened — see below.

---

## 3 · Group 1 — shipped to the working tree

Everything below is committed to the working tree only. **Not deployed.**

### 3.1 `Secure` on the Supabase auth cookie

New `src/lib/supabase/cookie-options.ts` exports `AUTH_COOKIE_OPTIONS = { secure: true }`,
wired into **both** `createServerClient` sites:

- `src/lib/supabase/proxy.ts` — the refresh path
- `src/lib/supabase/server.ts` — `/auth/callback`, which writes the **first** cookie of every
  session. Setting `Secure` only in the proxy would have missed it.

Measured before and after, off the wire:

```
before   sb-<ref>-auth-token; Path=/; Max-Age=34560000; SameSite=lax
after    sb-<ref>-auth-token; Path=/; Max-Age=34560000; Secure; SameSite=lax
```

`HttpOnly` correctly still absent; `Path` and `SameSite` survived the merge.

**Note recorded in the module:** `cookieOptions` merges as
`{ ...DEFAULT_COOKIE_OPTIONS, ...yours }` but then **re-forces `maxAge`** back to 400 days on
the write path. Session lifetime is not reachable from here — it needs GoTrue's refresh-token
expiry on the project.

### 3.2 The four headers, plus `poweredByHeader: false`

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(self "https://api.razorpay.com")
```

**`Permissions-Policy` deliberately does not use `payment=()`.** The browser default for
`payment` is `self`; Razorpay's checkout runs cross-origin on `api.razorpay.com` and uses the
Payment Request API for Google Pay and card autofill. A child frame can only be delegated a
feature the parent's policy already permits for that origin, so `payment=()` denies it
outright — and *omitting* `payment` leaves the default `self`, which does not include Razorpay
either. The value shipped is **more permissive** than what the shop served before, so it
cannot break a payment.

No `getUserMedia`, `navigator.geolocation` or `mediaDevices` anywhere in `src/` — checked
before denying those three. `interest-cohort` deliberately absent (FLoC was removed from
Chrome; a directive no engine reads is noise).

**HSTS untouched.** `preload` and `includeSubDomains` are one-way doors and were declined on
the merits, not acquired as a side effect of a header sweep. A comment records the decision so
the next reader does not add them as tidy-up.

### 3.3 The early return removed

`headers()` opened with `if (isIndexable()) return []`. Correct while noindex was the only
header there; a landmine the moment anything joined it. Setting `SITE_INDEXABLE=true` — launch
day — would have deleted every security header with it, silently, with no diff and no deploy
to blame.

Now:

```ts
async headers() {
  const headers = [...SECURITY_HEADERS];
  if (!isIndexable()) headers.push({ key: "X-Robots-Tag", value: NOINDEX_HEADER });
  return [{ source: "/:path*", headers }];
}
```

### 3.4 New gate: `npm run audit:headers`

`scripts/audit/security-headers.ts`, registered in `run-all.ts` beside the pure gates.
**45 assertions, exit 0.** It calls the real `headers()` under both values of
`SITE_INDEXABLE` rather than inspecting the array, so it exercises the branch, not the
ingredient.

**Proven to fail.** Reinstating the early return produced 10 failures naming the cause:

```
FAIL  x-content-type-options identical with indexing off and on — ABSENT when indexable — the early return is back
FAIL  x-frame-options identical with indexing off and on — ABSENT when indexable — the early return is back
FAIL  referrer-policy identical with indexing off and on — ABSENT when indexable — the early return is back
FAIL  permissions-policy identical with indexing off and on — ABSENT when indexable — the early return is back
FAIL  the two states differ by exactly one header — …, x-robots-tag
10 failed.
```

It also pins three judgement calls: `payment` is never blanket-denied, neither `preload` nor
`includeSubDomains` creeps into HSTS, and `upgrade-insecure-requests` matches the CSP mode.

### 3.5 Reclaim window: 30 minutes → 10

`supabase/migrations/20260813150000_shorten_abandoned_order_window.sql`, plus
`ABANDONED_AFTER_MINUTES` in `src/app/api/cron/release-abandoned-orders/route.ts`.

Applied to **staging** and verified against the live catalog:

```
release_abandoned_orders | p_older_than_minutes integer DEFAULT 10 | {postgres=X/postgres,service_role=X/postgres}
release-abandoned-orders | */10 * * * * | select public.release_abandoned_orders()
```

ACL intact (same arity, and restated in the migration anyway); the cron still passes no
argument, so the default remains the only cutoff. Worst-case reclaim is now cutoff plus one
tick = 20 minutes, down from 40.

Safe because `20260809030000` already narrowed this function to orders with **no payments row
at all**, so nothing in flight is cut short. Ten minutes is still twice a PSP's five-minute
intent expiry.

Four prose sites still saying "thirty minutes" were updated: `checkout.ts` ×2,
`payment-state.ts`, `docs/architecture.md`, `docs/database.md`.

---

## 4 · Group 2 — the CSP, Report-Only

### 4.1 The policy

```
Content-Security-Policy-Report-Only:
  default-src 'self';
  script-src 'self' 'unsafe-inline' https://checkout.razorpay.com https://cdn.razorpay.com
             https://checkout-static-next.razorpay.com;
  style-src 'self' 'unsafe-inline' https://cdn.razorpay.com https://checkout-static-next.razorpay.com;
  img-src 'self' data: blob: https://*.supabase.co https://cdn.razorpay.com
          https://checkout-static-next.razorpay.com;
  media-src 'self' https://*.supabase.co;
  font-src 'self' data: https://cdn.razorpay.com https://checkout-static-next.razorpay.com;
  connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.razorpay.com
              https://lumberjack.razorpay.com https://lumberjack-cx.razorpay.com
              https://lumberjack-metrics.razorpay.com;
  frame-src https://api.razorpay.com https://checkout.razorpay.com;
  form-action 'self' https://api.razorpay.com;
  frame-ancestors 'none';
  base-uri 'self';
  object-src 'none';
  report-uri /api/csp-report;
  report-to csp

Reporting-Endpoints: csp="/api/csp-report"
```

`CSP_MODE` in `src/lib/csp.ts` is one word and drives the header **name**, so the mode and the
header can never disagree. **It is `report-only` and has not been flipped.**

### 4.2 Where the origins came from

Measured, not guessed. A real browser was driven across `/`, `/product/[slug]`, `/shop`,
`/cart` and `/checkout` **on production**, recording every request. The storefront touches
exactly two origins:

- `www.footvault.in` — document, script, stylesheet, font, image, fetch
- `https://ahumjhwqgmskjsitctcj.supabase.co` — **media only**: the hero video

Razorpay never appears until a payment starts, so its hosts were extracted from
`checkout.razorpay.com/v1/checkout.js` itself:

```
api.razorpay.com  api-dark.razorpay.com  cdn.razorpay.com
checkout-static-next.razorpay.com  express.razorpay.com
lumberjack.razorpay.com  lumberjack-cx.razorpay.com  lumberjack-metrics.razorpay.com
```

**Razorpay does not need `'unsafe-eval'`.** Its single `new Function` is the webpack
`globalThis` polyfill, wrapped in `try/catch` with a `window` fallback.

Three entries are load-bearing and easy to miss:

- **`wss://*.supabase.co`** — `client.ts` is used for "auth state and realtime", and realtime
  is a WebSocket. Dropping it breaks admin uploads and auth-state sync, not the storefront, so
  it would pass a casual click-through and fail in the panel the owner uses.
- **`media-src`** — omit it and the homepage hero silently falls back to its poster.
- **`blob:` in `img-src`** — the admin crop and re-crop dialogs build previews from blobs.

### 4.3 Why `'unsafe-inline'` stays on script-src

The homepage carries two inline `<script>` tags with no nonce — Next's RSC bootstrap.

The usual objection to nonces (they force dynamic rendering and kill ISR) **does not apply
here**. Measured on production, every storefront page already serves:

```
cache-control: private, no-cache, no-store, max-age=0, must-revalidate
x-vercel-cache: MISS
```

on `/`, `/shop`, `/product/nike-air-max-90-mens` and `/collection/new-in`. There is no static
generation left to lose.

The real objection is sharper: **`'strict-dynamic'` makes browsers ignore host allowlists
entirely.** Every `razorpay.com` entry would become a no-op, and the Razorpay tag would load
only if trust propagates from Next's nonced runtime through `next/script`. That is a mechanism
to verify deliberately, under Report-Only, with a real payment — not to discover in production
because the Pay button went quiet.

**Honest statement of what this policy buys today:** it stops an injected
`<script src="https://evil.example/x.js">`, stops the page being framed, stops a form posting
to another origin, and stops exfiltration to an arbitrary host. It does **not** stop an
injected inline `<script>`. Given the session cookie cannot be `httpOnly`, closing that gap is
worth a follow-up.

### 4.4 `'unsafe-eval'` is dev-only, and that was measured

Before writing the branch, a browser driven across the storefront against `next dev` produced
**1,533 violations**, every one of them:

```
Evaluating a string as JavaScript violates the following Content Security Policy directive
because 'unsafe-eval' is not an allowed source of script
```

That is React rebuilding server error stacks in development, exactly as Next's CSP guide
warns. Gated on `NODE_ENV` and verified both ways:

```
NODE_ENV=development   contains 'unsafe-eval': true
NODE_ENV=production    contains 'unsafe-eval': false
```

### 4.5 `upgrade-insecure-requests` — a mistake, caught by the suite

It was originally emitted unconditionally, reasoning that keeping it meant the flip to
`enforce` would not need a second edit.

**That was wrong, and the suite said so immediately.** Browsers ignore the directive in a
report-only policy and warn once per document load. Three gates whose entire job is console
cleanliness went red — `audit:hydration`, `audit:bag`, `audit:signedin` — with hydration
reporting:

```
hydration warnings: 0
other console errors/warnings: 42
```

Forty-two copies of that one warning across 23 routes and 14 populated states, and nothing
else.

Worse than three red gates: **the Report-Only bake ends with a human completing a real payment
with DevTools open**, watching for a blocked `razorpay.com` origin. Filling that console
competes with the one observation the whole staged rollout is built around.

Now emitted only when `CSP_MODE === "enforce"`, with a gate assertion pinning the pairing.
After the fix:

```
audit:hydration   exit=0   hydration warnings: 0, other console errors: 0
audit:bag         exit=0
audit:signedin    exit=0
audit:headers     exit=0   (45 assertions)
```

### 4.6 The report sink

`/api/csp-report` → `src/lib/errors/report-csp-violation.ts`, built to
`report-server-error.ts`'s shape: same order, same three prohibitions, same in-process
backstop for when the DB-backed limiter fails open.

**Its own rate-limit buckets, not `errorReport`'s.** A CSP header fires on every page view
while a server error needs something broken. Sharing `errorReportTotal` would let a noisy
afternoon of violations spend the 20/hour ceiling and silently suppress the next genuine
checkout 500 — a limiter starving the alarm it shares a budget with. New policies:

```
cspReport        [2, 3600]    per fingerprint
cspReportTotal   [12, 3600]   across all fingerprints
cspReportIngest  [60, 60]     per IP, spent before the body is parsed
```

No migration needed — the bucket key carries the policy name.

**Design details that matter:**

- Browser extensions are **filtered, not throttled** — rate limits are a shared budget, and
  extension noise that merely gets throttled still spends the ceiling a real violation needs.
- The fingerprint is **directive + blocked origin**, deliberately not the document URI. Keying
  on the document would mint a fresh bucket per product slug, so one missing directive would
  report once per item in the catalogue and the limit would never bind.
- Both wire formats parse: `application/csp-report` (hyphenated keys, single object) and
  `application/reports+json` (camelCase, array of envelopes).
- Every path returns **204**, including rejected ones. A browser does not act on the status;
  a 429 or 400 would only tell whoever is probing where the limits are.
- `/api/csp-report` is **excluded from the proxy matcher**. Otherwise every report costs a
  `getClaims()` round trip to verify a session the handler never reads — worst exactly when a
  policy is blocking something on every page.

### 4.7 What could NOT be proven: browser → sink delivery

**Chromium detects violations and delivers nothing.** Tested three ways, all zero:

| variant | reports delivered |
|---|---|
| headless, 90 s, watched at CDP `Network.requestWillBeSent` | 0 |
| headed | 0 |
| `--disable-background-networking` removed | 0 |

The endpoint itself is fine — a real POST is accepted, classified, rate-limited and logged,
proven repeatedly:

```
[csp] script-src blocked https://manual-probe.invalid/x.js on http://localhost:3210/ · disposition=report
```

This is almost certainly the harness: report delivery is background networking, which
automation suppresses, and Chrome prefers the batched `report-to` path when a policy offers
both. But it was **not demonstrated**, so it is recorded in the route handler as unproven
rather than assumed.

A client-side `securitypolicyviolation` forwarder was considered and **rejected** — that would
be permanent machinery built to work around a test-harness artefact, on the premise that real
Chrome is broken, for which there is no evidence.

**What this means for your test payment:** treat the **browser console as the primary
instrument**. A violation always logs there, in every browser, with no delivery step to fail.
Check the Vercel runtime log for `[csp]` as the secondary. **Silence at the endpoint is not
evidence of no violations.**

---

## 5 · Deploy sequence — where it got to

The documented sequence is `docs/staging.md` §4.4.

### Step 1 · Snapshot — DONE

```
~/footvault-backups/backup-20260813-2055-schema.sql   183K
~/footvault-backups/backup-20260813-2055-data.sql     538K
```

Outside the repo, `chmod 600`, directory `700` — the data dump holds real names, addresses and
phone numbers, and `docs/admin-guide.md` §12 is explicit these never go in the repository.

**Content-verified against live production, not just file size:**

| | |
|---|---|
| tables | 36 |
| functions | 37 |
| triggers | 29 |
| policies | 62 |
| indexes | 56 |
| live order numbers present in the dump | **21 / 21** |
| tables with `INSERT` blocks | 28 |
| `payment_events` live | 21, present |

And the snapshot is provably **pre-migration**:

```
release_abandoned_orders"("p_older_than_minutes" integer DEFAULT 30
```

> **The first verification pass was wrong and reported zeros for everything.** It grepped for
> `CREATE TABLE` and `COPY`; `supabase db dump` emits `CREATE TABLE IF NOT EXISTS
> "public"."orders"` and `INSERT INTO`. File size alone would have said "538K, fine"; the wrong
> pattern said "0 tables, 0 rows". Both would have been the wrong answer.

### Production migration backlog — checked, and the memory was stale

Read-only `SELECT` against `supabase_migrations.schema_migrations` on `ahumjhwqgmskjsitctcj`:

```
in the repo but NOT on production:
  20260813150000_shorten_abandoned_order_window.sql

on production but NOT in the repo:
  (none)
```

**113 applied on production, 114 in the repo, one difference — this session's own migration.**
The "~8 pending" note was from the Phase 11 overnight state and has since been applied. The
memory has been corrected, with the lesson recorded as method rather than number: *a pending
count goes stale the moment somebody pushes, so read it rather than recall it.*

### Step 2 · `npm run audit` — see §6

### Steps 3–6 · NOT STARTED

`audit:actions`, `audit:build-smoke`, apply migration, merge, deploy, verify by alias.

---

## 6 · The suite: two runs, six failures, all run to ground

### Run 1 — aborted by a Turbopack crash

The dev server died mid-run:

```
thread 'tokio-rt-worker' panicked at turbopack/crates/turbo-tasks-backend/src/backend/operation/mod.rs:292:17:
Restore of All for task TaskId 510340 failed in another thread: restoring failed
turbo-tasks: an internal panic occurred outside the per-task panic boundary.
Aborting.
```

Turbopack's persistent incremental cache corrupted itself and took the process down.
`audit:overflow`'s `/shop: no visible <h1>` was the first symptom; everything after
`audit:hero-media` was `ECONNREFUSED` noise. After `rm -rf .next` and a restart, `/shop`
returned 200 with its `<h1>` present.

**Plausible trigger, stated honestly:** `next.config.ts` and `src/lib/csp.ts` were edited
repeatedly *while that dev server was running*, and each edit forces a config reload and hot
restart. Nothing in the shipped code touches Turbopack's task graph. Editing under a live
`next dev` has been avoided since.

### Run 2 — 51/57, six failures

```
51/57 gates green in 18.5 min
failed: audit:transitions, audit:focus, audit:hydration, audit:bag, audit:signedin, audit:admin
```

> **A reporting error worth recording:** progress was tracked with a grep for `FAIL` at column
> 0. Only some gates report that way, so "1 FAIL" was reported several times when there were
> six. The summary block is the reliable source, not a grep.

### 6.1 Fixed — caused by this session (3 gates)

`audit:hydration`, `audit:bag`, `audit:signedin` — all one cause,
`upgrade-insecure-requests`. See [§4.5](#45-upgrade-insecure-requests--a-mistake-caught-by-the-suite).
All three now exit 0.

### 6.2 Fixed — crash litter (1 gate)

`audit:transitions` failed on ledger drift:

```
FAIL  reconcile_inventory reports zero drift on every variant this run touched
      — FV-REDCHI-OXFORDME-BLACK-7: 1
```

Cause confirmed by timestamp and signature — two movements with `reason=unspecified` and
empty notes:

```
15:36:41Z  delta=+1  reason=unspecified  note=''
15:33:00Z  delta=+1  reason=unspecified  note=''
```

21:03 and 21:06 IST — the window where run 1 crashed and run 2's teardown ran. Every other
movement on that variant is a properly-reasoned `order`/`cancellation` pair. Teardown restocked
units the cancellation path had already restocked.

`teardown.ts --stock-only` reported clean, because it compares shelf against *seed baseline*
accounting for live orders; `reconcile_inventory` compares shelf against *ledger sum*. Two
different invariants — only the second was broken.

The two artefact rows were removed (staging only, verified they carried no note).
`reconcile_inventory` went to zero drift and `audit:transitions` now exits 0.

### 6.3 NOT fixed — pre-existing (2 gates)

**`audit:admin`.** The security assertions all pass, including the one that matters:

```
5 · The stock ledger cannot be rewritten
  ✓ a customer cannot write a movement row — refused by table grant (42501)
  ✗ HOLE and after every attempt above, the ledger still reconciles — 2 drifting variants
  22 held, 1 holes
```

The failing line is a hygiene check with **two independent bugs**, in code not touched by this
session (`scripts/audit/admin-security.ts:516`):

```ts
!error && (drift?.length ?? 0) === 0
```

1. `reconcile_inventory` returns a row for any variant it has something to say about. At the
   time of the run that was two rows — but one had `drift: 0, unspecified_rows: 2`. The check
   counts **reported** variants as **drifting** ones, and the detail string
   `${drift?.length} drifting variants` compounds it by mislabelling the count.
2. The gate's own cleanup writes stock without setting a reason, so it manufactures the
   `unspecified` rows it then fails on — the recurring "gate proofs must restore data"
   problem.

**`audit:focus`** — two failures, both on already-deployed code:

```
FAIL  the /search input is reachable by Tab — never focused in 150 stops
FAIL  no component switches the focus outline off without a reason
      — src/components/admin/products/crop-stage.tsx
```

`crop-stage.tsx` shipped in `1b9a2e6` (the image-editor crop step), already on `origin/main`
and live. Neither file is in this session's diff.

**Neither was fixed.** Editing a security gate to make it green during a production deploy is
exactly the move that deserves scrutiny, and both are unrelated to what is being shipped.

---

## 7 · What is in the working tree

The tree carries **three** bodies of work. The owner was shown this and chose to ship all of it
in one commit.

**Group 1 + Group 2 (this session):**

```
M  next.config.ts
M  src/lib/supabase/proxy.ts
M  src/lib/supabase/server.ts
M  src/proxy.ts
M  src/lib/rate-limit.ts
M  src/lib/guest-token.ts
M  src/lib/cart/token.ts
M  src/app/api/cron/release-abandoned-orders/route.ts
M  src/lib/actions/checkout.ts
M  src/lib/orders/payment-state.ts
M  docs/architecture.md
M  docs/database.md
M  package.json
M  scripts/audit/run-all.ts
?  src/lib/csp.ts
?  src/lib/supabase/cookie-options.ts
?  src/lib/errors/csp-classify.ts
?  src/lib/errors/report-csp-violation.ts
?  src/lib/email/csp-violation.ts
?  src/app/api/csp-report/route.ts
?  scripts/audit/security-headers.ts
?  supabase/migrations/20260813150000_shorten_abandoned_order_window.sql
```

**Stage 2 (previous session, never deployed):**

| what | impact |
|---|---|
| 8 audit gate conversions + `scripts/audit/refusal.ts` | test-only |
| `eslint-rules/no-vacuous-refusal-assertion.mjs` | lint-only |
| `docs/staging.md` §4.6, two reports | docs |
| **`src/lib/images/{constants,pipeline}.ts`** | **runtime** — 50-megapixel `limitInputPixels` decode ceiling on sharp, plus a refusal message on the admin upload path |

`src/lib/rate-limit.ts` is genuinely entangled: 116 comment lines from that session and 3
policy lines from this one, in one file.

**Battery:** `typecheck` exit 0, `lint` exit 0, no gate drift.

---

## 8 · Follow-ups and deferred work

### 8.1 The decision that was taken

Three gates were red for understood reasons, **none implicating Group 1, Group 2 or Stage 2**.
The owner ruled on 2026-08-13: **proceed, with `audit:admin` and `audit:focus` documented as
known-red**, and fix them as their own change afterwards. Their reasoning on the point that
mattered: *"You were right not to edit a security gate green during a production deploy."*

### 8.2 The owner's test payment — STILL OUTSTANDING

Complete a real payment on `www.footvault.in` with DevTools open. Watch the console for
anything naming a `razorpay.com` origin. **The console is the primary instrument** — see
[§4.7](#47-what-could-not-be-proven-browser--sink-delivery).

**`CSP_MODE` has not been flipped and must not be until that payment is clean.**

### 8.3 Queued as their own change, now that the deploy has landed

Both were found by this session's suite run and both are **pre-existing**, not part of what is
being shipped. The owner ruled on 2026-08-13 that they are fixed separately rather than folded
into a production deploy.

**A · `crop-stage.tsx` — a real defect, not just a red gate.**

`src/components/admin/products/crop-stage.tsx` switches the focus outline off without a named
reason. It shipped in `1b9a2e6` (the image-editor crop step) and **is live on production now**.

The owner's framing, recorded because it is the part that matters: this is the **fourth
instance of that class**. `audit:focus` exists because the halo in `globals.css` *is* the focus
system, and a component that opts out of it silently removes the only indicator a keyboard user
has. The previous instance was the review form's inputs, fixed in the Phase 11 batch; this one
arrived after that fix and was never caught because the suite was not re-run after the
image-editor merge.

Fix: give it a named reason in `ALLOWED_OUTLINE_OFF` **or** restore the composite indicator.
Not "add it to the allowlist to make the gate green" — the allowlist entry has to carry a
reason that survives being read out loud.

The second `audit:focus` failure, `the /search input is reachable by Tab — never focused in
150 stops`, is unrelated and also pre-existing. Not yet diagnosed.

**B · `admin-security.ts:516` — a gate that fires on a clean ledger.**

```ts
!error && (drift?.length ?? 0) === 0
```

Two independent bugs, and they compound:

1. **It counts reported variants as drifting ones.** `reconcile_inventory()` returns a row for
   any variant it has something to say about — including `drift: 0, unspecified_rows: 2`. The
   detail string `${drift?.length} drifting variants` then mislabels the count, so the failure
   message actively misleads whoever reads it.
2. **Its own cleanup writes stock without setting `app.inventory_reason`**, so it manufactures
   the `unspecified` rows it subsequently fails on.

The owner's framing: both bugs make it **fire on a clean ledger, which is how people learn to
skip it, and how a real drift eventually gets missed.** That is the cost — not the red line
itself, but the habit it teaches.

Fix: assert on `drift !== 0` rather than row count, report `unspecified_rows` as its own
distinct signal rather than conflating the two, and make the gate's cleanup set a reason like
every production path does. Note that the security assertion above it —
`a customer cannot write a movement row — refused by table grant (42501)` — passes and must
keep passing; only the hygiene check is wrong.

### 8.4 Deferred by agreement

- **Group 3** — Vercel BotID at `basic` on the checkout and coupon-check actions only, tied to
  the `SITE_INDEXABLE` flip
- **Order-PII retention policy** — deferred, not built
- **Column-level encryption** — declined, reasoning recorded in
  [§2.3](#23-encryption--recommendation-do-not-add-column-level-encryption)
- **The nonce/`'strict-dynamic'` CSP** — the follow-up that would close the inline-script gap,
  see [§4.3](#43-why-unsafe-inline-stays-on-script-src)

---

## 9 · Sources

- [Supabase — Data Encryption](https://supabase.com/docs/guides/platform/encryption)
- [Supabase — pgsodium (pending deprecation)](https://supabase.com/docs/guides/database/extensions/pgsodium)
- [Supabase — Column Encryption is SQL-only now](https://github.com/orgs/supabase/discussions/18849)
- [Vercel — BotID](https://vercel.com/docs/botid/get-started)
- [Vercel — WAF rate limiting SDK](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting-sdk)
- Next 16 CSP guide, read locally from
  `node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md` per `AGENTS.md`

---

## 10 · Deploy record — 2026-08-13

**Deployed.** `www.footvault.in` → `dpl_84iLi2robdZMArRJfv6sJ9FXpTvx`, commit `261e5a0`.

### 10.1 The sequence, as executed

| step | result |
|---|---|
| 1 · Snapshot + content-verify | 21/21 orders, 36 tables, 37 functions, pre-change `DEFAULT 30` captured |
| 2 · `npm run audit` | 54/57 — 3 fixed, 2 known-red by the owner's ruling |
| 2b · `npm run audit:actions` | **128 / 0, exit 0** |
| 3 · `npm run audit:build-smoke` | **15 / 0, exit 0** |
| 4 · Apply `20260813150000` to production | applied |
| 4b · PostgREST | healthy, cache carries the new definition |
| 5 · Merge + deploy | `6d498b4..261e5a0`, deployment created |
| 6 · Verify by alias | confirmed, alias moved |
| 7 · Wire checks | all present |
| 8 · Smoke | all 200; `/admin` 404 |

### 10.2 `audit:actions` — the gate that had never run against a real deploy

```
1 · Positive control: an admin session runs the action
  ✓ admin + loadMovements(realVariant) returns ok:true
...
6 · Which layer refused
    route-hidden 120   guard-refused 0   ran 0   unattributed 0
  ✓ every refusal is attributable to a named layer
    note  adminAction was not exercised by this run — the proxy hid every
          /admin route first, so the POSTs never reached it.

128 passed, 0 failed
```

The positive control passing is what makes the 120 refusals meaningful rather than
"the request never arrived". The gate's own note about `adminAction` not being exercised is the
documented shipped behaviour, not a new finding.

### 10.3 `audit:build-smoke`

```
PASS  a build that cannot collect slugs fails instead of shipping — exited 1   (outage drill)
PASS  production build passes — exited 0
PASS  /product/[slug] /collection/[slug] /page/[slug] /shop/[category] — not SSG-with-zero-paths
PASS  next start serves the artifact — all four slug families 200 as document AND RSC
audit:build-smoke PASS
```

### 10.4 The migration, and the exception that authorised it

`docs/foot-vault-security-brief.md:27` says **"No production migration is applied by you."**
That was surfaced to the owner before applying anything, with the dry-run output. The owner
overruled it **for this migration only**, knowingly, and asked that the exception be recorded
as non-generalising. It is now a block quote under that line in the brief.

Their reasoning, recorded: `create or replace` at the same arity so the ACL survives; one
integer default changed; verified on staging first; and the snapshot provably captured
`DEFAULT 30`, so the rollback is one statement.

Post-apply verification on production:

```
release_abandoned_orders | p_older_than_minutes integer DEFAULT 10 | {postgres=X/postgres,service_role=X/postgres}
copies: 1                                    (no overload landmine)
release-abandoned-orders | */10 * * * * | select public.release_abandoned_orders() | active
migrations recorded: 20260813150000
```

### 10.5 PostgREST after the DDL

```
anon read /products                       200      (cache reloaded cleanly)
/rpc/release_abandoned_orders in cache    true
  description: "…Default cutoff 10 minutes (was 30 until 2026-08-13…"   ← the NEW comment
anon POST /rpc/release_abandoned_orders   401      (grants held through the reload)
```

The description proves PostgREST picked up the new definition rather than serving a stale
cache. **The function was deliberately not invoked** — calling it would sweep real production
orders.

### 10.6 Verified by alias, not by a 200

The specific failure being guarded against — a merge producing no deployment — did not recur.

```
before   www.footvault.in → dpl_9njZpqzCsrmwCdBrGNAhmUrvXfaf   commit 6d498b4
after    www.footvault.in → dpl_84iLi2robdZMArRJfv6sJ9FXpTvx   commit 261e5a0
         state READY, target production, aliasError null
```

The wait was keyed on the **Report-Only CSP header**, an identifier that exists only in the new
tree, rather than on a 200.

### 10.7 On the wire, www.footvault.in

```
x-content-type-options      nosniff
x-frame-options             DENY
referrer-policy             strict-origin-when-cross-origin
permissions-policy          camera=(), microphone=(), geolocation=(), payment=(self "https://api.razorpay.com")
x-powered-by                absent
strict-transport-security   max-age=63072000            (Vercel's, untouched)

content-security-policy-report-only: default-src 'self'; script-src 'self' 'unsafe-inline'
  https://checkout.razorpay.com …; media-src 'self' https://*.supabase.co; connect-src 'self'
  https://*.supabase.co wss://*.supabase.co …; frame-src https://api.razorpay.com …;
  frame-ancestors 'none'; report-uri /api/csp-report; report-to csp
Reporting-Endpoints: csp="/api/csp-report"

enforcing CSP present            no   — report-only only, correct
'unsafe-eval' present            no   — production build, correct
upgrade-insecure-requests        no   — correct for report-only
POST /api/csp-report             204  — endpoint live
```

**The auth cookie, measured on production:**

```
sb-ahumjhwqgmskjsitctcj-auth-token=<session>; Path=/; Expires=Fri, 17 Sep 2027;
  Max-Age=34560000; Secure; SameSite=lax
```

`Secure` present. `HttpOnly` correctly absent by design (§2.2).

> **A first attempt at this check failed and is recorded because it looked like it worked.**
> Sending a malformed `sb-…-auth-token` was expected to make `@supabase/ssr` emit a removal
> `Set-Cookie` carrying the same `cookieOptions`. It emitted **nothing** — the library treats an
> undecodable value as simply absent. A less careful reading of "no Set-Cookie" plus the earlier
> staging measurement would have produced a confident, unverified claim. The real check minted a
> session for an **existing** inert QA fixture (`fv-signedin.mslmmhlv@example.com` — no account
> created), backdated its stored expiry so production's proxy had to refresh, and read what the
> live app emitted. The fixture was signed out afterwards.

### 10.8 Smoke

```
/  /shop  /product/nike-air-max-90-mens  /cart  /checkout  /collection/new-in  /page/about   all 200
/admin                    404
/definitely-not-a-route   404      (indistinguishable, which is the point)
/admin with RSC: 1        404

crons active: poll-deliveries, prune-rate-limits, prune-shipping-quotes,
              reconcile-abandoned-orders, release-abandoned-orders
```

### 10.9 What is live now that was not before

- Four security headers, and `x-powered-by` gone
- `Secure` on the session cookie
- A Report-Only CSP with a working report endpoint
- A 10-minute abandoned-order reclaim window (was 30)
- A 50-megapixel decode ceiling on admin image uploads (Stage 2)
- Eight audit gates converted off the vacuous-assertion shape, plus `audit:headers`

### 10.10 The one thing still outstanding

**The owner's test payment.** Real payment, DevTools open, watching for a blocked
`razorpay.com` origin. Until that is clean, `CSP_MODE` stays `report-only`.
