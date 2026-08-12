"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { callerIdentity, consumeRateLimit } from "@/lib/rate-limit";
import { writeReview } from "@/lib/reviews/write";
import { createAdminClient } from "@/lib/supabase/admin";
import { maybeRow } from "@/lib/queries/run";

/**
 * Writing a review — the door with the delivered-parcel lock on it.
 *
 * The client holds no write grant on `reviews` at all (Phase 11 revoked
 * them; audit 11A.1), so this action is the ONLY write path. It is a thin
 * wrapper: who is asking (the session), how often (the limiter), then
 * `writeReview` — the enforcement seam, which `audit:reviews` drives
 * directly with real user ids. No check lives here that does not live
 * there.
 */

const schema = z.object({
  productId: z.uuid("That is not a product."),
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().max(120, "Keep the title under 120 characters.").optional(),
  body: z.string().trim().max(2000, "Keep the review under 2000 characters.").optional(),
});

export type ReviewWriteResult =
  | { ok: true; published: boolean }
  | {
      ok: false;
      reason:
        | "signed_out"
        | "not_delivered"
        | "already_reviewed"
        | "invalid"
        | "throttled"
        | "error";
      message: string;
    };

export async function submitReview(input: unknown): Promise<ReviewWriteResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid",
      message: parsed.error.issues[0]?.message ?? "That review did not parse.",
    };
  }

  const user = await getCurrentUser();
  if (!user) {
    return {
      ok: false,
      reason: "signed_out",
      message: "Sign in to review something you have received.",
    };
  }

  const throttle = await consumeRateLimit(
    "reviewWrite",
    await callerIdentity(user.id),
  );
  if (!throttle.allowed) {
    return {
      ok: false,
      reason: "throttled",
      message: "That is a lot of reviews at once. Give it a minute.",
    };
  }

  const verdict = await writeReview({
    userId: user.id,
    productId: parsed.data.productId,
    rating: parsed.data.rating,
    title: parsed.data.title || null,
    body: parsed.data.body || null,
  });

  if (verdict.ok) {
    /**
     * The page the review belongs on is static; regenerating it is what
     * makes post-moderation's "publishes immediately" true. The reviews
     * block reads live inside that regeneration — see reviews-section.tsx.
     */
    const slug = await maybeRow<{ slug: string }>(
      "reviews.productSlug",
      createAdminClient()
        .from("products")
        .select("slug")
        .eq("id", parsed.data.productId)
        .maybeSingle(),
    );
    if (slug) revalidatePath(`/product/${slug.slug}`);
  }

  return verdict;
}

const listSchema = z.object({
  productId: z.uuid(),
  sort: z.enum(["recent", "rating"]),
  page: z.number().int().min(1).max(200),
});

/**
 * More reviews, for the client-side sort and pager.
 *
 * A *read*, shaped as an action only because the product page is static —
 * its header forbids `searchParams` (a read there would put a database
 * round trip in front of the LCP image), so paging cannot be links.
 * Everything returned is already public over PostgREST under the
 * approved-and-not-removed RLS policy; this adds no reach, only a
 * POST-shaped door to the same rows, so it carries validation but no auth
 * and no throttle beyond the platform's.
 */
export async function fetchProductReviews(input: unknown) {
  const parsed = listSchema.safeParse(input);
  if (!parsed.success) {
    return { reviews: [], hasMore: false };
  }
  const { listProductReviews } = await import("@/lib/queries/reviews");
  return listProductReviews(parsed.data);
}
