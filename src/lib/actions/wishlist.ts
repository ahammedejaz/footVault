"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/actions/cart";

/**
 * Saving a shoe.
 *
 * Requires an account, and that is the honest design rather than a limitation:
 * a wishlist keyed to a browser cookie dies with the browser, which is the
 * opposite of what saving something is for. The bag is the thing that must work
 * signed out, and it does.
 *
 * The action returns `needsSignIn` rather than redirecting. Redirecting out of
 * a heart tap would throw away the page the customer is on and their scroll
 * position; the caller shows a prompt in place, carries the intent through the
 * round trip (src/lib/pending-intent.ts) and completes the save on the way
 * back.
 */

const productIdSchema = z.uuid();

export type SaveResult = { saved: boolean } | { needsSignIn: true };

export async function toggleSaved(productId: string): Promise<ActionResult<SaveResult>> {
  const parsed = productIdSchema.safeParse(productId);
  if (!parsed.success) return { ok: false, message: "That product could not be saved." };

  const user = await getCurrentUser();
  if (!user) return { ok: true, data: { needsSignIn: true } };

  try {
    const supabase = await createClient();

    const { data: existing, error: readError } = await supabase
      .from("wishlist_items")
      .select("id")
      .eq("user_id", user.id)
      .eq("product_id", parsed.data)
      .maybeSingle();

    if (readError) {
      console.error("[wishlist] read failed:", readError.message);
      return { ok: false, message: "That did not save. Try again." };
    }

    if (existing) {
      const { error } = await supabase.from("wishlist_items").delete().eq("id", existing.id);
      if (error) {
        console.error("[wishlist] delete failed:", error.message);
        return { ok: false, message: "That did not save. Try again." };
      }
      revalidatePath("/", "layout");
      return { ok: true, data: { saved: false } };
    }

    const { error } = await supabase
      .from("wishlist_items")
      .insert({ user_id: user.id, product_id: parsed.data });

    // 23505 is the unique constraint: the same product saved twice, from two
    // tabs or a double tap. The end state is what was asked for, so it is not
    // an error to report.
    if (error && error.code !== "23505") {
      console.error("[wishlist] insert failed:", error.message);
      return { ok: false, message: "That did not save. Try again." };
    }

    revalidatePath("/", "layout");
    return { ok: true, data: { saved: true } };
  } catch (error) {
    console.error("[wishlist] toggleSaved threw:", error);
    return { ok: false, message: "That did not save. Try again." };
  }
}

/**
 * Save without toggling.
 *
 * Used by /auth/callback to finish what the customer started before they signed
 * in. A toggle would be wrong there: if the product was already saved on
 * another device, honouring "save this" by removing it is the opposite of the
 * intent.
 */
export async function saveProduct(productId: string): Promise<boolean> {
  const parsed = productIdSchema.safeParse(productId);
  const user = await getCurrentUser();
  if (!parsed.success || !user) return false;

  const supabase = await createClient();
  const { error } = await supabase
    .from("wishlist_items")
    .insert({ user_id: user.id, product_id: parsed.data });

  if (error && error.code !== "23505") {
    console.error("[wishlist] saveProduct failed:", error.message);
    return false;
  }
  return true;
}
