import "server-only";

import { formatPaise } from "@/lib/format";
import {
  DELETION_WINDOW,
  GSTIN,
  REGISTERED_ADDRESS,
  REGISTERED_NAME,
} from "@/lib/legal";
import { maybeRow, rows } from "@/lib/queries/run";
import { formatPickupCutoff } from "@/lib/shipping/estimate";
import { shippingSettings } from "@/lib/shipping/settings";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Policy numbers, resolved into prose at render time.
 *
 * ## What this exists to stop, measured on the live database
 *
 * The brief flagged one hardcoded threshold, on `/page/returns`. Sweeping for
 * the pattern rather than for the string found three surfaces carrying the same
 * number and a settings row that had moved out from under all of them:
 *
 * | Surface | Said | `site_settings.shipping.free_above_paise` |
 * |---|---|---|
 * | `site_settings.announcement.text` | "Free shipping over ₹2,499" | **₹6,499** |
 * | `pages.body` (`shipping`), twice | "₹2,499 or more" | **₹6,499** |
 * | `docs/database.md` | ₹2,499 | **₹6,499** |
 *
 * So the shop was advertising free delivery from ₹2,499 in the strip above
 * every page while checkout charged for it up to ₹6,499. Not a stale document —
 * a promise on the storefront that the till does not keep, which is the most
 * expensive kind of drift available: the customer is right, the shop is wrong,
 * and nobody finds out until somebody complains at the payment step.
 *
 * The cause is that the number lived in *content*, and content is prose typed
 * by a person. `site_settings.shipping` is where the shop's thresholds live and
 * `/admin/settings` is where the owner changes them; the moment a second copy
 * of one is typed into a sentence, the two can only agree by coincidence.
 *
 * ## The mechanism
 *
 * A page body or an announcement writes `{{free_shipping_threshold}}` and this
 * substitutes the current value. The owner still writes the sentence; they no
 * longer write the number. Substitution happens on the way to the browser, so
 * changing the setting changes every sentence at once and there is nothing to
 * remember.
 *
 * An unknown token is left **exactly as typed** rather than blanked. A visible
 * `{{free_shiping_threshold}}` is a typo somebody reports in an hour; a silently
 * empty sentence is the same class of bug this file was written to remove.
 *
 * `npm run audit:literals` fails on a currency figure in either `pages.body` or
 * `site_settings.announcement`, so the old shape cannot come back by being
 * typed into the admin — which is exactly how it got there.
 *
 * ## The same defect, in hours and days
 *
 * The launch audit on 2026-08-14 found the identical failure wearing different
 * units, in four places at once, while the currency gate ran green:
 *
 * | Surface | Said | The shop |
 * |---|---|---|
 * | `pages.meta_description` (`returns`) | "7 day free return" | replacement only, 24 hours, no refunds |
 * | `pages.body` (`returns`) | "24 hours", typed | `{{return_window}}` already existed |
 * | `pages.body` (`shipping`) | "before 4pm" | pickup is at 11:00 |
 * | `pages.body` (`privacy`) | "within 7 days" | nothing behind it at all |
 *
 * So the tokens below now cover time as well as money, `audit:literals` fails
 * on a typed day count or clock time in any owner-edited column, and the
 * mechanism is the same one: **the owner writes the sentence, the shop supplies
 * the figure.**
 *
 * Where the figure lives differs by value and is chosen per value rather than
 * by habit:
 *
 *   - `{{free_shipping_threshold}}`, `{{cod_minimum_order_value}}`,
 *     `{{return_window}}` — `site_settings`, because the owner changes them.
 *   - `{{dispatch_cutoff}}` — **code**, because `PICKUP_CUTOFF_HOUR_IST` is an
 *     operational fact rather than a price and nothing on any screen edits it.
 *     A token that reads a constant still makes the page impossible to leave
 *     behind, which is the whole requirement, and costs no settings key.
 *   - `{{contact_*}}`, `{{business_hours}}` — `site_settings`, so the contact
 *     page and the footer cannot disagree about the shop's own phone number.
 *   - `{{registered_name}}`, `{{gstin}}`, `{{registered_address}}`,
 *     `{{deletion_window}}` — **code**, in `src/lib/legal.ts`. They are legal
 *     statements rather than operational figures: they change through a
 *     reviewed commit rather than through a form, and the registered address in
 *     particular must never be reachable from the shipping origin.
 *
 * ## One token was deliberately unresolved, and this is how that ended
 *
 * `{{deletion_window}}` was **not** in the map below, and that was the point.
 * The privacy page promised deletion "within 7 days" with nothing behind it —
 * not a setting, not a constant, not a process. Inventing a replacement figure
 * would have been inventing a legal commitment on the shop's behalf, so the
 * sentence carried the token and the token rendered visibly, braces and all, to
 * anybody who read the page.
 *
 * The owner answered it on 14 August 2026, with `{{registered_name}}` and
 * `{{gstin}}`; all three resolve from `src/lib/legal.ts` now. The mechanism is
 * the part worth keeping. `audit:privacy` listed them on every run and failed
 * outright once `SITE_INDEXABLE` was true, so the question could not be
 * forgotten and the site could not be indexed while it was still open — a
 * placeholder is a work-in-progress while the shop is hidden and a defect the
 * moment it is not.
 */

/*
  Re-exported rather than declared, so every existing `from
  "@/lib/content-tokens"` import keeps working while the browser can reach the
  same substitution through `@/lib/tokens`. See that file for why it moved.
*/
export { fillTokens, type ContentTokens } from "@/lib/tokens";

import { fillTokens, type ContentTokens } from "@/lib/tokens";

