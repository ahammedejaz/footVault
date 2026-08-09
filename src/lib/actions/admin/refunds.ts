"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminAction, type AdminResult } from "@/lib/admin/guard";
import {
  importRefundsForOrder,
  initiateRefund,
} from "@/lib/orders/refunds";

/**
 * The two buttons on the refund panel, guarded like every admin write.
 *
 * Neither takes an amount. The amount is computed server-side from the policy
 * matrix in `src/lib/orders/refund-policy.ts`; what the browser sends is
 * `expectedPaise`, the figure the admin was *shown* — recomputed and refused
 * on any difference, so a stale tab cannot confirm yesterday's number. The
 * cause is the one input that is genuinely the admin's to choose, because
 * whether the shop made the mistake is not knowable from any column.
 */

const createSchema = z.object({
  orderId: z.uuid("That is not an order."),
  cause: z.enum(["normal", "shop_error"]),
  note: z
    .string()
    .trim()
    .max(500, "Keep the note under 500 characters.")
    .optional(),
  expectedPaise: z.number().int().positive("Nothing to refund."),
});

export async function createRefund(
  input: unknown,
): Promise<AdminResult<{ amountPaise: number; razorpayRefundId: string }>> {
  return adminAction<{ amountPaise: number; razorpayRefundId: string }>(
    "createRefund",
    "adminMutation",
    async ({ actor }) => {
      const parsed = createSchema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          reason: "invalid",
          message:
            parsed.error.issues[0]?.message ?? "Check that and try again.",
        };
      }

      const result = await initiateRefund({
        orderId: parsed.data.orderId,
        cause: parsed.data.cause,
        note: parsed.data.note?.length ? parsed.data.note : null,
        expectedPaise: parsed.data.expectedPaise,
        actorId: actor.id,
      });

      if (!result.ok) {
        return {
          ok: false,
          reason:
            result.reason === "provider" || result.reason === "error"
              ? "error"
              : result.reason,
          message: result.message,
        };
      }

      revalidatePath(`/admin/orders/${parsed.data.orderId}`);
      return {
        ok: true,
        amountPaise: result.amountPaise,
        razorpayRefundId: result.razorpayRefundId,
      };
    },
  );
}

const importSchema = z.object({
  orderId: z.uuid("That is not an order."),
});

export async function importRefunds(
  input: unknown,
): Promise<AdminResult<{ checked: number; recorded: number; settled: number }>> {
  return adminAction<{ checked: number; recorded: number; settled: number }>(
    "importRefunds",
    "adminMutation",
    async () => {
      const parsed = importSchema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          reason: "invalid",
          message:
            parsed.error.issues[0]?.message ?? "Check that and try again.",
        };
      }

      const result = await importRefundsForOrder(parsed.data.orderId);
      if (!result.ok) {
        return { ok: false, reason: "error", message: result.message };
      }

      revalidatePath(`/admin/orders/${parsed.data.orderId}`);
      return {
        ok: true,
        checked: result.checked,
        recorded: result.recorded,
        settled: result.settled,
      };
    },
  );
}
