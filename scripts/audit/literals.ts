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
 * So the rule reads **every owner-editable text column in the database**,
 * including inside jsonb.
 *
 * ## The fourth time, and it was not a rupee
 *
 * That claim about the list being "derived rather than typed" was aspirational
 * when it was written, and on 2026-08-14 the launch audit measured what it
 * actually cost. The gate was green. Meanwhile:
 *
 *   - `/page/returns` served
 *     `<meta name="description" content="Foot Vault's 7 day free return and
 *     size exchange policy.">` while the body of the same page said replacement
 *     only, no refunds, no size exchange, 24 hours. The single worst sentence on
 *     the shop, invisible to this file, because the `pages` surface was declared
 *     `columns: ["title", "body"]` and a meta description is neither.
 *   - `categories`, `products`, `product_images` and `brands` — every one of
 *     them owner-typed and customer-facing — were not surfaces at all.
 *   - The shipping page promised dispatch "before 4pm" against a pickup at
 *     11:00, and "3–5 working days" nationwide against a courier that quotes
 *     Delhi 7. Both are policy figures going stale. Neither contains a `₹`.
 *
 * Two fixes, and they are the general form of those three failures rather than
 * a patch for each:
 *
 *   1. **Columns are opt-out.** Every string and jsonb column of every surface
 *      is scanned unless it is skipped by name with a written reason. A named
 *      column list can only ever check the columns somebody remembered.
 *   2. **Units are not just rupees.** A day count and a clock time are promises
 *      with numbers in them, and go stale in exactly the way a threshold does.
 *
 * and a third that makes the first two hold: **every table in the schema must
 * be classified**, as a scanned surface or as not-content-with-a-reason,
 * checked against the generated types. A content table added next month cannot
 * be silently absent.
 *
 * ## The three sections
 *
 *   **Code.** No rupee figure in a component or a page. The linter cannot see
 *   the difference between a price and a paragraph, so the rule is simply "no
 *   currency literal in JSX", and everything resolves from `site_settings`
 *   through `formatPaise`.
 *
 *   **Paise.** The same figure spelled as configuration — `free_above_paise:
 *   249900` — which carries no rupee sign and reads as a constant.
 *
 *   **Content.** No rupee figure and no policy time figure in anything the
 *   owner types in the admin, where no lint rule will ever run, so the check has
 *   to read the database. `{{free_shipping_threshold}}` and `{{return_window}}`
 *   are what they write instead — see `src/lib/content-tokens.ts`.
 *
 * Run without a browser and without a build; it needs the database only for the
 * third section, and says so rather than passing silently if it cannot reach it.
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

import { createClient } from "@supabase/supabase-js";

/**
 * **This gate's content half has never actually run.**
 *
 * It reads `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from
 * `process.env` — and nothing put them there. `npm run audit:literals` is
 * `tsx scripts/audit/literals.ts`, and npm does not read `.env.local`, so the
 * check printed its honest "skipped: … not set. That is a gap, not a pass" on
 * every single run and nobody read it as *the half that matters has never
 * executed*.
 *
 * It matters because the ₹2,499 incident's third recurrence was **in content**:
 * `homepage_sections.payload` still promised "Free shipping over ₹2,499" after
 * this gate was written and passing, and it was found by curling the deployed
 * site rather than by the gate.
 *
 * `.env.local` verbatim, deliberately, and this file is one of the two the
 * `audit:fixtures-guard` import check exempts by name: the content that matters
 * is the **shop's own** owner-edited copy, and pointing this at a seeded staging
 * database would turn a real assertion into an assertion about fixtures. It
 * writes nothing, anywhere.
 */
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

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

/* -------------------------------------------------------------- 2 · paise -- */

