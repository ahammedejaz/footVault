"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminAction, type AdminResult } from "@/lib/admin/guard";

/**
 * Moderation, after publication.
 *
 * Removal is soft and reasoned: the row survives with `removed_at`,
 * `removed_reason` and `removed_by`, so a pattern of removals stays visible
 * later — a shop that silently deletes its two-star reviews should at least
 * have to look at the ledger of itself doing so. The aggregate trigger
 * excludes removed rows, so the stars update the moment the removal lands.
 *
 * Through the service role (`elevated`): Phase 11 revoked every client write
 * grant on `reviews`, admins included — the same posture as
 * `inventory_movements`, where even an admin cannot PATCH history over
 * PostgREST and the action is the only door.
 */

const removeSchema = z.object({
  reviewId: z.uuid("That is not a review."),
  reason: z
    .string()
    .trim()
    .min(3, "Say why this review is being removed — the reason is recorded.")
    .max(500, "Keep the reason under 500 characters."),
});

export async function removeReview(
  input: unknown,
): Promise<AdminResult<{ removed: true }>> {
  return adminAction<{ removed: true }>(
    "removeReview",
    "adminMutation",
    async ({ actor, elevated }) => {
      const parsed = removeSchema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          reason: "invalid",
          message: parsed.error.issues[0]?.message ?? "That did not parse.",
        };
      }

      const { data, error } = await elevated()
        .from("reviews")
        .update({
          removed_at: new Date().toISOString(),
          removed_reason: parsed.data.reason,
          removed_by: actor.id,
        })
        .eq("id", parsed.data.reviewId)
        // Idempotent on the first removal: a second click changes neither the
        // reason nor the clock, and reports what actually happened.
        .is("removed_at", null)
        .select("id, product:products!inner(slug)");

      if (error) {
        return { ok: false, reason: "error", message: error.message };
      }
      if ((data?.length ?? 0) !== 1) {
        return {
          ok: false,
          reason: "invalid",
          message: "That review is already removed, or never existed.",
        };
      }

      const slug = (data![0] as { product: { slug: string } }).product.slug;
      revalidatePath(`/product/${slug}`);
      revalidatePath("/admin/reviews");
      return { ok: true, removed: true };
    },
  );
}

const restoreSchema = z.object({ reviewId: z.uuid("That is not a review.") });

/**
 * The undo, because a soft removal without one is a hard removal with extra
 * steps. Restoring clears the removal fields; the recorded reason lives on
 * only in whatever the admin wrote next time.
 */
export async function restoreReview(
  input: unknown,
): Promise<AdminResult<{ restored: true }>> {
  return adminAction<{ restored: true }>(
    "restoreReview",
    "adminMutation",
    async ({ elevated }) => {
      const parsed = restoreSchema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          reason: "invalid",
          message: parsed.error.issues[0]?.message ?? "That did not parse.",
        };
      }

      const { data, error } = await elevated()
        .from("reviews")
        .update({ removed_at: null, removed_reason: null, removed_by: null })
        .eq("id", parsed.data.reviewId)
        .not("removed_at", "is", null)
        .select("id, product:products!inner(slug)");

      if (error) {
        return { ok: false, reason: "error", message: error.message };
      }
      if ((data?.length ?? 0) !== 1) {
        return {
          ok: false,
          reason: "invalid",
          message: "That review is not removed, or never existed.",
        };
      }

      const slug = (data![0] as { product: { slug: string } }).product.slug;
      revalidatePath(`/product/${slug}`);
      revalidatePath("/admin/reviews");
      return { ok: true, restored: true };
    },
  );
}
