import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

/**
 * How much of the frame the owner wants a shoe to fill.
 *
 * ## One conversion, in one place
 *
 * The owner types a whole percent, because that is how the rule is stated
 * everywhere it is written down — Amazon says 85%, Flipkart says 85%, and a
 * form asking for 0.85 would be a form that gets 85 typed into it eventually.
 * Every calculation wants a fraction. So the column holds the percent, this
 * function returns the fraction, and nothing else converts.
 *
 * That is the paise-and-rupees lesson applied to a smaller number: two
 * representations of one quantity are fine, and the moment more than one place
 * knows how to move between them, one of them is wrong by a factor of a hundred
 * in a way nothing fails on.
 *
 * ## Why a missing row is a default rather than a refusal
 *
 * The loyalty settings refuse to operate unset, and deliberately: an unset earn
 * rate that quietly defaults would be the shop giving away margin it never
 * agreed to. Nothing here is money. A missing row means the crop tool draws its
 * guide at the marketplace figure and the owner can move it, which is strictly
 * better than a panel that refuses to open because a settings row is absent.
 */
export const SUGGESTED_TARGET_FILL_PERCENT = 85;

/** The bounds the form and this reader agree on. */
export const MIN_TARGET_FILL_PERCENT = 50;
export const MAX_TARGET_FILL_PERCENT = 95;

/**
 * The target as a fraction of the frame's edge, measured on the subject's
 * **longest side**. See the migration and the admin control's own wording for
 * why that distinction is stated everywhere it appears.
 */
export async function readTargetFill(
  supabase: SupabaseClient<Database>,
): Promise<number> {
  const { data, error } = await supabase
    .from("site_settings")
    .select("value")
    .eq("key", "images")
    .maybeSingle();

  if (error) {
    console.error("[images] could not read the target fill:", error.message);
    return SUGGESTED_TARGET_FILL_PERCENT / 100;
  }

  return targetFillFraction(data?.value);
}

/** The same conversion, for a settings blob already in hand. */
export function targetFillFraction(value: unknown): number {
  const percent =
    value && typeof value === "object"
      ? (value as { target_fill_percent?: unknown }).target_fill_percent
      : undefined;

  if (typeof percent !== "number" || !Number.isFinite(percent)) {
    return SUGGESTED_TARGET_FILL_PERCENT / 100;
  }

  return (
    Math.min(
      MAX_TARGET_FILL_PERCENT,
      Math.max(MIN_TARGET_FILL_PERCENT, percent),
    ) / 100
  );
}
