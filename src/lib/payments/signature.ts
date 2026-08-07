import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC, and comparing one without leaking it.
 *
 * Two functions, in their own file, because this is the entire security of the
 * payment path and it should be possible to read all of it in one screen and be
 * sure. Nothing here reads an environment variable or a database: the secret
 * arrives as an argument, which is also what makes the whole thing directly
 * testable against Razorpay's published vectors.
 *
 * No `razorpay` npm package. This is the only cryptography the integration
 * needs, `node:crypto` already ships it, and a dependency in the money path
 * costs more than the twenty lines below save. See the phase brief.
 */

/**
 * Razorpay signs everything with lowercase hex HMAC-SHA256, twice over:
 *
 *   the browser callback — HMAC(`${orderId}|${paymentId}`, KEY_SECRET)
 *   the webhook          — HMAC(rawRequestBody, WEBHOOK_SECRET)
 *
 * Different secrets, and in the webhook's case the message is the exact bytes
 * that arrived. See `verifyHexSignature` for why that matters.
 */
export function hmacSha256Hex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

/**
 * Does `provided` match the HMAC of `message`? Answered in constant time.
 *
 * `===` on strings short-circuits at the first differing character, so the
 * comparison takes measurably longer the more of the prefix an attacker has
 * guessed. That turns forging a signature from 2^256 work into 64 rounds of
 * "try sixteen characters and time the response". The attack is fiddly over the
 * public internet and completely practical from a colocated machine, and the
 * fix is one function call, so there is no version of this worth arguing about.
 *
 * `timingSafeEqual` throws if the buffers differ in length — which is itself a
 * length oracle, but signature length is fixed and public (64 hex characters),
 * so nothing is learned. The length check has to come first regardless, or a
 * malformed signature crashes the handler instead of being rejected.
 *
 * The message is hashed *inside* this function on purpose: a caller who
 * computes the expected value separately eventually compares the wrong two
 * things, and that bug looks like working code.
 */
export function verifyHexSignature(
  secret: string,
  message: string,
  provided: string | null | undefined,
): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;

  const expected = hmacSha256Hex(secret, message);

  // Not `Buffer.from(provided, "hex")`: a non-hex character decodes to a
  // *shorter* buffer instead of failing, so "zz…" and a 32-byte prefix could
  // end up the same length. Compared as ASCII, the bytes are exactly what
  // arrived.
  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(provided, "utf8");
  if (expectedBytes.length !== providedBytes.length) return false;

  return timingSafeEqual(expectedBytes, providedBytes);
}
