import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { maybeRow } from "@/lib/queries/run";

/**
 * The review write — the enforcement, importable.
 *
 * Split out of the Server Action so `audit:reviews` can drive the real
 * seam with real user ids (an action needs a request's cookies to answer
 * who is asking; this takes the answer as an argument). `submitReview` is
 * this plus authentication and a rate limit, nothing more — there is
 * deliberately no second implementation of any check here.
 *
 * The eligibility read is the whole anti-fraud design: one delivered order
 * of theirs carrying this product, resolved on the service role, reading
 * `orders.delivered_at` — the evidence field, never `status`. Accounts are
 * free; a delivered parcel is the one thing in this system a fake reviewer
 * cannot get cheaply.
 */
export type ReviewWriteVerdict =
  | { ok: true; published: boolean }
  | {
      ok: false;
      reason: "not_delivered" | "already_reviewed" | "error";
      message: string;
    };

export async function writeReview(input: {
  userId: string;
  productId: string;
  rating: number;
  title: string | null;
  body: string | null;
}): Promise<ReviewWriteVerdict> {
  const admin = createAdminClient();

  const delivered = await maybeRow<{ id: string }>(
    "reviews.eligibility",
    admin
      .from("orders")
      .select("id, order_items!inner(product_id)")
      .eq("user_id", input.userId)
      .eq("order_items.product_id", input.productId)
      .not("delivered_at", "is", null)
      .limit(1)
      .maybeSingle(),
  );
  if (!delivered) {
    return {
      ok: false,
      reason: "not_delivered",
      message:
        "Reviews are for delivered orders. Once a pair you ordered arrives, you can review it.",
    };
  }

  /**
   * The name the storefront will print: first name only, snapshotted now.
   * `profiles` is self-or-admin readable and the product page reads with
   * the cookieless static client, so the snapshot is what keeps that page
   * fast (audit 11A.2).
   */
  const profile = await maybeRow<{ full_name: string | null }>(
    "reviews.displayName",
    admin
      .from("profiles")
      .select("full_name")
      .eq("id", input.userId)
      .maybeSingle(),
  );
  const displayName =
    profile?.full_name?.trim().split(/\s+/)[0] || "Verified customer";

  /**
   * Post-moderation (owner's decision, plan D2): publish now, removable
   * later. A setting so reversing it never needs a migration; an absent row
   * means the decided default.
   */
  const moderation = await maybeRow<{ value: { require_approval?: boolean } }>(
    "reviews.moderationSetting",
    admin
      .from("site_settings")
      .select("value")
      .eq("key", "reviews")
      .maybeSingle(),
  );
  const requireApproval = moderation?.value?.require_approval === true;

  const { error } = await admin.from("reviews").insert({
    product_id: input.productId,
    user_id: input.userId,
    rating: input.rating,
    title: input.title,
    body: input.body,
    display_name: displayName,
    // True by construction: the eligibility check above IS the definition.
    is_verified_purchase: true,
    is_approved: !requireApproval,
  });

  if (error) {
    // The database's one-per-customer constraint answering a second attempt.
    if (error.code === "23505") {
      return {
        ok: false,
        reason: "already_reviewed",
        message: "You have already reviewed this pair. One review per customer.",
      };
    }
    console.error("[reviews] insert failed:", error.message);
    return {
      ok: false,
      reason: "error",
      message: "Something went wrong saving your review. Try again in a moment.",
    };
  }

  return { ok: true, published: !requireApproval };
}
