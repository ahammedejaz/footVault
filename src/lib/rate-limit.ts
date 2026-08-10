import "server-only";

import { headers } from "next/headers";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Rate limiting, as a shock absorber rather than as authorization.
 *
 * Read that distinction before using this module, because everything below
 * follows from it. A limiter answers "is this caller going too fast", never "is
 * this caller allowed". Nothing in this codebase may rely on a limit as the
 * only thing between a caller and an action: every admin mutation checks
 * `is_admin()` server-side, the webhook checks its HMAC, and checkout recomputes
 * every price in the database. The limiter exists so that a caller who is
 * *entitled* to do a thing cannot do it ten thousand times a minute.
 *
 * **It fails open, deliberately.** If the counter cannot be read the request
 * proceeds and the failure is logged loudly. The alternative — a database blip
 * that stops orders, or that makes us return non-2xx to Razorpay until it
 * disables our webhook — trades a small abuse risk for a large availability
 * one. Because it fails open, it can never be load-bearing for security, which
 * is the same statement as the paragraph above from the other direction.
 *
 * **The counters live in Postgres, not in module memory.** A per-instance Map
 * is the tempting version and it does not work here: serverless instances are
 * created and discarded constantly, so a counter resets on every cold start,
 * and a burst is spread across several concurrent instances that cannot see
 * each other's counts. The cost is one round trip on paths that are already
 * doing several.
 */

/**
 * A policy is `[limit, windowSeconds]` and the name is the first half of the
 * bucket key, so two policies can never share a counter by accident.
 *
 * The numbers are deliberately generous. A limiter tuned tight enough to be
 * interesting is a limiter that eventually rejects a real customer on a hotel
 * wifi behind one NAT, and that costs a sale to prevent an inconvenience.
 */
export const RATE_LIMITS = {
  /**
   * Razorpay retries aggressively and may redeliver a backlog in a burst, so
   * this is set well above anything legitimate rather than near it. It is here
   * to stop an anonymous flood of forged payloads making us compute an HMAC
   * per request, not to police Razorpay.
   */
  webhook: [300, 60],
  /** The verify action. Signed callbacks only, but the action is public. */
  paymentVerify: [20, 60],
  /** Placing an order. Per customer, not per IP — see `callerIdentity`. */
  checkout: [10, 60],
  /**
   * A customer abandoning their own unpaid order. Ownership is proved by RLS
   * before anything is cancelled, so this bounds the probing rather than the
   * cancelling: a caller guessing order numbers gets twenty guesses a minute.
   */
  orderCancel: [20, 60],
  /** Any single admin write. High, because a busy owner clicks a lot. */
  adminMutation: [120, 60],
  /** Bulk activate/deactivate and other whole-table writes. */
  adminBulk: [20, 60],
  /**
   * Fulfilment steps that reach the live Shiprocket account. Lower than the
   * others on purpose: these cost real money and create real parcels, so the
   * failure this guards against is a stuck retry loop, not an attacker.
   */
  fulfilment: [30, 60],
  /**
   * Serviceability lookups, which are customer-facing and proxy to Shiprocket.
   * Without this, a scraper can spend our Shiprocket quota from the checkout
   * page for free.
   */
  serviceability: [60, 60],
  /**
   * How often one *distinct* server error may email the owner.
   *
   * Three an hour per fingerprint. The thing being defended against is not an
   * attacker, it is a broken deploy: one failing page, crawled or refreshed,
   * produces the same error thousands of times, and an inbox with four
   * thousand identical messages in it is indistinguishable from an inbox with
   * none. Three is enough to notice and to see it is still happening.
   */
  /**
   * Writing to a bag. The one limit here that guards *row creation* by an
   * unauthenticated caller.
   *
   * **Keyed on the IP, never on the guest token**, and that is the whole point
   * rather than a detail. A guest cart is owned by a cookie the caller holds,
   * so a client that simply declines to send one gets a fresh token — and
   * `getOrCreateCartId` a fresh `carts` row — on every single request. A limit
   * bucketed by guest token would therefore be a limit an attacker resets at
   * will by dropping a cookie, which is not a limit. `callerIdentity(null)`
   * returns `ip:…` for exactly this reason.
   *
   * Ninety a minute: a customer tapping a quantity stepper is the busiest
   * legitimate caller and comes nowhere near it, while a script minting carts
   * is stopped a long way before it is interesting. Same trade as everything
   * else here — a limit tight enough to be exciting is a limit that eventually
   * rejects a real customer behind one hotel NAT.
   *
   * This bounds the *rate*, not the total. It is a shock absorber, not
   * authorization: every one of these actions is still scoped by RLS to the
   * cart the caller owns, and stock is still decided in the database at
   * checkout. What it stops is one source turning an afternoon into a million
   * rows.
   */
  /**
   * Turning one uploaded photograph into the catalogue's four sizes.
   *
   * Its own policy rather than `adminBulk` (20/min), because the two are sized
   * against different things. `adminBulk` bounds *whole-table writes* — a bulk
   * activate touches every product and twenty a minute is generous. This bounds
   * a single admin working through a shoebox: two shots per product across
   * thirty-five products is seventy calls in one sitting, and the panel is
   * one-photograph-at-a-time with a description typed for each, so the honest
   * ceiling is however fast a person can work rather than however fast a script
   * can loop.
   *
   * A hundred and twenty a minute is far above the first and still bounds a
   * stuck client, which is the actual failure this guards: normalisation is
   * several seconds of server CPU per call, so a retry loop is expensive in a
   * way that a misplaced click is not.
   *
   * It matters that this is generous because of *how* it fails. A throttled
   * upload mid-session does not read as "slow down"; it reads as the site
   * breaking, in the middle of the one task standing between this shop and
   * opening.
   */
  imageProcessing: [120, 60],
  cartWrite: [90, 60],
  /**
   * Trying a coupon code. The refusal messages deliberately collapse "no such
   * code" and "not for you" into one sentence so codes cannot be told apart —
   * this bounds how fast anyone can try telling anyway. Ten a minute is a
   * customer mistyping twice, not a dictionary.
   */
  couponCheck: [10, 60],
  errorReport: [3, 3600],
  /**
   * And a ceiling across *all* fingerprints, because the per-fingerprint limit
   * does not bound a failure that produces a different message every time —
   * a bad database credential throws with a fresh connection id on each
   * attempt. Twenty an hour total; past that the log is the record.
   */
  errorReportTotal: [20, 3600],
} as const satisfies Record<
  string,
  readonly [limit: number, windowSeconds: number]
