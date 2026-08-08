/**
 * `npm run audit:literals` — no policy number may be typed anywhere.
 *
 * The brief asked for this after finding a hardcoded free-shipping threshold on
 * `/page/returns`, and it asked for it in the strongest terms available: *"Add a
 * lint rule or test that fails on a currency literal in a component, so this
 * cannot come back a third time."*
 *
 * A third time is not rhetoric. The same number has now escaped twice:
 *
 *   1. Phase 6 — `shipping.flat_fee_paise` was read by the cart and the product
 *      page while checkout charged a live courier rate. Deleted rather than
 *      corrected, so it could not come back.
 *   2. Phase 7 — the threshold reappeared in *content*: the announcement strip
 *      and the shipping page both said "₹2,499" while
 *      `site_settings.shipping.free_above_paise` said ₹6,499. Not stale docs —
 *      a promise on every page of the storefront that checkout does not keep.
 *   3. Phase 7, **after this gate was written and passing**. It survived in a
 *      third place: `homepage_sections.payload`, the trust strip under the
 *      homepage hero, still promising "Free shipping over ₹2,499". Found by
 *      curling the deployed site rather than by the gate, because the gate read
 *      `pages.body` and the announcement and nothing else. A gate that checks
 *      the two places you already fixed is a gate that proves you fixed them.
 *
 * So the rule now reads **every owner-editable text column in the database**,
 * including inside jsonb, and the list is derived rather than typed: adding a
 * content table without adding it here is the way this happens a fourth time.
 *
 * So this checks two surfaces, because the second is where it went the moment
 * the first was closed:
 *
 *   **Code.** No rupee figure in a component or a page. The linter cannot see
 *   the difference between a price and a paragraph, so the rule is simply "no
 *   currency literal in JSX", and everything resolves from `site_settings`
 *   through `formatPaise`.
 *
 *   **Content.** No rupee figure in `pages.body` or in the announcement. The
 *   owner types these in the admin, where no lint rule will ever run, so the
 *   check has to read the database. `{{free_shipping_threshold}}` is what they
 *   write instead — see `src/lib/content-tokens.ts`.
 *
 * Run without a browser and without a build; it needs the database only for the
 * second half, and says so rather than passing silently if it cannot reach it.
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

import { createClient } from "@supabase/supabase-js";

let failed = 0;
const problems: string[] = [];

function report(where: string, detail: string) {
  failed += 1;
  problems.push(`${where} — ${detail}`);
  console.log(`  \x1b[31m✗\x1b[0m ${where}\n      ${detail}`);
}

/**
 * A rupee amount: the symbol, then a digit. Deliberately narrow.
 *
 * `₹{formatPaise(x)}` is not matched, because a brace is not a digit — and that
 * is the whole point: an interpolated figure has come from somewhere, a typed
 * one has not. Ranges in prose ("₹142–246") are matched and are meant to be:
 * they are exactly the kind of number that goes stale.
 */
const CURRENCY = /₹\s*\d/;

/** `Rs 199`, `Rs. 2,499` — the other way the same mistake is spelled. */
const RUPEES_WORD = /\bRs\.?\s*\d/;

/**
 * Figures that are the **name of a thing** rather than a promise about a
 * transaction.
 *
 * "Under ₹2,000" is a price-band rail. The number *is* the rail — it defines
 * which shoes are on it, the owner curates the contents by hand, and changing
 * the number without changing the contents would be the mistake rather than the
 * fix. Nothing in `site_settings` could resolve it, because it is not a setting.
 *
 * Matched on the **whole trimmed text**, never as a substring, so "Free
 * shipping over ₹2,000" is still caught. Each entry carries its reason: an
 * allowlist without one is a list of things somebody once found annoying.
 */
const ALLOWED = new Map<string, string>([
  [
    "Under ₹2,000",
    "a price-band rail name — the figure defines the rail, it does not promise anything",
  ],
]);

/* --------------------------------------------------------------- 1 · code -- */

console.log("\n\x1b[1m1 · no currency literal in a component or a page\x1b[0m");

