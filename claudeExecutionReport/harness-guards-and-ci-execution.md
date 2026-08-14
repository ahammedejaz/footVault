# The 19 harnesses, and two CI checks that passed by failing

2026-08-14, fifth message. No `src/` file changed — this is entirely harnesses,
CI, and the scripts behind them.

---

## 1 · All 19 browser-driven harnesses are guarded

`assertServerNotProduction(BASE_URL, "run <name>")` is now the first statement
of `main()` in eighteen of them, `customer-reachability.ts` first because it is
the one that fired. The nineteenth, `fixtures.ts`, has no `main()` — it is the
library the others build fixtures with — so its guard sits at the two points
where it actually drives a browser: `addToBag()` and the order-page navigation.

`interactions.ts` got **both** guards. It clicks "Add to bag", so it writes a
cart into whatever database the server it is driving is backed by, and it had
neither.

Coverage, by the same detector that produced the original list:

```
before: 43 harnesses write or drive a writing form
          19 browser-driven via BASE_URL with no server-side check
           2 missing the credential guard too

after:  43 harnesses write or drive a writing form
           0 browser-driven via BASE_URL with no server-side check
           0 missing the credential guard too
```

Proven on the harness that caused the incident:

```
$ AUDIT_BASE_URL=https://www.footvault.in npx tsx scripts/audit/customer-reachability.ts

Error: Refusing to run audit:reachability: https://www.footvault.in is serving
the production database.

  The server there is backed by ahumjhwqgmskjsitctcj, the live shop.
  A browser driven at this URL writes to whatever database that server
  is backed by — a cart, an account, an order, a settings row — no matter
  what credentials this process holds, and this process holds
  pblgpvcdappfpoxdascd.

  Run `npm run dev:stage` and point AUDIT_BASE_URL at it.
```

It refuses **before** the fixture build, which is the write that reached
production on 14 August.

Two supporting changes:

- **The check is memoised per base URL.** Every harness calls it from `main()`
  and `fixtures.ts` calls it again from two places, so a run building three
  fixtures would otherwise fetch the same two pages seven times to re-learn the
  same fact. The promise is cached, not the result, so concurrent callers share
  one check and a refusal reaches all of them.
- **The refusal message was written for `settings-controls` and now serves all
  nineteen**, so it names what a browser writes rather than "types QA values
  into real forms".

`keyboard.ts` is in the nineteen and still has no credential guard. It does not
write — I read it, and its `.press(` matches are navigation — so the server
guard is the one that matters for it. Say the word if you want the credential
guard there too for uniformity.

---

## 2 · The client-component guard: fixed, and proven both ways

Moved out of YAML into `scripts/ci/client-server-imports.mjs`, run by
`npm run guard:client-imports`, which CI now calls. The regex is unchanged; it
runs in Node's engine, which exists wherever Node does.

```
$ npm run guard:client-imports
97 "use client" files scanned, none value-imports a server-only module.      exit=0
```

Negative control — a real value import added to `src/app/error.tsx`:

```
Client components importing a server-only module (value import):
  src/app/error.tsx                                                          exit=1
```

Restored, green again. Two hardening details: it **fails if it scans zero
files**, so a run that covers nothing is visibly wrong rather than quietly
green; and it prints the count it scanned rather than only what it found.

The `secrets` job had no `setup-node` step — it only checked out. It relied on
whatever Node the runner image ships. Pinned to 22, with a note saying why.

---

## 3 · I found a second one with the same defect, in my own battery

Running the six jobs locally, job 5 reported:

```
  exit=0 — 1 "use server" files, all export only async functions
```

There are **28**. This shell is zsh, and zsh leaves `SH_WORD_SPLIT` off — so
`for f in $directives` did not word-split, the loop ran once with all 28 paths
as a single filename, grep answered `No such file or directory`, and the check
printed a pass having tested nothing.

