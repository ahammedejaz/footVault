import "server-only";

import { shiprocketFetch } from "@/lib/shipping/client";
import { shippingSettings } from "@/lib/shipping/settings";

/**
 * What is left in the Shiprocket wallet, and whether that is a problem.
 *
 * An empty wallet stops shipping completely. Not slowly and not partially:
 * `orders/create/adhoc` is refused, no AWB is assigned, and every parcel in the
 * shop waits — while the panel keeps saying "Create shipment" as if it were an
 * option. It is the one Shiprocket number that has to be visible *before*
 * somebody presses a button, which is why it is on the dashboard rather than on
 * the order page.
 *
 * ## Everything here fails soft, and that is the whole design
 *
 * This is read during the admin dashboard's render. The dashboard's job is to
 * tell the owner what is happening in their shop, and none of that depends on
 * Shiprocket — so a wallet lookup that times out, 500s, or comes back in a
 * shape nobody has seen before must degrade to "could not read" and leave every
 * other number on the page intact. Nothing in this file throws.
 *
 * **"Could not read" is never rendered as zero.** They are opposite facts: zero
 * means stop everything and recharge, unknown means look again in a minute. A
 * lookup that failed and displayed ₹0 would have the owner recharging an
 * account that is fine, and — far worse the other way round — a shop that
 * *believed* a stale zero would be a shop that stopped trusting the warning.
 *
 * The endpoint and its shape were verified against the live account rather than
 * taken from the documentation:
 *
 *   GET /account/details/wallet-balance
 *   200 {"data":{"balance_amount":"299.47"}}
 *
 * Rupees, as a **string**, with two decimal places. Everything in this codebase
 * is integer paise, so this is the boundary where that stops being true — the
 * same boundary `createShipment` crosses in the other direction.
 */

export type WalletReading =
  | { state: "read"; balancePaise: number }
  | {
      state: "unreadable";
      /** Shown to the owner. Says what we could not do, never what the balance is. */
      message: string;
    };

export type WalletThreshold =
  /** The owner has chosen a line. Warn at or below it. */
  | { state: "set"; paise: number }
  /** No `wallet_low_balance_paise` in site_settings. Nothing can warn. */
  | { state: "unset" }
  /** The settings row itself could not be read, which is not the same as unset. */
  | { state: "unreadable"; message: string };

export type WalletStatus = {
  reading: WalletReading;
  threshold: WalletThreshold;
  /**
   * True only when both numbers are known and the balance has reached the line.
   *
   * An unknown balance is not low and an unset threshold does not make one low
   * — either would be a warning the owner cannot act on, and the dashboard
   * says which half is missing instead.
   */
  low: boolean;
};

/**
 * A tighter deadline than the shipping default of eight seconds.
 *
 * This is on the render path of a page the owner opens to find out what needs
 * doing this morning, and it is the only thing on that page that leaves the
 * building. Eight seconds of an unresponsive courier API is eight seconds of a
 * blank dashboard; three is long enough for a healthy answer and short enough
 * that a sick one is just a line saying so. Technical, not a business number —
 * nothing about it is the owner's to decide.
 */
const WALLET_TIMEOUT_MS = 3000;

/** Shiprocket's own path. Verified against the live account; see the header. */
const WALLET_PATH = "/account/details/wallet-balance";

export async function shiprocketWalletStatus(): Promise<WalletStatus> {
  const [reading, threshold] = await Promise.all([
    readWalletBalance(),
    readWalletThreshold(),
  ]);
  return judgeWallet(reading, threshold);
}

/**
 * The comparison, as a pure function over two facts.
 *
 * Separated from both reads so the dashboard's behaviour in each of the six
 * combinations can be asserted without a network or a database — see
 * `npm run audit:shipping`.
 */
export function judgeWallet(
  reading: WalletReading,
  threshold: WalletThreshold,
): WalletStatus {
  const low =
    reading.state === "read" &&
    threshold.state === "set" &&
    reading.balancePaise <= threshold.paise;
  return { reading, threshold, low };
}

export async function readWalletBalance(): Promise<WalletReading> {
  const result = await shiprocketFetch<unknown>(WALLET_PATH, {
    timeoutMs: WALLET_TIMEOUT_MS,
  });

  if (!result.ok) {
    return {
      state: "unreadable",
      message:
        result.reason === "not_configured"
          ? "Shiprocket is not configured on this deployment, so there is no wallet to read."
          : result.message,
    };
  }

  const balancePaise = parseWalletBalancePaise(result.data);
  if (balancePaise === null) {
    /**
     * Answered, and not in a shape we recognise.
     *
     * Logged rather than swallowed: this is how a silently changed response
     * format is found — by somebody reading the log — rather than by the wallet
     * quietly reading "could not read" for a month while nobody wonders why.
     */
    console.error("[shiprocket] the wallet balance was not a number we could read", {
      payload: result.data,
    });
    return {
      state: "unreadable",
      message:
        "Shiprocket answered, but not with a balance we could read. Check the wallet in the Shiprocket panel.",
    };
  }

  return { state: "read", balancePaise };
}

/**
 * The low-balance line, which is the owner's number and nobody else's.
 *
 * Deliberately **not** defaulted. There is no sensible constant here: what
 * counts as low depends on how many parcels a day this shop sends and what they
 * weigh, and a figure invented in code would either cry wolf or stay silent
 * through an outage. So an unset threshold is its own state, and the dashboard
 * says out loud that nothing is watching the wallet.
 *
 * `shippingSettings()` throws when `site_settings.shipping` is unreadable — by
 * design, since a shop that cannot read its own thresholds must not quote from
 * invented ones. Here that would take the whole dashboard down over a number
 * that only decorates one line of it, so it is caught and reported as its own
 * state.
 */
export async function readWalletThreshold(): Promise<WalletThreshold> {
  try {
    const settings = await shippingSettings();
    const paise = settings.walletLowBalancePaise;
    return paise === null ? { state: "unset" } : { state: "set", paise };
  } catch (error) {
    return {
      state: "unreadable",
      message:
        error instanceof Error
          ? error.message
          : "The shipping settings could not be read.",
    };
  }
}

/**
 * `{"data":{"balance_amount":"299.47"}}` → 29947.
 *
 * Parsed as a decimal *string* rather than through `Number(x) * 100`, because
 * that multiplication is not exact: `299.47 * 100` is 29946.999999999996 in
 * IEEE 754, and rounding it is a habit that works until the one balance where
 * it does not. Splitting the string on the point and reading the two halves as
 * integers has no such case.
 *
 * A number is accepted too, in case the field ever arrives unquoted — it costs
 * one branch and saves the balance silently becoming unreadable.
 *
 * Negative balances are real: Shiprocket lets an account go into arrears, and
 * an owner in that position needs to see the minus sign rather than a shrug.
 */
export function parseWalletBalancePaise(payload: unknown): number | null {
  const raw = walletField(payload);
  if (typeof raw === "number")
    return Number.isFinite(raw) ? Math.round(raw * 100) : null;
  if (typeof raw !== "string") return null;

  const match = /^(-?)(\d+)(?:\.(\d{1,2})\d*)?$/.exec(raw.trim().replace(/,/g, ""));
  if (!match) return null;

  const [, sign, whole, fraction = ""] = match;
  const paise = Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
  if (!Number.isSafeInteger(paise)) return null;
  return sign === "-" ? -paise : paise;
}

/** `data.balance_amount`, without trusting any level of it to exist. */
function walletField(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as Record<string, unknown>).data;
  if (!data || typeof data !== "object") return null;
  return (data as Record<string, unknown>).balance_amount;
}
