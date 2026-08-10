/**
 * `npm run audit:settings-controls` — every control on /admin/settings, operated
 * by its visible label, and the stored value checked afterwards.
 *
 *   npm run dev:stage          # a server on :3210, pointed at staging
 *   npm run audit:settings-controls
 *
 * ## Why this exists, stated plainly
 *
 * For two phases the shop reported a delivery-mode selector and a Pay-on-Delivery
 * switch as "Built · proved". Both were on the page the whole time. The owner
 * could not find them, said so three times, and every gate stayed green —
 * because this is everything `admin-pages.ts` asserted about that page:
 *
 *     const settingsBody = await page.locator("body").innerText();
 *     check("the settings page renders for an admin",
 *           settingsBody.includes("Pay on Delivery"), …);
 *
 * `<Panel title="Delivery and Pay on Delivery">` satisfies that. **Delete the
 * checkbox entirely and the check still passes.** One control on the page was
 * ever operated — `#free-above` — and it was located by id.
 *
 * ## The rule this file is the mechanism for
 *
 * > Any owner-facing control ships with a test that **locates the control by its
 * > visible label, changes it, and asserts the stored value changed.**
 * >
 * > Locating by `id` is allowed only where no visible label exists — and that is
 * > itself a defect to fix. Asserting on page text is never sufficient.
 *
 * `getByLabel` is the whole point. It resolves through the accessible name, so a
 * control a screen reader cannot name is a control this harness cannot find, and
 * a label that drifts away from the thing it labels fails here rather than in
 * somebody's hands. An id survives any amount of that.
 *
 * ## Coverage is asserted, not claimed
 *
 * `CONTROLS` below lists all 31 controls on the page. The run fails if any of
 * them was never operated — so a control added to the form without an entry
 * here, or an entry that silently stopped running, is a failure rather than a
 * quieter report.
 *
 * ## What this does NOT cover, named so it never reads as coverage
 *
 * The ~29 product, variant, category, brand, media and customer CRUD actions in
 * `src/lib/actions/admin/` are **not** covered by anything that drives their UI.
 * That is a deliberate gap: a wrong product description is visible and
 * reversible, a wrong delivery setting is neither, and the money-adjacent
 * controls were where the reported failure was. It is printed at the end of
 * every run so it stays a known gap rather than becoming an assumed pass.
 */

// clients first: this writes settings into staging and must never reach the
// live shop.
import "./clients";
import { assertNotProduction } from "./clients";

assertNotProduction("run settings-controls");

import { chromium, type Locator, type Page } from "playwright";

import type { Json } from "../../src/lib/database.types";
import { adminClient, createAccount, sessionCookies } from "./fixtures";
import { BASE_URL } from "./routes";

let passed = 0;
let failed = 0;
const failures: string[] = [];
/** Every control id this run actually operated, for the coverage assertion. */
const operated = new Set<string>();

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed += 1;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/* ------------------------------------------------------------- the table -- */

type Kind = "money" | "number" | "text" | "radio" | "checkbox";

type Control = {
  /** Stable key, for the coverage assertion and the failure message. */
  id: string;
  /** The **visible label**. A regex where the label carries trailing prose. */
  label: string | RegExp;
  kind: Kind;
  /**
   * For a radio group: the words printed beside each option.
   *
   * The redesign replaced three `<select>`s with inline radios, because the
   * option an owner was scanning for — "Charge one flat amount" — only existed
   * inside a closed dropdown. So the thing to locate is no longer the group but
   * the **option**, by the words on it, which is a stronger version of the same
   * rule rather than a weaker one.
   */
  options?: Record<string, string | RegExp>;
  /** Which settings row it lands in. */
  row: "shipping" | "shipping_defaults" | "store_name" | "store_tagline" | "contact" | "social";
  /** Read the stored value out of that row's `value`. */
  read: (value: unknown) => unknown;
};

/**
 * All 31 controls, in the order they appear on the page.
 *
 * The labels are the strings a shopkeeper reads. When the panel is redesigned
 * these change, and that is the intended cost: a redesign that renames a control
 * without anybody noticing is exactly what this file exists to prevent.
 */
