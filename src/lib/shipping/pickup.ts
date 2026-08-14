import "server-only";

import { shiprocketFetch } from "@/lib/shipping/client";
import { shiprocketPickupLocation } from "@/lib/shipping/config";
import { shippingDefaults } from "@/lib/shipping/quote";

/**
 * The pickup addresses Shiprocket actually holds for this account.
 *
 * ## The failure this exists to catch
 *
 * The shop ships from one address, named by the `SHIPROCKET_PICKUP_LOCATION`
 * environment variable, and Shiprocket matches that nickname as a **literal
 * string**. It is `warehouse`, lowercase. Nothing in this codebase has ever
 * checked that the name it sends corresponds to anything.
 *
 * `config.ts` already records what happens when it does not: every quote, every
 * serviceability check and every page render keeps working, and the first thing
 * to break is **creating a real shipment for a real order** — "Wrong Pickup
 * location entered", from a third party, at the counter, on an order somebody
 * has already paid for. Throwing on an *unset* variable moved that failure
 * earlier. It did nothing for a variable that is set and wrong, which is the
 * more likely mistake of the two: a rename in the Shiprocket panel is a change
 * nobody makes in this repository.
 *
 * So this reads the list and lets `/admin/health` say whether the name matches.
 * That is a check the owner can act on before a customer is standing there.
 *
 * ## The PIN, which is the part that costs money
 *
 * The pickup PIN determines the rate — a quote from Proddatur and a quote from
 * Bengaluru for the same parcel are different amounts. `site_settings
 * .shipping_defaults.pickup_postcode` is what every quote is taken from, and it
 * is typed by hand at `/admin/settings`; the nickname sent at shipment time is a
 * separate value in an environment variable. **Nothing has ever asserted that
 * the two describe the same building.**
 *
 * They agree today (516360, `warehouse`). If they ever stop agreeing, the shop
 * quotes one lane and ships another — collecting the wrong delivery charge on
 * every order, silently, with both values individually looking correct. That is
 * the specific disagreement `pickupMismatch` reports.
 */

export type PickupLocation = {
  id: number;
  nickname: string;
  postcode: string;
  city: string | null;
  state: string | null;
  /** Shiprocket's own flag for the account's default. */
  isPrimary: boolean;
};

type RawPickup = {
  id?: unknown;
  pickup_location?: unknown;
  pin_code?: unknown;
  city?: unknown;
  state?: unknown;
  is_primary_location?: unknown;
};

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Every pickup address on the account, or a reason there is none.
 *
 * Returns a result rather than throwing: this is called from a health page and
 * from the admin, and a Shiprocket outage must render as "we could not ask"
 * rather than as a 500 on a page whose whole job is to report problems.
 */
export async function listPickupLocations(): Promise<
  | { ok: true; locations: PickupLocation[] }
  | { ok: false; message: string }
> {
  const result = await shiprocketFetch<{
    data?: { shipping_address?: RawPickup[] };
  }>("/settings/company/pickup");

  if (!result.ok) {
    return { ok: false, message: result.message };
  }

  const raw = result.data?.data?.shipping_address;
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      message:
        "Shiprocket answered without a list of pickup addresses. Nothing has been assumed.",
    };
  }

  const locations: PickupLocation[] = [];
  for (const entry of raw) {
    const nickname = text(entry.pickup_location);
    const postcode = text(entry.pin_code);
    // A row without a nickname or a PIN cannot be used for either of the two
    // things this list is for, so it is dropped rather than half-rendered.
    if (!nickname || !postcode) continue;
    locations.push({
      id: typeof entry.id === "number" ? entry.id : -1,
      nickname,
      postcode,
      city: text(entry.city),
      state: text(entry.state),
      isPrimary: entry.is_primary_location === 1 || entry.is_primary_location === true,
    });
  }

  return { ok: true, locations };
}

export type PickupVerdict =
  | { state: "unknown"; detail: string }
  | { state: "ok"; nickname: string; postcode: string; city: string | null }
  | {
      state: "missing";
      nickname: string;
      available: string[];
    }
  | {
      state: "pin_mismatch";
      nickname: string;
      shiprocketPostcode: string;
      settingsPostcode: string;
    };

/**
 * Does the shop's configuration describe a real address, and the same one
 * twice?
 *
 * Two questions rather than one, because they fail differently and the second
 * is the expensive one. A missing nickname stops shipping loudly at the
 * counter. A PIN mismatch stops nothing — it quietly charges every customer a
 * rate for a journey the parcel does not make.
 */
export async function checkPickupConfiguration(): Promise<PickupVerdict> {
  let nickname: string;
  try {
    nickname = shiprocketPickupLocation();
  } catch (error) {
    return {
      state: "unknown",
      detail: error instanceof Error ? error.message : "not configured",
    };
  }

  const listed = await listPickupLocations();
  if (!listed.ok) return { state: "unknown", detail: listed.message };

  const match = listed.locations.find(
    (location) => location.nickname.toLowerCase() === nickname.toLowerCase(),
  );

  if (!match) {
    return {
      state: "missing",
      nickname,
      available: listed.locations.map((location) => location.nickname),
    };
  }

  const defaults = await shippingDefaults();
  if (defaults.pickup_postcode !== match.postcode) {
    return {
      state: "pin_mismatch",
      nickname,
      shiprocketPostcode: match.postcode,
      settingsPostcode: defaults.pickup_postcode,
    };
  }

  return {
    state: "ok",
    nickname,
    postcode: match.postcode,
    city: match.city,
  };
}
