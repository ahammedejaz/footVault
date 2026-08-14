# CSP: the jitless fix, the flip to enforce, and the two queued items

**Date** 2026-08-13 into 2026-08-14
**Commits** `9eda085`, `1da1972`, `0fa8256`, `ad58ad0` — all on `main`, all deployed
**Outcome** Production serves an enforcing CSP. Zero violations on every route measured. Both queued items closed.

---

## 1 · What was asked

Four things, in order:

1. Apply the Zod jitless fix in its own commit, with a comment pointing at Zod's own source note.
2. Re-run the checkout gates, confirm zero violations on `/checkout` under Report-Only.
3. Flip `CSP_MODE` to enforce, deploy, verify by alias + smoke + header on the wire.
4. Add two notes to `docs/operations.md`, then pick up `crop-stage.tsx` and `admin-security.ts:516`.

All four are done. What follows is what was measured and what went wrong getting there.

---

## 2 · The jitless fix (`9eda085`)

### The mechanism, precisely

Zod decides once per JS realm whether it can JIT-compile schemas. It asks by running `new Function("")` inside a `try/catch`. Under a strict CSP the constructor throws, Zod catches it, the interpreted validator takes over, and **nothing breaks** — but the browser fires `securitypolicyviolation` at the point of the block, before the catch runs.

Zod's own source names this exact case, at `node_modules/zod/src/v4/core/util.ts:365`:

```
// Skip the probe under `jitless`: strict CSPs report the caught `new Function`
// as a `securitypolicyviolation` even though the throw is swallowed.
```

Two details decided the shape of the fix:

- **`allowsEval` is a one-shot `cached()` getter** (`util.ts:224`). It runs once, then overwrites itself via `Object.defineProperty`. That is why the bake showed exactly one violation, not one per schema.
- **It is read at schema *construction* time**, at `schemas.ts:2099`: `const fastEnabled = jit && allowsEval.value`. Note the short-circuit — with `jitless` set, `jit` is `false` and `.value` is never touched, so no `Function` is ever constructed.

### Why it re-exports `z`

The config must beat the *first* `z.object(...)`, and every schema in this app is a module-level const. A bare `import "./zod-config"` placed first in each schema file would work, per ES module evaluation order — and would keep working right up until an import sorter moved the line.

`src/lib/validations/z.ts` re-exports a configured `z` instead, which makes the ordering a data dependency the bundler must honour rather than a convention someone must remember. The four browser-reachable schema modules go through it:

| Module | Why it is reachable |
| --- | --- |
| `validations/cart.ts` | bag UI |
| `validations/checkout.ts` | checkout form |
| `validations/address.ts` | address book |
| `content/section-payload.ts` | admin appearance editor |

Every other Zod importer in `src/` is `"use server"` or `server-only` and is stripped from the client bundle — 27 of the 31, checked by reading the first line of each.

### The measurement

Against a **production stage build**, because `next dev` carries `'unsafe-eval'` and is what masked this in the first place. One variable moved — the config call itself, imports left identical — and the build repeated either side:

| Build | `/checkout` | `/cart`, `/`, `/shop` |
| --- | --- | --- |
| config **off** | **1 violation** — `script-src blocked=eval` at `3szwarg70504l.js:1:2860` | clean |
| config **on** | **0** | clean |

The column offset is the corroboration worth naming: production reported `0p2al4-hoykfw.js:1:2860`. Different chunk hash, **same byte offset** — the same probe in the same position in the same library.

### Cost, stated rather than hidden

`globalConfig` lives on `globalThis`, so the switch is per-realm. The schema modules are shared with server actions, so the server goes jitless too the moment an action imports one.

Accepted rather than gated on `typeof window`. Gating would keep the JIT server-side at the price of running the two halves of a shared schema through different validator implementations — a divergence that costs more the day it behaves differently than the interpreter costs on every request until then. These schemas are small and parsed a handful of times per request.

---

## 3 · The flip to enforce (`1da1972`)

### Local verification before flipping

| Check | Result |
| --- | --- |
| header name | `Content-Security-Policy` only; zero `Report-Only` headers |
| `upgrade-insecure-requests` | present (it is emitted only when enforcing) |
| CSP probe, 4 routes | 0 violations, 0 console errors |
| `audit:headers` | all assertions hold |
| `audit:checkout` | All checks passed |
| `audit:keyboard-checkout` | exit 0 |
| `audit:checkout-discount` | 20 passed, 0 failed |
| `audit:totals` | 48 passed, 0 failed |
| `audit:hydration` | exit 0 |
| `audit:bag` | All checks passed |
| `audit:signedin` | exit 0 |

The last three are the ones worth naming. Enforcing **adds** `upgrade-insecure-requests`, and the last time that directive was live in the wrong mode it put 42 copies of an "ignored in a report-only policy" warning across exactly those three gates, whose whole job is a quiet console. Under enforce it is legitimate and silent.

### Production verification

Deployment `dpl_AkBnjvmg4jM5UiyPdmwMCZVAXp2R`, commit `1da1972`, region `bom1` (the pin survived), aliased to `www.footvault.in`.

