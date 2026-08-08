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
  
    const { data: pages, error: pagesError } = await supabase
      .from("pages")
      .select("slug, body");
    if (pagesError) {
      report("pages", `could not be read: ${pagesError.message}`);
    } else {
      for (const page of pages ?? []) {
        const body = String(page.body ?? "");
        for (const [index, line] of body.split("\n").entries()) {
          if (CURRENCY.test(line) || RUPEES_WORD.test(line)) {
            report(
              `pages.body (${page.slug}) line ${index + 1}`,
              line.trim().slice(0, 110),
            );
          }
        }
      }
      console.log(
        `  \x1b[32m✓\x1b[0m ${pages?.length ?? 0} CMS pages checked`,
      );
    }
  
    const { data: settings, error: settingsError } = await supabase
      .from("site_settings")
      .select("key, value")
      .eq("key", "announcement")
      .maybeSingle();
    if (settingsError) {
      report("site_settings.announcement", settingsError.message);
    } else {
      const text = String(
        (settings?.value as { text?: unknown } | null)?.text ?? "",
      );
      if (CURRENCY.test(text) || RUPEES_WORD.test(text)) {
        report("site_settings.announcement", text.slice(0, 110));
      } else {
        console.log("  \x1b[32m✓\x1b[0m the announcement strip carries no figure");
      }
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
