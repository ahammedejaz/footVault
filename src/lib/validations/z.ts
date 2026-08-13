import { z } from "zod";

/**
 * Zod, with JIT compilation off, and the one import every schema must use.
 *
 * ## What this is fixing
 *
 * Zod probes the runtime once to decide whether it can compile schemas into
 * generated validator functions. The probe is a `new Function("")` inside a
 * `try/catch`. Under a strict CSP the constructor throws, Zod catches it and
 * falls back to the interpreted path — nothing breaks — but the browser has
 * already fired `securitypolicyviolation` by then, because a report is emitted
 * at the point of the block, not at the point of an uncaught error.
 *
 * Zod's own source says exactly this, at
 * `node_modules/zod/src/v4/core/util.ts:365`:
 *
 *     // Skip the probe under `jitless`: strict CSPs report the caught
 *     // `new Function` as a `securitypolicyviolation` even though the throw
 *     // is swallowed.
 *
 * That is the whole violation. It is Zod asking a question about the runtime,
 * not this shop evaluating a string, and it was measured to be independent of
 * Razorpay — see `claudeExecutionReport/csp-bake-eval-and-frame-attribution.md`
 * for the control trial with every `razorpay.com` request aborted.
 *
 * Enforcing without this fix is safe (the probe is blocked, the fallback runs,
 * checkout passes) but it leaves a permanent violation on `/checkout`. That is
 * worse than it sounds: the report endpoint's only job is to be quiet, and a
 * sink with a known-benign entry in it is a sink nobody reads. §4.2 of the
 * report is about error paths never being exercised; a log with standing noise
 * in it is the same failure in a different place.
 *
 * ## Why this re-exports `z` instead of being a side-effect import
 *
 * Because the config has to win a race, and a re-export is the only way to make
 * the bundler enforce it rather than a human remembering it.
 *
 * `allowsEval` is a `cached()` getter — it runs **once** per realm and then
 * replaces itself with the resolved value. It is read at schema *construction*
 * time, not parse time, at `node_modules/zod/src/v4/core/schemas.ts:2099`:
 *
 *     const fastEnabled = jit && allowsEval.value;
 *
 * Note the short-circuit. With `jitless` set, `jit` is `false` and `.value` is
 * never touched, so the getter never runs and no `Function` is ever
 * constructed. But `config()` must therefore execute before the first
 * `z.object(...)` in the realm — and every schema in this app is a module-level
 * const, so "before" means before those modules evaluate.
 *
 * A bare `import "./zod-config"` placed first in each schema file would do it,
 * per the ES module evaluation order, and would keep doing it right up until an
 * import sorter moved the line. Importing `z` *from here* makes the ordering a
 * data dependency: nothing can construct a schema without having already
 * evaluated this file, because this file is where `z` comes from.
 *
 * **So: never `import { z } from "zod"` in a module the browser can reach.**
 * The four that can are `cart.ts`, `checkout.ts`, `address.ts` and
 * `content/section-payload.ts`; every other Zod importer in `src/` is
 * `"use server"` or `server-only` and is stripped from the client bundle.
 *
 * ## What it costs
 *
 * `globalConfig` lives on `globalThis` (Zod attaches it there deliberately, so
 * one config is shared across CJS and ESM copies), so this switch is per-realm
 * and not per-import. The schema files here are shared by client components and
 * server actions alike, which means the server realm goes jitless too the
 * moment an action imports one.
 *
 * That is accepted rather than worked around. Gating on `typeof window` would
 * keep the JIT server-side, at the price of the two halves of a shared schema
 * running through different validator implementations — a divergence that costs
 * more the day it produces different behaviour than the interpreter costs on
 * every request until then. The schemas here are small and parsed a handful of
 * times per request; the JIT's advantage on them is not measurable against
 * network and database time.
 */
z.config({ jitless: true });

export { z };
