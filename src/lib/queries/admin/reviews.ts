import "server-only";

import { createClient } from "@/lib/supabase/server";
import { rows } from "@/lib/queries/run";

/**
 * The moderation desk's read. Through the caller's RLS client — the
 * "admins read every review" policy is what admits them — so a session that
 * is not an admin sees nothing here rather than everything.
 */

export type AdminReviewRow = {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
  displayName: string;
  createdAt: string;
  isApproved: boolean;
  removedAt: string | null;
  removedReason: string | null;
  productName: string;
  productSlug: string;
  /** Who wrote it — the account, beside the snapshot the storefront shows. */
  userId: string;
  reviewerName: string | null;
};

export async function listReviewsForAdmin(input: {
  rating?: number;
  productId?: string;
  /** "live" (default), "removed", or "all". */
  state?: "live" | "removed" | "all";
}): Promise<AdminReviewRow[]> {
  const supabase = await createClient();

  let query = supabase
    .from("reviews")
    .select(
      `id, rating, title, body, display_name, created_at, is_approved,
       removed_at, removed_reason, user_id,
       product:products!inner ( name, slug ),
       reviewer:profiles!reviews_user_id_fkey ( full_name )`,
    )
    .order("created_at", { ascending: false })
    .limit(200);

  if (input.rating) query = query.eq("rating", input.rating);
  if (input.productId) query = query.eq("product_id", input.productId);
  if ((input.state ?? "live") === "live") query = query.is("removed_at", null);
  if (input.state === "removed") query = query.not("removed_at", "is", null);

  const found = await rows<{
    id: string;
    rating: number;
    title: string | null;
    body: string | null;
    display_name: string;
    created_at: string;
    is_approved: boolean;
    removed_at: string | null;
    removed_reason: string | null;
    user_id: string;
    product: { name: string; slug: string };
    reviewer: { full_name: string | null } | null;
  }>("admin.reviews.list", query);

  return found.map((row) => ({
    id: row.id,
    rating: row.rating,
    title: row.title,
    body: row.body,
    displayName: row.display_name,
    createdAt: row.created_at,
    isApproved: row.is_approved,
    removedAt: row.removed_at,
    removedReason: row.removed_reason,
    productName: row.product.name,
    productSlug: row.product.slug,
    userId: row.user_id,
    reviewerName: row.reviewer?.full_name ?? null,
  }));
}
