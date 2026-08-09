import "server-only";

import { roundedDiscountPaise } from "@/lib/payments/discount";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The advisory half of coupon validation — the preview.
 *
 * The bag and the checkout both ask "what would this code be worth right now",
 * and this answers from the same eight rules the database enforces. It is
 * deliberately *not* the authority: the binding check runs inside
 * `create_order_with_stock`, under a row lock on the coupon, in the same
 * transaction as the stock decrement. Everything here can be stale by the time
 * Place Order lands, and that is fine — the function re-refuses and the
 * customer gets the same sentence a moment later.
 *
 * Reads through the admin client because `coupons` grants nothing to anon or
 * authenticated by design — a customer who could select from it could
 * enumerate codes. Every caller must therefore treat this module as a
 * boundary: the only things that leave it are a verdict and a number.
 *
 * ## What a refusal says (owner's decision, 2026-08-10)
 *
 * `expired`, `minimum`, `limit` and `used` are actionable, safe to say, and
 * said. "No such code", "not for you", "disabled" and "not started yet" are
 * one `unknown`, so codes can be neither enumerated nor confirmed before
 * launch. Audience is checked before expiry so a not-for-you code reads as
 * unknown even when it is also expired. The SQL half orders its checks
 * identically — `scripts/audit/coupons.ts` holds the two in agreement.
 */

export type CouponRejection = {
  ok: false;
  reason: "unknown" | "expired" | "minimum" | "limit" | "used";
  /** Set for `minimum`: the floor the basket has not reached, in paise. */
  minOrderPaise?: number;
};

export type CouponVerdict =
  | {
      ok: true;
      /** The canonical code as the admin typed it, not as the customer did. */
      code: string;
      discountPaise: number;
    }
  | CouponRejection;

export async function evaluateCoupon(input: {
  code: string;
  userId: string | null;
  goodsTotalPaise: number;
}): Promise<CouponVerdict> {
  const admin = createAdminClient();

  /**
   * `ilike` is the case-insensitive equality PostgREST offers, and its pattern
   * characters are the reason for the escape: an unescaped `%` typed into the
   * coupon field would otherwise match *some* code — which is enumeration by
   * wildcard, the exact thing the admin-only RLS exists to prevent.
   */
  const pattern = input.code.trim().replace(/([\\%_])/g, "\\$1");

  const { data: coupon, error } = await admin
    .from("coupons")
    .select(
      "id, code, type, value, min_order_value, max_discount, usage_limit, used_count, per_user_limit, audience, starts_at, expires_at, is_active",
    )
    .ilike("code", pattern)
    .maybeSingle();

  if (error) throw new Error(`coupon lookup failed: ${error.message}`);
  if (!coupon) return { ok: false, reason: "unknown" };

  if (coupon.audience === "specific_customers") {
    if (!input.userId) return { ok: false, reason: "unknown" };
    const { data: membership, error: memberError } = await admin
      .from("coupon_customers")
      .select("coupon_id")
      .eq("coupon_id", coupon.id)
      .eq("user_id", input.userId)
      .maybeSingle();
    if (memberError)
      throw new Error(`coupon audience lookup failed: ${memberError.message}`);
    if (!membership) return { ok: false, reason: "unknown" };
  }

  if (!coupon.is_active) return { ok: false, reason: "unknown" };

  const now = Date.now();
  if (coupon.starts_at && now < Date.parse(coupon.starts_at))
    return { ok: false, reason: "unknown" };
  if (coupon.expires_at && now >= Date.parse(coupon.expires_at))
    return { ok: false, reason: "expired" };

  if (coupon.usage_limit !== null && coupon.used_count >= coupon.usage_limit)
    return { ok: false, reason: "limit" };

  if (coupon.per_user_limit !== null && input.userId) {
    const { count, error: usesError } = await admin
      .from("coupon_redemptions")
      .select("id", { count: "exact", head: true })
      .eq("coupon_id", coupon.id)
      .eq("user_id", input.userId)
      .is("released_at", null);
    if (usesError)
      throw new Error(`coupon usage lookup failed: ${usesError.message}`);
    if ((count ?? 0) >= coupon.per_user_limit)
      return { ok: false, reason: "used" };
  }

  if (input.goodsTotalPaise < coupon.min_order_value)
    return {
      ok: false,
      reason: "minimum",
      minOrderPaise: coupon.min_order_value,
    };

  // The shop's one rounding rule: up to a whole rupee, then cap — max_discount
  // and the goods total, after the rounding. Same helper the prepaid discount
  // uses, so the two cannot drift.
  const raw =
    coupon.type === "percent"
      ? (input.goodsTotalPaise * coupon.value) / 100
      : coupon.value;
  const discountPaise = roundedDiscountPaise(
    raw,
    input.goodsTotalPaise,
    ...(coupon.max_discount !== null ? [coupon.max_discount] : []),
  );

  return { ok: true, code: coupon.code, discountPaise };
}

/**
 * The sentence for each refusal, written once so the bag, the checkout and the
 * Place Order failure all say the same thing.
 */
export function couponRejectionMessage(rejection: CouponRejection): string {
  switch (rejection.reason) {
    case "expired":
      return "That code has expired.";
    case "minimum": {
      const rupees =
        rejection.minOrderPaise !== undefined
          ? `₹${(rejection.minOrderPaise / 100).toLocaleString("en-IN")}`
          : null;
      return rupees
        ? `That code needs an order of at least ${rupees} in goods.`
        : "Your order is under this code's minimum.";
    }
    case "limit":
      return "That code has been fully used up.";
    case "used":
      return "You have already used that code.";
    case "unknown":
      return "That code did not work. Check it and try again.";
  }
}
