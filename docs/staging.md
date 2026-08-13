# Staging

The second Supabase project — **`pblgpvcdappfpoxdascd`** — and the only database
the QA harnesses are allowed to write to.

It exists because of a shape of failure rather than a preference. Every gate in
`scripts/audit/` that measures a populated screen has to _build_ that screen
first: sign up an account, fill a bag, place an order. `scripts/audit/clients.ts`
explains what that nearly cost — for the whole of Phase 8 the only database in
`.env.local` was the live shop, so a single `npm run audit` would have put QA
accounts and test orders next to real customers and reported a pass. The guard
in that file stops it. This project is the somewhere-else it has been telling
people to go, and until it existed the four browser gates below could not run at
all.

`docs/staging.md` is referenced by the guard's own error message. If you arrived
here from a stack trace, skip to [When the guard fires](#when-the-guard-fires).

---

## 1 · Pointing at staging

There are **two** processes and both have to move. Wiring one and not the other
is worse than running nothing: fixtures land in staging, the browser measures
production, and the gate passes.

| Process                           | What points it                     | Where                      |
| --------------------------------- | ---------------------------------- | -------------------------- |
| the harnesses (`scripts/audit/*`) | `SUPABASE_STAGE_*` in `.env.local` | `scripts/audit/clients.ts` |
| the dev server the browser drives | `npm run dev:stage`                | `scripts/stage.ts`         |

Both resolve staging through `scripts/staging-env.ts`, in one place, because two
resolutions that could disagree is the failure above with extra steps.

### The credentials

Four names, in `.env.local` — **not** in a `.env.staging` file. Nothing reads
that, and Next ranks `.env.local` above every `.env.<mode>` anyway, so it would
lose to the production values it is meant to replace.

```
SUPABASE_STAGE_URL=https://pblgpvcdappfpoxdascd.supabase.co
SUPABASE_STAGE_ANON_KEY=…
SUPABASE_STAGE_SERVICE_ROLE_KEY=…
SUPABASE_STAGE_DB_PASSWORD=…        # psql and `supabase db push` only
```

Set all three of the first three or none of them. Set some and every harness
stops on import with the name of the one that is missing — a URL from one
project and a key from another surfaces as a 401 several files from the mistake,
and "missing env" is not a better message than the variable's name.

With them set, `scripts/audit/clients.ts` also writes them back into
`process.env` under `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
and `SUPABASE_SERVICE_ROLE_KEY`. That is not tidiness: several harnesses parse
`.env.local` themselves and then read those three names directly, and without
the write-back a run that imported `adminClient()` _and_ read
`process.env.NEXT_PUBLIC_SUPABASE_URL` would talk to two databases at once.

### Email signup is OFF in both projects (it used to differ)

Production's only door is Google (`external.email = false`, closed by the owner
on 2026-08-11 — Phase 11 finding 11D.1: with email+autoconfirm on, anyone
holding the public anon key could mint confirmed accounts against addresses
they do not own, which makes every per-account loyalty grant free to farm).

**Staging used to keep the email provider ON, deliberately**, because
`scripts/audit/fixtures.ts` signed its QA accounts up with email and password
and every browser gate built on those fixtures. That divergence is gone, and
its removal is worth reading as a lesson rather than a cleanup.

When staging's signup was correctly turned off, eight harnesses died at once
with "Email signups are disabled" — six of them live gates in `run-all`
(`audit:auth`, `audit:cart`, `audit:signedin`, `audit:checkout`, `audit:admin`,
`audit:security-advance`) plus the two security gates. And `audit:signup-closed`
*failed on the staging half*, meaning the suite contained a gate asserting that
a security control must stay disabled. A test that pins a door open because the
harness walks through it will go dark every time somebody does the right thing,
and it makes the right thing look like a regression.

So the harnesses stopped using the door. `scripts/audit/accounts.ts` mints
accounts through the service-role admin API — `auth.admin.createUser`, then
`auth.admin.generateLink`, then `verifyOtp` for a genuine session — which works
with signup **and** email login disabled. Staging is now closed to match
production, and `npm run audit:signup-closed` asserts the same thing about both.

If production's door reopens, or staging's does, the gate names which.

### Checking which database you are about to measure

```
npm run audit:fixtures-guard
```

The last block of its output names the resolved target. `SAFE
(https://pblgpvcdappfpoxdascd.supabase.co)` is what you want to see before
anything writes.

---

## 2 · The dev server

```
npm run dev:stage          # next dev on :3210, pointed at staging
PORT=3000 npm run dev:stage
```

**Port 3210, not 3000.** Every harness in `scripts/audit/` defaults to
`http://localhost:3210` (`BASE_URL` in `routes.ts`, overridable with
`AUDIT_BASE_URL`), so a server on 3210 makes `npm run audit:overflow` and the
rest work with no extra environment — and makes it impossible to accidentally
measure whatever else is on 3000.

The staging project's own Site URL is `http://localhost:3000`. That matters only
for the Google sign-in redirect; nothing in the gates uses it, because
`fixtures.ts` signs up with email and password. If you want to click through
Google against staging, run on 3000 and pass `AUDIT_BASE_URL` to anything you
run alongside it.

`scripts/stage.ts` will run anything, not just the dev server:

```
npm run seed:stage
npm run stage -- npx tsx scripts/audit/teardown.ts --dry-run
```

It works because Next resolves the real environment before `.env.local`:
`@next/env`'s `processEnv` only assigns a key it does not already find set. A
variable exported into the child process therefore wins. That is the whole
mechanism — there is no `.env` file involved, on purpose.

**Verify rather than assume.** The cheap end-to-end proof is a round trip
through the database the page is supposed to be reading:

```sql
update site_settings set value = jsonb_set(value, '{text}', to_jsonb('PROOF'::text))
where key = 'announcement';
```

then `curl -s http://localhost:3210/ | grep -c PROOF` against the staging
connection, and put it back afterwards. Grepping the served JavaScript for the
project ref does **not** work — the browser client is in a lazily-loaded chunk
and neither ref appears in the first-load bundle.

---

## 3 · Building a staging project from scratch

The direct database host (`db.<ref>.supabase.co`) is **IPv6-only**. On a machine
with no IPv6 route it does not resolve at all, which reads as a dead project
rather than as a dead route. Use the session-mode pooler:

```
host=aws-0-ap-south-1.pooler.supabase.com  port=5432
user=postgres.pblgpvcdappfpoxdascd         dbname=postgres  sslmode=require
```

Wrong region, and the pooler answers `FATAL: (ENOTFOUND) tenant/user
postgres.<ref> not found` — that message means the host, not the password.

### The command

```
npm run rebuild:stage
```

One command, from empty to a working shop: cleans the staging database back to
nothing, replays every file in `supabase/migrations/`, runs
`supabase/seed.sql`, and then **verifies** — every migration recorded, exactly
one `cancel_order_with_restock`, all four cron jobs scheduled, the `shipping`
row present with its required keys and none of the deleted ones, the parcel
complete, the catalog counted. It exits non-zero on any drift. The script is
`scripts/db-rebuild.ts` and its header explains every statement in the clean
step.

It is pinned to the staging project by construction — there is no flag to aim
it anywhere else, deliberately. It needs `SUPABASE_STAGE_DB_PASSWORD` in
`.env.local` alongside the three staging keys, and `psql` on the PATH (any
version; the 17-or-newer trap in docs/admin-guide.md §12 is specific to
`pg_dump`).

This section used to be four subsections of workarounds — enable `pg_cron` by
hand first, push, seed, then re-apply a migration to repair what the seed broke.
Batch 3 fixed the defects those steps routed around (see §6), and the replay it
proved is run by the command above. If `rebuild:stage` fails, that is a defect
in the migration set or the seed, not a prompt to reach for the old choreography:
fix the file that broke, and re-run until it is green. A migration set that
cannot rebuild the schema is not a backup.

Two facts from the old procedure worth keeping:

- `--db-url` rather than `supabase link`, because linking writes a
  `supabase/config.toml` and needs the CLI logged into the owning account, and
  neither is needed to apply SQL.
- Verification is a count query, not the absence of an error. SQL sent through
  the Supabase MCP tool over roughly 5 KB fails **silently** — the call
  returns, nothing is applied. That is why the script uses the CLI and psql.

---

## 4 · Running the gates

With `npm run dev:stage` up on :3210:

```
npm run audit:overflow      # six widths, routes + populated states
npm run audit:a11y          # axe, WCAG 2.2 A/AA, 390 and 1440
npm run audit:shots         # screenshots at the same six widths
npm run audit:lighthouse    # mobile, devtools throttling
```

The six widths are `AUDIT_WIDTHS` in `scripts/audit/routes.ts` — 360, 390, 768,
1024, 1440, 1920 — and every width-walking harness reads that one list so they
cannot drift apart. `overflow.ts` prefixes each finding with its width;
`screenshots.ts` accepts `WIDTHS=` and `ROUTES=` to narrow a re-run.

Two things about Lighthouse, both recorded because both have wasted a day:

- It is run with `--throttling-method=devtools`, never `simulate`. Simulated
  throttling models a slow network on top of an observed trace, and on localhost
  the trace has no latency to model from; it has reported ~4 s LCP here against
  a 1.6 s reality. `scripts/audit/lighthouse.ts` hardcodes the devtools flag.
- A localhost run is a **baseline, not the gate**, and a run against `next dev`
  is not even that: development bundles are unminified and React is in its
  development build. The gate is the Vercel preview. For a meaningful local
  number, build first — `npm run stage -- npx next build` then `npm run stage --
npx next start -p 3210`.

Afterwards:

```
npm run audit:teardown -- --dry-run
npm run audit:teardown
```

which sweeps staging, because staging is now the default target.

---

## 4.4 · The deploy gate: a production build, against production data

Everything in §4 drives `next dev` against staging, and the 2026-08-10 incident
lived in exactly the gap that leaves. A production build bakes route
classification into its manifest, and what it bakes depends on what the
database returned during that one build: a Supabase 522 during a Vercel build
emptied `generateStaticParams` for `/product/[slug]`, the route shipped as SSG
with zero pages rendered, and every product page 500ed with
`DYNAMIC_SERVER_USAGE` — from a build that passed. No dev-driven gate can fail
that way.

So, before anything is merged to main (which is to say, before anything
deploys):

```
npm run audit:build-smoke
```

It runs four proofs: the outage drill (`STATIC_PARAMS_SIMULATE_OUTAGE=all` must
*fail* the build — see `src/lib/static-params.ts`), a real production build
against live data, a manifest assertion that no slug route is SSG with zero
prerendered paths, and a served smoke — one real URL per slug-route family read
from the artifact's own sitemap, fetched as a document and as an RSC request.

The half it cannot see — a network failure during the build on Vercel's own
machines — is covered by `staticParamsOr` itself, which since the incident
retries and then fails the build rather than shipping the landmine. CI is the
one deliberate exception (`STATIC_PARAMS_ALLOW_EMPTY=1` in ci.yml): its
placeholder credentials make every collection fail by design, and its artifact
never serves a request.

### The deploy sequence, explicitly

`audit:build-smoke` is named in `run-all.ts`'s `EXCLUDED` — it is the deploy
gate, not a suite member, and excluded must not come to mean forgotten. The
trigger is different: the suite runs *before a merge is considered*; this runs
*before the merge happens*, because merging to main is deploying. In order:

1. `npm run audit` — the full suite, green, against staging.
2. `npm run audit:actions` — the forged Server Action gate. It needs a built
   artifact rather than the suite's dev server, so it runs here:

   ```
   npm run build:stage
   npm run start:stage        # :3210, serving the build, pointed at staging
   npm run audit:actions      # in another shell
   ```

   It posts a forged `Next-Action` payload at all 60 admin actions as a
   customer, as an anonymous caller, and through the forward path, and it
   opens with a **positive control** — a real admin eliciting `ok:true`. Read
   that control first. If it is red, every refusal underneath it means "the
   request never reached the action" rather than "the guard held", and the run
   proves nothing. That is exactly what happens against `dev:stage`, which is
   why this step builds first.

   Read section 6 second. It names which layer refused, and under the shipped
   configuration the answer is `route-hidden 120, guard-refused 0` — the proxy
   404s `/admin/*` before the POST reaches `adminAction`. **This gate therefore
   does not exercise `adminAction` on its own**, which was found by deleting
   that guard, rebuilding, and watching the gate report 127 passed. Nothing is
   wrong with the shop — no admin action is registered on a route a non-admin
   can load (0 of 60) — but the coverage claim has to be honest.

#### Re-proving the second layer, deliberately

`adminAction` is proved by temporarily removing the proxy's route hiding, so
the forged POSTs actually arrive. Do this on staging only, and revert both
edits before committing anything:

1. In `src/lib/supabase/proxy.ts`, make the `ADMIN_PREFIX` branch fall through
   instead of returning `notFound(...)`.
2. `npm run build:stage && npm run start:stage`, then `npm run audit:actions`.
   Expect **0 holes** and section 6 reading `guard-refused 120` — the requests
   now reach `adminAction` and it refuses them.
3. To confirm the gate can fail, also delete the `if (!actor)` early return in
   `src/lib/admin/guard.ts`, rebuild, and re-run. Expect **122 holes**, each
   showing `"reason":"invalid"` — a customer reaching the Zod line, which is
   only reachable past `is_admin()`.
4. `git checkout src/lib/supabase/proxy.ts src/lib/admin/guard.ts`, rebuild,
   and confirm the gate is green again.

Measured 2026-08-13: 122 holes with the guard removed, 0 with it restored.
3. `npm run audit:build-smoke` — the outage drill, a real production build
   against live data, the manifest assertion, the served smoke. Green.
4. Merge to main. Vercel deploys.
5. Verify the deploy is *serving*, not merely READY — fetch an identifier that
   exists only in the new tree, against `www`, not the apex
   (docs/admin-guide.md has the procedure).

On a failed smoke check after a deploy: **revert immediately, never
forward-fix.** Two failed deploys in a row means stop deploying and leave it
for a human.

---

## 4.5 · The guard only covers the files that ask it

`clients.ts` refuses production and repoints the process at staging — **for the
harnesses that import it.** Three did not, and were building carts, orders,
payments and stock movements in the live shop on every `npm run audit`:
`checkout-orders.ts`, `cart-merge.ts` and `zero-stock.ts`. Each read `.env.local`
itself and built a service-role client from `NEXT_PUBLIC_SUPABASE_URL`. Found in
Phase 9, when a freshly-written migration was missing from the database a run
was really talking to.

The rule now has a mechanism rather than a convention. `audit:fixtures-guard`
reads the directory and fails if any file in `scripts/audit/` names a raw
Supabase credential *and* can write (`.insert`, `.update`, `.upsert`, `.delete`,
`.rpc`) without importing `./clients`.

Two harnesses are exempt, and they are **named on every run** rather than
silently skipped:

| File | Why |
|---|---|
| `literals.ts` | it checks the **shop's own** owner-edited copy for currency literals; against a seeded staging database that is an assertion about fixtures |
| `payment-health.ts` | it runs the dashboard's query against real rows |

Both are read-only and neither can write. If either ever gains a write, the
check fails and the exemption has to be argued again — which is the point.

---

## 4.6 · A gate that passes for the wrong reason

The guard above answers "is this harness pointed somewhere safe". This section
is about the other half: **is this assertion measuring the thing it names.**

Three gates were found asserting refusals in a shape that cannot fail for the
right reason. The rule and the tools live in `scripts/audit/refusal.ts`; this is
how to use them and, more importantly, how to check a conversion is real.

### The three shapes, and why each is green with the control removed

```ts
check("X refuses a customer", error !== null);               // 1
check("Y is not readable",    (data?.length ?? 0) === 0);    // 2
check("Z did not change",     error === null && rows === 0); // 3
```

**Shape 1 — any error will do.** A refused write here comes back as one of five
things and the boolean flattens all of them:

| what actually refused | code | message |
|---|---|---|
| no `GRANT` on the table | `42501` | `permission denied for table X` |
| no `GRANT EXECUTE` | `42501` | `permission denied for function X` |
| an RLS policy | `42501` | `new row violates row-level security policy for "X"` |
| the function's own `is_admin()` | `FVADM` | `not_admin` |
| a `CHECK`/`UNIQUE`/FK constraint | `23xxx` | *refuses anybody — proves nothing about the caller* |
| **nothing** | `PGRST202` | `Could not find the function … in the schema cache` |

Three share a SQLSTATE and are told apart only by the message. The last is not a
refusal at all — and it is what happened: a migration added a parameter to
`create_order_with_stock`, the gate's fixed-arity POST started answering
`PGRST202`, and `error !== null` counted that as a pass for two days while the
new 26-argument function sat executable by `anon`. A new arity is a new function
and inherits no ACL.

**Shapes 2 and 3 — nothing was there to begin with.** A read RLS filtered and a
read of an empty table are byte-identical: `rows=0, error=null`. No predicate
fixes that; only a precondition does. Five of the eight tables `audit:admin`
checked were empty in staging, so five of its ticks were `0 === 0` — proved by
disabling RLS on `coupons` and watching the gate report 8 held.

### What to write instead

```ts
g.verdict("adjust_variant_stock refuses a non-admin",
  refusedBy(error, "app-check"));                      // names the layer

g.verdict("coupons is not readable by a customer",
  await unreadableBy({ admin, caller, table: "coupons",
    expect: ["rls-read"], witness: witnessCoupon }));   // requires a row to exist

g.verdict("a customer cannot rewrite what they owe",
  await unchangedBy({ attempt, readBack, baseline }));  // compares to a known-good
```

`footvault/no-vacuous-refusal-assertion` fails the build on shape 1 inside
`scripts/audit/`, so the fourth instance is a lint error rather than a
discovery.

### Three outcomes, not two

`gate()` counts **held / holes / unprovable**. `unprovable` is a check that could
not be made to mean anything — an empty table with no witness, a row that does
not exist. It prints in its own colour and **fails the run**. It is not a hole in
the shop and it is not a pass, and folding it into either loses the only
information that matters about it.

When a check reports unprovable, the fix is to make it provable — give
`unreadableBy` a `witness` that plants a row with the service role for the
duration of the read — not to accept the amber.

### Proving a conversion, which is the part that matters

A converted assertion is worth nothing until it has been watched failing **for
the specific control it names**. Disable that control against staging, run the
gate, confirm red, restore. Every conversion in this repository was proved this
way. A representative set:

| Control disabled | Gate | What it printed |
|---|---|---|
| `alter table coupons disable row level security` | `audit:admin` | HOLE — the planted witness row is readable by a plain customer |
| `grant select on rate_limits to authenticated` | `audit:admin` | HOLE — refusal came from RLS, but this check claims table grant |
| `grant execute on consume_rate_limit` | `audit:admin` | HOLE — NOT REFUSED, the call succeeded |
| rename `adjust_variant_stock` (the PGRST202 landmine) | `audit:admin` | HOLE — the probe never reached a control, so nothing was proved |
| `grant insert on inventory_movements` | `audit:admin` | HOLE — refused by RLS policy where the check claims table grant |
| permissive INSERT policy on `order_status_history` | `audit:admin` | HOLE — NOT REFUSED |
| `grant select, insert on shipping_quotes` | `audit:security-advance` | HOLE + UNPROVABLE (empty table, before its witness existed) |
| permissive UPDATE policy on `site_settings` | `audit:security-advance` | HOLE — showed the before → after diff |
| permissive SELECT+UPDATE on `orders` | `audit:security-advance` | 4 HOLEs across the six money fields |
| `grant insert on coin_transactions` | `audit:coins-earning` | HOLE — the label's exact claim, "no grant, not merely no policy" |
| remove `limitInputPixels` from the pipeline | `audit:image-upload` | HOLE — the pixel limit is not in force |

**Two of those proofs write to staging.** A permissive policy means the forbidden
write *lands*: the `site_settings` proof replaced the whole `shipping` JSONB and
left the dev server unable to quote delivery, and the
`order_status_history` proof left a forged "delivered" line on a real staging
order. Restore the data as well as the DDL — the gate's own before/after detail
is what tells you the original value. Afterwards, check:

```sql
select polname from pg_policy where polname like 'fv_proof%';   -- expect 0 rows
select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
```

---

## 4.7 · Do not edit config while the suite's dev server is running

**Cost, measured on 2026-08-13: one whole suite run, plus ledger artefacts that
took a separate investigation to clear.**

Mid-run, the staging dev server died outright:

```
thread 'tokio-rt-worker' panicked at
  turbopack/crates/turbo-tasks-backend/src/backend/operation/mod.rs:292:17:
Restore of All for task TaskId 510340 failed in another thread: restoring failed

turbo-tasks: an internal panic occurred outside the per-task panic boundary.
This is a bug in turbo-tasks/Turbopack

Aborting.
```

Turbopack's **persistent incremental cache** corrupted itself and took the
process with it. What preceded it was `next.config.ts` and one of its imports
being edited repeatedly while that server was live — every such edit forces a
config reload and a hot restart, and this panic is in the cache's restore path.
That is a plausible trigger rather than a proven one; the rule below is cheap
enough that it is not worth proving.

**The rule: while a gate run is in flight, do not touch `next.config.ts`, its
imports, or anything else that reloads the server. Stop the server, edit, clear
`.next`, restart.** Docs and gate scripts are safe — the dev server does not
watch them.

### How it reads when it happens, which is the expensive part

Nothing announces "the server is gone". It looks like the shop is broken:

```
━━ audit:overflow
Error: /shop: no visible <h1> after 15s — is the page rendering?

━━ audit:hero-media
TypeError: fetch failed
  Error: connect ECONNREFUSED 127.0.0.1:3210
```

The first gate to notice reports a **rendering** failure, because at that point
the server is degraded rather than dead. Only later gates get the honest
`ECONNREFUSED`. An hour can go into "why does `/shop` not render" before anyone
scrolls far enough to find the panic in the server's own log — which is a
different file from the suite log, and is the one place the real cause appears.

**When a browser gate fails on "the page is not rendering", read the dev
server's log before reading the component.**

### Recovery, in order

1. `rm -rf .next` — the cache is the thing that is corrupt, and a restart alone
   restores it from the same bad state.
2. Restart the server, then confirm the route the gate complained about actually
   serves: `curl -s localhost:3210/shop | grep -c '<h1'`.
3. **Re-run the whole suite, not the failed tail.** Gate results from either side
   of the crash are not comparable — the ones before ran against a healthy
   server, the ones after against nothing.
4. **Check the ledger.** This is the part that is easy to skip and the reason it
   is written down.

### The crash leaves inventory artefacts behind

A run that dies mid-flight leaves orders half-finished. `run-all` opens the next
run with `teardown.ts`, which **restocks, then deletes** — and restocking an
order the cancellation path had already restocked writes a second `+1`. Those
extra rows carry `reason = 'unspecified'` and an empty note, because a bare stock
write never sets `app.inventory_reason`:

```
15:36:41Z  delta=+1  reason=unspecified  note=''
15:33:00Z  delta=+1  reason=unspecified  note=''
```

`audit:transitions` then fails on drift that nothing in the shop caused.

Note that **`teardown.ts --stock-only` will report clean** and is not the tool
for this: it compares the shelf against the *seed baseline*, accounting for units
held by live orders. `reconcile_inventory()` compares the shelf against the
*ledger sum*. Two different invariants; a crash breaks the second one only.

To find and clear it:

```sql
-- the drift, and whether unspecified rows explain it
select * from public.reconcile_inventory();

-- the artefacts themselves: no reason, no note, timestamped in the crash window
select id, created_at, delta, reason, note
  from public.inventory_movements
 where variant_id = '<the drifting variant>' and reason = 'unspecified';
```

Remove only rows with **no note** — every legitimate movement carries one. Then
re-run `audit:transitions` and confirm `reconcile_inventory()` reports zero
drift before trusting any later gate.

---

## 5 · When the guard fires

`assertNotProduction()` in `scripts/audit/clients.ts` throws at module scope in
`fixtures.ts`, so it fires on import and there is no entry point that can reach a
fixture builder without passing it. It accepts exactly three answers: the staging
project, a local stack on `127.0.0.1`, and nothing else.

**"Refusing to … against the production database."** `.env.local` is pointed at
`ahumjhwqgmskjsitctcj` and the staging variables are unset. Set them (§1). Do not
edit the guard: the failure it prevents is silent, irreversible, and one `cp`
away.

**"Refusing to …: this is not the staging project."** The resolved URL is neither
staging nor local. The message names the variable the value came from. Either
`SUPABASE_STAGE_URL` points at a third project, or `AUDIT_TARGET=env-local` is
set in your shell. This branch is newer than the production branch and it is the
more useful of the two: a check that only knows one forbidden project passes for
every other database in the world, including the next production project this
shop ever has.

**"Staging is half-configured in `.env.local`."** Exactly what it says, with the
missing variable named. Fill it in, or remove the others to fall back.

### The one escape hatch

```
AUDIT_TARGET=env-local npx tsx scripts/audit/teardown.ts --dry-run
```

`teardown.ts` is the single tool that is legitimately useful pointed at the live
shop — it only ever deletes, and only rows whose email carries a QA prefix. It is
how you clean up if the guard arrived a day too late. With staging configured it
would otherwise sweep staging and cheerfully report that production was clean,
so `AUDIT_TARGET=env-local` tells the client factories to take `.env.local` at
its word.

It is not a switch on the guard. Nothing it does lets a fixture builder reach
production: `fixtures.ts` still calls `assertNotProduction()` on import and still
throws. Any other value of `AUDIT_TARGET` is rejected by name rather than
ignored.

---

## 6 · What building this project found, 2026-08-09

None of these are staging defects. They are things that were only ever going to
be found by replaying the repository from empty, which is what a staging project
is for and what nobody had done before. **All were fixed in Batch 3
(2026-08-09)**, and `npm run rebuild:stage` now proves the fixes on every run;
the history stays here because the *shape* of each failure is the thing to
recognise next time.

**The migration set did not replay from an empty project.** Three ordering
defects, invisible on a database that grew a migration at a time:

1. `20260807224044_rate_limits_cleanup_job.sql` called `cron.schedule(...)`
   twelve hours of ordering before anything created `pg_cron`. Batch 2 routed
   around it by enabling the extension by hand; Batch 3 edited the migration to
   state its own prerequisite — `create extension if not exists pg_cron` — which
   is inert on any database that already ran it.
2. `cancel_order_with_restock` ended up with **two overloads** on replay.
   `20260807223318` (backdated into the sequence) drops the five-argument form
   and creates the six-argument one; replayed in timestamp order the drop is a
   no-op and `20260808090600` then recreates the five-argument form beside it.
   PostgREST could not choose between them — `teardown.ts` reported `Could not
   choose the best candidate function` on every order. Production applied the
   files in written order and has exactly one form; staging had both. Fixed by
   `20260809130000_drop_stale_cancel_order_overload.sql` at the end of the
   sequence, which repairs both kinds of database.
3. `20260807141500_revoke_event_trigger_execute.sql` revoked execute on
   `public.rls_auto_enable()` — a function **no migration created**. It and its
   `ensure_rls` event trigger were made by hand in the SQL editor before Phase
   5, so the revoke held everywhere except a replay from empty, which died at
   migration 21. Found by the first `rebuild:stage` run, the only defect of the
   four Batch 2's build did not surface. Fixed by editing that migration to
   create exactly what production carries — the definition read back via
   `pg_get_functiondef`, not reconstructed.

**The seed and the migrations disagreed about `site_settings.shipping`.** The
seed carried the pre-Phase-8 shape — the ₹2,499 threshold from two phases ago
plus the exact keys `20260809110100` deletes — so reseeding a migrated database
un-migrated its settings. The row now belongs to the migrations alone
(`20260809140000_shipping_settings_row_exists.sql`, the owner's confirmed
numbers) and the seed no longer contains a `shipping` entry at all.

**`cod_minimum_order_value_paise` is set by no migration at all.** Still true,
and intended now: the reader treats it as optional with zero meaning "no
minimum" (see the field's comment in `src/lib/shipping/settings.ts`), and an
unset field renders as an empty box at /admin/settings for the owner to fill.
The invented `0` staging carried was removed with the seed's `shipping` entry.

**`shipping_defaults.default_parcel_height_cm`** was null by instruction until
the owner gave the number. They did, in the Batch 3 brief: **10 cm**, written by
`20260809150000_parcel_box_height.sql`, so a rebuilt database ships the owner's
20 × 10 × 10 cm, 1000 g box and Pay on Delivery can quote.