/**
 * Every token the CMS may use, with what it renders to right now.
 *
 * Deliberately a flat map of strings rather than a nested object: it is written
 * by a shopkeeper into a sentence, so `{{free_shipping_threshold}}` has to be
 * the whole of what they need to know.
 */
export async function contentTokens(): Promise<ContentTokens> {
  /**
   * **A threshold that cannot be read is not substituted.**
   *
   * `shippingSettings()` throws rather than falling back to a constant — the old
   * constant said ₹2,499 while the live threshold was ₹6,499, which is the same
   * escaped number this file was written to stop. So an unreadable row leaves
   * `{{free_shipping_threshold}}` visible in the page instead, which is exactly
   * what this file already does with an unknown token and for the same reason: a
   * visible placeholder is reported within the hour, and a sentence promising
   * free delivery at the wrong number is not reported at all.
   */
  const [shipping, returnDays, shop] = await Promise.all([
    shippingSettings().catch((error: unknown) => {
      console.error(
        "[content] delivery thresholds unreadable; leaving their tokens unfilled:",
        error instanceof Error ? error.message : "unknown",
      );
      return null;
    }),
    returnWindowDays(),
    shopDetails(),
  ]);

  return {
    ...(shipping
      ? {
          free_shipping_threshold: formatPaise(shipping.freeAbovePaise),
          cod_minimum_order_value: formatPaise(
            shipping.codMinimumOrderValuePaise,
          ),
        }
      : {}),
    return_window: describeWindow(returnDays),
    /**
     * The advance is quoted live per PIN code and per basket, so there is no
     * figure to substitute — and a token that resolved to an average would be a
     * new version of the bug above. It resolves to the words instead.
     */
    delivery_advance: "the delivery charge",
    /**
     * The pickup hour, from the constant the arithmetic uses.
     *
     * The shipping page said "before 4pm" while `PICKUP_CUTOFF_HOUR_IST` was 11
     * — not a rounding error but five hours of orders told they went out today
     * when they went out tomorrow. There is no settings row behind this on
     * purpose; see the module header.
     */
    dispatch_cutoff: formatPickupCutoff(),
    ...shop,
    /*
      The shop's legal identity, and the one published commitment with no
      setting behind it. Named one at a time rather than spread out of
      `legal.ts`, because `audit:privacy` decides whether a token is resolvable
      by looking for its name in *this file* as text — a spread resolves at
      runtime and would read to the gate as a token nothing knows about.
    */
    registered_name: REGISTERED_NAME,
    gstin: GSTIN,
    registered_address: REGISTERED_ADDRESS,
    deletion_window: DELETION_WINDOW,
  };
}

/**
 * The shop's own details, for the pages that print them.
 *
 * The contact page used to say *"our contact details and opening hours are in
 * the footer of every page"* — which is not a contact page, it is a note
 * explaining that there isn't one. It is also the page `LocalBusiness` and the
 * local pack are judged against, and the surface a stranger checks before
 * trusting an unknown shop with a card number.
 *
 * **Absent means absent.** A missing phone leaves `{{contact_phone}}` visible
 * rather than resolving to an empty string, for the reason the module header
 * gives: a sentence that reads "Call us on ." is a defect nobody reports, and a
 * visible token is one somebody reports today.
 */
async function shopDetails(): Promise<ContentTokens> {
  const settings = await rows<{ key: string; value: unknown }>(
    "content.shopDetails",
    createAdminClient()
      .from("site_settings")
      .select("key, value")
      .in("key", ["contact", "business_hours"]),
  ).catch((error: unknown) => {
    console.error(
      "[content] shop details unreadable; leaving their tokens unfilled:",
      error instanceof Error ? error.message : "unknown",
    );
    return [] as { key: string; value: unknown }[];
  });

  const byKey = new Map(settings.map((row) => [row.key, row.value]));
  const contact = asRecord(byKey.get("contact"));
  const hours = asRecord(byKey.get("business_hours"));

  const tokens: ContentTokens = {};
  const put = (token: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) tokens[token] = value.trim();
  };

  put("contact_phone", contact.phone);
  put("contact_whatsapp", contact.whatsapp);
  put("contact_email", contact.email);
  put("contact_address", contact.address);

  const readable = describeHours(hours);
  if (readable) tokens.business_hours = readable;

  return tokens;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * `{weekday, saturday, sunday}` as one sentence.
 *
 * Built from whichever of the three are set rather than from all of them: a
 * shop that has not filled in Sunday is closed on Sunday as far as this
 * sentence is concerned, and printing "Sunday " with nothing after it would be
 * worse than printing nothing.
 */
function describeHours(hours: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const add = (label: string, value: unknown) => {
    if (typeof value === "string" && value.trim())
      parts.push(`${label} ${value.trim()}`);
  };
  add("Monday to Friday", hours.weekday);
  add("Saturday", hours.saturday);
  add("Sunday", hours.sunday);
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Convenience for the common case: read the tokens and fill in one go. */
export async function withTokens(text: string): Promise<string> {
  return fillTokens(text, await contentTokens());
}

/**
 * "24 hours" for a one-day window, "2 days" beyond that.
 *
 * The policy is 24 hours and every surface says so in hours, because a customer
 * with a damaged parcel is counting hours rather than days. Written as a
 * function of the setting so an owner who raises it to three days gets a
 * sentence that still reads correctly.
 */
function describeWindow(days: number): string {
  if (days <= 1) return "24 hours";
  return `${days} days`;
}

async function returnWindowDays(): Promise<number> {
  const row = await maybeRow<{ value: unknown }>(
    "content.returnWindow",
    createAdminClient()
      .from("site_settings")
      .select("value")
      .eq("key", "return_window_days")
      .maybeSingle(),
  );
  const value = row?.value;
  return typeof value === "number" && value > 0 ? value : 1;
}
