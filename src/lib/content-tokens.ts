import "server-only";

import { formatPaise } from "@/lib/format";
import { maybeRow } from "@/lib/queries/run";
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
 */

export type ContentTokens = Record<string, string>;

/**
 * Every token the CMS may use, with what it renders to right now.
 *
 * Deliberately a flat map of strings rather than a nested object: it is written
 * by a shopkeeper into a sentence, so `{{free_shipping_threshold}}` has to be
 * the whole of what they need to know.
 */
export async function contentTokens(): Promise<ContentTokens> {
  const [shipping, returnDays] = await Promise.all([
    shippingSettings(),
    returnWindowDays(),
  ]);

  return {
    free_shipping_threshold: formatPaise(shipping.freeAbovePaise),
    cod_minimum_order_value: formatPaise(shipping.codMinimumOrderValuePaise),
    return_window: describeWindow(returnDays),
    /**
     * The advance is quoted live per PIN code and per basket, so there is no
     * figure to substitute — and a token that resolved to an average would be a
     * new version of the bug above. It resolves to the words instead.
     */
    delivery_advance: "the delivery charge",
  };
}

/**
 * Substitute, leaving anything unrecognised visible.
 *
 * The regex is deliberately narrow — lowercase, underscores, inside doubled
 * braces — so a price written as `{2,499}` in ordinary prose is untouched.
 */
export function fillTokens(text: string, tokens: ContentTokens): string {
  return text.replace(
    /\{\{\s*([a-z0-9_]+)\s*\}\}/g,
    (whole, name: string) => tokens[name] ?? whole,
  );
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
