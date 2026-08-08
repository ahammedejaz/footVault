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
 */
import { readFileSync } from "node:fs";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../../src/lib/database.types";

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

/** Read once, on import — every harness in this directory needs the same three keys. */
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

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
 * Refuse to continue when pointed at the live shop.
 *
 * Throws. Callers do not catch it and must not: there is no sensible way to
 * carry on, and an audit that swallowed this would go on to write the very rows
 * it is meant to prevent.
 */
export function assertNotProduction(action: string): void {
  if (!isProductionUrl(SUPABASE_URL)) return;
  throw new Error(
    `Refusing to ${action} against the production database.\n\n` +
      `  NEXT_PUBLIC_SUPABASE_URL points at ${PRODUCTION_PROJECT_REF}, which is the live shop.\n` +
      `  These harnesses create QA accounts, carts and real orders. Running them here\n` +
      `  would put test data next to real customers, and nothing would undo it.\n\n` +
      `  Point .env.local at a staging project and run again. See docs/staging.md.`,
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
      "SUPABASE_SERVICE_ROLE_KEY is empty — cannot build fixtures",
    );
  return createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });
}