/**
 * The other half of the same mistake, and the half that got past section 1
 * twice.
 *
 * A rupee figure typed as `₹2,499` is caught above. The same figure typed as
 * `free_above_paise: 249900` is not: there is no rupee sign in it, so the
 * currency rule cannot see it, and it reads as configuration rather than as
 * copy. Both of the fallbacks removed in this preflight were that shape, and
 * both had been sitting in the tree while the gate above passed:
 *
 *   - `src/app/(storefront)/product/[slug]/page.tsx:82`
 *   - `src/lib/queries/cart.ts:109`
 *
 * They mattered because the production row says **₹1,599**, not ₹2,499. The two
 * numbers had already diverged and nothing surfaced it, because a fallback only
 * runs when the real value is unavailable — the one moment nobody is watching.
 *
 * ## What counts as an offence
 *
 * A **nonzero numeric literal assigned to a paise-named identifier**. That is
 * the whole rule, and each half of it is doing work:
 *
 *   - *Assigned*, so `capturedPaise === 0` and `refundPaise <= 0` are untouched.
 *     A comparison reads a number, it does not invent one.
 *   - *Numeric literal*, so `optionalPaise(partial.x, 0)` and
 *     `minOrderPaise: Math.round(Number(minOrder) * 100)` are untouched. A value
 *     computed from an input came from somewhere.
 *   - *Nonzero*, because zero is not a price. `balanceDuePaise: 0` is an empty
 *     accumulator or an explicit absence — "no cap", "deduct nothing" — and the
 *     server-side settings module already reasons about that distinction
 *     carefully at `src/lib/shipping/settings.ts:222-226`.
 *
 * ## Why all of `src/` rather than `src/` outside `lib/`
 *
 * The brief scoped this to "outside `lib/`". That scope does not hold, and the
 * reason is worth keeping: **one of the two offenders it was written to catch
 * lives in `src/lib/queries/cart.ts`**. A gate that misses half the thing it was
 * commissioned for is the failure mode this file's own header describes — "a
 * gate that checks the two places you already fixed is a gate that proves you
 * fixed them".
 *
 * The scope was presumably drawn to protect the genuine paise constants that do
 * live in `lib/`. Those are handled by name below instead, which is stricter:
 * they stay visible, each carries a reason, and a fourth one cannot appear
 * without somebody writing down why.
 */

console.log("\n\x1b[1m2 · no paise literal in code\x1b[0m");

/**
 * A paise-named identifier assigned a bare number.
 *
 * `[:=]` matches a single character, so `===`, `!==`, `<=` and `>=` fall out for
 * free: after the operator the pattern needs whitespace then a digit, and the
 * second `=` is neither.
 *
 * The value must be the *entire* right-hand side — digits, optional `_`
 * separators, then the end of the statement — so a literal buried in an
 * expression is deliberately not matched. `x * 100` is arithmetic; `x: 100` is a
 * decision.
 */
const PAISE_ASSIGNMENT =
  /\b([A-Za-z_$][A-Za-z0-9_$]*(?:_paise|Paise|_PAISE))\s*[:=]\s*([0-9][0-9_]*)\s*[,;)]*\s*$/;

/**
 * Paise constants that are **definitions rather than policy**, by identifier.
 *
 * Keyed on the name and not the line, so moving one does not silently drop its
 * justification. Each entry says why the number is not a thing the owner would
 * ever want to change from the admin panel, because that is the actual test: if
 * a shopkeeper could reasonably want it different, it belongs in `site_settings`
 * and not in a `const`.
 */
const ALLOWED_PAISE = new Map<string, string>([
  [
    "RUPEE_IN_PAISE",
    "the definition of the unit — one rupee is a hundred paise, and no owner setting can change that",
  ],
  [
    "MIN_CHARGEABLE_PAISE",
    "Razorpay's own floor on a charge, an external constraint the shop does not get a say in",
  ],
  [
    "ROUND_UP_TO_PAISE",
    "the granularity delivery fees round to, a presentation rule rather than a price",
  ],
]);

const paiseFiles = execSync("git ls-files 'src/**/*.ts' 'src/**/*.tsx'", {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

let paiseScanned = 0;
let paiseAllowed = 0;
const paiseFailedBefore = failed;
for (const file of paiseFiles) {
  const lines = readFileSync(file, "utf8").split("\n");

  let inBlockComment = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();

    // Same comment handling as section 1, and for the same reason: the
    // reasoning in this codebase quotes real figures from real orders.
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
    const match = PAISE_ASSIGNMENT.exec(code);
    if (!match) return;

    const [, identifier, rawValue] = match;
    if (Number(rawValue.replace(/_/g, "")) === 0) return;

    if (ALLOWED_PAISE.has(identifier)) {
      paiseAllowed += 1;
      console.log(
        `  \x1b[90m·\x1b[0m ${file}:${index + 1}: ${identifier} — ` +
          `allowed: ${ALLOWED_PAISE.get(identifier)}`,
      );
      return;
    }

    report(
      `${file}:${index + 1}`,
      `${trimmed.slice(0, 90)}  ← resolve ${identifier} from site_settings`,
    );
  });
  paiseScanned += 1;
}

console.log(
  failed === paiseFailedBefore
    ? `  \x1b[32m✓\x1b[0m ${paiseScanned} files, no typed paise figure` +
        (paiseAllowed > 0 ? ` (${paiseAllowed} named constants allowed)` : "")
    : `  ${paiseScanned} files scanned`,
);

