"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminAction, type AdminResult } from "@/lib/admin/guard";
import { formatPaise } from "@/lib/format";
import {
  restockRtoOrder as restockRtoOrderRpc,
  rtoReceiveSchema,
} from "@/lib/orders/rto";
import { transitionOrder } from "@/lib/orders/transition";
import { stockChanged } from "@/lib/stock-freshness";

/**
 * The three buttons on the RTO panel, guarded like every admin write.
 *
 * All three go through `adminAction`, which re-checks `is_admin()` against the
 * database before anything runs; `footvault/admin-actions-must-guard` fails
 * the build if an export here ever forgets. The status move is delegated to
 * `transitionOrder`, which owns the state machine and the compare-and-swap —
 * nothing in this file writes `orders.status`.
 *
 * The stock move is delegated further still, to the `restock_rto_order` RPC,
 * because "check the guards, then restock" is only one decision inside a row
 * lock. This file's job is turning verdicts into sentences.
 */

/* ---------------------------------------------------------------- receive -- */

/**
 * The parcel is physically back, and somebody has looked inside the box.
 *
 * Two writes, deliberately ordered. The **transition first** — `returning →
 * returned` through `transitionOrder`, carrying the inspection note so the
 * timeline says what was found in the same line that says it arrived. The
 * **stamp second** — `rto_received_at` / `rto_received_by` / `rto_condition`,
 * guarded by `is null` so two tabs pressing at once record one inspection.
 * This order is what makes a retry converge: if the stamp fails after the
 * transition, the order sits at `returned` with no receipt, the button stays
 * lit, and the second press finds `transitionOrder` answering "already there"
 * (a no-op, not an error) and goes on to stamp. Stamp-first would invert that:
 * a failed transition after a won stamp would tell the retry "already
 * received" while the status still said `returning`.
 *
 * **A damaged parcel writes no inventory movement, ever — and that is the
 * ledger being right, not a gap in it.** The units left stock when the order
 * was placed (`reason = 'order'`, at checkout) and a write-off means they
 * never re-enter: sum(delta) per variant still equals what is actually on the
 * shelf, which is the invariant `reconcile_inventory()` proves. The write-off
 * record is `rto_condition = 'damaged'` plus the required note in the history
 * row — a movement row here would *break* reconciliation by re-adding units
 * that are in the bin.
 */
export async function markRtoReceived(
  input: unknown,
): Promise<AdminResult<{ condition: "ok" | "damaged" }>> {
  return adminAction<{ condition: "ok" | "damaged" }>(
    "markRtoReceived",
    "adminMutation",
    async ({ actor, supabase, elevated }) => {
      const parsed = rtoReceiveSchema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          reason: "invalid",
          message:
            parsed.error.issues[0]?.message ?? "Check that and try again.",
        };
      }
      const { orderId, condition } = parsed.data;
      const note = parsed.data.note?.length ? parsed.data.note : null;

      const { data: order, error: readError } = await supabase
        .from("orders")
        .select("status, rto_at, rto_received_at")
        .eq("id", orderId)
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
      if (order.rto_received_at) {
        return {
          ok: false,
          reason: "invalid",
          message: "That parcel is already marked as received.",
        };
      }
      // The same "no RTO dimension" rule `rtoPanelState` renders by: a
      // `returned` order without an `rto_at` is a replacement, not an RTO.
      if (
        !(
          order.status === "returning" ||
          (order.status === "returned" && order.rto_at !== null)
        )
      ) {
        return {
          ok: false,
          reason: "invalid",
          message:
            "Only a parcel that is on its way back can be received. " +
            "If tracking has not caught up yet, press 'Refresh tracking' first.",
        };
      }

      const timelineNote =
        condition === "ok"
          ? `RTO parcel received and inspected — condition ok.${note ? ` ${note}` : ""}`
          : `RTO parcel received — damaged, written off. ${note}`;

      const moved = await transitionOrder({
        supabase,
        elevated,
        orderId,
        to: "returned",
        note: timelineNote,
        actorId: actor.id,
      });
      if (!moved.ok) {
        if (moved.reason === "conflict") {
          return { ok: false, reason: "conflict", message: moved.message };
        }
        if (moved.reason === "error") {
          return { ok: false, reason: "error", message: moved.message };
        }
        return { ok: false, reason: "invalid", message: moved.message };
      }

      /**
       * The service role for the stamp, after the RLS-bound read above proved
       * access — the same sequencing as `markCashCollected`, and the `is null`
       * guard is what turns two simultaneous presses into one inspection
       * record rather than the second silently overwriting the first's
       * condition.
       */
      const { data: stamped, error: stampError } = await elevated()
        .from("orders")
        .update({
          rto_received_at: new Date().toISOString(),
          rto_received_by: actor.id,
          rto_condition: condition,
        })
        .eq("id", orderId)
        .is("rto_received_at", null)
        .select("id");
      if (stampError) {
        return {
          ok: false,
          reason: "error",
          message:
            "The order moved but the inspection did not save. Press the button again.",
        };
      }
      if (!stamped || stamped.length === 0) {
        return {
          ok: false,
          reason: "conflict",
          message: "Somebody marked that parcel received a moment ago.",
        };
      }

      revalidatePath("/admin/orders");
      revalidatePath(`/admin/orders/${orderId}`);
      revalidatePath("/admin/rto");
      revalidatePath("/account/orders");
      return { ok: true, condition };
    },
  );
}

