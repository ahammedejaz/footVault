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

### a. Enable two extensions first

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
```

**This is not optional and it is not what the migrations say.**
`20260807224044_rate_limits_cleanup_job.sql` calls `cron.schedule(...)`, and the
`create extension if not exists pg_cron` that would make that legal does not
appear until `20260808100100`, twelve hours later in the ordering. Production
has never noticed because pg_cron was enabled there from the dashboard before
any of this ran. A replay from empty stops dead at migration 33 with `ERROR:
schema "cron" does not exist`.

### b. Push the migrations

```
supabase db push --db-url "postgresql://postgres.<ref>:<url-encoded-password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres" --include-all
```

`--db-url` rather than `supabase link`: linking writes a `supabase/config.toml`
and needs the CLI logged into the account that owns the project, and neither is
needed to apply SQL.

### c. Seed, then re-apply the settings migrations

```
npm run seed:stage
```

**In that order, and then repair the row.** `npm run seed` upserts
`site_settings` from `scripts/seed-data.ts`, which still holds the pre-Phase-8
shape of the `shipping` key — so seeding _after_ migrating throws away every
field the later migrations added, and the storefront then answers 500 on every
page with `ShippingSettingsUnavailableError`. Re-run the transformations, which
are idempotent:

```
psql "<connection>" -f supabase/migrations/20260809110100_shipping_rate_mode_and_cod_controls.sql
```

Seeding _before_ migrating avoids the problem, at the cost of migrating a
populated database.

### d. Check it landed

```sql
select count(*) from information_schema.tables
 where table_schema = 'public' and table_type = 'BASE TABLE';   -- 30
select count(*) from supabase_migrations.schema_migrations;     -- one per file
select count(*) from products;                                  -- 35
select count(*) from product_variants;                          -- 403
```

A count query, not the absence of an error. SQL sent through the Supabase MCP
tool over roughly 5 KB fails **silently** — the call returns, nothing is
applied. That is why the CLI and psql are the recommendation here and the MCP
tool is not.

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
is for and what nobody had done before.

**The migration set does not replay from an empty project.** Two ordering
defects, both invisible on a database that grew a migration at a time:

1. `20260807224044_rate_limits_cleanup_job.sql` calls `cron.schedule(...)`
   twelve hours of ordering before anything creates `pg_cron`. Fixed here by
   enabling the extension first — see §3a — not by editing the migration.
2. `cancel_order_with_restock` ends up with **two overloads**.
   `20260807223318_cancel_order_writes_movements.sql` drops the five-argument
   form and creates a six-argument one; on a fresh replay that drop is a no-op
   because the five-argument form does not exist yet, and
   `20260808090600_cancel_order_with_restock.sql` then creates it. PostgREST
   cannot choose between them, so `teardown.ts` reports `Could not choose the
best candidate function` on every order and restocks nothing through the RPC.
   Its seed reconciliation still puts the units back, which is why the run ends
   `Restored 2 of 2` and looks fine. **Any database that applied these in
   timestamp order has both**, so this is worth checking on production rather
   than assuming it is ours.

**The seed and the migrations disagree about `site_settings.shipping`.** See
§3c. Until `scripts/seed-data.ts` catches up, seeding after migrating needs the
repair step, and the symptom is a 500 on every page rather than a warning.

**`cod_minimum_order_value_paise` is set by no migration at all.**
`src/lib/shipping/settings.ts` requires it and every page that reads shipping
settings throws `ShippingSettingsUnavailableError` without it — on any database.
Staging carries `0`, meaning no minimum, which is the behaviour that existed
before the field did. It is invented data and should be replaced by whatever
migration eventually writes it.

**`shipping_defaults.default_parcel_height_cm` is null and staying that way**
until the owner gives the number — `20260809110000_parcel_defaults.sql` explains
why guessing it is worse. Two consequences to expect while it is unset, both
intended: `npm run audit:parcel` fails on that one check by design, and Pay on
Delivery is refused shop-wide with delivery priced from
`prepaid_estimate_fee_paise` and labelled an estimate. Neither is a regression
and neither should be "fixed" by typing a height.
