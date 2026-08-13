# The CSP Bake: the `eval` Violation, and Who Owns the Fraud-Stack Traffic

**Date:** 2026-08-13
**Scope:** the two questions the owner raised after completing a real UPI payment on
production under the Report-Only CSP. Investigation only — **no code was changed and
`CSP_MODE` was not flipped.**
**Verdict:** both answered. The violation is a guarded feature probe that is safe to enforce,
proven by running the checkout gates under an enforcing policy. The fraud-stack traffic is
outside our policy's reach, proven by static analysis of `checkout.js`. **One residual risk is
recorded in [§4](#4-the-residual-risk-worth-knowing-about) and it is not zero.**

---

## 0 · The payment result

The owner completed a real UPI payment on `www.footvault.in` — successful, order paid, receipt
correct. **Not one `razorpay.com` origin was blocked.** The allowlist in
[§4.1 of the deploy report](./security-headers-cookie-csp.md) is correct against a full,
real payment flow.

That is the observation the whole staged rollout existed to produce.

---

## 1 · The `eval` violation — what it is

### 1.1 The finding contradicted the earlier report, and the earlier report was wrong

§4.4 of the deploy report said the storefront produced **zero** real violations under
Report-Only. That was measured across `/`, `/shop`, `/product/[slug]`, `/cart` and `/checkout`
against **`next dev`**, where a dev-only `'unsafe-eval'` is present — so the probe below was
permitted and never reported. The claim was true of the environment measured and false of
production. **The premise is re-established below against production.**

### 1.2 Reproduced, with structured fields

Driven over seven production routes, capturing `securitypolicyviolation` events rather than
console text:

```
/checkout
   directive=script-src  blocked=eval  disposition=report
   source=https://www.footvault.in/_next/static/immutable/chunks/0p2al4-hoykfw.js:1:2860
```

**It fires on `/checkout` and on no other route.** `/`, `/shop`, `/product/nike-air-max-90-mens`,
`/cart`, `/search?q=nike` and `/page/about` are all clean.

### 1.3 What evaluates a string

The bytes at that exact offset:

```js
let k = c(() => {
  if (o.jitless || "u" > typeof navigator && navigator?.userAgent?.includes("Cloudflare"))
    return !1;
  try { return Function(""), !0 } catch(e) { return !1 }
});
```

The chunk is **Zod 4.4.3** — 482 `_zod` references, `$ZodType`, `ZodError`, `safeParse`,
`jitless`. It is first-party only in the sense that it is bundled into our chunk; the code is
the library's.

This is a **feature probe**, not a dependency. Zod compiles fast validators with `Function()`
when the environment permits it, and falls back to an interpreted path when it does not. The
probe exists to find out which.

Zod's own source says so, and describes this exact situation —
`node_modules/zod/v4/core/util.js:146`:

```js
// Skip the probe under `jitless`: strict CSPs report the caught `new Function`
// as a `securitypolicyviolation` even though the throw is swallowed.
if (globalConfig.jitless) {
    return false;
}
```

and `node_modules/zod/v4/core/schemas.cjs:1001`:

```js
const jit = !core.globalConfig.jitless;
const allowsEval = util.allowsEval;
const fastEnabled = jit && allowsEval.value;   // false → the interpreted path
```

**Why `/checkout` specifically:** it is where an object schema is first parsed client-side.
`checkoutSchema` in `src/lib/actions/checkout.ts` is the shape being validated; the probe runs
once, lazily, the first time a schema is compiled.

### 1.4 On load, or only after Razorpay's script?

**On load, and entirely independent of Razorpay.** Two trials, one with every `razorpay.com`
request aborted at the network layer:

| trial | razorpay requests | violations |
|---|---|---|
| normal `/checkout` | **0** | 1 — `script-src / eval @ 0p2al4-hoykfw.js:1` |
| `/checkout`, all `razorpay.com` blocked | **0** | 1 — identical |

Zero Razorpay requests were made in *either* case, because an empty bag never reaches payment
initiation — and the violation fired regardless. It precedes Razorpay entirely.

### 1.5 Is it safe to enforce? Tested, not assumed

Zod's comment says the throw is swallowed. That is the library's claim about itself, so it was
verified against a real enforcing build (`CSP_MODE = "enforce"`, built with `build:stage`,
served, then reverted):

```
=== /checkout under an ENFORCING policy ===
  violations: 1
    script-src / eval @ …:1   disposition=enforce      ← actually blocked, not reported
  uncaught page errors: 0
  homepage renders under enforce: true
```

And the gates that exercise the checkout form and its validation, run against that same
enforcing build:

```
audit:checkout           exit=0
audit:keyboard-checkout  exit=0
audit:bag                exit=0
audit:cart-limit         exit=0
```

**Enforcing blocks the probe, Zod catches it, validation continues on the interpreted path,
and every checkout gate still passes.** The cost is validator performance on `/checkout`, not
correctness.

The temporary flip was reverted; production has been `report-only` throughout and the working
tree is clean.

### 1.6 The clean remedy — proposed, not applied

The violation is cosmetic but not harmless: it will fire once per `/checkout` load forever,
train whoever reads the log to ignore `[csp]` lines, and bury a real violation later. Zod
provides the fix it documented:

```ts
import { config } from "zod";
config({ jitless: true });
```

That skips the probe entirely, so no violation is ever generated, and it makes explicit the
path the code already takes under CSP. **Not applied** — the owner asked for the questions
answered, not for a change, and this belongs in its own commit with its own gate run.

---

## 2 · The fraud-stack traffic — who owns it

The owner's belief: `sardine.ai`, `sentry-cdn` and `localhost:7070` / `:37857` are Razorpay's
fraud stack running inside its own cross-origin iframe, which our CSP does not govern — so
enforcing would not block them. **Verified, and the belief is correct.**

### 2.1 Static analysis of `checkout.js`

`checkout.razorpay.com/v1/checkout.js` is the only Razorpay code that runs **in our document**.
Everything else runs in the `api.razorpay.com` iframe it creates.

| looked for | result |
|---|---|
| `sardine` (any form) | **not referenced anywhere in checkout.js** |
| `localhost:<port>` / `127.0.0.1:<port>` | **not referenced anywhere** |
| `browser.sentry-cdn.com` | present — **but not as a script load** |

The Sentry reference is a **string inside an error-message filter**, not a fetch:

```js
{ exactMatches: ["Not implemented on this platform"],
  looseMatches: ["Cannot redefine property: ethereum",
                 "chrome-extension://", "moz-extension://", "webkit-masked-url://",
                 "https://browser.sentry-cdn.com", "chain is not set up", …,
                 "Blocked a frame with ori…"] }
```

It sits beside `chrome-extension://` and `"Blocked a frame with origin"` — a noise filter for
Razorpay's own telemetry, listing error sources it chooses to ignore. It never loads Sentry
into our page.

So **none of the three can be initiated by the code running in our document.**

### 2.2 Why our policy does not reach the iframe

CSP applies **per document**. The Razorpay modal is a cross-origin document on
`api.razorpay.com`, delivered with its own headers and governed by its own policy. Our
`frame-src` controls whether we may *embed* it; once embedded, its subresource loads are its
business, not ours. There is no inheritance across a cross-origin boundary.

### 2.3 The corroborating evidence from the real payment

This is the part that closes it, and it comes from the owner's own run rather than from
reasoning:

- `sardine.ai`, `sentry-cdn` and the localhost ports are **not in our allowlist**.
- The policy was live in Report-Only during the payment.
- Had any of that traffic originated in **our** document, `connect-src` or `script-src` would
  have reported it.
- **The only violation reported was the Zod `eval`.**

Traffic observed in the network panel, zero violations reported for it, and no code path in
`checkout.js` capable of initiating it from our document — all three agree: it happens inside
the iframe.

**Enforcing would not block it.**

---

## 3 · Answers, stated plainly

> **What in the production bundle evaluates a string?**
> Zod 4.4.3's `allowsEval` feature probe — `Function("")` inside a `try/catch` — used to decide
> between a JIT-compiled validator and an interpreted one. Bundled at
> `/_next/static/immutable/chunks/0p2al4-hoykfw.js:1:2860`.

> **Which route does it fire on?**
> `/checkout`, and only `/checkout`. Six other production routes are clean.

> **On load, or only after Razorpay's script arrives?**
> On load, and independent of Razorpay. Proven with every `razorpay.com` request aborted: zero
> Razorpay requests in either trial, identical violation in both.

> **Is the sardine/sentry/localhost traffic outside our policy?**
> Yes. `sardine` and the localhost ports are absent from `checkout.js` entirely;
> `browser.sentry-cdn.com` appears only as a string in an error-filter array. All three
> originate inside the cross-origin `api.razorpay.com` iframe, which our CSP does not govern.

> **Would enforcing break payments?**
> Not on this evidence. The one violation is a swallowed probe with a working fallback, proven
> by `audit:checkout`, `audit:keyboard-checkout`, `audit:bag` and `audit:cart-limit` all
> passing against an enforcing build. The fraud stack is out of reach of our policy.

---

## 4 · The residual risk worth knowing about

**A clean Report-Only bake proves what happened, not what can happen.** Two specific gaps:

1. **Razorpay can change `checkout.js` at any time.** It is fetched fresh from their CDN on
   every checkout. If a future version loads Sardine — or anything else — from **our** document
   rather than the iframe, an enforcing `connect-src`/`script-src` would block it, and the
   failure would be silent in exactly the way [§4 of the deploy
   report](./security-headers-cookie-csp.md) describes. Today's analysis is a snapshot of
   today's bundle.

2. **Error paths were not exercised.** The payment succeeded. A failed or abandoned payment may
   take code paths that a successful one does not, and Razorpay's own error reporter is
   precisely the component whose filter list names `sentry-cdn`.

Neither is a reason to withhold enforcement — an enforcing CSP is still a large net gain, and
the alternative is having no policy at all. They are reasons to **keep the report sink and
watch it after the flip**, and to treat a sudden run of `[csp]` lines naming a Razorpay origin
as a payments incident rather than a policy nit.

Bear in mind that browser → sink delivery remains **unproven** (deploy report §4.7): Chromium
under automation detects violations and delivers nothing. If `[csp]` lines never appear in the
production log after the flip, that is a fact about reporting, not a clean bill of health.

---

## 5 · What was and was not done

**Done:** reproduction on production, byte-level identification, library confirmation from
Zod's own source, a Razorpay-blocked control trial, a full enforcing build with four checkout
gates, and static analysis of `checkout.js` for all three fraud-stack hosts.

**Not done, deliberately:**

- `CSP_MODE` **not flipped** — production is still `report-only`, confirmed on the wire after
  the investigation.
- The `jitless` fix **not applied** — proposed in [§1.6](#16-the-clean-remedy--proposed-not-applied).
- The temporary enforcing build **reverted**; working tree clean, nothing committed.

**Still queued** from the deploy report §8.3: `crop-stage.tsx` (focus outline, fourth instance
of that class, live on production) and `admin-security.ts:516` (counts reported variants as
drifting, and manufactures the rows it fails on).
