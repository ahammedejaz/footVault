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
 * ## The registered address is not the address the courier collects from
 *
 * This is the whole reason the constant exists rather than being read from
 * `site_settings.contact.address`. The first version of this header said the
 * two were "genuinely different places" in different towns. That was wrong, and
 * how it was wrong is worth keeping:
 *
 * | | Where | PIN |
 * |---|---|---|
 * | `site_settings.contact.address` | Near RTC Bus Stand, **Proddatur** | 516360 |
 * | `REGISTERED_ADDRESS` below | DCSR Colony, Mydukur Road, **Proddatur** | 516361 |
 *
 * They are the same shop on the same street. `contact.address` said "Cuddapah",
 * which is a city 51 km south and the name of the *district* rather than the
 * town, and three things agreed against it: the shop's own Google listing
 * ("Foot vault branded store", DCSR Colony, 516360), the GST certificate, and
 * the PIN Shiprocket has always collected from. Corrected 14 August 2026.
 *
 * What survives the correction is the reason for keeping the two apart. The
 * PINs still differ; a delivery quote is keyed on the pickup PIN; and one of
 * these strings is a legal statement whose wording is fixed by a certificate
 * while the other is a line the owner edits in `/admin/settings`. Wiring the
 * legal one into a courier payload would move the pickup PIN by one digit and
 * quietly re-rate every delivery on the site.
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
