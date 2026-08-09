"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { readGuestToken } from "@/lib/cart/token";
import {
  couponRejectionMessage,
  evaluateCoupon,
} from "@/lib/coupons/validate";
import { getCart } from "@/lib/queries/cart";
import { callerIdentity, consumeRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

/**
 * Applying a code to the bag — the advisory half of coupons.
 *
 * What this writes is `carts.coupon_code` and nothing else: the code waits on
 * the cart row so it survives navigation and the cart→checkout handoff, and
 * the *binding* validation happens inside `create_order_with_stock` at Place
 * Order, under a row lock, in the same transaction as the stock claim. A code
 * that dies between here and there — expires, runs out, is switched off — is
 * caught at the only moment that counts, and the customer hears the same
 * sentence this action would have said.
 *
 * Rate-limited under `couponCheck` because the refusal copy deliberately
 * collapses "no such code" and "not for you" into one message; the limiter
 * bounds how fast anyone can probe past that anyway. Keyed like `cartWrite`:
 * the user id when signed in, the IP when not — never the guest token, which
 * the caller can reset at will.
 */

const schema = z.object({
  code: z
    .string()
    .trim()
    .min(1, "Type a code first.")
    .max(40, "That code did not work. Check it and try again.")
    // The character set an admin can actually create — anything outside it
    // cannot be a real code, so it fails without a database round trip.
    .regex(/^[A-Za-z0-9_-]+$/, "That code did not work. Check it and try again."),
});

export type CouponFieldResult =
  | { ok: true; code: string; discountPaise: number }
  | { ok: false; message: string };

export async function applyCoupon(input: unknown): Promise<CouponFieldResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Type a code first.",
    };
  }

  const user = await getCurrentUser();
  const throttle = await consumeRateLimit(
    "couponCheck",
    await callerIdentity(user?.id ?? null),
  );
  if (!throttle.allowed) {
    return { ok: false, message: "Give that a moment, then try again." };
  }

  try {
    const cart = await getCart();
    if (!cart.id || cart.lines.length === 0) {
      return { ok: false, message: "Add something to your bag first." };
    }

    const verdict = await evaluateCoupon({
      code: parsed.data.code,
      userId: user?.id ?? null,
      goodsTotalPaise: cart.subtotal,
    });

    if (!verdict.ok) {
      return { ok: false, message: couponRejectionMessage(verdict) };
    }

    const saved = await writeCartCode(cart.id, verdict.code);
    if (!saved) return { ok: false, message: "That did not save. Try again." };

    revalidatePath("/cart");
    revalidatePath("/checkout");
    return { ok: true, code: verdict.code, discountPaise: verdict.discountPaise };
  } catch (error) {
    console.error(
      "[coupon] applyCoupon failed:",
      error instanceof Error ? error.message : "unknown",
    );
    return { ok: false, message: "We could not check that just now." };
  }
}

export async function removeCoupon(): Promise<CouponFieldResult> {
  const user = await getCurrentUser();
  const throttle = await consumeRateLimit(
    "couponCheck",
    await callerIdentity(user?.id ?? null),
  );
  if (!throttle.allowed) {
    return { ok: false, message: "Give that a moment, then try again." };
  }

  try {
    const cart = await getCart();
    if (!cart.id) return { ok: true, code: "", discountPaise: 0 };

    const cleared = await writeCartCode(cart.id, null);
    if (!cleared) return { ok: false, message: "That did not save. Try again." };

    revalidatePath("/cart");
    revalidatePath("/checkout");
    return { ok: true, code: "", discountPaise: 0 };
  } catch (error) {
    console.error(
      "[coupon] removeCoupon failed:",
      error instanceof Error ? error.message : "unknown",
    );
    return { ok: false, message: "That did not save. Try again." };
  }
}

/**
 * Through the RLS client, deliberately: the policies on `carts` scope updates
 * to the cart the caller owns, so a forged cart id writes nothing. The guard
 * on `readGuestToken` mirrors `getCart` — a caller with neither identity has
 * no cart, and got refused above.
 */
async function writeCartCode(
  cartId: string,
  code: string | null,
): Promise<boolean> {
  const user = await getCurrentUser();
  const guestToken = user ? null : await readGuestToken();
  if (!user && !guestToken) return false;

  const supabase = await createClient();
  const { error } = await supabase
    .from("carts")
    .update({ coupon_code: code })
    .eq("id", cartId)
    .eq("status", "active");

  if (error) {
    console.error("[coupon] cart update failed:", error.message);
    return false;
  }
  return true;
}