/* ------------------------------------------------------------ 3 · content -- */

console.log(
  "\n\x1b[1m3 · no policy figure in owner-edited content\x1b[0m",
);

/**
 * A span of time — "24 hours", "3–5 working days", "within 7 days".
 *
 * ## Why this rule exists at all
 *
 * The currency rule above was written after a threshold escaped into copy three
 * times. A **day count** is the same defect wearing different units, and on
 * 2026-08-14 the audit found it had already happened in four places at once
 * while this gate ran green:
 *
 * | Surface | Said | The code said |
 * |---|---|---|
 * | `pages.meta_description` (`returns`) | "7 day free return" | replacement only, 24 hours, no refunds |
 * | `pages.body` (`shipping`) | "before 4pm" | `PICKUP_CUTOFF_HOUR_IST = 11` |
 * | `pages.body` (`shipping`) | "3–5 working days" | Delhi 7, Hyderabad and Bangalore 4, local 3 |
 * | `pages.body` (`privacy`) | "within 7 days" | nothing at all — an unbacked promise |
 *
 * Every one of those is a promise with a number in it, which is precisely what
 * the currency rule exists to stop; it simply could not see them, because it
 * was looking for `₹`.
 *
 * ## The shape of the pattern
 *
 * A digit, optionally a range, then a unit of time. `[\s-]*` between them so
 * "24-hour" is caught alongside "24 hours" — the hyphenated form is the one a
 * copywriter reaches for and it would otherwise walk straight through.
 *
 * "one day" and "a fortnight" are deliberately **not** matched. The rule is
 * about a *figure* going stale against a setting, and a word does not read as a
 * value somebody will forget to update. `{{return_window}}` resolves to "24
 * hours" today and "3 days" if the owner raises it, so the token is what a
 * sentence should carry either way.
 */
const TIME_SPAN =
  /\b\d{1,3}(?:\s*[–—-]\s*\d{1,3})?[\s-]*(?:working\s+days?|business\s+days?|hours?|hrs?|days?|weeks?|months?)\b/i;

/**
 * A time of day — "4pm", "11:00", "10:30 – 20:30".
 *
 * The shipping page promised dispatch "before 4pm" while pickup is at 11:00,
 * which is not a rounding error: it is five hours of orders told they go out
 * today when they go out tomorrow.
 */
const CLOCK_TIME = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b/i;

/**
 * **Every** distinct time literal in a string, in the order they appear.
 *
 * Every, rather than the first, and the shipping page is why. Its body carries
 * both "3–5 working days" and "before 4pm"; a first-match rule reported the
 * range, and the cutoff — the one that was wrong by five hours — would only
 * have surfaced on the next run, after somebody had already fixed the range and
 * believed the page was clean. A gate that reveals one defect per run teaches
 * the reader that green means finished when it means *finished for now*.
 *
 * Deduplicated by the matched text, so a page saying "24 hours" three times is
 * one line of output and not three.
 */
function timeLiterals(text: string): string[] {
  const all = [
    ...text.matchAll(new RegExp(TIME_SPAN.source, "gi")),
    ...text.matchAll(new RegExp(CLOCK_TIME.source, "gi")),
  ].map((m) => m[0]);
  return [...new Set(all)];
}

/**
 * Time figures that are the **definition of a thing** rather than a promise
 * about one, keyed by the surface they live in.
 *
 * Keyed by surface rather than by matched text, in the manner of
 * `ALLOWED_PAISE` above: moving the value does not silently drop its
 * justification, and an exemption that says *which field* is exempt is far
 * narrower than one that pardons a string wherever it appears.
 *
 * Each entry carries its reason. An allowlist without one is a list of things
 * somebody once found annoying.
 */
const ALLOWED_TIME = new Map<string, string>([
  [
    "site_settings.value (business_hours)",
    "the opening hours themselves — this row is the source every page resolves from, so the figure in it is the setting rather than a copy of one",
  ],
]);

