import "server-only";

/**
 * Where the payment secrets are read, and the only place.
 *
 * Not in `src/lib/env.ts`, deliberately. That file is imported by the Supabase
 * clients, which are imported by nearly everything, and two of the three values
 * below are secrets that must never be one careless import away from a browser
 * bundle. `import "server-only"` at the top of *this* file makes that import a
 * build error rather than a code review.
 *
 * **There is no `NEXT_PUBLIC_RAZORPAY_KEY_ID`, and there must not be one.** The
 * key id is publishable — it is designed to sit in a checkout modal — but a
 * `NEXT_PUBLIC_` variable is inlined into every page of the bundle, including
 * the ones that will never take a payment. The server hands the key id to the
 * browser inside `PaymentInitiation`, at the moment an order exists and is
 * about to be paid, and nowhere else. Same value, a hundredth of the exposure,
 * and it can be rotated without a redeploy of the whole site.
 *
 * The three variables are three different things and confusing them is the
 * classic Razorpay integration bug:
 *
 *   RAZORPAY_KEY_ID          publishable. Basic-auth username, and the `key`
 *                            the checkout modal opens with.
 *   RAZORPAY_KEY_SECRET      secret. Basic-auth password, and the HMAC key for
 *                            the *browser callback* signature.
 *   RAZORPAY_WEBHOOK_SECRET  a different secret, set by hand in the Razorpay
 *                            dashboard when the webhook is registered. The HMAC
 *                            key for the `x-razorpay-signature` header, and
 *                            **only** for that. Verifying a webhook with the
 *                            key secret fails every time, and the symptom —
 *                            "all my webhooks are 400" — looks like a network
 *                            problem rather than a wrong constant.
 */

/**
 * Blank is the same as absent.
 *
 * `.env.local` currently holds `RAZORPAY_WEBHOOK_SECRET=` with nothing after
 * it, because creating the secret is an owner task in the dashboard. An empty
 * string is falsy in JavaScript but a shell that exports it still produces a
 * defined variable, and `process.env.X !== undefined` would have called that
 * configured. Trim, then treat empty as missing.
 */
function readSecret(name: string): string | null {
  const value = process.env[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";

/** How long we wait on Razorpay before giving up. A hung checkout is worse than a failed one. */
export const RAZORPAY_TIMEOUT_MS = 10_000;

export function razorpayKeyId(): string | null {
  return readSecret("RAZORPAY_KEY_ID");
}

export function razorpayKeySecret(): string | null {
  return readSecret("RAZORPAY_KEY_SECRET");
}

export function razorpayWebhookSecret(): string | null {
  return readSecret("RAZORPAY_WEBHOOK_SECRET");
}

/**
 * Can we talk to Razorpay at all?
 *
 * This is what `PaymentAdapter.isAvailable()` answers with, and the checkout
 * page filters the payment choices on it. A shop with no keys configured must
 * not offer a method that 500s the moment it is picked — the customer has then
 * been failed twice, once by the outage and once by being invited into it.
 *
 * The webhook secret is deliberately **not** part of this. Payments can be
 * taken and verified through the client callback without it; what is lost is
 * the authoritative confirmation for customers whose browser never came back.
 * That is a degraded shop, not a closed one, and refusing to sell over it would
 * be the wrong trade.
 */
export function isRazorpayConfigured(): boolean {
  return razorpayKeyId() !== null && razorpayKeySecret() !== null;
}

/**
 * The API credentials, or a thrown error naming what is missing.
 *
 * Call this only after `isRazorpayConfigured()`. It throws rather than
 * returning null because every caller is already inside a path that has decided
 * Razorpay is in use, and threading a null through the request builder buys
 * nothing but an unreachable branch.
 */
export function requireRazorpayApiKeys(): { keyId: string; keySecret: string } {
  const keyId = razorpayKeyId();
  const keySecret = razorpayKeySecret();
  if (!keyId || !keySecret) {
    throw new Error(
      "Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in " +
        ".env.local and in the Vercel project (Preview and Production separately). " +
        "Neither takes a NEXT_PUBLIC_ prefix.",
    );
  }
  return { keyId, keySecret };
}
