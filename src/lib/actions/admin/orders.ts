"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminAction, type AdminResult } from "@/lib/admin/guard";
import { ORDER_TRANSITIONS, type OrderStatus } from "@/lib/orders/types";
import { transitionOrder } from "@/lib/orders/transition";
import { withinReplacementWindow } from "@/lib/orders/replacement-window";
import {
  REPLACEMENT_REASONS,
  REPLACEMENT_REASON_LABEL,
} from "@/lib/orders/replacement";

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

/* ------------------------------------------------------- replacements -- */

const replacementSchema = z.object({
  orderId: z.uuid("That is not an order."),
  reason: z.enum(REPLACEMENT_REASONS),
  note: z
    .string()
    .trim()
    .min(1, "Say what happened — this is the record.")
    .max(500, "Keep it under 500 characters."),
});

/**
 * Record a replacement against a delivered order.
 *
 * **There is deliberately no customer-facing path to this.** The policy is that
 * a customer contacts the shop and a human decides; a self-service button would
 * be a different policy, and building one "just in case" is how a shop ends up
 * honouring something it never agreed to.
 *
 * The move is `delivered → returned` through `transitionOrder`, the same
 * compare-and-swap every other status change uses. Nothing here writes
 * `orders.status`.
 *
 * **It does not touch stock.** A replacement means another pair leaves the
 * shelf, and possibly one comes back — but "possibly" is the whole problem, and
 * a guess written into `product_variants` is a count nobody can later explain.
 * The owner adjusts stock in /admin/inventory, where the ledger records who did
 * it and why; `inventory_movement_reason` has a `replacement` value for exactly
 * that.
 *
 * **The 24-hour window is recorded, not enforced.** Whether to honour a late
 * claim is the shop's decision and it is not one an action should make on the
 * owner's behalf. What it can do is put the fact in the record, so a pattern of
 * late claims is visible rather than remembered.
 */
export async function recordReplacement(
  input: unknown,
): Promise<AdminResult<{ status: OrderStatus }>> {
  return adminAction<{ status: OrderStatus }>(
    "recordReplacement",
    "adminMutation",
    async ({ actor, supabase, elevated }) => {
      const parsed = replacementSchema.safeParse(input);
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
        .select("status, delivered_at")
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
      if (order.status !== "delivered") {
        return {
          ok: false,
          reason: "invalid",
          message:
            "Only a delivered order can be replaced. Mark it delivered first if the parcel has arrived.",
        };
      }

      const within = withinReplacementWindow(order.delivered_at);
      const note =
        `Replacement — ${REPLACEMENT_REASON_LABEL[parsed.data.reason]}. ` +
        `${parsed.data.note}` +
        (within === null
          ? " (No delivery timestamp on this order.)"
          : within
            ? ""
            : " (Reported after the 24-hour window.)");

      const result = await transitionOrder({
        supabase,
        elevated,
        orderId: parsed.data.orderId,
        to: "returned",
        note,
        actorId: actor.id,
      });

      if (!result.ok) {
        if (result.reason === "conflict") {
          return { ok: false, reason: "conflict", message: result.message };
        }
        if (result.reason === "error") {
          return { ok: false, reason: "error", message: result.message };
        }
        return { ok: false, reason: "invalid", message: result.message };
      }

      revalidatePath("/admin/orders");
      revalidatePath(`/admin/orders/${parsed.data.orderId}`);
      revalidatePath("/account/orders");
      return { ok: true, status: result.status };
    },
  );
}

/* --------------------------------------------------------- cash at the door -- */

const cashSchema = z.object({
  orderId: z.uuid("That is not an order."),
});

/**
 * Mark the courier's cash as received.
 *
 * **By hand, never inferred from a Shiprocket "Delivered" status.** Delivery
 * usually means the money was handed over and occasionally does not, and the
 * difference is the shop's. An automatic rule here would quietly mark
 * uncollected cash as collected, which is the one direction this must never
 * fail in.
 *
 * `payment_status` is deliberately untouched. It means *the online portion*
 * throughout this codebase — the webhook owns it, and a second writer would be
 * exactly the kind of drift Phase 5 spent itself preventing. Cash is
 * `cash_collected_at`, and the two are different facts.
 */