/**
 * Every table the owner can type into, and which columns are prose.
 *
 * ## Columns are opt-**out**, and that inversion is the fix
 *
 * This surface list used to name its columns — `pages` was declared
 * `["title", "body"]` — and on 2026-08-14 that omission was the reason the
 * worst copy defect on the shop survived a sweep that was specifically looking
 * for it: `/page/returns` served
 * `<meta name="description" content="Foot Vault's 7 day free return and size
 * exchange policy.">` while the body said replacement only, 24 hours, no
 * refunds. The gate read `title` and `body`, found nothing, and printed a tick.
 *
 * A named column list can only ever check the columns somebody remembered. So
 * **every string and jsonb column is scanned unless it is skipped by name with
 * a written reason** — the same trick as `GATES`/`EXCLUDED` in `run-all.ts` and
 * `SETTINGS_VISIBILITY`: make forgetting fail rather than pass. A meta
 * description added next year is covered the day the column exists.
 *
 * Non-string, non-object values are skipped by type: a `price_paise` integer or
 * an `is_published` boolean cannot carry a sentence.
 */
type Surface = {
  table: string;
  /** Columns deliberately not scanned, each with why. */
  skip?: Record<string, string>;
  label: (row: Record<string, unknown>) => string;
};

const SURFACES: Surface[] = [
  { table: "pages", label: (r) => String(r.slug) },
  { table: "site_settings", label: (r) => String(r.key) },
  { table: "homepage_sections", label: (r) => String(r.section_type) },
  { table: "banners", label: (r) => String(r.placement ?? r.id) },
  { table: "collections", label: (r) => String(r.slug) },
  /*
    Both were absent entirely until 2026-08-14, and both are owner-typed from
    the admin and rendered to customers. `products` is the larger hole of the
    two: a description promising free delivery over a figure is the ₹2,499
    incident with a different table name.
  */
  { table: "categories", label: (r) => String(r.slug) },
  { table: "products", label: (r) => String(r.slug) },
  { table: "product_images", label: (r) => String(r.alt_text ?? r.id) },
  { table: "brands", label: (r) => String(r.slug) },
];

/**
 * Column names that are never prose, wherever they appear.
 *
 * Kept deliberately short. The temptation is to list everything structural —
 * ids, urls, slugs — but a uuid and a URL contain neither a rupee sign nor a
 * clock, so scanning them costs nothing and skipping them would be a rule
 * nobody could later tell was load-bearing. Only `_at` earns its place: a
 * timestamp really does contain `12:39:24`, and that clock is a row's age
 * rather than a promise to a customer.
 */
const NOT_PROSE: { test: RegExp; reason: string }[] = [
  {
    test: /_at$/,
    reason:
      "a timestamp — the clock inside `2026-08-07 12:39:24+00` is when the row changed, not a time the shop promised anybody",
  },
];

/**
 * Tables that hold no owner-typed copy, each with why.
 *
 * The list exists so that **adding a content table without adding it above is a
 * failure rather than an omission** — the drift check below compares this plus
 * `SURFACES` against every table in `src/lib/database.types.ts`. That file is
 * generated from the schema, so a new table appears in it the moment it is
 * migrated, and this gate goes red until somebody has decided which half it
 * belongs in.
 *
 * This gate's own header warns that "adding a content table without adding it
 * here is the way this happens a fourth time", and until 2026-08-14 nothing
 * enforced it: `categories`, `products`, `product_images` and `brands` had all
 * been missing since the list was written.
 */
const NOT_CONTENT: Record<string, string> = {
  addresses: "a customer's own delivery address",
  cart_items: "what is in somebody's bag",
  carts: "a bag, and its guest token",
  coin_accounts: "a loyalty balance",
  coin_transactions: "ledger entries — a record of what happened",
  collection_products: "a join table",
  coupon_customers: "who a coupon is restricted to",
  coupon_redemptions: "a record of a coupon being used",
  coupons: "codes and audiences, not sentences — the discount is a figure the checkout computes, never copy",
  inbound_emails: "mail the shop received",
  integration_tokens: "credentials",
  inventory_movements: "stock ledger entries",
  order_items: "a snapshot of what was bought",
  order_status_history: "an audit trail",
  orders: "orders — customer-entered, and a record rather than copy",
  payment_events: "webhook payloads",
  payments: "provider references",
  product_variants: "sizes, colours and skus",
  profiles: "a customer's own name and phone",
  rate_limits: "counters",
  refunds: "provider references and a computed breakdown",
  reviews:
    "written by customers, not by the shop. A figure a reviewer types is their sentence and not a promise the shop is making",
  shipment_errors: "courier failures, for the owner to read",
  shipment_events: "courier webhooks",
  shipments: "courier references and raw responses",
  shipping_quotes: "cached courier rates — the live figures this gate exists to make the copy defer to",
  wishlist_items: "a join table",
};

