/**
 * `npm run audit:settings-visibility` — no settings key is published by
 * accident.
 *
 * RLS grants `anon` `select` on `site_settings` `using (is_public)`, per **row**
 * rather than per field, so a public row publishes its whole jsonb — including
 * keys added to it long after the flag was set. `src/lib/settings-visibility.ts`
 * holds the decision for every key, with a reason; this asserts the database
 * agrees with it.
 *
 * ## What it would look like if this were broken
 *
 * A worthwhile question to ask of any gate, and the reason this one reads the
 * database twice through two different clients.
 *
 * Asserting only that `SETTINGS_VISIBILITY` matches `site_settings.is_public`
 * would pass in a world where RLS had been rewritten to ignore `is_public`
 * entirely — every classification would still "agree" with a column no longer
 * controlling anything, and the gate would be green while the whole table was
 * readable by anyone. The flag is a statement of *intent*; what an anonymous
 * caller can actually fetch is the fact. So section 3 asks the anon client
 * directly and compares what comes back against what was classified public.
 *
 * Run without a browser. It needs the database, and says so rather than passing
 * silently if it cannot reach it.
 */

import { readFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";

import {
  SETTINGS_VISIBILITY,
  type Visibility,
} from "../../src/lib/settings-visibility";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

let failed = 0;
let passed = 0;

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !serviceKey || !anonKey) {
    console.error(
      "\n\x1b[31mCannot run: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY " +
        "and NEXT_PUBLIC_SUPABASE_ANON_KEY must all be set.\x1b[0m\n" +
        "This gate is about what an anonymous caller can read, so it needs both " +
        "clients. Skipping would be a gap, not a pass.\n",
    );
    process.exit(1);
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
  const anon = createClient(url, anonKey, { auth: { persistSession: false } });

  /* --------------------------------------------- 1 · every entry reasoned -- */

  console.log("\n\x1b[1m1 · every classification carries a reason\x1b[0m");

  let unreasoned = 0;
  for (const entry of Object.values(SETTINGS_VISIBILITY)) {
    if (!entry.reason || entry.reason.trim().length < 20) unreasoned += 1;
  }
  check(
    "no entry is classified without saying why",
    unreasoned === 0,
    `${Object.keys(SETTINGS_VISIBILITY).length} keys classified`,
  );

  /* ------------------------------------------- 2 · the database agrees ----- */

  console.log(
    "\n\x1b[1m2 · every key in the database is classified, and matches\x1b[0m",
  );

  const { data: rows, error } = await admin
    .from("site_settings")
    .select("key, is_public")
    .overrideTypes<{ key: string; is_public: boolean }[]>();

  if (error || !rows) {
    console.error(`  could not read site_settings: ${error?.message}`);
    process.exit(1);
  }

  for (const row of rows) {
    const entry = SETTINGS_VISIBILITY[row.key];
    if (!entry) {
      check(
        `${row.key} is classified`,
        false,
        "present in the database and absent from src/lib/settings-visibility.ts. " +
          "Classify it public or private, with a reason, before it ships",
      );
      continue;
    }

    const expected: Visibility = row.is_public ? "public" : "private";
    check(
      `${row.key}: ${entry.visibility}`,
      entry.visibility === expected,
      entry.visibility === expected
        ? entry.reason.slice(0, 72)
        : `classified ${entry.visibility}, but is_public is ${row.is_public}`,
    );
  }

  const live = new Set(rows.map((row) => row.key));
  const orphaned = Object.keys(SETTINGS_VISIBILITY).filter(
    (key) => !live.has(key),
  );
  check(
    "no classification refers to a key that no longer exists",
    orphaned.length === 0,
    orphaned.length ? orphaned.join(", ") : `${rows.length} rows`,
  );

  /* ------------------------------- 3 · what anon can actually fetch -------- */

  console.log(
    "\n\x1b[1m3 · what an anonymous caller really gets back\x1b[0m",
  );

  /**
   * The fact rather than the intent. See the header: a gate that only compared
   * the classification against `is_public` would stay green if RLS stopped
   * consulting `is_public` at all.
   */
  const { data: visible, error: anonError } = await anon
    .from("site_settings")
    .select("key")
    .overrideTypes<{ key: string }[]>();

  if (anonError) {
    check("the anon client can read the public half", false, anonError.message);
  } else {
    const anonKeys = new Set((visible ?? []).map((row) => row.key));
    const expectedPublic = Object.entries(SETTINGS_VISIBILITY)
      .filter(([, entry]) => entry.visibility === "public")
      .map(([key]) => key)
      .filter((key) => live.has(key))
      .sort();

    const leaked = [...anonKeys].filter(
      (key) => SETTINGS_VISIBILITY[key]?.visibility !== "public",
    );
    check(
      "anon sees nothing classified private",
      leaked.length === 0,
      leaked.length ? `LEAKED: ${leaked.join(", ")}` : "no private key is readable",
    );

    const missing = expectedPublic.filter((key) => !anonKeys.has(key));
    check(
      "anon sees everything classified public",
      missing.length === 0,
      missing.length
        ? `unreachable: ${missing.join(", ")} — the storefront renders these`
        : expectedPublic.join(", "),
    );
  }

  /* ------------------------------------------------------------- report --- */

  console.log(
    failed === 0
      ? `\n\x1b[1m\x1b[32msettings-visibility: ${passed} checks, all green.\x1b[0m\n`
      : `\n\x1b[1m\x1b[31msettings-visibility: ${failed} of ${passed + failed} checks failed.\x1b[0m\n` +
          "Classify the key in src/lib/settings-visibility.ts, or change the row's\n" +
          "is_public to match the decision recorded there.\n",
  );
  if (failed > 0) process.exit(1);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
