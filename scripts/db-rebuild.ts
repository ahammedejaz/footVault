/**
 * Rebuild the staging database from nothing but this repository, and prove it.
 *
 *   npm run rebuild:stage
 *
 * One command: drop everything in staging, replay all of
 * `supabase/migrations/`, run `supabase/seed.sql`, then verify the result and
 * fail loudly on any drift. This is the disaster-recovery path being exercised
 * rather than believed in — if production ever has to be rebuilt from
 * migrations, this script is the evidence that the migration set can actually
 * do it. Batch 2 discovered it could not: three defects (`pg_cron` used before
 * it existed, a stale `cancel_order_with_restock` overload reappearing, the
 * seed clobbering `site_settings.shipping`) were invisible until somebody
 * replayed the set into an empty project for the first time. The Batch 3 brief
 * turned that replay into a required, repeatable command.
 *
 * ## Why the clean step is spelled out here
 *
 * `supabase db reset --db-url` looks like the one-liner for this and is not:
 * against a remote URL the CLI takes a legacy path that replays migrations
 * **without cleaning first** — tried on 2026-08-09 with CLI 2.113.0, it died
 * on `20260807120000_foundation.sql` with `relation "order_number_seq"
 * already exists`, eleven statements in. The non-legacy reset exists only for
 * `--linked` and `--local`, both of which need an authenticated CLI or a
 * local stack. So the clean is explicit, and every statement in it maps to
 * something the migrations create outside `drop schema public cascade`'s
 * reach: the `private` schema, the four policies on `storage.objects`, the
 * signup trigger on `auth.users` (dropped by the cascade through
 * `handle_new_user`, listed anyway so the dependency is visible), and the
 * migration history itself. Bucket rows in `storage.buckets` stay — their
 * migration upserts (`on conflict (id) do update`), so replay converges them.
 * Postgres' own defaults for a fresh schema differ from Supabase's, so the
 * grants and default privileges Supabase bootstraps onto `public` are
 * restored to match — without them PostgREST's roles cannot see the rebuilt
 * tables and every REST call 401s.
 *
 * ## Staging only, structurally
 *
 * The connection string is built *here*, from `STAGING_PROJECT_REF` and the
 * staging password in `.env.local`. There is no flag to point it anywhere else:
 * a script whose first act is `db reset --yes` does not get a URL parameter,
 * because the one mistake it could make is unrecoverable and the shop's order
 * records exist in exactly one place (docs/admin-guide.md §12). Rebuilding
 * production, if that day ever comes, is a deliberate act following that
 * document — not this script with a different URL.
 *
 * ## What "verified" means
 *
 * `db reset` succeeding proves the replay ran; the assertions prove it
 * produced the shop. Each one is a defect this repository has actually had:
 *
 *   - every local migration recorded remotely       (the set applied, all of it)
 *   - exactly one `cancel_order_with_restock`       (the overload defect, fixed)
 *   - all four cron jobs scheduled                  (the pg_cron ordering defect)
 *   - `shipping` row present with required keys     (the seed-clobber defect)
 *   - no key the migrations delete has come back    (`fallback_fee_paise` et al)
 *   - the parcel defaults complete, height included (Pay on Delivery can quote)
 *   - the catalog counts match the seed             (the seed actually ran)
 *
 * psql runs the SQL side. The 14.x client speaks to the 17.x server fine —
 * the version trap in docs/admin-guide.md §12 is specific to `pg_dump`.
 */
import { spawnSync } from "node:child_process";

import { products } from "./seed-data";
import {
  loadEnvLocal,
  requireStagingCredentials,
  isStagingUrl,
  STAGING_PROJECT_REF,
} from "./staging-env";

/**
 * The staging session pooler, port 5432 — the transaction pooler on 6543
 * cannot run migrations. Host per docs/staging.md §3b; override
 * `SUPABASE_STAGE_DB_HOST` if Supabase ever moves the project between
 * regional poolers.
 */
function stagingDbUrl(): string {
  const password = process.env.SUPABASE_STAGE_DB_PASSWORD ?? "";
  if (!password) {
    throw new Error(
      "SUPABASE_STAGE_DB_PASSWORD is not set in .env.local.\n" +
        "It is the staging project's database password (dashboard → Project " +
        "Settings → Database), needed to run migrations. See docs/staging.md.",
    );
  }
  const host =
    process.env.SUPABASE_STAGE_DB_HOST ?? "aws-0-ap-south-1.pooler.supabase.com";
  return (
    `postgresql://postgres.${STAGING_PROJECT_REF}:` +
    `${encodeURIComponent(password)}@${host}:5432/postgres`
  );
}

function run(command: string, args: string[], allowFail = false): string {
  console.log(`\n$ ${command} ${args.join(" ").replace(/:[^@]*@/, ":***@")}`);
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 32 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? "");
  if (result.status !== 0 && !allowFail) {
    throw new Error(`${command} exited ${result.status}`);
  }
  return result.stdout ?? "";
}

