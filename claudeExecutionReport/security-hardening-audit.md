# Security Hardening — Stage 1 Audit

**Date:** 2026-08-13
**Scope:** the six areas in `docs/foot-vault-security-brief.md`. Audit only — nothing was fixed.
**Method:** source read, a production build (`build:stage`) grepped for secrets, git-history scan across all 224 revisions, `npm audit`, direct SQL against the production project (`ahumjhwqgmskjsitctcj`) for grants/RLS/policies, Supabase security advisors, and an attempt to run the forged-attack gates against a production-mode stage server.

Severities: **P0** exploitable now · **P1** exploitable under a plausible condition · **P2** defence in depth · **P3** hygiene.

---

## Headline

**No P0 was found.** The money path takes no client-supplied number, every admin action is forced through `adminAction()` by an ESLint rule and the DB re-checks `is_admin()`, no secret appears in the built client bundle or in git history, and `npm audit` is clean. The order-creation and rate-limit RPCs are `service_role`-only by grant.

The most important finding is not a hole in the shop — it is that **the two gates meant to prove the shop is not holed cannot currently run** (F1). For a project whose entire method is "verification must be able to fail," a suite that errors out on setup is the finding.

| # | Severity | Finding | Evidence |
|---|----------|---------|----------|
| F1 | **P1** | Forged-action and money-path attack gates are non-runnable — staging signups are disabled, so the fixtures cannot mint accounts | `audit:security-advance` and `audit:actions` both die at `createAccount`/`makeAccount` |
| F2 | **P2** | `/api/search/suggest` has no rate limit; a keystroke-cadence public DB query, cache bypassed by distinct `q` | `src/app/api/search/suggest/route.ts` |
| F3 | **P2** | `audit:actions` (the named forged-post gate) targets the **production** URL where signup is correctly off, so it can never mint its accounts — it is structurally dead, not merely excluded | `scripts/audit/server-actions.ts:84,125` |
| F4 | **P3** | `/api/cart` GET, wishlist toggle, and address writes have no rate limit | route + `cart.ts`/`wishlist.ts`/`address.ts` |
| F5 | **P3** | Committed docs contain a Razorpay **test** key id and a DB URL template; no secret, but reads as one | `docs/phase-5-brief.md:160,194`, `docs/admin-guide.md:823` |
| F6 | **P3** | Supabase advisors: `pg_net` in `public`, leaked-password protection off (N/A — Google-only auth) | `get_advisors` |

Everything else in the six areas was checked and is either correct or a deliberate, documented decision. Details below, including the ones that look like findings and are not, because the brief asked for that discipline.

---

## 1 · Rate limiting

**Confirmed still true (not re-litigated):** nine policies, all consumed, none declared-but-dead. Fail-open is by design; the `serviceability` exception has its in-memory backstop (`COURIER_CALLS_PER_HOUR = 600`, `src/lib/shipping/quote.ts:251`) and the error-report path has its own (`IN_PROCESS_LIMIT = 5`, `src/lib/errors/report-server-error.ts:64`). Both verified present, not just documented.

**Policy → call-site map (all 11 live consumers):**

| Policy | Site | Key |
|--------|------|-----|
| `webhook` [300/60] | `api/payments/razorpay/webhook/route.ts:98` | IP |
| `paymentVerify` [20/60] | `actions/payment.ts:105` | IP (no session by design) |
| `checkout` [10/60] | `actions/checkout.ts:130` | user-or-IP |
| `orderCancel` [20/60] | `actions/checkout.ts:752` | user-or-IP |
| `adminMutation`/`adminBulk`/`fulfilment`/`imageProcessing` | `admin/guard.ts:133` (all 60 admin actions) | `admin:{id}` |
| `serviceability` [60/60] | `shipping-quote.ts:113`, `delivery-check.ts:59` | user-or-IP |
| `couponCheck` [10/60] | `coupon.ts:59,100` | user-or-IP |
| `reviewWrite` [5/60] | `reviews.ts:63` | user |
| `cartWrite` [90/60] | `cart.ts:224` | IP (deliberate — guest token is resettable) |
| `errorReport`/`errorReportTotal` | `report-server-error.ts:119,125` | fingerprint / "all" |

**Endpoints with no limit at all, ranked by cost if hammered:**

