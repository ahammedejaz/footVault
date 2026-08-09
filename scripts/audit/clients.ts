/**
 * The Supabase clients every audit harness shares, and the guard that decides
 * which database they are allowed to point at.
 *
 * This module exists because of a near miss. `fixtures.ts` reads `.env.local`
 * directly and builds its clients from whatever it finds there. During Phase 8
 * `.env.local` was pointed at **production** — live Razorpay keys and all — so
 * `npm run audit` would have created QA accounts, carts and real orders inside
 * the live shop, next to real customers. Nothing would have stopped it and
 * nothing would have said so afterwards; the run would simply have passed.
 *
 * A comment saying "don't do that" is not a fix for this. The failure is silent,
 * it is irreversible, and it is one `cp .env.production .env.local` away. So the
 * guard is a module-scope throw in `fixtures.ts` — the file that creates data —
 * and it is not switchable by an environment variable, because a switch is just
 * a slower way of arriving at the same place.
 *
 * The client factories live here rather than in `fixtures.ts` so that
 * `teardown.ts` can still reach them. Teardown only ever *deletes*, and only
 * rows whose email carries `QA_EMAIL_PREFIX`, so it is the one tool that is
 * legitimately useful pointed at production — it is how you clean up if this
 * guard was added a day too late.
 *
 * ## Where these clients point (new)
 *
 * The guard above was correct and it left the harnesses with nowhere to run:
 * every fixture-building gate has been blocked since Phase 7 because the only
 * database in `.env.local` was the live one. A staging project now exists, and
 * **this file is where it takes effect**. Every harness in this directory
 * imports these factories, so routing them here routes all of them at once —
 * and, just as importantly, routes them all to the *same place*.
 *
 * Resolution order, once:
 *
 *   1. `AUDIT_TARGET=env-local` — use `.env.local`'s `NEXT_PUBLIC_SUPABASE_URL`
 *      and friends verbatim. This is teardown's route to production and the
 *      only way to reach it.
 *   2. `SUPABASE_STAGE_*` present in `.env.local` — staging. The default.
 *   3. neither — `.env.local` verbatim, exactly as this file behaved before
 *      staging existed. A checkout with no staging keys still runs
 *      `fixtures-guard` and `teardown`; it just cannot build fixtures, which is
 *      the pre-existing and correct state of affairs.
 *
 * Whichever wins is also written back into `process.env` under the three names
 * the rest of the repository reads (`NEXT_PUBLIC_SUPABASE_URL`,
 * `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`). That is
 * deliberate and it is the reason this file is worth being a chokepoint at all:
 * several harnesses parse `.env.local` themselves and then read those names
 * directly. Imports run before module bodies, so this assignment lands first
 * and their own loaders — every one of which is `if (!process.env[k])` — leave
 * it alone. Without it, a harness that imports `adminClient()` *and* reads
 * `process.env.NEXT_PUBLIC_SUPABASE_URL` would talk to two different databases
 * in one run.
 *
 * The dev server is a separate process and does not import this file. It is
 * pointed at staging by `scripts/stage.ts` — see `npm run dev:stage`. Wiring
 * one without the other gives fixtures in staging and a browser looking at
 * production, which is worse than not running the gates at all.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../../src/lib/database.types";
import {
  isLocalUrl,
  isStagingUrl,
  loadEnvLocal,
  RUNTIME_VARS,
  stagingCredentials,
  STAGING_PROJECT_REF,
  STAGING_VARS,
} from "../staging-env";

/** The one prefix teardown sweeps on. Changing it orphans every account. */
export const QA_EMAIL_PREFIX = "fv-qa.";

/**
 * The production Supabase project. Hardcoded, and that is the point.
 *
 * Reading this from configuration would let the same mistake that pointed
 * `.env.local` at production also unset the guard, which is no guard at all. It
 * is a project ref rather than a full URL so that the pooler host, the REST
 * host and a direct connection string all match the same check.
 */
export const PRODUCTION_PROJECT_REF = "ahumjhwqgmskjsitctcj";

export { STAGING_PROJECT_REF, isStagingUrl } from "../staging-env";

/** Read once, on import — every harness in this directory needs the same three keys. */
loadEnvLocal();

/**
 * The one escape hatch, and what it is for.
 *
 * `teardown.ts` is the single tool that is legitimately useful pointed at the
 * live shop, and with staging configured it would otherwise sweep staging and
 * report that production was clean. It is not a switch on the *guard* — nothing
 * here lets a fixture builder reach production — it only decides which set of
 * credentials is read.
 *
 * Spelled `env-local` rather than `production` because that is what it does:
 * take `.env.local` at its word, whatever `.env.local` currently says.
 */
const TARGET = process.env.AUDIT_TARGET ?? "staging";
if (TARGET !== "staging" && TARGET !== "env-local") {
  throw new Error(
    `AUDIT_TARGET=${TARGET} is not a target.\n\n` +
      `  staging    the SUPABASE_STAGE_* project (the default)\n` +
      `  env-local  whatever NEXT_PUBLIC_SUPABASE_URL says — teardown's route\n` +
      `             to production\n\n` +
      `  See docs/staging.md.`,
  );
}

