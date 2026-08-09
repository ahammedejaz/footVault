/**
 * `npm run audit:parcel` — the shop's box is measured, and nothing guesses it.
 *
 * Two things, and the second is why this is a script rather than a note.
 *
 * **Is the parcel complete?** Every field of `site_settings.shipping_defaults`
 * has to be set, because Shiprocket cannot price a parcel with a missing
 * dimension and the code no longer invents one. When something is missing this
 * fails and says which field, in the words the admin form uses.
 *
 * **Can a literal come back?** `src/lib/shipping/quote.ts` used to carry
 * `FALLBACK = { weight_grams: 900, length_cm: 33, breadth_cm: 22, height_cm: 13,
 * pickup_postcode: "560001" }`, reached silently whenever the settings row was
 * incomplete. That constant was the shop's real shipping weight for most of two
 * phases without anybody deciding it was, and nothing anywhere said so — a
 * half-filled row and a filled one produced identical quotes for different
 * parcels. The owner's instruction for Batch 2 was that nothing may fall through
 * to a literal, and an instruction that is only honoured by whoever remembers it
 * is honoured until the next person. So the source is read here.
 *
 * This is the same shape of gate as `npm run audit:literals`, and for the same
 * reason: the rupee threshold escaped three times, twice after it had been
 * "fixed". A rule with a test survives a refactor.
 */

import { readFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed += 1;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

/* ------------------------------------------------ 1 · the source is clean -- */

console.log("\n\x1b[1m1 · no parcel dimension may be written down in code\x1b[0m");

const QUOTE_SOURCE = readFileSync("src/lib/shipping/quote.ts", "utf8");

/**
 * Code, not prose.
 *
 * The file's own header describes the deleted constant by name and quotes its
 * old values, which is documentation worth keeping — so comment bodies are
 * stripped before the check rather than the pattern being made cleverer. A
 * regex that tried to tell a comment from an assignment would fail in whichever
 * direction was least convenient.
 */
const CODE = QUOTE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /\/\/[^\n]*/g,
  "",
);

const BANNED: { what: string; pattern: RegExp; why: string }[] = [
  {
    what: "a packed weight",
    pattern: /weight_grams\s*:\s*\d/,
    why: "this is exactly how 900g lived here, unnoticed, for two phases",
  },
  {
    what: "a box length",
    pattern: /length_cm\s*:\s*\d/,
    why: "Shiprocket prices on volumetric weight, so a written-down side misprices every parcel",
  },
  {
    what: "a box breadth",
    pattern: /breadth_cm\s*:\s*\d/,
    why: "Shiprocket prices on volumetric weight, so a written-down side misprices every parcel",
  },
  {
    what: "a box height",
    pattern: /height_cm\s*:\s*[1-9]/,
    why: "the owner has not given this number yet, so any value here was invented",
  },
  {
    what: "a pickup PIN",
    pattern: /pickup_postcode\s*:\s*["']\d/,
    why: "every estimate is measured from here, so a wrong one is believable and wrong",
  },
];

for (const { what, pattern, why } of BANNED) {
  const hit = pattern.exec(CODE);
  check(
    `quote.ts does not write down ${what}`,
    hit === null,
    hit ? `found \`${hit[0].trim()}\` — ${why}` : "",
  );
}

check(
  "quote.ts still has no FALLBACK constant",
  !/\bconst\s+FALLBACK\b/.test(CODE),
  "the object this gate exists to keep deleted has come back",
);

/* ----------------------------------------------- 2 · the parcel is set ----- */

console.log("\n\x1b[1m2 · the shop's parcel is fully measured\x1b[0m");

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

const url = process.env.SUPABASE_STAGE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.env.SUPABASE_STAGE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * The field names as they are stored, and as the admin form labels them.
 *
 * Both, because the two audiences are different: a log line and a grep want the
 * stored key, and the person who has to go and type the number wants the label
 * on the box they type it into.
 */
const FIELDS: [string, string][] = [
  ["default_parcel_weight_grams", "Packed weight (grams)"],
  ["default_parcel_length_cm", "Box length (cm)"],
  ["default_parcel_breadth_cm", "Box breadth (cm)"],
  ["default_parcel_height_cm", "Box height (cm)"],
];

async function checkSettings() {
  if (!url || !key) {
    console.log(
      "  \x1b[33m!\x1b[0m skipped: no Supabase URL / service-role key in the environment.\n" +
        "      The source check above ran; the settings check needs a database.",
    );
  } else {
    const supabase = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await supabase
      .from("site_settings")
      .select("value")
      .eq("key", "shipping_defaults")
      .maybeSingle();

    if (error) {
      check("shipping_defaults is readable", false, error.message);
    } else if (!data?.value || typeof data.value !== "object") {
      check(
        "shipping_defaults exists and is an object",
        false,
        "the row is missing entirely — no quote can be taken at all",
      );
    } else {
      const row = data.value as Record<string, unknown>;
      const unset: string[] = [];

      for (const [field, label] of FIELDS) {
        const value = row[field];
        const ok = typeof value === "number" && Number.isFinite(value) && value > 0;
        if (!ok) unset.push(label);
        check(
          `${field} is set`,
          ok,
          ok
            ? ""
            : `it is ${value === undefined ? "absent" : JSON.stringify(value)}. ` +
              `Set "${label}" at /admin/settings.`,
        );
      }

      const pickup = row.pickup_postcode;
      check(
        "pickup_postcode is a six-digit PIN",
        typeof pickup === "string" && /^\d{6}$/.test(pickup),
        `it is ${JSON.stringify(pickup)} — every delivery estimate is measured from here`,
      );

      /**
       * The consequence, printed rather than left to be inferred from a red cross.
       *
       * Somebody running this because a customer said Pay on Delivery had vanished
       * needs to be told that these two facts are the same fact.
       */
      if (unset.length > 0) {
        console.log(
          `\n  \x1b[33mWhile ${unset.join(" and ")} ${unset.length === 1 ? "is" : "are"} unset:\x1b[0m\n` +
            "      · no Shiprocket quote can be taken, so delivery is priced from the estimate\n" +
            "      · Pay on Delivery is refused shop-wide — there is no round trip to secure it\n" +
            "      · creating a shipment fails at the button with the same message\n" +
            "      Nothing is guessed. Fill it in at /admin/settings and all three clear.",
        );
      }

      check(
        "the old 900g default is not still in the database",
        row.weight_grams === undefined && row.default_parcel_weight_grams !== 900,
        "the pre-Batch-2 field name or value survived the migration",
      );
    }
  }
}

async function main() {
  await checkSettings();

  console.log(
    `\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m`,
  );
  if (failed > 0) {
    console.log("\nFailures:");
    for (const failure of failures) console.log(`  · ${failure}`);
    process.exit(1);
  }
}

void main();
