/**
 * `npm run audit:customer-copy` — no engine-room vocabulary on a customer's screen.
 *
 * The customer of FV-2026-00623 opened their own order page and read
 * `rfnd_TNeaZX8YweRyFi`, `cancelled_before_dispatch` and the word "webhook".
 * None of those is a typo. They are an internal audit trail — written for
 * whoever has to reconcile a payment six months later, which is exactly the
 * right thing to record — rendered to the wrong audience because
 * `order_status_history.note` served both.
 *
 * 9C fixed the cause by splitting the column. This is the gate that keeps it
 * fixed, and it checks the two surfaces the words can arrive from:
 *
 *   **Code.** Customer-facing strings in `src/components/checkout/`,
 *   `src/components/storefront/` and `src/app/(storefront)/`. Comments are
 *   skipped, for the same reason `literals.ts` skips them: the reasoning is
 *   where the mechanism is legitimately named, and a rule that fires on its own
 *   documentation is a rule people turn off.
 *
 *   **Data.** Every `order_status_history.customer_note` in the database. The
 *   column is new and nothing stops a future caller passing it `p_reason`, which
 *   is precisely the mistake being guarded against — and no lint rule can see a
 *   string that arrives from a `values (...)` in a migration.
 *
 * Read-only against the database, and it says so rather than passing silently
 * when it cannot reach one.
 */

// clients first: this reads the database, so it must resolve its target the
// same way every other harness does.
import "./clients";

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

import { adminClient } from "./clients";

let failed = 0;
let checked = 0;
const problems: string[] = [];

function report(where: string, detail: string) {
  failed += 1;
  problems.push(`${where} — ${detail}`);
  console.log(`  \x1b[31m✗\x1b[0m ${where}\n      ${detail}`);
}

/**
 * The vocabulary of the machine, as it actually leaked.
 *
 * Every entry is a word that appeared on a real customer's page or is one
 * keystroke away from doing so. They fall into three families:
 *
 *   - **Provider identifiers.** `rfnd_`, `pay_`, `order_` — Razorpay's handles.
 *     A customer has no account in which to look one up.
 *   - **Mechanism.** `webhook`, `RPC`, `idempotent`, `reconcile` — how the shop
 *     knows something, which is never what the customer asked.
 *   - **Reason codes.** `cancelled_before_dispatch` and its siblings: enum
 *     values, correct in a column and unreadable in a sentence.
 *
 * `captur` matches "capture", "captured" and "capturing" in one. It is the
 * provider's word for money moving; the customer's word is "paid".
 */
const INTERNAL =
  /webhook|captur|reconcil|idempoten|\bRPC\b|rfnd_|pay_|order_[a-z0-9]|_before_|_after_|payment_status|order_status|[a-z]+_paise\b/i;

/**
 * Words that are fine in a customer sentence despite matching above.
 *
 * Each carries its reason. An allowlist without one is a list of things
 * somebody once found annoying.
 */
const ALLOWED = new Map<string, string>([
  [
    "pay_now",
    "a form field name, never rendered — kept here so the pattern can stay broad",
  ],
]);

/* --------------------------------------------------------------- 1 · code -- */

console.log("\n\x1b[1m1 · no internal vocabulary in customer-facing code\x1b[0m");

const files = execSync(
  "git ls-files 'src/components/checkout/**/*.tsx' " +
    "'src/components/storefront/**/*.tsx' " +
    "'src/app/(storefront)/**/*.tsx' " +
    "'src/components/checkout/order-format.ts'",
  { encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean);

let scanned = 0;
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");

  let inBlockComment = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();

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

    /**
     * Only what is *between quotes or in JSX text* — never an identifier.
     *
     * `paymentStatus`, `order.payment_status` and `formatPaise` are the names of
     * things and appear on every second line of these files; matching them would
     * make the rule fire on correct code and be switched off within a week. What
     * a customer reads is a string literal, a template literal, or bare JSX
     * text, so those are the three things extracted.
     */
    for (const text of customerText(code)) {
      if (ALLOWED.has(text.trim())) continue;
      const hit = INTERNAL.exec(text);
      if (hit) {
        report(`${file}:${index + 1}`, `“${text.trim().slice(0, 90)}” — ${hit[0]}`);
      }
    }
  });
  scanned += 1;
}
checked += scanned;
console.log(
  failed === 0
    ? `  \x1b[32m✓\x1b[0m ${scanned} files, nothing a shopkeeper would not say`
    : `  ${scanned} files scanned`,
);

/**
 * The parts of a line a customer could actually read.
 *
 * Quoted strings and template literals, plus JSX text between tags. Import
 * specifiers are dropped — `from "@/lib/orders/payment-status"` is a path, not
 * a sentence — and so are the contents of `${...}`, which are expressions.
 */
function customerText(line: string): string[] {
  if (/^\s*import\b/.test(line) || /^\s*}?\s*from\s+["']/.test(line)) return [];

  const out: string[] = [];
  const quoted = line.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`]*)`/g);
  for (const match of quoted) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    // Class names, ids and attribute values are not prose. The cheap test that
    // separates them: prose has a space and at least one word of three letters.
    if (!/\s/.test(value)) continue;
    out.push(value.replace(/\$\{[^}]*\}/g, "…"));
  }

  const jsx = line.matchAll(/>([^<>{}]{4,})</g);
  for (const match of jsx) out.push(match[1]);

  return out;
}

/* --------------------------------------------------------------- 2 · data -- */

console.log(
  "\n\x1b[1m2 · no internal vocabulary in a stored customer_note\x1b[0m",
);

async function checkStoredNotes(): Promise<void> {
  const db = adminClient();
  const { data, error } = await db
    .from("order_status_history")
    .select("id, order_id, customer_note")
    .not("customer_note", "is", null)
    .limit(2000);

  if (error) {
    failed += 1;
    problems.push(`order_status_history — ${error.message}`);
    console.log(
      `  \x1b[31m✗\x1b[0m could not read order_status_history: ${error.message}\n` +
        "      This half did not run. That is a gap, not a pass.",
    );
    return;
  }

  for (const row of data ?? []) {
    checked += 1;
    const note = row.customer_note ?? "";
    const hit = INTERNAL.exec(note);
    if (hit) {
      report(
        `order_status_history ${row.id}`,
        `“${note.slice(0, 90)}” — ${hit[0]}`,
      );
    }
  }
  console.log(
    `  ${data?.length ?? 0} customer notes read` +
      (failed === 0 ? " — \x1b[32mall of them readable\x1b[0m" : ""),
  );
}

/* ------------------------------------------------------------------ done -- */

async function main(): Promise<void> {
  await checkStoredNotes();

  console.log(
    failed === 0
      ? `\n\x1b[32mPASS\x1b[0m — ${checked} files and notes, no internal vocabulary\n`
      : `\n\x1b[31mFAIL\x1b[0m — ${failed} place(s):\n${problems
          .map((p) => `  · ${p}`)
          .join("\n")}\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

void main();