const files = execSync(
  "git ls-files 'src/components/**/*.tsx' 'src/app/**/*.tsx'",
  { encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean);

let scanned = 0;
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");

  let inBlockComment = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();

    // Comments are where the *reasoning* lives, and the reasoning is full of
    // real amounts from real orders — "₹199 against ₹220" is the evidence for a
    // decision, not a promise to a customer. Stripping them is what keeps this
    // rule usable rather than something everybody disables.
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      return;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      return;
    }
    if (trimmed.startsWith("*") || trimmed.startsWith("//")) return;

    const code = line.replace(/\/\/.*$/, "");
    if (CURRENCY.test(code) || RUPEES_WORD.test(code)) {
      report(`${file}:${index + 1}`, trimmed.slice(0, 110));
    }
  });
  scanned += 1;
}
console.log(
  failed === 0
    ? `  \x1b[32m✓\x1b[0m ${scanned} files, no typed rupee figure`
    : `  ${scanned} files scanned`,
);

/* ------------------------------------------------------------ 2 · content -- */

console.log(
  "\n\x1b[1m2 · no currency literal in owner-edited content\x1b[0m",
);

async function checkContent(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  if (!url || !key) {
    console.log(
      "  \x1b[33m!\x1b[0m skipped: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.\n" +
        "      The content half of this gate did not run. That is a gap, not a pass.",
    );
  } else {
    const supabase = createClient(url, key, {
      auth: { persistSession: false },
    });
  
    /**
   * Every owner-editable surface, and what a figure in it would be promising.
   *
   * `collections.name` is deliberately **not** here. "Under ₹2,000" is a
   * price-band rail — the number is the definition of the rail rather than a
   * promise about delivery, and tokenising it would be nonsense. Every other
   * text a shopkeeper can type is checked, because every other one can carry a
   * threshold.
   */
  const surfaces: {
    table: string;
    columns: string[];
    label: (row: Record<string, unknown>) => string;
  }[] = [
    { table: "pages", columns: ["title", "body"], label: (r) => String(r.slug) },
    {
      table: "site_settings",
      columns: ["value"],
      label: (r) => String(r.key),
    },
    {
      table: "homepage_sections",
      columns: ["title", "subtitle", "payload"],
      label: (r) => String(r.section_type),
    },
    {
      table: "banners",
      columns: ["headline", "subtext", "cta_label"],
      label: (r) => String(r.placement ?? r.id),
    },
    {
      table: "collections",
      columns: ["description"],
      label: (r) => String(r.slug),
    },
  ];

  for (const surface of surfaces) {
    const { data, error } = await supabase
      .from(surface.table)
      .select("*")
      .overrideTypes<Record<string, unknown>[]>();

    if (error) {
      report(surface.table, `could not be read: ${error.message}`);
      continue;
    }

    for (const row of data ?? []) {
      for (const column of surface.columns) {
        const value = row[column];
        if (value === null || value === undefined) continue;
        // jsonb arrives as an object; stringifying is exactly right, because a
        // figure buried three levels down is still on the page.
        const text =
          typeof value === "string" ? value : JSON.stringify(value);
        if (!CURRENCY.test(text) && !RUPEES_WORD.test(text)) continue;
        if (ALLOWED.has(text.trim())) {
          console.log(
            `  \x1b[90m·\x1b[0m ${surface.table}.${column}: "${text.trim()}" — ` +
              `allowed: ${ALLOWED.get(text.trim())}`,
          );
          continue;
        }
        const line =
          text.split("\n").find((l) => CURRENCY.test(l) || RUPEES_WORD.test(l)) ??
          text;
        report(
          `${surface.table}.${column} (${surface.label(row)})`,
          line.trim().slice(0, 110),
        );
      }
    }
    console.log(
      `  \x1b[32m✓\x1b[0m ${surface.table}: ${(data ?? []).length} rows, ${surface.columns.join(", ")}`,
    );
  }
  }
}

/* --------------------------------------------------------------- report -- */

function finish(): void {
  if (failed > 0) {
    console.log(
      `\n\x1b[31m${failed} literal${failed === 1 ? "" : "s"} found.\x1b[0m\n` +
        "Resolve each from site_settings — in code through formatPaise(), in\n" +
        "content through a {{token}}. See src/lib/content-tokens.ts.\n",
    );
    process.exit(1);
  }
  console.log("\n\x1b[1mNo policy number is typed anywhere.\x1b[0m\n");
}

void checkContent().then(finish);