The header name was used as the serving identifier, since `Content-Security-Policy` is absent from the old tree — READY is a build state, not proof of serving. The transition was watched on the wire:

```
t=5s   report-only=1 enforcing=0
t=10s  report-only=1 enforcing=0
t=15s  report-only=1 enforcing=0
t=20s  report-only=0 enforcing=1     <- new deploy serving
```

Then, against live production:

- Full enforcing header present, `report-only` count **0**
- The other four headers intact: HSTS, `nosniff`, referrer policy, permissions policy, plus `Reporting-Endpoints`
- Route smoke: `/`, `/shop`, `/cart`, `/checkout`, `/search`, `/page/returns` all 200; `/api/csp-report` 204; a dynamic product page 200
- **Browser probe against production: 0 violations, 0 console errors** on `/checkout`, `/cart`, `/`, `/shop`

---

## 4 · What went wrong

Recorded because each one nearly produced a false result.

### 4.1 The positive control was invalid, twice

A "zero violations" reading is worthless if the listener is broken, so the probe carried a control. The first version called `new Function` via `page.evaluate` — **which reported nothing**, because Playwright drives that through CDP `Runtime.evaluate`, and CDP-evaluated code is not subject to the page's CSP.

The second version appended a real `<script>` element whose body called `new Function`. That also reported nothing. Diagnosis showed the listener was fine — an `img-src` violation to `example.com` and a `script-src-elem` violation both captured cleanly on `document` and `window` — but the injected script's `new Function` *ran successfully*, unblocked, so the attribution still leaked from the CDP world.

**The control that actually worked was the A/B build.** Toggling the config call and rebuilding gives a positive case from the real code path, with the real chunk, at a known byte offset. Synthetic eval injection through an automation harness is not a substitute.

Had the probe been written without a control, it would have printed `PASS /checkout violations=0` on the **unfixed** build and the whole exercise would have concluded on a false negative.

### 4.2 `audit:security`'s 6 failures — pre-existing, and verified so

The gate reports 6 failures, all page-layer, all `200` where `404` was expected. It was **not** among the 6 failing gates in the last full suite run, so it needed attributing rather than waving away.

It is not the CSP work and not the Zod change. `/order/[orderNumber]` streams a skeleton from `loading.tsx`, so the response commits `200 OK` before `getOrderForViewer` answers; `notFound()` then swaps the body in-stream. **The route's own header documents this**, measured 2026-08-10, and explicitly names the gate's expectation as the stale thing. It shows up now and not before because that suite ran against `next dev`; this ran against a production build.

Re-checked rather than trusted. Fetched as a stranger with no cookie:

| Request | Status | Bytes |
| --- | --- | --- |
| a real order `FV-2026-00606` | 200 | 86153 |
| a never-issued `FV-2026-99999` | 200 | 86153 |

Both carry the not-found body. Normalising the order number, the two responses are **byte-identical** — no length oracle, no content oracle. Every API-layer check in the same gate passes (`0 rows` to every stranger read). The body is what protects the order-number space, and it holds.

### 4.3 A shell idiom that reports a false green

`npm run lint 2>&1 | tail -4 && echo "lint OK"` prints `lint OK` **whatever eslint does**, because `&&` chains off `tail`'s exit status, not eslint's. It printed `lint OK` directly beneath a genuine eslint error.

Use `${PIPESTATUS[0]}`, or run the command without a pipe. The error it masked was mine — an investigation scratch file left in `scripts/audit/` — but the idiom would mask anything.

### 4.4 Transient infrastructure

`audit:bag` and `audit:signedin` first failed with `locator.waitFor: Timeout` and `could not create fv-signedin…@example.com: fetch failed` during a network outage. Both passed on re-run once connectivity returned. Neither was a CSP finding, and neither should be recorded as one.

---

## 5 · `docs/operations.md` (`0fa8256`)

**The file did not exist and was referenced nowhere**, so this creates it rather than appending to it. Two entries, both about reading a live signal rather than about the policy:

- **A `[csp]` line naming a razorpay.com origin is a payments incident.** `checkout.js` is fetched fresh at every checkout and is neither vendored nor pinned, so Razorpay can change what it loads with no deploy here; the allowlist is a snapshot of their dependency graph on one day. Under enforce a missing origin blocks, in the silent shape — no customer-visible error, stock already reserved, first server-side sign is the abandoned-order sweep hours later. The signal is *specific* because their fraud stack runs inside the cross-origin `api.razorpay.com` iframe, which our policy does not govern; a razorpay.com origin in **our** log therefore means something moved into our document. Includes the fix and the rollback — report-only is one word and restores payments while keeping the signal.

- **Silence at the sink is not evidence of a clean run.** The sink's half is proven (`audit:headers` §9). The browser's half is not: Chromium under Playwright detects violations, logs them, and delivers nothing — headless, headed, and with background networking re-enabled, watched at CDP level for ninety seconds. So the console is the primary instrument and the endpoint the secondary. The asymmetry runs one way, and the doc tabulates it: reports arriving proves delivery works; nothing arriving proves nothing.