/* ---------------------------------------------------------------- restock -- */

const restockSchema = z.object({
  orderId: z.uuid("That is not an order."),
});

/**
 * The stock back on the shelf — the one write that invents inventory, so it is
 * a database function with a row lock and this action is only its mouthpiece.
 * Every verdict below is the RPC refusing for a reason it checked *inside* the
 * lock; the RLS-bound read first is the convention that the service role only
 * acts on rows the caller was allowed to see.
 */
export async function restockRtoOrder(
  input: unknown,
): Promise<AdminResult<object>> {
  return adminAction<object>(
    "restockRtoOrder",
    "adminMutation",
    async ({ actor, supabase }) => {
      const parsed = restockSchema.safeParse(input);
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
        .select("id")
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

      const verdict = await restockRtoOrderRpc(parsed.data.orderId, actor.id);

      if (verdict === "restocked") {
        // The shelves changed; the storefront's cached availability is stale
        // the same way a cancellation makes it stale.
        stockChanged();
        revalidatePath("/admin/orders");
        revalidatePath(`/admin/orders/${parsed.data.orderId}`);
        revalidatePath("/admin/rto");
        return { ok: true };
      }
      if (verdict === "already_restocked") {
        // The idempotent second press. A clear sentence rather than an error
        // the owner has to interpret — nothing moved, and nothing needed to.
        return {
          ok: false,
          reason: "conflict",
          message:
            "That parcel's stock is already back on the shelf. Nothing moved.",
        };
      }
      if (verdict === "not_received") {
        return {
          ok: false,
          reason: "invalid",
          message:
            "Mark the parcel as received first — stock only returns after somebody has the box in their hands.",
        };
      }
      if (verdict === "damaged") {
        return {
          ok: false,
          reason: "invalid",
          message:
            "This return was written off as damaged. Damaged stock is never restocked.",
        };
      }
      if (verdict === "wrong_status") {
        return {
          ok: false,
          reason: "invalid",
          message:
            "Only a returned order can be restocked. Receive the parcel first.",
        };
      }
      return {
        ok: false,
        reason: "invalid",
        message: "That order no longer exists.",
      };
    },
  );
}

/* ----------------------------------------------------------- actual charge -- */

const chargeSchema = z.object({
  orderId: z.uuid("That is not an order."),
  /**
   * Rupees in the form, paise in the database — the same boundary every admin
   * money field crosses (see `src/lib/actions/admin/settings.ts`). The figure
   * itself is typed from Shiprocket's panel, never computed or guessed here:
   * the actual charge is the owner's number, and the brief is explicit that
   * inventing a rupee value is the defect.
   */
  actualRupees: z
    .number({ message: "Type the charge from Shiprocket's panel." })
    .nonnegative("A charge cannot be negative.")
    .max(100_000, "That is more than any return leg costs — check the figure.")
    .transform((value) => Math.round(value * 100)),
});

/**
 * What Shiprocket actually billed for the return leg, recorded beside the
 * frozen quote.
 *
 * **This number changes refund arithmetic the moment it lands.** `freightFor()`
 * in `src/lib/orders/refunds.ts` prefers `rto_actual_charge_paise` over
 * `quoted_rto_paise` when the policy matrix computes an RTO deduction — so an
 * admin recording the real charge is also correcting what a pending refund
 * verdict will offer. That is the point: the quote is an estimate frozen at
 * checkout, the actual is what the shop was billed, and the customer's
 * deduction should follow the truth, not the forecast.
 *
 * Deliberately re-typeable: the update is unconditional, because Shiprocket
 * revises charges (weight disputes) and a typo must be correctable. Each
 * recording leaves its own history line, so a changed figure has a visible
 * trail rather than a silent overwrite.
 */
export async function recordRtoCharge(
  input: unknown,
): Promise<AdminResult<{ actualPaise: number }>> {
  return adminAction<{ actualPaise: number }>(
    "recordRtoCharge",
    "adminMutation",
    async ({ actor, supabase, elevated }) => {
      const parsed = chargeSchema.safeParse(input);
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
        .select("status, rto_at")
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
      if (
        !order.rto_at &&
        order.status !== "returning" &&
        order.status !== "returned"
      ) {
        return {
          ok: false,
          reason: "invalid",
          message:
            "This order has not come back, so there is no return charge to record.",
        };
      }

      const { error: writeError } = await elevated()
        .from("orders")
        .update({ rto_actual_charge_paise: parsed.data.actualRupees })
        .eq("id", parsed.data.orderId);
      if (writeError) {
        return {
          ok: false,
          reason: "error",
          message: "That did not save. Try again.",
        };
      }

      const { error: historyError } = await elevated()
        .from("order_status_history")
        .insert({
          order_id: parsed.data.orderId,
          status: order.status,
          note: `Actual return charge recorded from Shiprocket: ${formatPaise(parsed.data.actualRupees)}. Refund deductions now use this figure instead of the quote.`,
          changed_by: actor.id,
        });
      // The figure is recorded; a missing timeline line is worth a log, not a
      // failure the owner has to act on.
      if (historyError) {
        console.error(
          "[admin] RTO charge recorded but the timeline line failed:",
          historyError.message,
        );
      }

      revalidatePath(`/admin/orders/${parsed.data.orderId}`);
      revalidatePath("/admin/rto");
      return { ok: true, actualPaise: parsed.data.actualRupees };
    },
  );
}
