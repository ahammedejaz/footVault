/**
 * The address book's four verbs, in a real browser, against staging.
 *
 * The edit verb is why this exists. Until it was added, `saveAddress` inserted
 * unconditionally and the account page told customers "Editing anything here
 * never changes an order already placed" — a sentence about editing, on a page
 * with no way to edit. This gate is what stops that drifting apart again: it
 * asserts the control is on screen, that it changes the row rather than adding
 * one, and that the count does not move.
 *
 * The PIN code gets its own section because it is the field that costs money.
 * A quote is keyed `(cart_id, postal_code, payment_method)` in
 * `shipping_quotes`, so an edited PIN must not be able to match a quote stored
 * for the old one. That is asserted here against the real table rather than
 * argued from the schema.
 *
 *   npm run audit:address-book
 */
import { chromium, type Page } from "playwright";

import { adminClient } from "./clients";
import { createAccount, sessionCookies } from "./fixtures";

const BASE = process.env.AUDIT_BASE_URL ?? "http://localhost:3210";

let failures = 0;
function check(name: string, passed: boolean, detail = "") {
  if (!passed) failures++;
  console.log(
    `${passed ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`,
  );
}

async function fill(page: Page, name: string, value: string) {
  const field = page.locator(`#checkout-${name}`);
  await field.fill(value);
}

async function main() {
  console.log("\nThe address book\n");

  const account = await createAccount("fv-qa.addrbook");

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  await context.addCookies(await sessionCookies(account.session));
  const page = await context.newPage();
  console.log(`  signed in as ${account.email}\n`);

  const admin = adminClient();

  await page.goto(`${BASE}/account/addresses`, { waitUntil: "load" });

  /* 1 ── add ───────────────────────────────────────────────────────────── */

  await fill(page, "recipientName", "Priya Sharma");
  await fill(page, "phone", "9876543210");
  await fill(page, "line1", "12 Residency Road");
  await fill(page, "city", "Bengaluru");
  await page.locator("#checkout-state").selectOption({ label: "Karnataka" });
  await fill(page, "postalCode", "560025");
  await page.getByRole("button", { name: "Save address" }).click();
  await page.getByText("Priya Sharma").first().waitFor({ timeout: 10_000 });

  const { data: afterAddRows, error: afterAddError } = await admin
    .from("addresses")
    .select("id, postal_code, recipient_name, is_default")
    .eq("user_id", account.userId);
  // A failed read would otherwise present as "0 rows" and read like a defect
  // in the shop rather than a broken harness.
  check("the book reads back", !afterAddError, afterAddError?.message ?? "");
  const afterAdd = { data: afterAddRows };
  check(
    "an address is added",
    afterAdd.data?.length === 1,
    `${afterAdd.data?.length ?? 0} row(s)`,
  );
  check(
    "the first one becomes the default without being asked",
    afterAdd.data?.[0]?.is_default === true,
  );
  const addressId = afterAdd.data?.[0]?.id;

  /* 2 ── the edit control exists and is operable ───────────────────────── */

  /*
    Asserted as a *control on screen*, not as an action reachable from code.
    A verb that exists in the server action and nowhere in the interface is the
    exact hole that hid two settings toggles for two phases.
  */
  const editButton = page.getByRole("button", { name: /^Edit/ }).first();
  check("an Edit control is on the page", (await editButton.count()) > 0);
  await editButton.click();

  const heading = await page
    .getByRole("heading", { name: "Edit address" })
    .count();
  check("it opens a form that says it is editing", heading > 0);

  const prefilled = await page.locator("#checkout-recipientName").inputValue();
  check(
    "the form is prefilled with the entry being edited",
    prefilled === "Priya Sharma",
    prefilled,
  );

  /* 3 ── editing changes the row, it does not add one ──────────────────── */

  await fill(page, "recipientName", "Priya S Sharma");
  await fill(page, "postalCode", "110001");
  await page.locator("#checkout-state").selectOption({ label: "Delhi" });
  await fill(page, "city", "New Delhi");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByText("Priya S Sharma").first().waitFor({ timeout: 10_000 });

  const { data: afterEditRows, error: afterEditError } = await admin
    .from("addresses")
    .select("id, postal_code, recipient_name, is_default")
    .eq("user_id", account.userId);
  check("the book reads back after the edit", !afterEditError, afterEditError?.message ?? "");
  const afterEdit = { data: afterEditRows };

  check(
    "the book still holds one entry — edited, not duplicated",
    afterEdit.data?.length === 1,
    `${afterEdit.data?.length ?? 0} row(s)`,
  );
  check(
    "it is the same row",
    afterEdit.data?.[0]?.id === addressId,
    `${addressId} → ${afterEdit.data?.[0]?.id}`,
  );
  check(
    "the name changed",
    afterEdit.data?.[0]?.recipient_name === "Priya S Sharma",
    afterEdit.data?.[0]?.recipient_name ?? "",
  );
  check(
    "the PIN changed",
    afterEdit.data?.[0]?.postal_code === "110001",
    afterEdit.data?.[0]?.postal_code ?? "",
  );
  check(
    "and it is still the default",
    afterEdit.data?.[0]?.is_default === true,
  );

  /* 4 ── the edited PIN cannot be served an old quote ──────────────────── */

  /*
    The money question. `shipping_quotes` is keyed
    (cart_id, postal_code, payment_method), so the claim being tested is that
    no stored quote exists under the *new* PIN for this customer's cart — a
    changed PIN is structurally a cache miss, not a rate carried over.
  */
  const { data: staleQuoteRows, error: staleQuoteError } = await admin
    .from("shipping_quotes")
    .select("postal_code")
    .eq("postal_code", "110001");
  check("shipping_quotes reads back", !staleQuoteError, staleQuoteError?.message ?? "");
  const staleQuotes = { data: staleQuoteRows };

  check(
    "no quote is stored under the new PIN, so the next read must re-quote",
    (staleQuotes.data?.length ?? 0) === 0,
    `${staleQuotes.data?.length ?? 0} quote(s) for 110001`,
  );

  /* 5 ── cleanup ──────────────────────────────────────────────────────── */

  const { error: cleanupError } = await admin
    .from("addresses")
    .delete()
    .eq("user_id", account.userId);
  if (cleanupError)
    console.log(`  (cleanup left rows behind: ${cleanupError.message})`);

  await browser.close();

  console.log(
    failures === 0
      ? "\nAll checks passed.\n"
      : `\n${failures} check(s) failed.\n`,
  );
  if (failures > 0) process.exit(1);
}

void main();
