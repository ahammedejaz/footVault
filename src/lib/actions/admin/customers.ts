"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminAction, type AdminResult } from "@/lib/admin/guard";

/**
 * Withdrawing Pay on Delivery from one customer.
 *
 * **The tail is where the losses concentrate.** A refused parcel costs the shop
 * the forward leg and the return leg and collects nothing, and refusals are not
 * spread evenly — a handful of phone numbers account for most of them. The
 * round-trip advance means the shop is covered on any single refusal, so this
 * is not about recovering money; it is about not spending a week's dispatch
 * capacity on parcels that come back.
 *
 * **Why it is per customer and not a threshold.** A rule that blocked anybody
 * with two refusals would catch a customer who was genuinely out both times,
 * and the shop would never know it had turned them away. This is a judgement
 * with a name against it: the owner looks at the orders, decides, and the
 * reason is stored so somebody can be told why.
 *
 * The column it writes is frozen against the customer themselves by
 * `guard_profile_role()` — the trigger that has always protected `role` now
 * protects these two as well, because a control the person it constrains can
 * switch off is not a control. That was G-2 in the Phase 7 adversarial review,
 * reproduced end to end before it was closed.
 *
 * Written through the **caller's own client**, so the `admins` policy on
 * `profiles` is re-checked by Postgres on the row. `elevated` would work and
 * would mean the panel's authorisation depended on this file being right.
 */

const blockSchema = z.object({
  customerId: z.uuid("That is not a customer."),
  blocked: z.boolean(),
  reason: z
    .string()
    .trim()
    .max(240, "Keep the reason under 240 characters.")
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
});

export async function setCodBlocked(
  input: unknown,
): Promise<AdminResult<object>> {
  return adminAction<object>(
    "setCodBlocked",
    "adminMutation",
    async ({ actor, supabase }) => {
      const parsed = blockSchema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          reason: "invalid",
          message:
            parsed.error.issues[0]?.message ?? "Check that and try again.",
        };
      }
      const { customerId, blocked, reason } = parsed.data;

      /**
       * A block with no reason is a block nobody can explain to the customer
       * who rings up about it, and "the system did it" is not an answer a shop
       * can give. Required on the way in, optional on the way out.
       */
      if (blocked && !reason) {
        return {
          ok: false,
          reason: "invalid",
          message:
            "Say why. If this customer rings up, somebody has to be able to tell them.",
          field: "reason",
        };
      }

      const { error } = await supabase
        .from("profiles")
        .update({
          cod_blocked_at: blocked ? new Date().toISOString() : null,
          cod_blocked_reason: blocked
            ? `${reason} — ${actor.name ?? actor.email ?? "an admin"}`
            : null,
        })
        .eq("id", customerId);

      if (error) {
        console.error("[admin] setCodBlocked failed:", error.message, error.code);
        return {
          ok: false,
          reason: "error",
          message: "That did not save. Nothing has been changed.",
        };
      }

      revalidatePath("/admin/customers");
      return { ok: true };
    },
  );
}