>;

export type RateLimitPolicy = keyof typeof RATE_LIMITS;

export type RateLimitVerdict = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

const ALLOWED_ON_ERROR: RateLimitVerdict = {
  allowed: true,
  remaining: 0,
  retryAfterSeconds: 0,
};

/**
 * Spend one unit of `policy` for `identity`.
 *
 * `identity` is whatever the caller decided distinguishes one actor from
 * another — a user id, a guest token, an IP, or an IP plus a target id. It is
 * concatenated with the policy name, so callers do not need to namespace it
 * themselves and cannot collide across policies if they forget.
 */
export async function consumeRateLimit(
  policy: RateLimitPolicy,
  identity: string,
): Promise<RateLimitVerdict> {
  const [limit, windowSeconds] = RATE_LIMITS[policy];

  try {
    const { data, error } = await createAdminClient().rpc(
      "consume_rate_limit",
      {
        p_bucket: `${policy}:${identity}`,
        p_limit: limit,
        p_window_seconds: windowSeconds,
      },
    );

    if (error) {
      console.error("[rate-limit] counter unavailable, allowing", {
        policy,
        detail: error.message,
      });
      return ALLOWED_ON_ERROR;
    }

    const row = data?.[0];
    if (!row) {
      console.error("[rate-limit] counter returned no row, allowing", {
        policy,
      });
      return ALLOWED_ON_ERROR;
    }

    return {
      allowed: row.allowed,
      remaining: row.remaining,
      retryAfterSeconds: row.retry_after_seconds,
    };
  } catch (error) {
    console.error("[rate-limit] counter threw, allowing", {
      policy,
      detail: error instanceof Error ? error.message : "unknown",
    });
    return ALLOWED_ON_ERROR;
  }
}

/**
 * The caller's IP, as well as it can be known.
 *
 * `x-vercel-forwarded-for` is set by the platform and cannot be overwritten by
 * the client, so it is preferred. `x-forwarded-for` is the fallback and is only
 * trustworthy behind a proxy that rewrites it — which Vercel does. Off Vercel,
 * treat the result as a hint: a client can send any `x-forwarded-for` it likes,
 * which is another reason nothing security-critical may depend on this.
 *
 * `unknown` is returned rather than throwing, so every caller behind an
 * unidentifiable IP shares one bucket. That is the safe direction: it
 * over-limits an anonymous crowd rather than exempting them.
 */
export async function callerIp(): Promise<string> {
  const h = await headers();
  const vercel = h.get("x-vercel-forwarded-for");
  if (vercel) return firstHop(vercel);

  const forwarded = h.get("x-forwarded-for");
  if (forwarded) return firstHop(forwarded);

  return h.get("x-real-ip")?.trim() || "unknown";
}

function firstHop(header: string): string {
  return header.split(",")[0]?.trim() || "unknown";
}

/**
 * Who to count against for a customer-facing action.
 *
 * A signed-in customer is counted as themselves so that a shared IP — an office,
 * a campus, a phone network's NAT — does not make one shopper's checkout attempts
 * exhaust another's. Everyone else falls back to their IP.
 *
 * A guest token is deliberately *not* used here even though one exists: it is a
 * cookie the client holds, so rotating it resets the counter. It is fine for
 * scoping a bag and useless for limiting.
 */
export async function callerIdentity(userId: string | null): Promise<string> {
  return userId ? `user:${userId}` : `ip:${await callerIp()}`;
}