export async function markCashCollected(
  input: unknown,
): Promise<AdminResult<{ collectedAt: string }>> {
  return adminAction<{ collectedAt: string }>(
    "markCashCollected",
    "adminMutation",
    async ({ actor, supabase, elevated }) => {
      const parsed = cashSchema.safeParse(input);
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
        .select("status, balance_due_on_delivery, cash_collected_at")
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
      if (order.balance_due_on_delivery <= 0) {
        return {
          ok: false,
          reason: "invalid",
          message: "Nothing was due at the door on this order.",
        };
      }
      if (order.cash_collected_at) {
        return {
          ok: false,
          reason: "invalid",
          message: "That cash is already marked as collected.",
        };
      }

      const collectedAt = new Date().toISOString();

      /**
       * Written with the service role, and guarded by `is null` rather than by
       * the read above. Two tabs pressing this at once would otherwise both pass
       * the check and both write — harmless to the timestamp, but it would put
       * two "cash received" lines on the timeline for one payment.
       */
      const admin = elevated();
      const { data: updated, error } = await admin
        .from("orders")
        .update({
          cash_collected_at: collectedAt,
          cash_collected_by: actor.id,
        })
        .eq("id", parsed.data.orderId)
        .is("cash_collected_at", null)
        .select("id");
      if (error) {
        return {
          ok: false,
          reason: "error",
          message: "That did not save. Try again.",
        };
      }
      if (!updated || updated.length === 0) {
        return {
          ok: false,
          reason: "conflict",
          message: "Somebody marked that collected a moment ago.",
        };
      }

      const { error: historyError } = await admin
        .from("order_status_history")
        .insert({
          order_id: parsed.data.orderId,
          status: order.status,
          note: "Cash collected on delivery",
          customer_note: "The balance was paid in cash on delivery. Paid in full.",
          changed_by: actor.id,
        });
      // The money is recorded; a missing timeline line is worth a log, not a
      // failure the owner has to act on.
      if (historyError) {
        console.error(
          "[admin] cash collected but the timeline line failed:",
          historyError.message,
        );
      }

      revalidatePath("/admin/orders");
      revalidatePath(`/admin/orders/${parsed.data.orderId}`);
      return { ok: true, collectedAt };
    },
  );
}

/* --------------------------------------------------------------- deleting -- */

const deleteOrderSchema = z.object({
  orderId: z.uuid("That is not an order."),
});

/**
 * Every way `admin_delete_order` can say no, in words the owner can act on.
 *
 * The function returns a code rather than raising, so the refusal survives the
 * trip through PostgREST intact and this is a lookup rather than a scrape of an
 * error string. Each sentence names **the next move**, because "cannot delete a
 * paid order" leaves the owner staring at a row with nothing to do about it,
 * and every one of these has something.
 */
const REFUSALS: Record<string, string> = {
  paid:
    "This order has been paid, so it is the shop's record of a sale and a tax record too. " +
    "It cannot be deleted. Cancel it if it is not going ahead, and refund it if money needs to go back.",
  payment_attempted:
    "A payment was started against this order and has not conclusively failed, so the shop cannot " +
    "tell from its own records whether the customer was charged. It will settle by itself once the " +
    "payment check runs — if it comes back unpaid, this will delete then.",
  refunded:
    "A refund has been raised against this order, so it has to stay — the refund record points at it.",
  dispatched:
    "This order is with the courier or has already been delivered. Deleting it would leave the " +
    "courier's updates arriving for an order that does not exist. It cannot be deleted.",
  stock_stuck:
    "The pairs on this order could not be put back on the shelf, so the order has been left alone — " +
    "it is the only record of where that stock went. Nothing has been changed.",
  not_found: "That order has already gone.",
};

/**
 * Remove an order from the database for good.
 *
 * **This is the only destructive action in the panel that cannot be undone by
 * anything, including the database.** Everything else here either soft-deletes,
 * or destroys something re-creatable. So the decision about what may go is not
 * made in this file: `admin_delete_order` owns it, checks four separate things,
 * and restocks through `cancel_order_with_restock` before it removes anything.
 * See that migration for the reasoning, particularly on why a payment row at
 * `created` counts against deleting.
 *
 * What lives here is the translation. The refusal codes are the useful half of
 * the design — an owner who is told "cannot delete" learns nothing, and an
 * owner who is told "a payment was started and has not failed; it will settle
 * when the payment check runs" knows both why and what happens next.
 */
export async function deleteOrder(
  input: unknown,
): Promise<AdminResult<object>> {
  return adminAction<object>(
    "deleteOrder",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = deleteOrderSchema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          reason: "invalid",
          message: parsed.error.issues[0]?.message ?? "That is not an order.",
        };
      }

      const { data, error } = await supabase.rpc("admin_delete_order", {
        p_order_id: parsed.data.orderId,
      });

      if (error) {
        if (error.code === "FVADM") {
          return {
            ok: false,
            reason: "forbidden",
            message: "That is not available.",
          };
        }
        console.error(
          "[admin] admin_delete_order failed:",
          error.message,
          error.code,
        );
        return {
          ok: false,
          reason: "error",
          message: "The order is still there. Nothing has been changed.",
        };
      }

      if (data !== "deleted") {
        return {
          ok: false,
          // `conflict` rather than `error`: the function did exactly what it is
          // supposed to do, and the owner asked for something it will not do.
          reason: data === "not_found" ? "invalid" : "conflict",
          message:
            REFUSALS[data ?? ""] ??
            "That order cannot be deleted. Nothing has been changed.",
        };
      }

      revalidatePath("/admin/orders");
      revalidatePath("/admin");
      return { ok: true };
    },
  );
}