/** One value from one SQL statement, trimmed. */
function sql(dbUrl: string, statement: string): string {
  const result = spawnSync("psql", [dbUrl, "-X", "-A", "-t", "-c", statement], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`psql failed for: ${statement}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

type Check = { name: string; actual: string; pass: boolean };

/**
 * Everything the migrations have ever created, removed. Each statement's
 * reason is in the file header; the order matters only in that the schema
 * drop must come before the grants that recreate it.
 */
const CLEAN_SQL = `
begin;
-- The signup trigger rides on a public function; the cascade below would take
-- it anyway, but a rebuild script should say what it deletes.
drop trigger if exists on_auth_user_created on auth.users;
drop schema if exists public cascade;
drop schema if exists private cascade;
drop schema if exists supabase_migrations cascade;
drop policy if exists "storefront assets are publicly readable" on storage.objects;
drop policy if exists "admins upload storefront assets" on storage.objects;
drop policy if exists "admins replace storefront assets" on storage.objects;
drop policy if exists "admins delete storefront assets" on storage.objects;
create schema public;
comment on schema public is 'standard public schema';
-- Supabase's own bootstrap for a project's public schema, restored, because a
-- bare "create schema" grants none of it and PostgREST's roles go blind.
grant usage on schema public to postgres, anon, authenticated, service_role;
grant all on schema public to postgres, service_role;
alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;
commit;
`;

function main(): void {
  loadEnvLocal();

  // Fails by name if the staging credentials are absent or half-set, and the
  // ref is pinned — see the header for why there is no way to aim this
  // anywhere else.
  const credentials = requireStagingCredentials();
  if (!isStagingUrl(credentials.url)) {
    throw new Error(
      `SUPABASE_STAGE_URL (${credentials.url}) is not the staging project ` +
        `(${STAGING_PROJECT_REF}). Refusing to reset anything else.`,
    );
  }
  const dbUrl = stagingDbUrl();

  console.log(
    `Rebuilding staging (${STAGING_PROJECT_REF}) from empty:\n` +
      `  migrations, then supabase/seed.sql, then verification.`,
  );

  // The clean: see the header for why this is not `supabase db reset`.
  console.log("\nCleaning staging back to empty…");
  const cleaned = spawnSync(
    "psql",
    [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-c", CLEAN_SQL],
    { encoding: "utf8" },
  );
  if (cleaned.status !== 0) {
    throw new Error(`the clean step failed:\n${cleaned.stderr}`);
  }

  // Replays every migration into the now-empty database. `--include-all`
  // because the set contains backdated timestamps (see 20260809130000's
  // header); `--yes` because this script *is* the confirmation: it can only
  // ever aim at staging.
  run("npx", [
    "supabase",
    "db",
    "push",
    "--db-url",
    dbUrl,
    "--include-all",
    "--yes",
  ]);

  // The seed, exactly as `supabase db reset` would have run it.
  console.log("\nSeeding…");
  const seeded = spawnSync(
    "psql",
    [dbUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "supabase/seed.sql"],
    { encoding: "utf8" },
  );
  if (seeded.status !== 0) {
    throw new Error(`seeding failed:\n${seeded.stderr}`);
  }

  // The local-versus-remote table, for the record in the report.
  run("npx", ["supabase", "migration", "list", "--db-url", dbUrl], true);

  const localMigrations = run("bash", [
    "-c",
    "ls supabase/migrations/*.sql | wc -l",
  ]).trim();

  const checks: Check[] = [];
  const expect = (name: string, actual: string, expected: string) =>
    checks.push({ name, actual, pass: actual === expected });

  expect(
    `all ${localMigrations} migrations recorded`,
    sql(dbUrl, "select count(*) from supabase_migrations.schema_migrations"),
    localMigrations,
  );
  expect(
    "cancel_order_with_restock has exactly one form",
    sql(
      dbUrl,
      "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace " +
        "where n.nspname = 'public' and p.proname = 'cancel_order_with_restock'",
    ),
    "1",
  );
  expect(
    "all four cron jobs scheduled",
    sql(
      dbUrl,
      "select count(*) from cron.job where jobname in ('prune-rate-limits', " +
        "'prune-shipping-quotes', 'release-abandoned-orders', 'reconcile-abandoned-orders')",
    ),
    "4",
  );
  expect(
    "shipping settings row carries its required keys",
    sql(
      dbUrl,
      "select (value ? 'free_above_paise' and value ? 'prepaid_estimate_fee_paise')::text " +
        "from site_settings where key = 'shipping'",
    ),
    "true",
  );
  expect(
    "no deleted settings key has come back",
    sql(
      dbUrl,
      "select (value ?| array['fallback_fee_paise', 'cod_advance_mode', " +
        "'cod_advance_minimum_paise', 'cod_advance_fixed_paise'])::text " +
        "from site_settings where key = 'shipping'",
    ),
    "false",
  );
  expect(
    "the parcel is complete: 20 × 10 × 10 cm at 1000 g",
    sql(
      dbUrl,
      "select concat_ws('/', value ->> 'default_parcel_length_cm', " +
        "value ->> 'default_parcel_breadth_cm', value ->> 'default_parcel_height_cm', " +
        "value ->> 'default_parcel_weight_grams') " +
        "from site_settings where key = 'shipping_defaults'",
    ),
    "20/10/10/1000",
  );
  expect(
    `catalog seeded: ${products.length} products`,
    sql(dbUrl, "select count(*) from products"),
    String(products.length),
  );

  const variants = sql(dbUrl, "select count(*) from product_variants");
  checks.push({
    name: `variants seeded (${variants})`,
    actual: variants,
    pass: Number(variants) > 0,
  });

  console.log("\nVerification:");
  for (const check of checks) {
    console.log(`  ${check.pass ? "PASS" : "FAIL"}  ${check.name}` +
      (check.pass ? "" : `  (got: ${check.actual})`));
  }

  const failed = checks.filter((check) => !check.pass);
  if (failed.length > 0) {
    console.error(
      `\n${failed.length} check(s) failed. The migration set did not rebuild ` +
        `the shop — fix the defect before trusting these migrations as a backup.`,
    );
    process.exit(1);
  }
  console.log(
    "\nStaging rebuilt from empty: migrations, seed and every check green.",
  );
}

main();
