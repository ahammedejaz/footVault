/**
 * Which `site_settings` rows the shop window may read, decided once and written
 * down.
 *
 * ## Why this file exists
 *
 * RLS on `site_settings` grants `anon` and `authenticated` `select`
 * `using (is_public)`, and the grant is per **row**, not per field. A row marked
 * public publishes its entire `value` — every key inside the jsonb, including
 * ones added to it years after the flag was set.
 *
 * `shipping` is the worked example. It is public because the storefront has to
 * print the free-delivery threshold, and it has since accumulated the
 * Pay-on-Delivery deposit, the advance cap, the COD minimum, the stacking
 * ceiling and the RTO deduction policy. None of those was a decision to
 * publish; each was a field added to a row that already happened to be public.
 *
 * The owner reviewed that and chose to leave it, for a reason worth recording
 * because it is the reason this file is a *classification* rule and not a
 * schema change: **nothing in that row is exploitable.** The server is
 * authoritative on every figure it contains — checkout recomputes prices,
 * `create_order_with_stock` re-derives the discount, and the client cannot
 * influence any of them. The cost of publishing it is transparency, not
 * security. Splitting the row would be schema plus authorisation work in the
 * money path, which Phase 10 is meant to leave alone.
 *
 * What that reasoning does *not* survive is the next key. A genuinely sensitive
 * value — an API identifier, a supplier's terms, an internal margin — must not
 * be able to arrive inside a row that is already public, or beside a new row
 * whose flag nobody thought about. So:
 *
 * > **Every `site_settings` key is classified here, with a reason, at the
 * > moment it is added.** `audit:settings-visibility` fails when the database
 * > holds a key this file does not, when a classification disagrees with the
 * > row's `is_public`, or when an entry carries no reason.
 *
 * An unclassified key is a failure rather than a default, which is the whole
 * point: the failure mode being designed against is a sensitive value
 * *inheriting* publicity from a decision made about something else.
 */

export type Visibility = "public" | "private";

export type SettingClassification = {
  visibility: Visibility;
  /**
   * Why. An entry without one is rejected by the gate — a classification list
   * with no reasons is a list of flags somebody once set, which is the thing it
   * replaces.
   */
  reason: string;
};

export const SETTINGS_VISIBILITY: Record<string, SettingClassification> = {
  announcement: {
    visibility: "public",
    reason:
      "the strip across the top of every storefront page — it is published by definition",
  },
  business_hours: {
    visibility: "public",
    reason: "printed on the contact page so a customer knows when to ring",
  },
  contact: {
    visibility: "public",
    reason:
      "the phone, WhatsApp, email and address in the footer — a shop that hides these has no customers",
  },
  // payment_methods is gone, not reclassified: the row was read by nothing,
  // published to anyone, and false ("online": false while the shop takes
  // online payments). The classification gate fails on an orphaned entry, so
  // this comment is the record of the decision rather than a dormant key.
  // Dropped 2026-08-20 — see
  // supabase/migrations/20260820100000_drop_payment_methods_row.sql.
  images: {
    visibility: "private",
    reason:
      "the target fill percentage the crop tool nudges toward. Operational: it shapes what the owner is guided to while framing a photograph, and a customer learns the result by looking at the pictures rather than by reading the figure",
  },
  loyalty: {
    visibility: "private",
    reason:
      "the coin earn rate, expiry and (Batch C) redemption caps — the owner's margin. The storefront's 'what a coin is worth' copy is rendered server-side from this row; nothing a browser can read carries it. Every number in it starts unset: the programme earns and redeems nothing until the owner types the values",
  },
  reviews: {
    visibility: "private",
    reason:
      "the moderation switch (require_approval). Operational policy read only by the review server action; a customer learns the moderation model from whether their review appears, not from a flag — and publishing the flag would tell a bad actor whether fakes surface instantly",
  },
  return_window_days: {
    visibility: "public",
    reason:
      "the promise made on the returns page; a customer must be able to read the terms they are agreeing to",
  },
  shipping: {
    visibility: "public",
    reason:
      "the storefront prints the free-delivery threshold from it. It also carries the Pay-on-Delivery deposit and cap, the COD minimum, the stacking ceiling and the RTO policy — reviewed by the owner and deliberately left public, because the server is authoritative on all of them and the client cannot influence any, so the cost is transparency rather than security. A genuinely sensitive figure must not be added to this row; give it its own private one",
  },
  shipping_defaults: {
    visibility: "private",
    reason:
      "the pickup PIN and parcel dimensions. Operational, never rendered to a customer, and the pickup PIN is the shop's own address",
  },
  social: {
    visibility: "public",
    reason: "the footer's social links, which exist to be followed",
  },
  store_name: {
    visibility: "public",
    reason: "the name in the header, the title and both social cards",
  },
  store_tagline: {
    visibility: "public",
    reason: "printed under the name on the OG image and in the footer",
  },
};

/** Every key the shop expects to exist, for the gate to compare against. */
export const CLASSIFIED_KEYS = Object.keys(SETTINGS_VISIBILITY).sort();

/** True when the classification says this key belongs in the public half. */
export function shouldBePublic(key: string): boolean | null {
  const entry = SETTINGS_VISIBILITY[key];
  return entry ? entry.visibility === "public" : null;
}