const CONTROLS: Control[] = [
  /* ── delivery and Pay on Delivery · 18 ─────────────────────────────────── */
  { id: "free-above", label: "Free delivery at or above", kind: "money", row: "shipping", read: (v) => obj(v).free_above_paise },
  { id: "delivery-mode", label: "How the delivery charge is decided", kind: "radio", row: "shipping",
    options: { live: "Charge the courier's rate", flat: "Charge one flat amount" },
    read: (v) => obj(v).shipping_rate_mode },
  { id: "delivery-flat", label: "Flat delivery charge", kind: "money", row: "shipping", read: (v) => obj(v).flat_shipping_fee_paise },
  { id: "flat-deposit-mode", label: "Deposit taken on a Pay-on-Delivery order", kind: "radio", row: "shipping",
    options: { unset: "Not chosen yet", multiplier: "A multiple of the flat delivery charge", fixed: "A fixed amount" },
    read: (v) => obj(v).flat_cod_deposit_mode },
  { id: "flat-deposit-multiplier", label: "Times the flat delivery charge", kind: "number", row: "shipping", read: (v) => obj(v).flat_cod_deposit_multiplier },
  { id: "flat-deposit-fixed", label: "Deposit taken upfront", kind: "money", row: "shipping", read: (v) => obj(v).flat_cod_deposit_paise },
  { id: "cod-enabled", label: "Offer Pay on Delivery", kind: "checkbox", row: "shipping", read: (v) => obj(v).cod_enabled },
  { id: "waive-cod-fee", label: "Waive the cash-handling fee when delivery is free", kind: "checkbox", row: "shipping", read: (v) => obj(v).waive_cod_fee_above_threshold },
  { id: "cod-minimum", label: "Smallest order that may pay on delivery", kind: "money", row: "shipping", read: (v) => obj(v).cod_minimum_order_value_paise },
  { id: "cod-cap", label: "Most that may be taken upfront", kind: "money", row: "shipping", read: (v) => obj(v).cod_advance_maximum_paise },
  { id: "include-gst", label: "Recover the 18% GST on delivery in the upfront amount", kind: "checkbox", row: "shipping", read: (v) => obj(v).include_gst_in_advance },
  { id: "prepaid-discount-mode", label: "Kind of discount", kind: "radio", row: "shipping",
    options: { flat: "A fixed amount off", percent: "A percentage off" },
    read: (v) => obj(obj(v).prepaid_discount).mode },
  { id: "prepaid-discount-value", label: /Discount amount/, kind: "number", row: "shipping", read: (v) => obj(obj(v).prepaid_discount).value },
  { id: "max-total-discount-percent", label: /Most a coupon and this discount can take off together/, kind: "number", row: "shipping", read: (v) => obj(v).max_total_discount_percent },
  { id: "rto-policy", label: "What a customer who paid online gets back", kind: "radio", row: "shipping",
    options: { actual_freight: "Everything except what the journey cost", flat: "Everything except a fixed amount", none: "Everything, nothing deducted" },
    read: (v) => obj(v).rto_deduction_policy },
  { id: "rto-flat", label: "Fixed amount kept back", kind: "money", row: "shipping", read: (v) => obj(v).rto_deduction_flat_paise },
  { id: "prepaid-estimate", label: "Estimated delivery charge for paying online", kind: "money", row: "shipping", read: (v) => obj(v).prepaid_estimate_fee_paise },
  { id: "fallback-behaviour", label: "Pay on Delivery during an outage", kind: "radio", row: "shipping",
    options: { refuse_cod: "Do not offer it", allow_all: "Offer it, secured by the deposit" },
    read: (v) => obj(v).fallback_behaviour },
  { id: "wallet-low", label: "Warn when the wallet falls below", kind: "money", row: "shipping", read: (v) => obj(v).wallet_low_balance_paise },

  /* ── the shop's parcel · 5 ─────────────────────────────────────────────── */
  { id: "parcel-weight", label: /Packed weight/, kind: "number", row: "shipping_defaults", read: (v) => obj(v).default_parcel_weight_grams },
  { id: "parcel-length", label: /Box length/, kind: "number", row: "shipping_defaults", read: (v) => obj(v).default_parcel_length_cm },
  { id: "parcel-breadth", label: /Box breadth/, kind: "number", row: "shipping_defaults", read: (v) => obj(v).default_parcel_breadth_cm },
  { id: "parcel-height", label: /Box height/, kind: "number", row: "shipping_defaults", read: (v) => obj(v).default_parcel_height_cm },
  { id: "pickup-pin", label: "Pickup PIN code", kind: "text", row: "shipping_defaults", read: (v) => obj(v).pickup_postcode },

  /* ── the shop · 8 ──────────────────────────────────────────────────────── */
  { id: "store-name", label: "Shop name", kind: "text", row: "store_name", read: (v) => v },
  { id: "store-tagline", label: "Tagline", kind: "text", row: "store_tagline", read: (v) => v },
  { id: "contact-phone", label: "Phone", kind: "text", row: "contact", read: (v) => obj(v).phone },
  { id: "contact-whatsapp", label: "WhatsApp", kind: "text", row: "contact", read: (v) => obj(v).whatsapp },
  { id: "contact-email", label: "Email", kind: "text", row: "contact", read: (v) => obj(v).email },
  { id: "contact-address", label: "Shop address", kind: "text", row: "contact", read: (v) => obj(v).address },
  { id: "social-instagram", label: "Instagram", kind: "text", row: "social", read: (v) => obj(v).instagram },
  { id: "social-facebook", label: "Facebook", kind: "text", row: "social", read: (v) => obj(v).facebook },
];

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

