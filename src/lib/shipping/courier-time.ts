import "server-only";

/**
 * Shiprocket's clock, and the five and a half hours it does not tell you about.
 *
 * ## The assumption, stated once
 *
 * Every timestamp Shiprocket sends looks like `2021-07-02 16:41:59` — no
 * offset, no zone, no `Z`. **It is India Standard Time**, UTC+05:30, because
 * the account, the couriers, the pickup address and the customers are all in
 * India and their panel displays these same strings as local time.
 *
 * `new Date("2021-07-02 16:41:59")` reads that as the *server's* local time.
 * On Vercel that is UTC, so every delivery would be stamped five and a half
 * hours early. That is not a display nicety: the replacement window this shop
 * offers is **24 hours from delivery**, measured from this field, and it is the
 * only remedy the shop has. Five and a half hours early is five and a half
 * hours of a customer's remedy, silently removed, in the direction that favours
 * the shop.
 *
 * ## Why it is a module rather than a line
 *
 * It was a line — inside `deliveredTimestamp` in `fulfilment.ts`, correct and
 * invisible. The inbound webhook needs the identical rule, and a second copy of
 * a timezone assumption is a second thing to get wrong on the day somebody
 * decides the first one was overcautious. One implementation, one comment, one
 * gate check that fails if the offset moves.
 *
 * ## What it does not assume
 *
 * A string that already carries a zone — `…Z`, `…+05:30`, `…-0700` — is taken
 * at its word. Shiprocket does not send those today; if they start, or if a
 * courier's own feed differs, the offset must not be applied twice. The check
 * is the presence of a zone, not the absence of one we recognise.
 */
export const COURIER_TIMEZONE_OFFSET = "+05:30" as const;

/** True when a timestamp string already says which zone it is in. */
function carriesZone(raw: string): boolean {
  return /[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw.trim());
}

/**
 * A courier timestamp as an instant, or null if it is not one.
 *
 * Null rather than `now()`: a caller that wants "now" as a fallback should say
 * so at the point where that trade is being made, because it is a trade —
 * `deliveredTimestamp` takes it deliberately, and the webhook receiver
 * deliberately does not.
 */
export function courierInstant(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text.length === 0) return null;

  const withZone = carriesZone(text)
    ? text
    : `${text.replace(" ", "T")}${COURIER_TIMEZONE_OFFSET}`;
  const parsed = new Date(withZone);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
