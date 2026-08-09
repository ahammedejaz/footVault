/**
 * Where staging is, and how anything in this repository finds it.
 *
 * The staging project exists because of the near miss recorded in the header of
 * `scripts/audit/clients.ts`: the fixture-building harnesses create accounts,
 * carts and real orders, and for the whole of Phase 8 the only database they
 * could reach was the live shop. The guard there stops them. This is the other
 * half — the somewhere-else for them to run.
 *
 * Its credentials live in `.env.local` under their own names rather than in a
 * `.env.staging` file, because a second env file is a second thing that can be
 * copied over the first one. `SUPABASE_STAGE_URL` cannot be mistaken for
 * `NEXT_PUBLIC_SUPABASE_URL` by a `cp`.
 *
 * Two callers, and they must not disagree:
 *
 *   - `scripts/audit/clients.ts` — every harness's Supabase client
 *   - `scripts/stage.ts`         — the dev server the browser gates drive
 *
 * If those two ever resolved staging differently the result is the worst
 * failure available here: fixtures written to one database and a browser
 * looking at another, reported as a pass. So the resolution lives in one file
 * and both import it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The staging Supabase project. Hardcoded, for the same reason
 * `PRODUCTION_PROJECT_REF` is.
 *
 * A guard that can only say "this is not production" passes for every database
 * in the world except one. Naming staging too lets it say the useful thing
 * instead: *this is the project the fixtures are allowed to write to*. Point
 * the staging variables somewhere else and the guard says so by name rather
 * than shrugging.
 *
 * A project ref rather than a URL so the REST host, the pooler host and a
 * direct connection string all match the same check.
 */
export const STAGING_PROJECT_REF = "pblgpvcdappfpoxdascd";

/** What the staging credentials are called in `.env.local`. */
export const STAGING_VARS = {
  url: "SUPABASE_STAGE_URL",
  anonKey: "SUPABASE_STAGE_ANON_KEY",
  serviceKey: "SUPABASE_STAGE_SERVICE_ROLE_KEY",
} as const;

/**
 * What the app and the harnesses actually read.
 *
 * `next dev`, `src/lib/env.ts`, `scripts/seed.ts` and half of `scripts/audit/`
 * all read these three names and nothing else. Pointing a process at staging
 * means putting the staging values *under these names* in its environment —
 * which is exactly what `scripts/stage.ts` does to the dev server and what
 * `scripts/audit/clients.ts` does to its own process.
 */
export const RUNTIME_VARS = {
  url: "NEXT_PUBLIC_SUPABASE_URL",
  anonKey: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  serviceKey: "SUPABASE_SERVICE_ROLE_KEY",
} as const;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Read `.env.local` into `process.env`, without overwriting anything already
 * set.
 *
 * Resolved from this file's own location rather than from `process.cwd()`. The
 * old cwd-relative read worked only because every harness happens to be started
 * from the repository root, and failed with a bare ENOENT the one time somebody
 * ran one from `scripts/`.
 *
 * A missing file is not an error: an environment that already carries the
 * variables — CI, or a shell with them exported — is a legitimate way to run
 * these, and the callers below all fail by name if something is actually
 * absent. Anything other than "no such file" is rethrown, because an
 * unreadable `.env.local` is a real problem wearing a silent disguise.
 */
export function loadEnvLocal(): void {
  let contents: string;
  try {
    contents = readFileSync(join(REPO_ROOT, ".env.local"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const line of contents.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

/**
 * Is this URL the staging project?
 *
 * Substring, like `isProductionUrl`, and for the same reason: one project
 * answers on `https://<ref>.supabase.co`, on the pooler host and in a
 * connection string, and a check that recognised only one of those shapes would
 * be a check that passes for the two spellings nobody remembers to test.
 */
export function isStagingUrl(url: string): boolean {
  return url.includes(STAGING_PROJECT_REF);
}

/**
 * A local Supabase stack — `supabase start`.
 *
 * Allowed alongside staging wherever staging is allowed. It is self-evidently
 * not the live shop: it is on this machine, it holds nothing anybody paid for,
 * and it is thrown away by `supabase stop`.
 */
export function isLocalUrl(url: string): boolean {
  return url.includes("127.0.0.1") || url.includes("localhost");
}

export type StagingCredentials = {
  url: string;
  anonKey: string;
  serviceKey: string;
};

/**
 * The staging credentials, or null when this checkout has none.
 *
 * Three outcomes, and the middle one is the point:
 *
 *   - none of the three set → `null`. Staging is not configured here; the
 *     caller falls back to whatever `.env.local` says and the production guard
 *     does its job. This is a checkout that predates staging, not a mistake.
 *   - all three set → the credentials.
 *   - *some* set → throws, naming the ones that are missing.
 *
 * The partial case is the one worth writing code for. Half-configured staging
 * is how you get a service-role key for one project and a URL for another, and
 * the failure that produces is a 401 from PostgREST three files away with
 * nothing in it that says "you forgot SUPABASE_STAGE_ANON_KEY". A message that
 * says "missing env" is barely better. So this names the variable.
 *
 * Call `loadEnvLocal()` first.
 */
export function stagingCredentials(): StagingCredentials | null {
  const found = {
    url: process.env[STAGING_VARS.url] ?? "",
    anonKey: process.env[STAGING_VARS.anonKey] ?? "",
    serviceKey: process.env[STAGING_VARS.serviceKey] ?? "",
  };

  const missing = (
    Object.keys(STAGING_VARS) as (keyof typeof STAGING_VARS)[]
  ).filter((key) => found[key].length === 0);

  if (missing.length === 3) return null;
  if (missing.length > 0) {
    throw new Error(
      `Staging is half-configured in .env.local.\n\n` +
        missing.map((key) => `  ${STAGING_VARS[key]} is not set\n`).join("") +
        `\n  All three of ${Object.values(STAGING_VARS).join(", ")}\n` +
        `  have to be present together — a URL from one project and a key from\n` +
        `  another fails as a 401 a long way from here. Fill in the missing\n` +
        `  variable, or remove the others to fall back to .env.local.\n\n` +
        `  See docs/staging.md.`,
    );
  }

  return found;
}

/**
 * The staging credentials, or a thrown error naming what is missing.
 *
 * For callers whose entire purpose is staging — `scripts/stage.ts` — where
 * "staging is not configured" is not a fallback but the end of the road.
 */
export function requireStagingCredentials(): StagingCredentials {
  const credentials = stagingCredentials();
  if (credentials) return credentials;
  throw new Error(
    `Staging is not configured in .env.local.\n\n` +
      Object.values(STAGING_VARS)
        .map((name) => `  ${name} is not set\n`)
        .join("") +
      `\n  These are the keys of the staging Supabase project ` +
      `(${STAGING_PROJECT_REF}).\n` +
      `  Copy them from the Supabase dashboard into .env.local — not into a\n` +
      `  .env.staging file, which nothing reads. See docs/staging.md.`,
  );
}