It is correct on CI, which runs bash. Confirmed by re-running it under
`bash -c`: 28 files, exit 0, no violation. But it is **vacuous on the machine
the code is written on**, which is the same split the `grep -P` guard had, and
the reason to fix it is the one you gave: a check that passes because it failed.

So it is a script too — `scripts/ci/use-server-exports.mjs`, faithful to the
original regexes including their exclusions. Negative control, a `SIGN_IN_IDLE`
constant added to a real `"use server"` file — the exact defect Phase 4 shipped:

```
A "use server" file may only export async functions:
  src/lib/actions/cart.ts:577  export const SIGN_IN_IDLE = { state: "idle" };   exit=1
```

Restored: `28 "use server" files scanned, all export only async functions`,
exit 0. It also fails if it finds zero `"use server"` files.

That is two of the six CI jobs that were silent-pass on this machine. Both are
now scripts, both print their scan count, both refuse an empty scan.

---

## 4 · What went wrong

**I reformatted 35 files I had no business touching.** `npx prettier --write
"scripts/audit/*.ts"` hit the whole directory, not the twenty I had edited.
Those files were not prettier-clean — hand-wrapped in places — so it rewrote
them: 166 changed lines in `admin-pages.ts` for a one-line guard, 76 in
`reviews.ts`, 74 in `image-editor.ts`.

Caught by reading `git status` before committing, which showed 55 modified files
where I expected 20. Reverted all 35, then reverted the 19 I *had* edited and
re-applied the guard **without** running Prettier over them — my inserted block
is already Prettier-clean, so nothing needed reformatting. The diff is now 8–9
lines per harness.

None of it would have broken anything. It would have buried a nineteen-line
change in six hundred lines of noise, and made the next person reading
`git blame` on those files find me instead of the author.

---

## 5 · The battery — all six CI jobs, with exit codes

Not typecheck and lint.

```
═══ 1/6  Typecheck ═══
  exit=0
═══ 2/6  Lint ═══
  exit=0
═══ 3/6  Cached shapes match SHAPE_VERSION ═══
  exit=0 — 16 cached shapes unchanged at v8.
═══ 4/6  Build (placeholder credentials, STATIC_PARAMS_ALLOW_EMPTY=1) ═══
  exit=0 — ✓ Compiled successfully in 1124ms
           Failed to compile occurrences: 0
═══ 5/6  Assert "use server" files export only async functions ═══
  exit=0 — 28 "use server" files scanned, all export only async functions.
═══ 6/6  Guard the service_role key ═══
  a) exit=0 — SUPABASE_SERVICE_ROLE_KEY referenced only in src/lib/supabase/admin.ts
  b) exit=0 — no NEXT_PUBLIC_ service key
  c) exit=0 — 97 "use client" files scanned, none value-imports a server-only module.
```

Job 4's `[static-params] … ENOTFOUND placeholder.supabase.co` lines are expected
and are the point of the job: the build must not need live credentials, and
`STATIC_PARAMS_ALLOW_EMPTY=1` is CI declaring that its artifact never serves
traffic.

---

## 6 · Deploy

`git status src` is **empty** — no application file changed, so the push is a
no-op for the storefront and there is nothing to verify by alias that was not
verified in the last report. What matters here is the CI run, recorded below.

---

## 7 · CI record

Commit `0957c63`, run **31825867687** — both jobs green:

```
Typecheck, lint, build:      success  (2m28s)
Guard the service_role key:  success
```

The two rewritten checks, quoted from the Ubuntu run rather than from my
machine:

```
97 "use client" files scanned, none value-imports a server-only module.
28 "use server" files scanned, all export only async functions.
```

Those are the same counts the local run printed, which is the point: the numbers
now agree across bash and zsh, GNU grep and BSD grep, because neither check
depends on a shell any more. Before this commit the local run of one printed
`1 "use server" files` and the other printed nothing at all, and both exited 0.