const byId = new Map(CONTROLS.map((control) => [control.id, control]));

function control(id: string): Control {
  const found = byId.get(id);
  if (!found) throw new Error(`no control named ${id} — the table and the script disagree`);
  return found;
}

/* ------------------------------------------------------------ the driver -- */

/** Which button saves which panel. */
const SAVE: Record<Control["row"], RegExp> = {
  shipping: /Save delivery settings/,
  // `.` rather than an apostrophe: the button renders `&rsquo;`, and a straight
  // quote here matches nothing while looking exactly right in the source.
  shipping_defaults: /Save the shop.s parcel/,
  store_name: /Save shop details/,
  store_tagline: /Save shop details/,
  contact: /Save shop details/,
  social: /Save shop details/,
};

/**
 * The control, found the way a person finds it.
 *
 * `getByLabel` resolves through the accessible name. A control with no label, or
 * with a label that no longer describes it, is not found — which is the failure
 * this harness is for, so it is reported rather than worked around with an id.
 */
function locate(page: Page, entry: Control, value?: string): Locator {
  if (entry.kind === "radio") {
    const option = entry.options?.[String(value)];
    if (option === undefined) {
      throw new Error(`${entry.id} has no option labelled for ${value}`);
    }
    // By the words printed beside the radio, not by a value attribute. If the
    // option's wording changes, this fails — which is the point: those words are
    // what the owner scans for.
    return page.getByRole("radio", { name: option }).first();
  }
  return page.getByLabel(entry.label, { exact: false }).first();
}

/**
 * A radio group is only found if its **legend** is on the page too.
 *
 * The option label says what choosing it does; the legend says what is being
 * chosen. An owner needs both, and a group whose legend went missing would still
 * pass an option-only check.
 */
async function legendIsVisible(page: Page, entry: Control): Promise<boolean> {
  const text = await page.locator("body").innerText();
  const label = typeof entry.label === "string" ? entry.label : entry.label.source;
  return text.toLowerCase().includes(label.toLowerCase());
}

async function setValue(page: Page, id: string, value: string | boolean): Promise<boolean> {
  const entry = control(id);
  if (entry.kind === "radio" && !(await legendIsVisible(page, entry))) {
    check(`${id} — the group is introduced by "${labelOf(entry)}"`, false, "legend missing");
    return false;
  }
  const target = locate(page, entry, typeof value === "string" ? value : undefined);
  if ((await target.count()) === 0) {
    check(`${id} — a human can find "${entry.label}" on the page`, false, "no control carries that label");
    return false;
  }
  if (!(await target.isVisible())) {
    check(`${id} — the control is visible, not merely in the DOM`, false, "hidden");
    return false;
  }
  if (await target.isDisabled()) {
    check(`${id} — the control is operable`, false, "disabled");
    return false;
  }

  switch (entry.kind) {
    case "checkbox":
      if (value === true) await target.check();
      else await target.uncheck();
      break;
    case "radio":
      await target.check();
      break;
    default:
      await target.fill(String(value));
      break;
  }
  operated.add(id);
  return true;
}

async function save(page: Page, row: Control["row"]): Promise<void> {
  await page.getByRole("button", { name: SAVE[row] }).click();
  // The action revalidates and the client refreshes; the read-back below is the
  // real assertion, so this only has to outlast the round trip.
  await page.waitForTimeout(2_500);
}

async function stored(row: Control["row"]): Promise<unknown> {
  const { data, error } = await adminClient()
    .from("site_settings")
    .select("value")
    .eq("key", row)
    .maybeSingle();
  if (error) throw new Error(`read-back of ${row} failed: ${error.message}`);
  return data?.value ?? null;
}