async function checkContent(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.log(
      "  \x1b[33m!\x1b[0m skipped: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.\n" +
        "      The content half of this gate did not run. That is a gap, not a pass.",
    );
    return;
  }

  /* ---- 3a · every table is classified ---- */

  const declared = new Set([
    ...SURFACES.map((s) => s.table),
    ...Object.keys(NOT_CONTENT),
  ]);
  const schemaTables = tablesInGeneratedTypes();
  for (const table of schemaTables) {
    if (declared.has(table)) continue;
    report(
      `database.types.ts: ${table}`,
      "is neither a scanned surface nor listed in NOT_CONTENT — decide which, " +
        "with a reason. A content table nobody classified is how a policy " +
        "figure hides.",
    );
  }
  for (const table of declared) {
    if (schemaTables.has(table)) continue;
    report(
      `literals.ts: ${table}`,
      "is declared here but is not in the schema — regenerate types or remove it.",
    );
  }
  if (schemaTables.size > 0) {
    console.log(
      `  \x1b[32m✓\x1b[0m ${schemaTables.size} tables, every one classified ` +
        `(${SURFACES.length} scanned, ${Object.keys(NOT_CONTENT).length} not content)`,
    );
  }

  /* ---- 3b · every prose column in every surface ---- */

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  for (const surface of SURFACES) {
    const { data, error } = await supabase
      .from(surface.table)
      .select("*")
      .overrideTypes<Record<string, unknown>[]>();

    if (error) {
      report(surface.table, `could not be read: ${error.message}`);
      continue;
    }

    const rows = data ?? [];
    const scannedColumns = new Set<string>();
    const skippedColumns = new Set<string>();

    for (const row of rows) {
      for (const [column, value] of Object.entries(row)) {
        // A number, a boolean or a null cannot carry a sentence.
        if (value === null || value === undefined) continue;
        if (typeof value !== "string" && typeof value !== "object") continue;

        const shape = NOT_PROSE.find((rule) => rule.test.test(column));
        if (shape ?? surface.skip?.[column]) {
          skippedColumns.add(column);
          continue;
        }
        scannedColumns.add(column);

        // jsonb arrives as an object; stringifying is exactly right, because a
        // figure buried three levels down is still on the page.
        const text = typeof value === "string" ? value : JSON.stringify(value);
        const where = `${surface.table}.${column} (${surface.label(row)})`;

        if (CURRENCY.test(text) || RUPEES_WORD.test(text)) {
          if (ALLOWED.has(text.trim())) {
            console.log(
              `  \x1b[90m·\x1b[0m ${surface.table}.${column}: "${text.trim()}" — ` +
                `allowed: ${ALLOWED.get(text.trim())}`,
            );
          } else {
            const line =
              text
                .split("\n")
                .find((l) => CURRENCY.test(l) || RUPEES_WORD.test(l)) ?? text;
            report(where, line.trim().slice(0, 110));
          }
        }

        for (const found of timeLiterals(text)) {
          if (ALLOWED_TIME.has(where)) {
            console.log(
              `  \x1b[90m·\x1b[0m ${where}: "${found}" — ` +
                `allowed: ${ALLOWED_TIME.get(where)}`,
            );
            continue;
          }
          const line = text.split("\n").find((l) => l.includes(found)) ?? text;
          report(
            where,
            `"${found}" in: ${line.trim().slice(0, 90)}  ← resolve it from ` +
              `site_settings or the code through a {{token}}`,
          );
        }
      }
    }

    console.log(
      `  \x1b[32m✓\x1b[0m ${surface.table}: ${rows.length} rows, ` +
        `${scannedColumns.size} prose columns scanned` +
        (skippedColumns.size > 0
          ? ` (${[...skippedColumns].sort().join(", ")} skipped)`
          : ""),
    );
  }
}

/**
 * The public tables, read out of the generated types.
 *
 * Parsed rather than imported because types do not exist at runtime, and read
 * from the generated file rather than from `information_schema` because
 * PostgREST does not expose it — and because a file in the tree fails the same
 * way on every machine, which a live introspection query would not.
 */
function tablesInGeneratedTypes(): Set<string> {
  const source = readFileSync("src/lib/database.types.ts", "utf8");
  const block = /\n {4}Tables: \{\n([\s\S]*?)\n {4}Views: \{/.exec(source);
  if (!block) {
    report(
      "src/lib/database.types.ts",
      "no `Tables:` block found — the table drift check cannot run, which is a gap, not a pass.",
    );
    return new Set();
  }
  return new Set(
    [...block[1].matchAll(/^ {6}([a-z_][a-z0-9_]*): \{$/gm)].map((m) => m[1]),
  );
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
