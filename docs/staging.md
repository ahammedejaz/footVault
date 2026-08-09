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
