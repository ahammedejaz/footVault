/**
 * Who the shop legally is, and the one commitment that has no setting behind it.
 *
 * ## Why these are in code
 *
 * Every other figure the policy pages print lives in `site_settings`, because
 * the owner changes it: a delivery threshold, a returns window, a phone number.
 * These four do not work that way.
 *
 * A GSTIN and a registered name are what a customer is told they are
 * contracting with. They change when the business is restructured, which is a
 * reviewed event, not an afternoon's edit — and a value typed into `/admin/pages`
 * or `/admin/settings` changes a legal statement with nobody reading the diff.
 * In this file they change through a commit, which is the review.
 *
 * ## The registered address is not the dispatch address
 *
 * This is the whole reason the constant exists rather than being read from
 * `site_settings.contact.address`, and the two are genuinely different places:
 *
 * | | Where | PIN |
 * |---|---|---|
 * | `site_settings.contact.address` | Near RTC Bus Stand, **Cuddapah** | 516360 |
 * | `REGISTERED_ADDRESS` below | DCSR Colony, **Proddatur**, District YSR | 516361 |
 *
 * The first is the shop a customer walks into and the origin Shiprocket
 * collects from. The second is the principal place of business on the GST
 * certificate. Conflating them would move the pickup PIN by one digit and
 * quietly re-rate every delivery quote on the site.
 *
 * So this value has exactly one consumer — `content-tokens.ts`, which turns it
 * into `{{registered_address}}` for the Terms page — and `npm run audit:privacy`
 * fails if any second module imports this file. That is the mechanical form of
 * the instruction: it is a legal statement in Terms only, and it is not wired to
 * anything.
 *
 * ## The deletion window
 *
 * `{{deletion_window}}` sat unresolved on the live privacy page from 14 August
 * 2026 until the owner answered it, printing its own braces to any visitor —
 * deliberately, because the sentence it replaced promised deletion "within 7
 * days" with nothing behind it: not a setting, not a constant, not a process.
 * It is here rather than in `site_settings` for the same reason as the rest of
 * this file. It is a published legal commitment under the DPDP Act, and the
 * shop should not be able to shorten it from a form.
 */

/** The proprietor named on the GST certificate. */
export const REGISTERED_NAME = "Shaik Reshma";

export const GSTIN = "37QXYPS8603E1ZC";

/**
 * The principal place of business, exactly as the GST certificate has it.
 *
 * Not the shop's street address and not the courier pickup address — see the
 * table in the module header before using this anywhere.
 */
export const REGISTERED_ADDRESS =
  "Room No. 2, SV 328/1, Classic Vastralayam, Mydukur Road, DCSR Colony, Proddatur, District YSR, Andhra Pradesh 516361";

/**
 * How long after a deletion request the account is actually removed.
 *
 * Prose rather than a number, so the sentence around it reads correctly whatever
 * the answer is — and so `audit:literals`, which forbids a typed day count in
 * any owner-edited column, has something to point the page at.
 */
export const DELETION_WINDOW = "30 days";