1. **`/api/search/suggest`** (F2, **P2**) — public GET, no limit, runs `catalog_query` (trigram) per call. `revalidate = 60` caches *per URL*, so a caller varying `q` every request bypasses the cache entirely and lands a DB query each time. Cost is database load, not money or third-party quota. A broken system here looks identical to a working one until the DB saturates — which is why it is worth a ceiling. Not P1 because `catalog_query` is indexed and the shop's WAF is the volumetric layer.
2. **`/api/cart` GET** (F4, P3) — RLS-scoped four-table join, `force-dynamic`, no limit. Cheap, per-customer, low value to abuse.
3. **Wishlist toggle / address writes** (F4, P3) — authenticated, RLS-scoped, schema-bounded. Wishlist is capped by a unique `(user,product)` constraint so row creation is bounded by catalogue size; address writes have no per-user cap but write validated rows only.

**Review endpoint (Phase 11):** covered — `reviewWrite` [5/60], keyed on the user, with the delivered-order check as the real lock (`reviews.ts:63`).

**Webhooks:**
- **Razorpay** — `webhook` [300/60] on IP, and the handler answers **429** on trip with a `Retry-After` (`webhook/route.ts:104`). Razorpay redelivers non-2xx with backoff for ~a day, so a hard retry storm is *delayed*, never dropped. A `400` is reserved for genuinely unacceptable payloads. Correct.
- **Resend inbound** — no rate limit, and that is right: it is Svix-signature-gated before any work, idempotent on `inbound_emails.email_id`, and fail-soft (200 after claim so a retry can't be weaponised into disabling the endpoint). A flood costs one HMAC each; adding a limit risks dropping a legitimate forward.

**Cron routes:** `authorisedCronRequest` (`src/lib/cron/auth.ts`) is called as the **first line** of both cron handlers, before any DB read. It is a constant-time compare, denies on absent `CRON_SECRET`, and length-checks before `timingSafeEqual` (which throws on length mismatch). A wrong secret is a cheap `401` with no detail. Verified at `poll-deliveries/route.ts:52` and `release-abandoned-orders/route.ts:67`.

**Configurable vs hardcoded:** all thresholds are hardcoded in the `RATE_LIMITS` literal in `src/lib/rate-limit.ts`. The brief asked for configurable; today they are code constants, `as const satisfies`. This is a deliberate-looking choice (every number is commented with its rationale) but does not meet "configurable." Flagging as a **Stage 2 decision**, not a vulnerability — moving them to `site_settings` adds a DB read to every limited path and a validation surface.

**Backoff vs hard block:** every customer-facing trip returns a soft, recoverable message ("Give that a moment," "Wait a moment and try again") — none reads as the shop being broken. The webhook returns 429+Retry-After. No hard blocks. Confirmed across `coupon.ts`, `checkout.ts`, `reviews.ts`, `cart.ts`.

**IP keying under CGNAT:** used only where there is no better handle — `webhook`, `paymentVerify` (no session exists), and `cartWrite` (guest-token is resettable, documented). All three are generous enough (300, 20, 90/min) that a shared NAT is not realistically the failure. Signed-in customer paths key on `user:{id}`. Correct given the constraints.

---

## 2 · Input validation

**Server-side schema coverage — every customer action validates server-side and rejects (does not coerce silently):**

- `placeOrder` → `checkoutSchema` (`checkout.ts:89`), `verifyRazorpayPayment` → `razorpayCallbackSchema` (`payment.ts:71`), cart trio → `addToBag/setQuantity/removeLine` schemas, `applyCoupon` → char-set + length schema, `submitReview` → rating/length schema, `checkDeliveryTo`/`quoteShipping` → 6-digit PIN regex, address CRUD → `addressBookSchema`. All `safeParse`, all reject on failure.
- **No client-only schema with a missing server counterpart was found.** The shared `src/lib/validations/*` modules are imported by both the form and the action.

**Money fields — the P0-by-definition class — are recomputed server-side:**

- `PlaceOrderInput` carries **no price, total, line, quantity, or cart id** (`checkout.ts:45`). The bag is resolved from the caller's own RLS session; every rupee is recomputed inside `create_order_with_stock` under a row lock. Confirmed the RPC call passes only quote-derived server figures (`checkout.ts:372–397`), and the DB signature has 26 params but the client supplies none of the money ones directly — they come from `computeOrderTotals`/the stored quote.
- `previewCoinSpend` (`coins.ts`) **does** accept three client numbers — and this is safe and documented: it only draws a checkbox. The binding coin spend is recomputed by `planCoinSpend` under the account lock in `create_order_with_stock`. Verified the preview result is never persisted.
- `spendCoins` is a **boolean**, not an amount (`checkout.ts` schema) — the server plans the spend. Same discipline as every other figure.
- No endpoint accepting a client-supplied `amount` remains (the historical one the brief mentions is closed).

**Length/shape limits present:** review title 120 / body 2000 (`reviews.ts:26`), customer note 500, coupon code 40 + charset, address lines 80/120/60, homepage title 120 / subtitle 300 (`appearance.tsx`), section count ≤ 20, settings text fields all `.max()`-bounded, parcel weight ≤ 50 000 g and sides ≤ 120 cm. **No unbounded free-text field reaches the DB from a customer surface.**

**`is_admin()` inside every admin action — verified two ways:**
- ESLint rule `footvault/admin-actions-must-guard` = `error` (`eslint.config.mjs:43`) fails the build on any exported action under `src/lib/actions/admin/` not wrapped in `adminAction()`. Count: **60 exported admin actions, 60 `adminAction()` wrappers** — 1:1.
- `adminAction()` calls `currentAdmin()` → `is_admin()` RPC (SECURITY DEFINER, reads `profiles.role` for `auth.uid()`) and short-circuits before the work runs (`admin/guard.ts:123`). It fails **closed** on DB error.
- DB backstop: `adjust_variant_stock` and `admin_delete_product` are `authenticated`-executable but both open with `if not public.is_admin() then raise 'not_admin'` (confirmed in the function bodies). `reorder_product_images` is `authenticated`-executable, **invoker-rights**, no `is_admin` — but `product_images` RLS has an admin-only `ALL` policy, so a non-admin's writes inside it are refused by RLS. Not a hole.

**JSONB payloads:**
- `homepage_sections.payload` — validated per section-type by `vetSection`/`parseSectionPayload` on write; an *uneditable* type may pass through **only if the row already exists** (`appearance.tsx:64`). `z.record(z.string(), z.unknown())` is the outer shape but the per-type parser is the real gate.
- `crop` parameters — `z.unknown()` at the schema, then `normaliseCrop` **clamps every field into range** and fills missing ones rather than rejecting (`crop.ts:120`). Deliberate: a second zod opinion would drift from the browser's `normaliseCrop`. Junk input yields a valid default crop, never an error or an out-of-range value.
- `site_settings` rows — `textSettingSchema`, `parcelSchema`, `imageSettingsSchema` all bounded (`settings.ts:341,445,643`).

**Numeric bounds:** `assertPaise` (`payments/types.ts:63`) rejects non-`SafeInteger`/negative money at every provider boundary. Quantities `min(0/1).max(10)`. Coin figures `int().min(0).max(100_000_000)`. No path multiplies a client integer into paise without a server recompute.

---

## 3 · Secrets

**Built client bundle (`.next/static`, from a real `build:stage`) — grepped for each secret's actual value:**

```
RAZORPAY_KEY_SECRET       : 0 files
RAZORPAY_WEBHOOK_SECRET   : 0 files
SUPABASE_SERVICE_ROLE_KEY : 0 files
SUPABASE_DB_PASSWORD      : 0 files
RESEND_API_KEY            : 0 files
SHIPROCKET_PASSWORD       : 0 files
CRON_SECRET               : 0 files
RESEND_WEBHOOK_SECRET     : 0 files
```

Also 0 hits in `.next/server`. Clean. (A broken system would show ≥1 file with the literal value inlined — the grep can discriminate.)

**Git history — all 224 revisions, current secret values:** 0 hits for every secret above (searched each value across `git rev-list --all`). No `.env.local`/`.env.staging`/`backup-*.sql` was ever committed — only `.env.example` (added in `470f0d0`). Pattern scan for key-shaped strings (`rzp_*`, `re_*`, JWT, `postgres://…:…@`) outside the lockfile returned only: audit-fixture placeholders (`rzp_live_R9xxxx`, `eyJhbGciOi` fragment), a password-templated URL in `docs/admin-guide.md` (literal `PASSWORD`), and a Razorpay **test** key id in `docs/phase-5-brief.md`. → **F5, P3**: no live secret, but the test key id and URL template should be scrubbed since they read as leaks.

**`NEXT_PUBLIC_` variables** — exactly four, all genuinely public: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (anon key is designed for the browser, RLS enforces), `SITE_URL`, `RAZORPAY_KEY_ID` (Razorpay's publishable id). Nothing sensitive acquired the prefix.

**Server-only enforcement:** 72 modules import `server-only`, including `supabase/admin.ts` (the service-role client) — so importing it from a Client Component is a **build error**, not a runtime surprise. The bundle grep above is the running proof it holds. The service-role bundle assertion lives in `audit:security` §9 (`security-checkout.ts:1273`) — note this gate is **superseded/excluded** from `run-all` (see F1/F3), but the check itself is sound and I reproduced its result manually.

**Log output:** verified no payment payload, webhook secret, token, or password reaches a log. Razorpay/Resend webhooks log the *reason* and event id, never the body (`webhook/route.ts:148`, `inbound/route.ts:125`). The incident email (`email/incident.ts`) **deliberately strips request headers** (which carry the auth cookie) and the customer identity; it includes the error message and stack (one recipient, the owner, documented risk) and the query string is stripped from the path in `instrumentation.ts`. Error emails are triple-capped (per-fingerprint, total, in-process) so an attacker cannot volume-trigger them.

**`.claude/settings.json`** — enables 11 plugins deliberately (github, vercel, claude-mem, playwright, code-review, etc.). Noted, not changed, per instruction.

---

## 4 · Dependencies

**`npm audit`: 0 vulnerabilities** (info/low/moderate/high/critical all 0), 786 deps. Nothing reachable, nothing to rank.

**Outdated (all patch/minor, none security-driven):** `@supabase/supabase-js` 2.112.2→.3, `react-hook-form` 7.84→7.85, `lucide-react` 1.30→1.31, `sonner`, `tsx`, `zustand`, `shadcn`, `@axe-core/playwright` — all safe patch bumps. **Major bumps to hold as their own change** (per brief): `eslint` 9→10, `typescript` 5.9→7.0, `@types/node` 20→26. Do not bulk-update.

**Unmaintained/superseded:** none found.

---

## 5 · Error handling and information leakage

**What a customer sees:** `error.tsx`/`global-error.tsx` render a generic message + an opaque `digest` reference only (`error.tsx:50`) — no stack, no file path, no Postgres error, no Supabase code. Production strips the message and leaves the digest; the **full** detail reaches the owner's incident email and the Vercel runtime log keyed by that same digest (`incident.ts`), so the digest is retrievable, not useless.

**Server errors:** `onRequestError` (`instrumentation.ts`) is the single sink — it catches render, route, action, and proxy throws (the four the error boundaries alone would miss). It never alters the error the customer sees; it taps the wire.

**Enumeration:** `/order/[orderNumber]` returns `notFound()` for both "not yours" and "doesn't exist" — byte-identical (`order/[orderNumber]/page.tsx:45–90`). Confirmed the same discipline elsewhere: coupon refusals collapse "no such code" and "not for you" into one message (documented in `rate-limit.ts` `couponCheck`), review submission returns generic reasons, admin actions return `"That is not available."` for a non-admin (never "you are not an admin"). No message reveals what exists.

**Error emails cannot be volume-triggered** (three caps, §3) and carry no secret or customer identity.

---

## 6 · File upload safety

**Bucket policies (production, live query):**

| Bucket | Public read | Write | Size | MIME allow-list |
|--------|-------------|-------|------|-----------------|
| `product-images` | yes | `is_admin()` only | 5 MB | jpeg/png/webp/avif |
| `category-images` | yes | `is_admin()` only | 5 MB | jpeg/png/webp/avif |
| `site-assets` | yes | `is_admin()` only | 5 MB | jpeg/png/webp/avif/**svg**/x-icon |
| `site-video` | yes | `is_admin()` only | 10 MB | mp4/webm |

Every write/update/delete policy on `storage.objects` is gated on `is_admin()` (confirmed all 6 mutating policies). Read is public and deliberate.

**Content validation, not extension:** `inspect()` decodes with `sharp(input).metadata()` and throws `ImagePipelineError` if width/height are absent (`pipeline.ts:144`). The pipeline re-encodes every variant through sharp — a MIME string is never trusted. The `requestUploadSlot` action independently rejects any `contentType` outside the JPEG/PNG/WebP/AVIF allow-list before issuing a signed URL (`media.ts:90`).

**Size limits — both sides:** client/action schema caps at `MAX_UPLOAD_BYTES` (`media.ts:49`) **and** the bucket enforces 5 MB / 10 MB server-side regardless of what the action believes.

**Path construction:** `buildPath` slugifies the stem (`[^a-z0-9]→-`, `slice(0,60)`), appends a random 8-char UUID suffix, and derives the extension from the **validated content type**, not the filename — so `hero.jpg.svg` cannot land as an SVG (`media.ts:320`). The `prefix` is regex-bounded (`^[a-z0-9][a-z0-9/-]*$`) and explicitly rejects `..` (`media.ts:64`). No user string reaches the path unfiltered; no traversal.

**SVG:** cannot be uploaded to `product-images`/`category-images` (not in their MIME list) and the action refuses it with an explicit message about executable content (`media.ts:95`). It **is** allowed in `site-assets` (favicons/logos) — that is admin-only write, and the seed placeholders are first-party SVG. The distinction between first-party assets and customer uploads is clean: no customer-reachable path writes SVG. Worth a Stage 2 note: an admin-uploaded SVG to `site-assets` is served without sandboxing, so it trusts the one admin — acceptable, but the only executable-content surface left.

**Malicious file reality:** storage is object storage — no execution. Stated plainly rather than mitigated theatrically. The two real risks are (a) a **decompression bomb** consuming a function's memory during `sharp` decode, and (b) a file rendering as something other than claimed. For (a), `sharp` is called with `failOn: "none"` (tolerant) and **no explicit `limitInputPixels`** — sharp's default pixel limit (0x3FFF×0x3FFF ≈ 268 MP) is in force, so a bomb is bounded by that default, but this is worth an explicit `limitInputPixels` in Stage 2 as defence in depth. For (b), the re-encode neutralises it.

**Video path:** `site-video`, 10 MB cap, admin-only write, served directly to every visitor. `mp4`/`webm` only. No transcode/decode on our side (served as-is), so no decompression surface; the risk is purely the 10 MB public asset, which is the intent.

---

## Reviewed and dismissed (so they are not rediscovered)

- **Supabase advisor `rls_enabled_no_policy`** on `inbound_emails`, `integration_tokens`, `rate_limits`, `shipping_quotes` — **not a finding.** RLS on + no policy = deny-all to anon/authenticated; only `service_role` (which bypasses RLS) touches them. This is the *correct* posture for service-role-only tables, not a gap.
- **Advisor `anon/authenticated_security_definer_function_executable`** on `is_admin`, `owns_order`, `product_is_live`, `can_access_cart`, `discontinued_product_hint`, `adjust_variant_stock`, `admin_delete_product` — intentional. The first five are RLS predicate helpers that *must* be callable; the last two carry an internal `is_admin()` check. Confirmed in function bodies.
- **Money/limit RPCs** (`create_order_with_stock`, `consume_rate_limit`, `cancel_order_with_restock`, `credit_order_coins`, `reverse_order_coins`, `restock_rto_order`, `assert_cart_stock`) — all granted `postgres`/`service_role` **only**. Anon/authenticated cannot execute them. This is the catalogue-derived check `security-advance` is meant to automate; I ran it by hand against the live grants.
- **Advisor `auth_leaked_password_protection` off / `pg_net in public`** (F6, P3) — leaked-password protection is **N/A** (Google-only auth, no passwords). `pg_net` in `public` is minor hygiene.

---

## F1 / F3 — the verification gap, in full

The brief's Stage 2 requires "New security assertions proven to fail on the unfixed tree" and lists "Every admin action refuses a forged Server Action post, with and without a session" as a quality gate. Today:

- **`audit:security-advance`** (the sanctioned money-path attacker) dies at `createAccount`: staging returns **"Email signups are disabled."** Fixtures default to staging (`SUPABASE_STAGE_*` present → clients.ts default). So the gate that proves anon/customer cannot move the advance/discount **cannot run at all**.
- **`audit:actions`** (the named forged-post gate) reads `NEXT_PUBLIC_SUPABASE_URL` = **production**, where signup is correctly disabled, and calls `signUp` to mint its admin+customer (`server-actions.ts:84,125`). It is structurally unable to create its accounts — dead by construction, not merely "superseded."

**Why P1, not P2:** this project's documented failure mode is checks that can't discriminate (a `PGRST202` read as "refused," an assertion matching a lookalike). A gate that throws at setup is read as infra-flakiness and skipped — which is exactly how a silent admin-authz or money-path regression would ship unnoticed. The controls themselves are verified sound *right now* by the independent SQL/ESLint evidence above, so this is not P0/exploitable-today; it is the plausible-condition risk that the next regression is invisible.

**What a broken system would look like (so the check can fail):** if the guard were removed, `security-advance` would print `✗ HOLE` and `audit:actions` would elicit `"ok":true`/`"reason":"invalid"` for a non-admin. Neither can produce that signal while it errors at account creation — so neither is currently a check.

**Not fixed here** (audit only). Stage 2 options for the owner to pick: re-enable email signup on **staging** only (the brief's stated intent — "staging keeps it because the browser fixtures depend on it"), or move the fixtures to mint accounts via the service-role admin API (`auth.admin.createUser`) so they no longer depend on the signup toggle at all. The second is more robust and touches auth, so it is on your list, not mine.

---

## Suggested Stage 2 order

1. **F1/F3** — restore the ability to run the attack gates (owner decision: staging toggle vs. service-role fixtures). Nothing else in Stage 2 can be "proven to fail on the unfixed tree" until this is done.
2. **F2** — a limit on `/api/search/suggest` (a new `searchSuggest` policy, IP-keyed, generous).
3. **F4** — limits on `/api/cart` GET and address writes (low value, do together).
4. **F5** — scrub the test key id / URL template from `docs/`.
5. **Defence-in-depth notes:** explicit `sharp` `limitInputPixels`; decide whether rate-limit thresholds move to `site_settings` (the brief's "configurable" ask); document the admin-SVG-to-`site-assets` trust boundary.

Each carries a test in Stage 2 that fails on the unfixed tree first, per the brief.

---
---

# Stage 2 — the vacuous-assertion class, and the defence-in-depth notes

**Date:** 2026-08-13. Everything below was implemented, not merely recommended, and every converted assertion was watched failing before being called done.

## Headline

The Stage 1 sweep found `audit:actions`'s shape in five other gates. It is now treated as a **class with a rule**, not as N local fixes:

- `scripts/audit/refusal.ts` — classifies *why* a probe was refused and enforces the precondition that makes a read assertion mean anything.
- `footvault/no-vacuous-refusal-assertion` — an ESLint rule that fails the build on the shape inside `scripts/audit/`.
- `docs/staging.md` §4.6 — the rule, the three outcomes, and the procedure for proving a conversion.

## What was actually wrong

Three shapes, all green with the control they name removed:

```ts
check("X refuses a customer", error !== null);               // 1 · any error will do
check("Y is not readable",    (data?.length ?? 0) === 0);    // 2 · nothing came back
check("Z did not change",     error === null && rows === 0); // 3 · nothing happened
```

**Shape 1** flattens six distinct facts into a boolean. Measured against staging, a refused operation answers with:

| what actually refused | code | message |
|---|---|---|
| no table `GRANT` | `42501` | `permission denied for table X` |
| no `GRANT EXECUTE` | `42501` | `permission denied for function X` |
| an RLS policy | `42501` | `new row violates row-level security policy for "X"` |
| the function's own check | `FVADM` | `not_admin` |
| a trigger raising privilege | `42501` | `Only an admin can change a profile role` |
| a `CHECK`/`UNIQUE`/FK constraint | `23xxx` | *refuses anybody — says nothing about the caller* |
| **nothing at all** | `PGRST202` | `Could not find the function … in the schema cache` |

Three share a SQLSTATE and are separated only by the message. Two of them — the constraint and the `PGRST202` — are not authorization evidence at all.

**Shapes 2 and 3** are worse: no predicate fixes them, only a precondition. A read RLS filtered and a read of an empty table are byte-identical. **Five of the eight tables `audit:admin` checked were empty in staging**, plus `shipping_quotes` in `audit:security-advance` — so six ticks were `0 === 0`.

## What was built

`refusal.ts` exports a classifier (`classifyRefusal`), three assertions (`refusedBy`, `unreadableBy`, `unchangedBy`), a witness mechanism, and a shared tally with **three** outcomes.

**`unprovable` is the important one.** A check that cannot be made to mean anything — an empty table with no witness, a row that does not exist — is neither a pass nor a hole in the shop. It prints in its own colour and **fails the run**. Folding it into a pass is the whole defect; folding it into a hole would send someone looking for a vulnerability that isn't there.

Where a table was empty, the fix was to **make the check provable** rather than report amber: `unreadableBy` takes a `witness` that plants a row with the service role for the duration of the read and removes it afterwards. Six checks gained witnesses.

## Gates converted

| Gate | Converted | Now |
|---|---|---|
| `audit:admin` | 8 table reads (4 witnessed), 5 RPC refusals, 2 order writes, ledger insert, self-promotion | 23 held, 0 holes |
| `audit:security-advance` | 6 money-field writes, own-order write, `shipping_quotes` read+write, `site_settings`, shipment, timeline | 14 held, 0 holes |
| `audit:coupons` | 6 reads across 3 tables, 2 callers, 2 witnesses | 0 failing |
| `audit:coins-earning` | the ledger insert, and the read whose `.every()` was vacuous on an empty array | 20/20 |
| `audit:checkout-orders` | unfiltered `payment_events` read; **and a pre-existing throw** — see below | all checks passed |
| `audit:address-book` | the stale-quote check, which had no positive control | all checks passed |

**Examined and left alone**, because they were already sound: `audit:reviews` §7 pairs its invisibility check with a positive control; `audit:zero-stock`'s absence assertion is preceded by proof the request reached the server; the reconciliation checks assert a state, not a refusal. `audit:error-reporting` reads source with a regex and is not this shape at all.

## Two defects found while converting

**1 · `audit:checkout` had been dying at section 10, and taking `audit:admin` down with it.**

`rows("anon reads payments", …)` — `anon` holds no SELECT grant on `payments`, so PostgREST answers `42501` and `rows()`, which is right to treat an unexpected error as fatal, threw. The assertion below it never ran. The throw sits **above this suite's cleanup**, so every run left its fixture `unspecified` inventory rows behind — the exact artefacts whose own comment records that leaving them makes `audit:admin` fail afterwards. `npm run audit` runs checkout before admin. Two gates, one root cause, and the same confusion in its loud form: the harness did not know which layer refuses `payments` for an anonymous caller.

**2 · A before/after comparison is only sound against a known-good baseline.**

`unchangedBy` originally re-read its own "before" per attempt. In a six-iteration loop against one order, the first successful write became the next iteration's baseline and three of six checks went green off the damage. It now takes an explicit `baseline` captured once. Found by running the proof, not by reading the code.

## Proofs — every conversion watched failing

Each control was disabled against staging, the gate run, and the state restored. Full table in `docs/staging.md` §4.6.

| Control disabled | Result |
|---|---|
| RLS off on `coupons` | HOLE — the planted witness row is readable by a plain customer |
| `grant select on rate_limits` | HOLE — refused by RLS, but this check claims table grant |
| `grant execute on consume_rate_limit` | HOLE — NOT REFUSED, the call succeeded |
| rename `adjust_variant_stock` (the PGRST202 landmine) | HOLE — the probe never reached a control |
| `grant insert on inventory_movements` | HOLE — layer moved from grant to RLS |
| permissive INSERT policy on `order_status_history` | HOLE — NOT REFUSED |
| `grant select, insert on shipping_quotes` | HOLE + UNPROVABLE |
| permissive UPDATE on `site_settings` | HOLE — printed the before → after diff |
| permissive SELECT+UPDATE on `orders` | 4 HOLEs across six money fields |
| `grant insert on coin_transactions` | HOLE — the label's exact claim |
| remove `limitInputPixels` | HOLE — the pixel limit is not in force |

The `rate_limits` proof is the most instructive: the table stayed unreadable — RLS caught it — but the control the assertion *named* was gone, and the gate said so. The old `!leaked` check stayed green through exactly that.

**Two proofs write to staging** (a permissive policy means the forbidden write lands). Both were restored; the procedure and the post-proof verification queries are in `docs/staging.md` §4.6.

---

## Defence-in-depth notes

### `sharp` `limitInputPixels` — F-DiD-1, now explicit

**A byte limit is not a pixel limit.** `MAX_UPLOAD_BYTES` (5MB) bounds the wire; the compression ratio belongs to whoever made the file. Measured: an 8000 × 8000 flat PNG is **197KB — 3.9% of the ceiling — and 64 megapixels decoded**. It is a real PNG with correct magic bytes that passes every check the upload path has, and it lands in `inspect()` before a single one of the pipeline's dimension checks runs.

`MAX_DECODED_PIXELS = 50_000_000`, applied at the three points untrusted bytes enter sharp. Derived rather than picked: photographic JPEG runs ~0.3–0.5 bytes/pixel, so the largest genuine photograph inside 5MB is 10–16MP and does not reach 30. sharp's default is 268 402 689 (~1GB decoded), chosen to be permissive rather than safe.

The refusal is also **sayable** — it was a raw `Input image exceeds pixel limit`, which reached the admin as the same sentence a corrupt file produces. It is now an `ImagePipelineError` naming the actual problem.

Gated: four checks in `audit:image-upload`, including that the ceiling is not so low it refuses a real `UPLOAD_EDGE`-sized upload. Proven to fail by removing the option.

### Admin SVG → `site-assets` trust boundary — F-DiD-3, documented

`next.config.ts` justified `dangerouslyAllowSVG` on two grounds and said "both have to stay true". **The first one was false.** Migration 0011 took `image/svg+xml` off `product-images` and `category-images` but deliberately left it on `site-assets`, where a vector logo is the point — and `remotePatterns` admits that bucket. The optimiser can and does serve an uploaded SVG.

The comment now states the boundary as it actually is, in the order it bites:

- **Who can put one there** — `storage.objects` carries an INSERT policy gated on `is_admin()`. The bucket is public to read, admin-only to write. A hostile SVG there presupposes an admin account, which has strictly worse powers available. This is a boundary around the owner, not around a customer.
- **Through `/_next/image`** — `contentSecurityPolicy: script-src 'none'; sandbox` plus `contentDispositionType: "attachment"`. Script does not run. **This is the load-bearing control**, and now the only one on that line that is.
- **Around the optimiser**, via the raw Supabase URL — renders on `*.supabase.co`, a different origin. Same-origin policy does the containing.
- **In an `<img src>`**, which is how every storefront surface renders these — browsers do not execute script in an image-context SVG.

Residual, accepted and written down: an admin uploading a hostile SVG *and* linking someone to its raw Supabase URL, which lands script on Supabase's origin, not the shop's.

### Rate-limit thresholds stay in code — F-DiD-2, decided

**Settled. Recorded in `src/lib/rate-limit.ts` so it is not relitigated.**

The brief asked for "configurable" and Stage 1 flagged the literal as not meeting the word. Declined, because making a number editable means reading it where it is used — and every policy sits on a limited path by definition. That is **a database read on every request the limiter guards**, including the webhook, checkout, and a keystroke-cadence search endpoint, in front of the round trip the limiter already costs.

What it buys is changing a number without a deploy. One operator, two-minute deploys, and no threshold here has ever been changed in an incident — the numbers are sized against what a person can physically do, which does not move.

Secondary costs, all real: a validation surface where zero means "outage on checkout" (today a malformed policy is a *compile* error via `as const satisfies`); a second failure mode on a component that must fail open, whose fallback would be the constant again, now able to disagree with the row; and the rationale drifting from the number. If one ever needs to move at runtime, the cheap version is a module-load environment variable for that one policy.

### `rate-limit.ts` comment/key misalignment — fixed

Out of scope, in the same file, and actively misleading. Three doc blocks had drifted above the wrong keys: the `errorReport` block sat above `cartWrite`'s, which sat above `imageProcessing`'s, and only the last was adjacent to its key. `errorReport: [3, 3600]` had **no** doc at all, so a reader attached `errorReportTotal`'s — which opens "And a ceiling across *all* fingerprints" and reads as a continuation. Every key now carries its own block. This is the one table someone reads during an incident.