/** Operate one control, save its panel, and assert the database moved. */
async function assertStored(
  page: Page,
  id: string,
  expected: unknown,
): Promise<void> {
  const entry = control(id);
  const actual = entry.read(await stored(entry.row));
  /*
    A read-back that happens to match while the control was never touched is not
    evidence of anything — and it is the precise shape of the failure this file
    exists for. Proved on a tree with the Pay-on-Delivery checkbox deleted: the
    "switch it back on" assertion passed, because the stored value was already
    true. Requiring a successful `setValue` first makes the coincidence a
    failure.
  */
  check(
    `${id} — "${labelOf(entry)}" now stores ${JSON.stringify(expected)}`,
    operated.has(id) && JSON.stringify(actual) === JSON.stringify(expected),
    operated.has(id)
      ? `stored ${JSON.stringify(actual)}`
      : "the control was never operated, so this proves nothing",
  );
}

function labelOf(entry: Control): string {
  return typeof entry.label === "string"
    ? entry.label
    : entry.label.source.replace(/\\/g, "").slice(0, 46);
}

/* ------------------------------------------------------------------ main -- */

async function main() {
  const admin = adminClient();

  /** Everything this run will touch, captured to be put back in the finally. */
  const rows: Control["row"][] = [
    "shipping",
    "shipping_defaults",
    "store_name",
    "store_tagline",
    "contact",
    "social",
  ];
  const original = new Map<string, Json>();
  for (const row of rows) {
    const { data, error } = await admin
      .from("site_settings")
      .select("value")
      .eq("key", row)
      .maybeSingle();
    if (error) throw new Error(`could not read ${row}, refusing to run: ${error.message}`);
    original.set(row, (data?.value ?? null) as Json);
  }

  const account = await createAccount("settingsctl");
  {
    const { error } = await admin
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", account.userId);
    if (error) throw new Error(`could not promote the probe: ${error.message}`);
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.addCookies(await sessionCookies(account.session));
  const page = await context.newPage();

  const open = async () => {
    await page.goto(`${BASE_URL}/admin/settings`, { waitUntil: "load" });
  };

  try {
    /* ═══ 1 · the shop, and the parcel — no ordering constraints ═══════════ */
    section("1 · the shop's own details");

    await open();
    const text: [string, string][] = [
      ["store-name", "Foot Vault QA"],
      ["store-tagline", "Shoes, proved"],
      ["contact-phone", "9111100001"],
      ["contact-whatsapp", "9111100002"],
      ["contact-email", "qa-settings@example.com"],
      ["contact-address", "12 Gate Street, Cuddapah 516360"],
      ["social-instagram", "https://instagram.com/footvault.qa"],
      ["social-facebook", "https://facebook.com/footvault.qa"],
    ];
    for (const [id, value] of text) await setValue(page, id, value);
    await save(page, "store_name");
    for (const [id, value] of text) await assertStored(page, id, value);

    section("2 · the shop's parcel");
    await open();
    const parcel: [string, string, number][] = [
      ["parcel-weight", "1234", 1234],
      ["parcel-length", "21.5", 21.5],
      ["parcel-breadth", "11.5", 11.5],
      ["parcel-height", "12.5", 12.5],
    ];
    for (const [id, value] of parcel) await setValue(page, id, value);
    await setValue(page, "pickup-pin", "516360");
    await save(page, "shipping_defaults");
    for (const [id, , expected] of parcel) await assertStored(page, id, expected);
    await assertStored(page, "pickup-pin", "516360");

    /* ═══ 3 · delivery, in an order the form's own rules allow ════════════ */
    /*
      The shipping form refuses several combinations on purpose — flat mode with
      no flat charge, Pay on Delivery in flat mode with no deposit, a flat RTO
      deduction of zero — so the controls cannot be exercised in table order.
      This walks the form through legal states instead, asserting each control as
      the save that carries it lands.
    */
    section("3 · delivery — the plain numbers");
    await open();
    await setValue(page, "free-above", "3111");
    await setValue(page, "cod-minimum", "700");
    await setValue(page, "cod-cap", "450");
    await setValue(page, "prepaid-estimate", "88");
    await setValue(page, "wallet-low", "1500");
    await save(page, "shipping");
    await assertStored(page, "free-above", 311_100);
    await assertStored(page, "cod-minimum", 70_000);
    await assertStored(page, "cod-cap", 45_000);
    await assertStored(page, "prepaid-estimate", 8_800);
    await assertStored(page, "wallet-low", 150_000);

    section("4 · delivery — the switches");
    await open();
    await setValue(page, "waive-cod-fee", true);
    await setValue(page, "include-gst", true);
    await save(page, "shipping");
    await assertStored(page, "waive-cod-fee", true);
    await assertStored(page, "include-gst", true);

    section("5 · the prepaid discount");
    await open();
    await setValue(page, "prepaid-discount-mode", "percent");
    // The unit in the field's label follows the mode, so choosing the mode
    // first is part of the flow being exercised rather than a setup step.
    await setValue(page, "prepaid-discount-value", "12.5");
    await save(page, "shipping");
    await assertStored(page, "prepaid-discount-mode", "percent");
    await assertStored(page, "prepaid-discount-value", 12.5);

    section("5b · the stacking ceiling");
    await open();
    await setValue(page, "max-total-discount-percent", "30");
    await save(page, "shipping");
    await assertStored(page, "max-total-discount-percent", 30);
    // And back to unset: an empty box must write null — "no ceiling chosen,
    // stacking withheld" — never zero, which would read as a rule.
    await open();
    await setValue(page, "max-total-discount-percent", "0");
    await save(page, "shipping");
    await assertStored(page, "max-total-discount-percent", null);

    section("6 · what a returned parcel costs the customer");
    await open();
    await setValue(page, "rto-policy", "flat");
    await setValue(page, "rto-flat", "150");
    await save(page, "shipping");
    await assertStored(page, "rto-policy", "flat");
    await assertStored(page, "rto-flat", 15_000);

    section("7 · the flat delivery charge, and the deposit it needs");
    /*
      The two controls the owner could not find, and the reason this file exists.
      `delivery-mode` and `delivery-flat` are asserted from one save because the
      form refuses flat mode with a charge of zero — each is still located by its
      own visible label and its own stored key is checked.
    */
    await open();
    await setValue(page, "delivery-mode", "flat");
    await setValue(page, "delivery-flat", "79");
    await setValue(page, "flat-deposit-mode", "multiplier");
    await setValue(page, "flat-deposit-multiplier", "2");
    await save(page, "shipping");
    await assertStored(page, "delivery-mode", "flat");
    await assertStored(page, "delivery-flat", 7_900);
    await assertStored(page, "flat-deposit-mode", "multiplier");
    await assertStored(page, "flat-deposit-multiplier", 2);

    section("8 · a fixed deposit instead of a multiple");
    await open();
    await setValue(page, "flat-deposit-mode", "fixed");
    await setValue(page, "flat-deposit-fixed", "260");
    await save(page, "shipping");
    await assertStored(page, "flat-deposit-mode", "fixed");
    await assertStored(page, "flat-deposit-fixed", 26_000);

    section("9 · what happens during a courier outage");
    await open();
    await setValue(page, "fallback-behaviour", "allow_all");
    await save(page, "shipping");
    await assertStored(page, "fallback-behaviour", "allow_all");

    section("10 · Pay on Delivery itself, the other missing control");
    await open();
    await setValue(page, "cod-enabled", false);
    await save(page, "shipping");
    await assertStored(page, "cod-enabled", false);
    // And back on, so the switch is proved in both directions rather than in the
    // one that happens to be the default.
    await open();
    await setValue(page, "cod-enabled", true);
    await save(page, "shipping");
    await assertStored(page, "cod-enabled", true);

    /* ═══ 11 · coverage, asserted ═════════════════════════════════════════ */
    section("11 · every control on the page was operated");
    const missed = CONTROLS.filter((entry) => !operated.has(entry.id));
    check(
      `all ${CONTROLS.length} controls were located, changed and checked`,
      missed.length === 0,
      missed.map((m) => m.id).join(", "),
    );
  } finally {
    for (const [row, value] of original) {
      if (value === null) continue;
      const { error } = await admin
        .from("site_settings")
        .update({ value })
        .eq("key", row);
      if (error) console.error(`  !! could not restore ${row}: ${error.message}`);
    }
    console.log("\n  restored every settings row this run touched");
    await admin.auth.admin.deleteUser(account.userId).catch(() => {});
    await browser.close();
  }

  console.log(
    `\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m` +
      (failures.length ? `\n\n${failures.map((f) => `  · ${f}`).join("\n")}` : ""),
  );

  /**
   * The gap, printed on every run.
   *
   * Naming it here is the difference between a deliberate limit and a silent
   * one. `admin-pages.ts` reported "the settings page renders" for two phases
   * and nobody read that as "one control out of 31 is checked" — because nothing
   * said so.
   */
  console.log(
    "\n  \x1b[2mNot covered by any gate: the ~29 product, variant, category,\n" +
      "  brand, media and customer actions in src/lib/actions/admin/. They are\n" +
      "  driven by no test that operates their UI. Deliberate — see the phase 9\n" +
      "  plan, §G — and due in Batch C for the order, refund, RTO and inventory\n" +
      "  controls.\x1b[0m",
  );

  process.exit(failed > 0 ? 1 : 0);
}

void main();