function resolveCredentials(): {
  url: string;
  anonKey: string;
  serviceKey: string;
  /** Which set of variable names the values above actually came from. */
  from: "staging" | "env-local";
} {
  const fromEnvLocal = {
    url: process.env[RUNTIME_VARS.url] ?? "",
    anonKey: process.env[RUNTIME_VARS.anonKey] ?? "",
    serviceKey: process.env[RUNTIME_VARS.serviceKey] ?? "",
    from: "env-local" as const,
  };
  if (TARGET === "env-local") return fromEnvLocal;

  // Throws, naming the variable, if staging is half-configured.
  const staging = stagingCredentials();
  if (!staging) return fromEnvLocal;

  // Everything downstream that reads these names by hand has to agree with the
  // clients built below. See the header.
  process.env[RUNTIME_VARS.url] = staging.url;
  process.env[RUNTIME_VARS.anonKey] = staging.anonKey;
  process.env[RUNTIME_VARS.serviceKey] = staging.serviceKey;
  return { ...staging, from: "staging" };
}

const RESOLVED = resolveCredentials();

const SUPABASE_URL = RESOLVED.url;
const ANON_KEY = RESOLVED.anonKey;
const SERVICE_KEY = RESOLVED.serviceKey;

export function supabaseUrl(): string {
  return SUPABASE_URL;
}

/** The publishable key, for the one caller that builds an SSR client by hand. */
export function anonKey(): string {
  return ANON_KEY;
}

/**
 * Is this URL the live shop?
 *
 * Substring rather than equality on purpose. The same project answers on
 * `https://<ref>.supabase.co`, on the pooler host, and on a direct connection
 * string, and a check that only recognised one of those shapes would be a guard
 * that passes for the two spellings nobody remembers to test.
 *
 * Exported so it can be tested against strings rather than by re-importing this
 * module with a different environment, which Node's module cache makes
 * unreliable.
 */
export function isProductionUrl(url: string): boolean {
  return url.includes(PRODUCTION_PROJECT_REF);
}

/**
 * Refuse to continue when pointed anywhere the fixtures may not write.
 *
 * Throws. Callers do not catch it and must not: there is no sensible way to
 * carry on, and an audit that swallowed this would go on to write the very rows
 * it is meant to prevent.
 *
 * **It now names an allowed list rather than one forbidden project**, and that
 * is a strengthening, not a convenience. The old check could only say "this is
 * not `ahumjhwqgmskjsitctcj`" — which is true of every database in the world
 * except one, including the *next* production project this shop ever has, and
 * including a URL that is empty because a variable was misspelled. It passed
 * for all of them. Now there are exactly three answers it accepts:
 *
 *   - the staging project (`STAGING_PROJECT_REF`)
 *   - a local stack — `supabase start`, on 127.0.0.1
 *   - nothing else
 *
 * so it can say "this is not the staging project either" instead of shrugging.
 * The production case keeps its own message because it is the one mistake that
 * has actually nearly happened, and it deserves to be recognised by name.
 */
export function assertNotProduction(action: string): void {
  if (isStagingUrl(SUPABASE_URL) || isLocalUrl(SUPABASE_URL)) return;

  if (isProductionUrl(SUPABASE_URL)) {
    throw new Error(
      `Refusing to ${action} against the production database.\n\n` +
        `  ${RUNTIME_VARS.url} points at ${PRODUCTION_PROJECT_REF}, which is the live shop.\n` +
        `  These harnesses create QA accounts, carts and real orders. Running them here\n` +
        `  would put test data next to real customers, and nothing would undo it.\n\n` +
        `  Set ${Object.values(STAGING_VARS).join(", ")}\n` +
        `  in .env.local and run again — they take precedence over the values above.\n` +
        `  See docs/staging.md.`,
    );
  }

  throw new Error(
    `Refusing to ${action}: this is not the staging project.\n\n` +
      `  Resolved Supabase URL: ${SUPABASE_URL || "(unset)"}\n` +
      `  Expected the staging project ${STAGING_PROJECT_REF}, or a local stack\n` +
      `  on 127.0.0.1.\n\n` +
      (RESOLVED.from === "env-local"
        ? `  The value came from ${RUNTIME_VARS.url} in .env.local, because ` +
          `${
            TARGET === "env-local"
              ? "AUDIT_TARGET=env-local is set"
              : `${STAGING_VARS.url} is not set`
          }.\n\n`
        : `  The value came from ${STAGING_VARS.url}, which points somewhere\n` +
          `  other than the staging project.\n\n`) +
      `  A guard that only knew production would have let this run. It does not\n` +
      `  know what is in this database and it will not find out by writing to it.\n` +
      `  See docs/staging.md.`,
  );
}

export function anonClient(): SupabaseClient<Database> {
  return createClient<Database>(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
  });
}

export function adminClient(): SupabaseClient<Database> {
  if (!SERVICE_KEY)
    throw new Error(
      `${
        RESOLVED.from === "staging"
          ? STAGING_VARS.serviceKey
          : RUNTIME_VARS.serviceKey
      } is empty — cannot build fixtures`,
    );
  return createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });
}
