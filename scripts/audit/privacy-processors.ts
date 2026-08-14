/**
 * `npm run audit:privacy` — every processor the shop uses is named on the
 * privacy page.
 *
 * ## The defect this inverts
 *
 * On 2026-08-14 `/page/privacy` said *"we do not share it with anyone other
 * than the courier carrying your parcel"* while six third parties were
 * receiving customer data. Nothing in the repository noticed, and nothing could
 * have: the privacy policy is prose in a database row, and prose has no type.
 *
 * The failure has the same shape as the ₹2,499 incident — the system changed
 * and the copy did not — but a `{{token}}` cannot fix it, because the missing
 * fact is a *name* rather than a number.
 *
 * What it has instead is `src/lib/csp.ts`, a list of exactly which external
 * origins the browser may reach, maintained under pain of breaking payments.
 * This gate reads that list, plus the environment, plus the code, through
 * `src/lib/processors.ts`, and asserts the page names every processor it finds.
 *
 * So the direction of failure is now the useful one:
 *
 *   before   add a host to the CSP  →  the privacy policy silently becomes false
 *   after    add a host to the CSP  →  the build goes red, with the hostname in
 *                                      the message
 *
 * ## Three sources, because processors arrive three ways
 *
 * The CSP alone would not have been enough, and it is worth being precise about
 * why: **Shiprocket and Resend are server-side.** The browser never talks to
 * either, so neither appears in any directive, and a gate built only on the
 * allowlist would have pronounced the policy complete while the two processors
 * that see a customer's home address and email went unmentioned. Google is a
 * third case again — a top-level redirect, which no CSP directive governs at
 * all. See the module header of `src/lib/processors.ts`.
 *
 * ## What it reads
 *
 * `.env.local` verbatim and therefore the **production** database, for the same
 * reason `literals.ts` does: the thing being checked is the shop's own
 * published policy, and pointing this at a seeded staging row would turn a real
 * assertion into an assertion about fixtures. It writes nothing, anywhere, and
 * `audit:fixtures-guard` names it in the read-only list on every run.
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";

import { PROCESSORS, cspHostFamilies } from "../../src/lib/processors";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

let failed = 0;

function fail(where: string, detail: string): void {
  failed += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${where}\n      ${detail}`);
}

function pass(detail: string): void {
  console.log(`  \x1b[32m✓\x1b[0m ${detail}`);
}

/* ------------------------------------------- 1 · every host has an owner -- */

console.log(
  "\n\x1b[1m1 · every third-party host in the CSP maps to a named processor\x1b[0m",
);

const families = cspHostFamilies();
const claimed = new Map<string, string>();
for (const processor of PROCESSORS) {
  for (const host of processor.hosts ?? []) claimed.set(host, processor.name);
}

for (const [family, directives] of families) {
  const owner = claimed.get(family);
  if (owner) {
    pass(`${family} → ${owner}  (${directives.join(", ")})`);
    continue;
  }
  fail(
    `CSP host ${family}`,
    `is allowed by ${directives.join(", ")} and belongs to nobody. Add it to ` +
      "PROCESSORS in src/lib/processors.ts with what they receive, and name " +
      "them on /page/privacy. A browser reaching a host the privacy policy " +
      "does not mention is undisclosed processing.",
  );
}

for (const [family, owner] of claimed) {
  if (families.has(family)) continue;
  fail(
    `PROCESSORS: ${owner}`,
    `claims ${family}, which is no longer in CSP_DIRECTIVES. Either the ` +
      "processor is gone — in which case remove it here and from the privacy " +
      "page — or a directive lost a host it still needs.",
  );
}

/* ------------------------------------------ 2 · every processor is real -- */

console.log(
  "\n\x1b[1m2 · every processor is detectable, and which are live\x1b[0m",
);

/** Why this processor counts as configured, or null if it is not. */
function detect(processor: (typeof PROCESSORS)[number]): string | null {
  if (processor.always) return `always — ${processor.always}`;

  const hosts = (processor.hosts ?? []).filter((host) => families.has(host));
  if (hosts.length > 0) return `CSP allows ${hosts.join(", ")}`;

  const vars = (processor.env ?? []).filter((name) => process.env[name]);
  if (vars.length > 0) return `${vars.join(", ")} set`;

  if (processor.code) {
    if (!existsSync(processor.code.file)) return null;
    const source = readFileSync(processor.code.file, "utf8");
    if (source.includes(processor.code.symbol))
      return `${processor.code.file} still exports ${processor.code.symbol}`;
  }
  return null;
}

const required: { name: string; purpose: string; why: string }[] = [];

