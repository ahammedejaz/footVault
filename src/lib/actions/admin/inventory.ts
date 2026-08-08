"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  adminAction,
  INVENTORY_NOTE_MAX,
  type AdminResult,
} from "@/lib/admin/guard";
import {
  getVariantMovements,
  type MovementRow,
} from "@/lib/queries/admin/inventory";

/**
 * Changing stock by hand.
 *
 * The write itself is `public.adjust_variant_stock()`, and the reasons it lives
 * in the database rather than here are worth being explicit about:
 *
 *   - **Attribution has to be in the same transaction as the write.** The
 *     `app.inventory_*` GUCs the ledger trigger reads are transaction-local, so
 *     setting them from here would be a separate round trip on a pooled
 *     connection and would attribute somebody else's movement.
 *   - **`is_admin()` is checked there too**, against `auth.uid()` from the
 *     caller's own JWT. So this action being wrong is not enough to move stock;
 *     Postgres has to be wrong as well.
 *   - **A delta, not a total.** Two people counting the same shelf with
 *     absolutes overwrite each other and one count silently disappears. Two
 *     deltas both land.
 */

const adjustSchema = z.object({
  variantId: z.uuid("That is not a size."),
  delta: z
    .number()
    .int("Whole pairs only.")
    .refine((value) => value !== 0, "Nothing to change.")
    // A shop, not a warehouse. A typo'd 9999 is a worse outcome than an owner
    // having to press the button twice for a genuinely large delivery.
    .refine(
      (value) => Math.abs(value) <= 999,
      "That is more than 999 — split it up.",
    ),
  reason: z.enum(["admin_adjustment", "restock"]),
  note: z
    .string()
    .trim()
    .min(1, "Say why. This goes on the record next to your name.")
    .max(INVENTORY_NOTE_MAX, `Keep it under ${INVENTORY_NOTE_MAX} characters.`),
});

export async function adjustStock(
  input: unknown,
): Promise<AdminResult<{ stock: number; movements: MovementRow[] }>> {
  return adminAction<{ stock: number; movements: MovementRow[] }>(
    "adjustStock",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = adjustSchema.safeParse(input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
          ok: false,
          reason: "invalid",
          message: issue?.message ?? "Check that and try again.",
          field:
            issue?.path[0] === undefined ? undefined : String(issue.path[0]),
        };
      }

      const { data, error } = await supabase.rpc("adjust_variant_stock", {
        p_variant_id: parsed.data.variantId,
        p_delta: parsed.data.delta,
        p_reason: parsed.data.reason,
        p_note: parsed.data.note,
      });

      if (error) {
        /**
         * `CHECK (stock_quantity >= 0)` is what refuses an over-removal, and it
         * arrives as 23514. Translated here rather than shown raw, because
         * "new row violates check constraint" is not a sentence to put in front
         * of a shop owner — and the thing they need to know is that nothing
         * changed.
         */
        if (error.code === "23514") {
          return {
            ok: false,
            reason: "invalid",
            message:
              "That would take the count below zero. Nothing has been changed.",
            field: "delta",
          };
        }
        if (error.code === "FVADM") {
          return {
            ok: false,
            reason: "forbidden",
            message: "That is not available.",
          };
        }
        console.error(
          "[admin] adjust_variant_stock failed:",
          error.message,
          error.code,
        );
        return {
          ok: false,
          reason: "error",
          message: "The stock did not change. Nothing has been recorded.",
        };
      }

      // The storefront reads stock on every product and listing page, and an
      // owner who has just put six pairs back wants to see them on the shop.
      revalidatePath("/admin/inventory");
      revalidatePath("/", "layout");

      return {
        ok: true,
        stock: data ?? 0,
        // Returned with the result so the row can show its own new history
        // without a second round trip and without a full page refresh.
        movements: await getVariantMovements(parsed.data.variantId, 20),
      };
    },
  );
}

const historySchema = z.object({ variantId: z.uuid() });

/** The ledger for one size, on demand — the panel opens per row. */
export async function loadMovements(
  input: unknown,
): Promise<AdminResult<{ movements: MovementRow[] }>> {
  return adminAction<{ movements: MovementRow[] }>(
    "loadMovements",
    "adminMutation",
    async () => {
      const parsed = historySchema.safeParse(input);
      if (!parsed.success) {
        return { ok: false, reason: "invalid", message: "That is not a size." };
      }
      return {
        ok: true,
        movements: await getVariantMovements(parsed.data.variantId, 50),
      };
    },
  );
}
