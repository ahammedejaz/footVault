import "server-only";

/**
 * Shiprocket's credentials, and the correction that had to happen first.
 *
 * `.env.local` arrived at this phase holding `SHIPROCKET_API_KEY`, read by no
 * code. Shiprocket's external API at `apiv2.shiprocket.in` does not authenticate
 * with a static key at all, so before anything was built against it the value
 * was checked: it is 32 characters, a single segment, and it is **not** a JWT
 * (a Shiprocket token is ~700 characters in three dot-separated parts starting
 * `eyJ`). Sent as a bearer token to a read-only endpoint it returns
 * `401 unauthorized request`. It authenticates nothing.
 *
 * The real flow, and the reason the variables below are named as they are:
 *
 *   1. An **API user** is created in the Shiprocket panel under
 *      Settings → API → Configure. Its email must be *different* from the
 *      account's own login email.
 *   2. `POST /v1/external/auth/login` with those credentials returns a JWT
 *      **valid for 240 hours**.
 *   3. Every other call sends `Authorization: Bearer <token>`.
 *
 * So the code needs an email and a password, not a key. Had the old value been
 * a token rather than a random string, the failure would have been the worst
 * kind available: everything working for ten days and then every shipping call
 * failing at once, with no deploy to explain it.
 *
 * **Nothing here throws on a missing variable.** Every other integration in
 * this codebase fails loudly when unconfigured, and this one must not: an
 * unconfigured Shiprocket has to leave checkout working, COD offered and the
 * delivery estimate defaulted. `isShiprocketConfigured()` is what the callers
 * branch on, and `docs/admin-guide.md` says what to set.
 */

export const SHIPROCKET_BASE_URL = "https://apiv2.shiprocket.in/v1/external";

/**
 * How long before expiry to fetch a new token.
 *
 * Twelve hours out of 240. Generous on purpose: the cost of refreshing early is
 * one extra login every ten days, and the cost of refreshing late is a shipment
 * that fails while an owner is standing at the counter. The 401 retry exists as
 * the backstop for a token revoked in the panel, not as the normal path.
 */
export const SHIPROCKET_REFRESH_MARGIN_MS = 12 * 60 * 60 * 1000;

/** Shiprocket says 240 hours; used only when a login response omits an expiry. */
export const SHIPROCKET_ASSUMED_TTL_MS = 240 * 60 * 60 * 1000;

/**
 * Every outbound call is bounded.
 *
 * A logistics API that has stopped answering must never hold a checkout render
 * open. Eight seconds is far longer than a healthy response and far shorter
 * than a customer's patience.
 */
export const SHIPROCKET_TIMEOUT_MS = 8000;

/** Serviceability is on the checkout path, so it gets a tighter budget. */
export const SHIPROCKET_SERVICEABILITY_TIMEOUT_MS = 4000;

export type ShiprocketCredentials = { email: string; password: string };

export function shiprocketCredentials(): ShiprocketCredentials | null {
  const email = process.env.SHIPROCKET_EMAIL?.trim();
  const password = process.env.SHIPROCKET_PASSWORD;
  if (!email || !password) return null;
  return { email, password };
}

export function isShiprocketConfigured(): boolean {
  return shiprocketCredentials() !== null;
}

/**
 * The pickup location's nickname, as it is spelled in the Shiprocket panel.
 *
 * The adhoc order payload requires it and Shiprocket matches it as a literal
 * string, so a mismatch is rejected at order creation with a message about a
 * pickup location rather than about a spelling. It is an environment variable
 * rather than a setting in the database because it belongs to the Shiprocket
 * account, not to the shop — a preview deployment pointing at a test account
 * needs a different one.
 */
export function shiprocketPickupLocation(): string {
  const configured = process.env.SHIPROCKET_PICKUP_LOCATION?.trim();
  if (configured) return configured;

  /**
   * **No default, and this throws.**
   *
   * It used to fall back to `"Primary"`, which is not what this account's
   * location is called — it is `warehouse`, lowercase, and Shiprocket matches
   * the nickname as a literal string. So the fallback did not degrade
   * gracefully; it deferred the failure to the worst possible moment. Every
   * quote, every serviceability check and every page render would keep working,
   * and the first thing that broke would be **creating a real shipment for a
   * real order** — with "Wrong Pickup location entered" coming back from a
   * third party, at the counter, on an order somebody has already paid for.
   *
   * Failing here instead means an unset variable is found by the deployment
   * that introduced it. Nothing on the customer path calls this: quoting takes
   * the pickup *postcode* from `site_settings.shipping_defaults`, so a missing
   * nickname cannot stop the shop selling. It stops the shop shipping, loudly,
   * which is the correct direction.
   */
  throw new ShiprocketConfigError(
    "SHIPROCKET_PICKUP_LOCATION is not set. It must be the pickup location's " +
      "nickname exactly as it is spelled in Settings → Company → Pickup Addresses " +
      'in the Shiprocket panel — for this account, "warehouse", lowercase. ' +
      "Shiprocket matches it as a literal string, so a mismatch is rejected at " +
      "order creation rather than at boot.",
  );
}

export class ShiprocketConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShiprocketConfigError";
  }
}