for (const processor of PROCESSORS) {
  const detectable =
    processor.always ??
    processor.hosts ??
    processor.env ??
    processor.code ??
    null;
  if (!detectable) {
    fail(
      `PROCESSORS: ${processor.name}`,
      "has no hosts, no env, no code and no `always` — nothing can ever make " +
        "it required, so listing it reads like coverage and is not. Give it a " +
        "way to be detected or take it out.",
    );
    continue;
  }

  const why = detect(processor);
  if (why) {
    required.push({ name: processor.name, purpose: processor.purpose, why });
    pass(`${processor.name} — configured: ${why}`);
  } else {
    console.log(
      `  \x1b[90m·\x1b[0m ${processor.name} — not configured here, so not required on the page`,
    );
  }
}

/* ------------------------------------- 3 · the page names every one of them -- */

console.log(
  "\n\x1b[1m3 · the privacy page names every configured processor\x1b[0m",
);

async function checkPage(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    fail(
      "environment",
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — the page " +
        "could not be read. That is a gap, not a pass.",
    );
    return;
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await supabase
    .from("pages")
    .select("body, is_published")
    .eq("slug", "privacy")
    .maybeSingle();

  if (error) {
    fail("pages.privacy", `could not be read: ${error.message}`);
    return;
  }
  if (!data) {
    fail(
      "pages.privacy",
      "there is no privacy page. Six processors receive customer data and the " +
        "shop has nowhere that says so.",
    );
    return;
  }
  if (!data.is_published) {
    fail(
      "pages.privacy",
      "exists but is not published, so nobody can read it.",
    );
  }

  const body = String(data.body ?? "").toLowerCase();
  for (const processor of required) {
    if (body.includes(processor.name.toLowerCase())) {
      pass(`${processor.name} is named`);
      continue;
    }
    fail(
      `pages.privacy does not name ${processor.name}`,
      `${processor.why}. The page must say that ${processor.name} ` +
        `${processor.purpose}.`,
    );
  }

  /*
    The other direction. A policy that names a processor the shop stopped using
    is wrong in the same way as one that omits a processor it uses — it is a
    statement about where a customer's data goes that is not true — and it is
    the more likely of the two to survive for years, because nothing breaks.
  */
  const requiredNames = new Set(required.map((p) => p.name.toLowerCase()));
  for (const processor of PROCESSORS) {
    if (requiredNames.has(processor.name.toLowerCase())) continue;
    if (!body.includes(processor.name.toLowerCase())) continue;
    fail(
      `pages.privacy names ${processor.name}`,
      "but nothing here is configured to send them anything. Either the " +
        "detection in src/lib/processors.ts is wrong, or the page is " +
        "describing a processor the shop no longer uses.",
    );
  }
}

/* ------------------------- 4 · placeholders awaiting the owner ----------- */

/**
 * Tokens that are deliberately unresolved because only the owner knows the
 * answer, each with the question being waited on.
 *
 * The brief's rule is absolute — *"Never invent a fact about the business. A
 * guessed return window in a published policy is a promise the shop did not
 * make"* — so where a policy page needs a fact nobody has supplied, it carries
 * a token, `fillTokens` leaves it visible, and the sentence reads as obviously
 * unfinished rather than as quietly wrong.
 *
 * That is only safe while the shop is hidden. Batch D precondition 2 is
 * "policy pages published with real values and no placeholders", and this is
 * that precondition mechanised: a placeholder is work-in-progress under
 * `SITE_INDEXABLE=false` and a defect the moment it is true.
 *
 * Removing an entry from here is how the owner's answer lands: fill the value
 * in, delete the line, and the gate stops mentioning it.
 */
/*
  Empty, and kept rather than deleted.

  It held three entries between 14 August 2026 and the same evening:
  `deletion_window`, `registered_name` and `gstin`. All three were answered and
  now resolve from `src/lib/legal.ts`, so a page carrying one is no longer
  waiting on anybody — it is checked by the ordinary resolvability rule below
  like every other token.

  The shape stays because the next unanswerable fact is a question of when, not
  whether, and the alternative to a placeholder that fails the build is a
  plausible number typed into a policy page by somebody in a hurry. Add the
  token name and what is being waited on; the page may then ship un-indexed and
  cannot ship indexed.
*/
const AWAITING_OWNER: Record<string, string> = {};

