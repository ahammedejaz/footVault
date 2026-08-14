/**
 * `npm run audit:contact` — the shop's published contact details are the
 * shop's, and they work.
 *
 * ## The measurement that made this a gate
 *
 * On 2026-08-14 the launch audit read `site_settings.contact` on **production**
 * and found:
 *
 *     phone     +91 91602 52643                     ← real, and Andhra Pradesh
 *     email     inquiry@footvault.in                 ← real
 *     address   …Near RTC Bus Stand, Cuddapah…       ← real, wrong town
 *     whatsapp  +91 98450 22001                      ← the seed fixture, byte for byte
 *
 * Three of the four had been updated to the real shop. The fourth still held
 * the number `scripts/seed-data.ts` invents for staging — and it is the one the
 * returns policy routes damage claims through, inside a 24-hour deadline.
 *
 * Nothing caught it, and nothing *could* have, because a fixture that leaks
 * into production does not look like a bug. It looks like data.
 *
 * ## The rule
 *
 * A production contact value that is byte-identical to its seed fixture is a
 * fixture, not a decision. That is a mechanical comparison against the seed
 * file rather than a judgement about which numbers look real, so it stays true
 * when the fixtures change and it cannot be argued with.
 *
 * ## What this deliberately does not check
 *
 * Whether the number **answers**. Only a person can do that, and this gate
 * failing is what puts it in front of one. The plan's rule stands: owner
 * confirmation gates the deploy of the WhatsApp link, not merely its copy.
 *
 * Reads `.env.local` verbatim and therefore production, like `literals.ts` and
 * `privacy-processors.ts`, and for the same reason: the thing being checked is
 * the shop's own published data, and a staging row would be an assertion about
 * fixtures. It writes nothing, anywhere.
 */

import { readFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";

import { whatsappHref } from "../../src/lib/contact";
import { siteSettings } from "../seed-data";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

let failed = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    return;
  }
  failed += 1;
  console.log(
    `  \x1b[31m✗\x1b[0m ${label}${detail ? `\n      ${detail}` : ""}`,
  );
}

/** The fixture value for one field of one settings row, or null. */
function fixture(key: string, field: string): string | null {
  const row = siteSettings.find((setting) => setting.key === key);
  const value = row?.value;
  if (!value || typeof value !== "object") return null;
  const held = (value as Record<string, unknown>)[field];
  return typeof held === "string" ? held : null;
}

function asRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      typeof v === "string" ? v : "",
    ]),
  );
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log(
      "\n  \x1b[31m✗\x1b[0m NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set —\n" +
        "      the shop's own settings could not be read. That is a gap, not a pass.",
    );
    process.exit(1);
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await supabase
    .from("site_settings")
    .select("key, value")
    .in("key", ["contact", "social"]);

  if (error) {
    console.log(
      `\n  \x1b[31m✗\x1b[0m site_settings unreadable: ${error.message}`,
    );
    process.exit(1);
  }

  const byKey = new Map((data ?? []).map((row) => [row.key, row.value]));
  const contact = asRecord(byKey.get("contact"));
  const social = asRecord(byKey.get("social"));

  /* ------------------------------------------------- 1 · nothing is a fixture -- */

  console.log(
    "\n\x1b[1m1 · no published detail is still the seed fixture\x1b[0m",
  );

  const fields: { key: string; field: string; what: string }[] = [
    { key: "contact", field: "phone", what: "the number a customer rings" },
    {
      key: "contact",
      field: "whatsapp",
      what: "the channel the returns policy sends damage claims to, inside 24 hours",
    },
    { key: "contact", field: "email", what: "where enquiries arrive" },
    {
      key: "contact",
      field: "address",
      what: "the shop's address, and what LocalBusiness will claim",
    },
    {
      key: "social",
      field: "instagram",
      what: "a profile `sameAs` will tell Google is this business",
    },
    {
      key: "social",
      field: "facebook",
      what: "a profile `sameAs` will tell Google is this business",
    },
  ];

  for (const { key, field, what } of fields) {
    const live = (key === "contact" ? contact : social)[field] ?? "";
    const seeded = fixture(key, field);
    if (!live) {
      console.log(`  \x1b[90m·\x1b[0m ${key}.${field} — not set`);
      continue;
    }
    check(
      `${key}.${field} is not the seed fixture`,
      seeded === null || live.trim() !== seeded.trim(),
      `"${live}" is byte-identical to scripts/seed-data.ts. It is ${what}. ` +
        "Either the owner has confirmed this value and it happens to match the " +
        "fixture — change the fixture — or staging data is live on the shop.",
    );
  }

  /* --------------------------------------------------- 2 · the details work -- */

  console.log(
    "\n\x1b[1m2 · the details a customer needs are present and usable\x1b[0m",
  );

  check(
    "a phone number is published",
    Boolean(contact.phone?.trim()),
    "the returns policy tells a customer to call. There is nothing to call.",
  );
  check(
    "an email address is published",
    Boolean(contact.email?.trim()),
    "nothing on the site says where to write.",
  );
  check(
    "a shop address is published",
    Boolean(contact.address?.trim()),
    "LocalBusiness needs a full postal address and the local pack is judged on it.",
  );

  const whatsapp = contact.whatsapp?.trim() ?? "";
  check(
    "a WhatsApp number is published",
    Boolean(whatsapp),
    "the returns policy names WhatsApp as a route for damage claims.",
  );
  if (whatsapp) {
    check(
      `WhatsApp normalises to a wa.me link (${whatsappHref(whatsapp) ?? "—"})`,
      whatsappHref(whatsapp) !== null,
      `"${whatsapp}" has ${whatsapp.replace(/\D/g, "").length} digits. wa.me ` +
        "needs a country code and 10–15 digits, so this renders as plain text " +
        "and the link the returns policy relies on does not exist.",
    );
  }

  console.log(
    failed === 0
      ? "\n\x1b[1mThe shop's published contact details are the shop's own.\x1b[0m\n"
      : `\n\x1b[31m${failed} problem${failed === 1 ? "" : "s"}.\x1b[0m\n` +
          "A contact detail is a promise that somebody answers. See\n" +
          "src/lib/contact.ts and scripts/seed-data.ts.\n",
  );
  if (failed > 0) process.exit(1);
}

void main();
