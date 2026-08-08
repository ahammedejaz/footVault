"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminAction, type AdminResult } from "@/lib/admin/guard";
import { ORDER_TRANSITIONS, type OrderStatus } from "@/lib/orders/types";
import { transitionOrder } from "@/lib/orders/transition";

/**
 * The admin's writes against an order.
 *
 * Both of them go through `adminAction`, which re-checks `is_admin()` against
 * the database before anything runs — the middleware 404 protects navigation to
 * /admin and has nothing to say about a POST to a Server Action's endpoint.
 * `footvault/admin-actions-must-guard` fails the build if an export here ever
 * forgets.
 *
 * Status moves are delegated to `transitionOrder`, which owns the state machine
 * and the compare-and-swap. Nothing in this file writes `orders.status`.
 */

const ORDER_STATUSES = Object.keys(ORDER_TRANSITIONS) as [
  OrderStatus,
  ...OrderStatus[],
];

const transitionSchema = z.object({
  orderId: z.uuid("That is not an order."),
  to: z.enum(ORDER_STATUSES),
  note: z
    .string()
    .trim()
    .max(500, "Keep the note under 500 characters.")
    .optional(),
});

export async function setOrderStatus(
  input: unknown,
): Promise<AdminResult<{ status: OrderStatus }>> {
  return adminAction<{ status: OrderStatus }>(
    "setOrderStatus",
    "adminMutation",
    async ({ actor, supabase, elevated }) => {
      const parsed = transitionSchema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          reason: "invalid",
          message:
            parsed.error.issues[0]?.message ?? "Check that and try again.",
        };
      }

      const result = await transitionOrder({
        supabase,
        elevated,
        orderId: parsed.data.orderId,
        to: parsed.data.to,
        note: parsed.data.note ?? null,
        actorId: actor.id,
      });

      if (!result.ok) {
        /**
         * Each branch returns its own literal rather than computing `reason` into
         * a variable first. `AdminFailure` is a discriminated union, and an object
         * whose `reason` is the *union* `"invalid" | "conflict" | "error"` is not
         * assignable to it — TypeScript cannot tell which member such an object
         * claims to be, so it belongs to none of them.
         */
        if (result.reason === "conflict") {
          return { ok: false, reason: "conflict", message: result.message };
        }
        if (result.reason === "error") {
          return { ok: false, reason: "error", message: result.message };
        }
        // not_found, illegal and paid are all "you cannot do that to this order",
        // and each already carries a sentence that says which.
        return { ok: false, reason: "invalid", message: result.message };
      }

      // The customer's own order page reads the same row, and a status the owner
      // has changed while the customer is looking at it should be the next thing
      // they see rather than the next thing they see after a cache expires.
      revalidatePath("/admin/orders");
      revalidatePath(`/admin/orders/${parsed.data.orderId}`);
      revalidatePath("/account/orders");
      return { ok: true, status: result.status };
    },
  );
}

const noteSchema = z.object({
  orderId: z.uuid("That is not an order."),
  note: z
    .string()
    .trim()
    .min(1, "Write something first.")
    .max(500, "Keep it under 500 characters."),
});

/**
 * A note on the timeline without a status change.
 *
 * Written as a history row at the order's *current* status rather than as a
 * column on the order, so "rang the customer, no answer" sits in the same
 * timeline as "packed" and in the right place in it. An order with a
 * `notes` text column instead would give the owner one box that the last edit
 * overwrites, which is not a record of anything.
 */
export async function addOrderNote(
  input: unknown,
): Promise<AdminResult<object>> {
  return adminAction<object>(
    "addOrderNote",
    "adminMutation",
    async ({ actor, supabase }) => {
      const parsed = noteSchema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          reason: "invalid",
          message:
            parsed.error.issues[0]?.message ?? "Check that and try again.",
        };
      }

      const { data: order, error: readError } = await supabase
        .from("orders")
        .select("status")
        .eq("id", parsed.data.orderId)
        .maybeSingle();
      if (readError) {
        return {
          ok: false,
          reason: "error",
          message: "Could not read that order.",
        };
      }
      if (!order) {
        return {
          ok: false,
          reason: "invalid",
          message: "That order no longer exists.",
        };
      }

      const { error } = await supabase.from("order_status_history").insert({
        order_id: parsed.data.orderId,
        status: order.status,
        note: parsed.data.note,
        changed_by: actor.id,
      });
      if (error) {
        return {
          ok: false,
          reason: "error",
          message: "The note did not save.",
        };
      }

      revalidatePath(`/admin/orders/${parsed.data.orderId}`);
      return { ok: true };
    },
  );
}
