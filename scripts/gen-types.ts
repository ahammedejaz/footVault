/**
 * Regenerate `src/lib/database.types.ts` from **staging**, never production.
 *
 * The generated types have to move in the same commit as the migration that
 * changes the schema, and the only database that has that migration before the
 * owner applies it to production is staging. Generating from production would
 * silently produce the *old* shape and make a correct migration look like a type
 * error — or worse, type-check a column that does not exist yet.
 *
 * Same credentials and same pooler as `scripts/db-rebuild.ts`, resolved through
 * `scripts/staging-env.ts` so there is one place a project ref can be wrong.
 *
 *   npm run types:stage
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import { loadEnvLocal, STAGING_PROJECT_REF } from "./staging-env";

const OUT = "src/lib/database.types.ts";

/** What the checked-in file has carried since Phase 5. */
const POSTGREST_VERSION = "14.15";

function main(): void {
  loadEnvLocal();
  const password = process.env.SUPABASE_STAGE_DB_PASSWORD ?? "";
  if (!password) {
    throw new Error(
      "SUPABASE_STAGE_DB_PASSWORD is not set in .env.local. See docs/staging.md.",
    );
  }
  const host =
    process.env.SUPABASE_STAGE_DB_HOST ?? "aws-0-ap-south-1.pooler.supabase.com";
  const dbUrl =
    `postgresql://postgres.${STAGING_PROJECT_REF}:` +
    `${encodeURIComponent(password)}@${host}:5432/postgres`;

  const result = spawnSync(
    "npx",
    ["supabase", "gen", "types", "typescript", "--db-url", dbUrl],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`supabase gen types exited ${result.status}`);

  const types = result.stdout ?? "";
  // A short answer means the CLI printed a warning and no schema. Writing it
  // would delete every type in the repository and the failure would surface as
  // a thousand unrelated errors.
  if (types.length < 10_000 || !types.includes("export type Database")) {
    throw new Error(`refusing to write ${OUT}: the generated output looks wrong`);
  }
  writeFileSync(OUT, keepPostgrestVersion(types));
  console.log(`wrote ${OUT} from staging (${types.length} bytes)`);
}

main();

/**
 * Put `__InternalSupabase` back if the CLI dropped it.
 *
 * `supabase gen types --db-url` against the session pooler does not emit the
 * `PostgrestVersion` block that the dashboard-generated file carries, and
 * `createClient<Database>` reads it to pick its PostgREST behaviour. Losing it
 * is a silent client-typing change riding along with an unrelated migration,
 * which is exactly the kind of diff nobody reviews.
 */
function keepPostgrestVersion(types: string): string {
  // The declaration, not the name: `DatabaseWithoutInternals` further down the
  // file mentions `"__InternalSupabase"` in an `Omit`, so a bare substring test
  // matches a file that does not have the block and quietly does nothing.
  if (types.includes("__InternalSupabase: {")) return types;
  return types.replace(
    "export type Database = {\n",
    "export type Database = {\n" +
      "  // Allows to automatically instantiate createClient with right options\n" +
      "  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)\n" +
      "  __InternalSupabase: {\n" +
      `    PostgrestVersion: "${POSTGREST_VERSION}"\n` +
      "  }\n",
  );
}
