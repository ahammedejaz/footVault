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
/**
 * The database behind a *server*, which is a different question from the
 * database behind this process's credentials.
 *
 * ## The half `assertNotProduction` cannot see
 *
 * That guard is keyed on the credential and it works — proven in both
 * directions on 2026-08-14. It still did not stop production picking up two
 * guest carts that day, because nothing it can see was wrong: the harness held
 * staging credentials, passed, and then drove a browser at
 * `AUDIT_BASE_URL=http://localhost:3213` — a `next start` serving a production
 * build, reading `.env.local`, talking to the live shop.
 *
 * Every write the *admin client* made went to staging. Every write the
 * *browser* made went to production. The visible symptom was `no active cart to
 * convert`: the cart existed, in the other database.
 *
 * `AUDIT_BASE_URL` moves the browser, the credentials move the client, and a
 * guard on either says nothing about the other.
 *
 * ## What this can see, and what it cannot
 *
 * It reads the project ref out of the served markup, because production serves
 * every catalogue image from Supabase storage and the host is therefore a fact
 * about the response — no debug route, which would then exist in production.
 *
 * **This is positive evidence only, and the limit is worth stating rather than
 * discovering.** Staging serves its seeded images from local static media
 * (`/_next/image?url=%2F_next%2Fstatic%2Fmedia%2F…`), so *no* Supabase host
 * appears there at all. Absence therefore cannot mean "not production" — it
 * means "this check found nothing", and the run proceeds. A production server
 * with no Supabase-hosted image would pass, and that is not the shape of this
 * production today: 122 product images, all in the storage bucket.
 *
 * What it does catch is the accident that actually happened, and the split-brain
 * variant of it, both loudly.
 */
export async function assertServerNotProduction(
  baseUrl: string,
  action: string,
): Promise<void> {
  const expected = projectRefOf(SUPABASE_URL);
  let served: string | null = null;

  for (const path of ["/", "/shop"]) {
    let html: string;
    try {
      html = await (await fetch(`${baseUrl}${path}`)).text();
    } catch {
      continue;
    }
    const found = /https:\/\/([a-z0-9]{15,})\.supabase\.co/.exec(html);
    if (found) {
      served = found[1];
      break;
    }
  }

  if (served === PRODUCTION_PROJECT_REF) {
    throw new Error(
      `Refusing to ${action}: ${baseUrl} is serving the production database.\n\n` +
        `  The server there is backed by ${PRODUCTION_PROJECT_REF}, the live shop.\n` +
        `  This harness types QA values into real forms, so the browser writes them\n` +
        `  wherever that server points — no matter what credentials this process\n` +
        `  holds, and this process's credentials are ${expected || "(unset)"}.\n\n` +
        `  Run \`npm run dev:stage\` and point AUDIT_BASE_URL at it.`,
    );
  }

  if (served !== null && served !== expected) {
    throw new Error(
      `Refusing to ${action}: the browser and this process disagree.\n\n` +
        `  ${baseUrl} is serving  ${served}\n` +
        `  these credentials hold ${expected || "(unset)"}\n\n` +
        `  Writes would land in two databases and the assertions would read the\n` +
        `  wrong one. This is what produced "no active cart to convert" on\n` +
        `  2026-08-14.`,
    );
  }
}

/** The subdomain of a Supabase URL — the project ref, or "" if it is not one. */
function projectRefOf(url: string): string {
  return /https:\/\/([a-z0-9]+)\.supabase\.co/.exec(url)?.[1] ?? "";
}

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

/**
 * Options both factories take.
 *
 * ## Why the guard moved in here
 *
 * For four waves, the rule was "a harness that writes must import
 * `./clients`", and `audit:fixtures-guard` policed it by reading the directory.
 * That rule was checking the wrong property, and the fifth wave found out how.
 *
 * Importing this module **repoints** the process at staging. It does not
 * **refuse** anything. The refusal was `assertNotProduction`, and the only place
 * it ran automatically was `fixtures.ts`'s module scope — so a harness that
 * imported `./clients` and never touched `./fixtures` passed the guard while
 * being completely unprotected. `server-actions.ts` was in exactly that state:
 * under `AUDIT_TARGET=env-local`, or on any checkout with no `SUPABASE_STAGE_*`
 * where resolution falls back to `.env.local`, it would have created accounts
 * and promoted one to **admin** on the live shop. `cart-limit.ts` and
 * `refunds.ts` were in the same position.
 *
 * A static rule of that shape can only ever be as complete as the last person to
 * think about it, and it had been believed complete four times. So the guard is
 * no longer a property of the *file* — it is a property of the *credential*. You
 * cannot obtain a client from this module that points at production without
 * saying so in the call. Nobody has to remember, no regex has to notice, and a
 * harness added next year is covered on the day it is written.
 */
export type ClientOptions = {
  /**
   * Permit this client to point at the live shop.
   *
   * Exactly one caller sets it: `teardown.ts`, which only ever deletes rows
   * whose email carries a QA prefix and is the tool you reach for when this
   * guard was added a day too late. It is spelled out at the call site so that
   * "this one talks to production" is visible in the diff that introduces it,
   * which is the only property that matters for a flag like this.
   */
  allowProduction?: boolean;
};

export function anonClient(
  options: ClientOptions = {},
): SupabaseClient<Database> {
  if (!options.allowProduction) assertNotProduction("open an anon client");
  return createClient<Database>(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
  });
}

export function adminClient(
  options: ClientOptions = {},
): SupabaseClient<Database> {
  if (!options.allowProduction)
    assertNotProduction("open a service-role client");
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