async function checkPlaceholders(): Promise<void> {
  console.log("\n\x1b[1m4 · placeholders in published pages\x1b[0m");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await supabase
    .from("pages")
    .select("slug, body, meta_title, meta_description")
    .eq("is_published", true);

  if (error) {
    fail("pages", `could not be read: ${error.message}`);
    return;
  }

  /*
    Resolvable means the token name appears in `content-tokens.ts` at all — read
    as text rather than imported, because that module is `server-only` and
    reaches the app's `@/` alias, neither of which a plain tsx script has. Crude
    on purpose: the question here is "does anything know this name", and a
    misspelled `{{free_shiping_threshold}}` answers no in both readings.
  */
  const tokenSource = readFileSync("src/lib/content-tokens.ts", "utf8");
  const indexable = process.env.SITE_INDEXABLE === "true";
  let found = 0;

  for (const page of data ?? []) {
    const text = [page.body, page.meta_title, page.meta_description]
      .filter(Boolean)
      .join("\n");
    for (const match of new Set(
      [...text.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/g)].map((m) => m[1]),
    )) {
      const waiting = AWAITING_OWNER[match];
      if (waiting) {
        found += 1;
        if (indexable) {
          fail(
            `pages.${page.slug}: {{${match}}}`,
            `SITE_INDEXABLE is true and this page still carries a placeholder. ` +
              `Waiting on: ${waiting}`,
          );
        } else {
          console.log(
            `  \x1b[33m!\x1b[0m pages.${page.slug}: {{${match}}} — awaiting the owner\n` +
              `      ${waiting}`,
          );
        }
        continue;
      }
      if (!tokenSource.includes(match)) {
        fail(
          `pages.${page.slug}: {{${match}}}`,
          "nothing in src/lib/content-tokens.ts knows this name, so it renders " +
            "to a customer exactly as typed. Either it is a misspelling or the " +
            "token was never built.",
        );
      }
    }
  }

  if (found === 0) {
    pass("no page is waiting on an owner answer");
  } else if (!indexable) {
    console.log(
      `  \x1b[90m·\x1b[0m ${found} placeholder${found === 1 ? "" : "s"} — ` +
        "tolerated while SITE_INDEXABLE is false, and a failure the moment it is not.",
    );
  }
}

/* --------------------------------- 5 · the registered address stays put -- */

/**
 * `src/lib/legal.ts` is imported by exactly one module.
 *
 * The registered place of business on the GST certificate is Proddatur, PIN
 * 516361. The shop Shiprocket collects from is Cuddapah, PIN 516360. They share
 * a building name and nothing else, and the owner's instruction was explicit:
 * the registered address is a legal statement on the Terms page and must not be
 * wired to anything.
 *
 * A comment saying so is not a guarantee — the next person to need "the shop's
 * address" in a courier payload will find `REGISTERED_ADDRESS` by grep and it
 * will look right. So the constraint is checked instead: one importer,
 * `content-tokens.ts`, which turns it into `{{registered_address}}` and nothing
 * else. Wiring it into the shipping origin would move the pickup PIN by one
 * digit and silently re-rate every delivery quote on the site, which is the
 * kind of defect that is only visible in the money.
 */
const LEGAL_IMPORTER = "src/lib/content-tokens.ts";
const IMPORTS_LEGAL = /from\s+"(?:@\/lib\/legal|[^"]*\/legal)"/;

function checkLegalIsolation(): void {
  console.log(
    "\n\x1b[1m5 · the registered address is not wired to anything\x1b[0m",
  );

  /*
    `--others --exclude-standard` as well as the index, and the first run of
    this check is why. Written with a plain `git ls-files`, it passed while a
    throwaway `import { REGISTERED_ADDRESS }` sat in src/lib/contact.ts — because
    that file was new and therefore untracked, and so was legal.ts itself. A
    guard against a mistake somebody is about to make cannot be blind to the
    files they are making it in.
  */
  const files = execSync(
    "git ls-files --cached --others --exclude-standard 'src/**/*.ts' 'src/**/*.tsx' 'scripts/**/*.ts'",
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .filter((file) => file !== "src/lib/legal.ts");

  const importers = files.filter((file) =>
    IMPORTS_LEGAL.test(readFileSync(file, "utf8")),
  );

  for (const file of importers.filter((f) => f !== LEGAL_IMPORTER)) {
    fail(
      file,
      "imports src/lib/legal.ts. REGISTERED_ADDRESS is the GST certificate's " +
        "principal place of business (Proddatur, 516361), not the shop and not " +
        "the courier pickup (Cuddapah, 516360). Read the header of legal.ts.",
    );
  }

  if (!importers.includes(LEGAL_IMPORTER)) {
    fail(
      LEGAL_IMPORTER,
      "no longer imports src/lib/legal.ts, so {{registered_name}}, {{gstin}}, " +
        "{{registered_address}} and {{deletion_window}} render to a customer as " +
        "braces on the Terms and privacy pages.",
    );
    return;
  }

  if (importers.length === 1) {
    pass(`src/lib/legal.ts is imported by ${LEGAL_IMPORTER} and nothing else`);
  }
}

void checkPage()
  .then(checkPlaceholders)
  .then(checkLegalIsolation)
  .then(() => {
    if (failed > 0) {
      console.log(
        `\n\x1b[31m${failed} problem${failed === 1 ? "" : "s"}.\x1b[0m\n` +
          "A privacy policy is a statement of fact about where a customer's data\n" +
          "goes. See src/lib/processors.ts.\n",
      );
      process.exit(1);
    }
    console.log(
      "\n\x1b[1mEvery processor the shop uses is named on the privacy page.\x1b[0m\n",
    );
  });