The second entry names the mistake it exists to prevent — the first deploy report claimed zero violations from a session measured against `next dev`, whose policy carries `'unsafe-eval'`, so the one real violation could not have appeared.

---

## 6 · The two queued items (`ad58ad0`)

### 6.1 `crop-stage.tsx` — fixed, not allowlisted

The framing square is `tabIndex={0}`, `role="group"`, and driven entirely from the keyboard: arrows nudge the crop, shift-arrows nudge four times as far, `+`/`-` zoom. It carried `focus-visible:outline-hidden` **with nothing in its place** — no ring, no focus state, no background change. A keyboard user could focus it, press an arrow, watch the photograph move, and have no way to tell what they were driving.

`focus-ring.ts` offers two remedies: allowlist with a reason, or drop the class. The existing exemptions are all for controls that indicate focus another way — a menu item's `bg-accent` is a real indicator, just not an outline. This one had none, so the class was dropped.

Proven on the **rendered component**, since a source rule proving a class is absent is exactly what that gate exists to distrust. Admin session, real product, real upload, tabbed to the square rather than focused programmatically so `:focus-visible` genuinely matches:

```
outlineStyle   solid
outlineWidth   2px
outlineColor   rgb(254, 147, 1)
outlineOffset  1px
boxShadow      rgb(10, 21, 38) 0px 0px 0px 4px
focusVisible   true
```

That is exactly the composite indicator `globals.css` specifies. `audit:image-editor` still passes, so the crop UI is intact.

### 6.2 `admin-security.ts:516` — the check now tests its own claim

`reconcile_inventory()` answers two questions at once. Its `HAVING` is `sum(delta) <> stock_quantity OR unspecified_rows > 0`, and the function's own comment names them apart: *"a write bypassed the trigger … or a caller failed to declare its reason."* Only the first is a security finding.

The gate counted **rows**, so it conflated them. It reported "2 drifting variants" one night and 4 the next — and three of those four had `drift: 0`:

| SKU | drift | unspecified rows |
| --- | --- | --- |
| `FV-REDCHI-OXFORDME-BLACK-7` | 1 | 1 |
| `FV-ADIDAS-SAMBAOGM-COREBL-10` | **0** | 2 |
| `FV-SKECHE-SUMMITSW-ALLBLA-3` | **0** | 2 |
| `FV-SKECHE-SUMMITSW-GREYLA-3` | **0** | 2 |

They were not drifting. They carried `unspecified` movements in matched pairs (`-7` then `+7`) — fixtures being set up and torn down.

Those artefacts are **structural, not sloppiness**. Attribution reaches the trigger through transaction-local GUCs set with `set_config(..., true)`, and a PostgREST `.update({ stock_quantity })` cannot set one, because every REST write is its own transaction. Six harnesses move stock that way — `zero-stock`, `coupons`, `transitions`, `checkout-orders`, `security-checkout`, `teardown` — and the rows accumulate across runs, so the count only ever grows.

The check now snapshots `reconcile_inventory()` when the section opens and fails only on variants that **gained** drift or **gained** an unattributed row while the attempts ran. That is what the label always claimed: *"after every attempt above"* is a statement about a delta. It is strictly sharper than counting — an `unspecified` row created *by this gate* now fails it, where before it was lost in the pile.

**Proven non-vacuous rather than assumed.** With the baseline forced empty the gate goes red and names each transition:

```
✗ HOLE  and after every attempt above, the ledger still reconciles
        — FV-REDCHI-OXFORDME-BLACK-7: drift 0→1, unattributed 0→1;
          FV-ADIDAS-SAMBAOGM-COREBL-10: drift 0→0, unattributed 0→2; …
```

Restored: **24 held, 0 holes.**

---

## 7 · Still open

- **`audit:focus` remains red** on its *other* failure: the `/search` input is never focused in 150 Tab stops. A real keyboard-reachability defect, in the same gate as `crop-stage.tsx` but a separate item, and never queued here. Not touched.
- **`audit:security`'s 6 page-layer status checks** still report. The behaviour is correct and documented; the gate's expectation is stale. Fixing it means teaching it to assert on the body rather than the status line — the route header already says the same of `scripts/audit/routes.ts`, which declares 404 for `/order/FV-2026-99999`.
- **Browser-to-sink delivery is still unproven.** Now recorded in `docs/operations.md` as a standing caveat rather than a to-do, because the console is a sufficient primary instrument.
- **`'unsafe-inline'` is still on `script-src`.** Unchanged by this work; the nonce + `strict-dynamic` follow-up is described in `csp.ts` along with why it is not worth doing blind.

## 8 · Note for the payment test

Two things to have in view while putting the second payment through, and while abandoning one at the Razorpay modal:

1. **The console is the instrument**, not the report endpoint. Keep DevTools open.
2. **Any `razorpay.com` origin appearing in a violation is the incident**, and the rollback is one word in `src/lib/csp.ts`. Everything else can wait for a batch.
