/**
 * `npm run push:stage` — apply pending migrations to staging, and nothing else.
 *
 *   npm run push:stage -- --list     # what is pending, without applying it
 *   npm run push:stage               # apply it
 *
 * ## Why this exists next to `rebuild:stage`
 *
 * `rebuild:stage` is the from-empty replay: it proves the whole migration set
 * still builds a shop, and it is the right tool before a production push. It is
 * the wrong tool for "I wrote one migration and want it on staging", because it
 * drops the database first — so a gate run that was mid-session loses its
 * fixtures, and a five-line `alter table` costs a full reseed.
 *
 * This is the same `supabase db push --db-url` that `rebuild:stage` runs, with
 * the same staging-only targeting and none of the destruction. Pending
 * migrations are applied in order; anything already recorded is skipped.
 *
 * ## Pinned to staging by construction
 *
 * There is no flag to aim it anywhere else, and that is deliberate — the same
 * decision `db-rebuild.ts` documents at greater length. Production migrations
 * are the owner's to run, from the procedure in docs/staging.md, after a
 * content-verified dump. A script that could do either with one changed
 * argument is a script that eventually does the wrong one at midnight.
 *
 * The password is read from `.env.local` and URL-encoded before it goes into
 * the connection string: a `#` or `?` in it silently truncates the URL and the
 * failure that follows names the host, not the password.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Staging, and only staging. See docs/staging.md §3b. */
const STAGING_PROJECT_REF = "pblgpvcdappfpoxdascd";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

const password = process.env.SUPABASE_STAGE_DB_PASSWORD ?? "";
if (!password) {
  console.error(
    "\nSUPABASE_STAGE_DB_PASSWORD is not set in .env.local.\n" +
      "It is the staging project's database password (dashboard → Project " +
      "Settings → Database). See docs/staging.md.\n",
  );
  process.exit(1);
}

const host =
  process.env.SUPABASE_STAGE_DB_HOST ?? "aws-0-ap-south-1.pooler.supabase.com";
const dbUrl =
  `postgresql://postgres.${STAGING_PROJECT_REF}:` +
  `${encodeURIComponent(password)}@${host}:5432/postgres`;

const listOnly = process.argv.includes("--list");
const args = listOnly
  ? ["supabase", "migration", "list", "--db-url", dbUrl]
  : ["supabase", "db", "push", "--db-url", dbUrl, "--yes"];

console.log(
  `\n\x1b[1m${listOnly ? "Listing" : "Applying"} migrations — STAGING (${STAGING_PROJECT_REF})\x1b[0m\n`,
);

const result = spawnSync("npx", args, { stdio: "inherit", encoding: "utf8" });
process.exit(result.status ?? 1);
