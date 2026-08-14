"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminAction, type AdminResult } from "@/lib/admin/guard";
import { transitionOrder } from "@/lib/orders/transition";
import { getOrderDetail } from "@/lib/queries/admin/orders";
import {
  assignAwb,
  createShipment,
  readTracking,
  generateDocuments,
  schedulePickup,
  type TrackingSnapshot,
} from "@/lib/shipping/fulfilment";
import {
  applyCourierSignal,
  signalFromTracking,
} from "@/lib/shipping/inbound";
import { maybeRow } from "@/lib/queries/run";

/**
 * The five buttons on an order's shipping panel.
 *
 * Each one is a separate action rather than a single `fulfil(step)`, because a
 * single action taking a step name is a single action that can be called with a
 * step the UI never offers — and "assign an AWB for an order that has not been
 * created" is a Shiprocket error the owner then has to interpret. Five actions
 * means five explicit preconditions, checked in `src/lib/shipping/fulfilment.ts`
 * against our own row before anything leaves the building.
 *
 * All five are rate-limited under `fulfilment`, which is the tightest policy in
 * the file: these steps cost real money and create real parcels, so the thing
 * being guarded against is a stuck retry loop rather than an attacker.
 *
 * **A failure revalidates the page too, and that is new.** `outcome.message`
 * used to go into a toast and nowhere else: three and a half seconds of red
 * text, gone on reload, gone for the second admin looking at the same order.
 * The message is now written to `shipment_errors` by the fulfilment step
 * itself, so the page has something to render — and it only renders it if the
 * cache is dropped, which is why every `!outcome.ok` branch below revalidates
 * before it returns. Without this the stored reason appears on the *next*
 * navigation, which is exactly when nobody is looking for it.
 */

const orderSchema = z.object({ orderId: z.uuid("That is not an order.") });

type StepResult = { message: string; already: boolean };

export async function createShipmentForOrder(
  input: unknown,
): Promise<AdminResult<StepResult>> {
  return adminAction<StepResult>(
    "createShipment",
    "fulfilment",
    async ({ supabase }) => {
      const parsed = orderSchema.safeParse(input);
      if (!parsed.success)
        return {
          ok: false,
          reason: "invalid",
          message: "That is not an order.",
        };

      const order = await getOrderDetail(parsed.data.orderId);
      if (!order)
        return {
          ok: false,
          reason: "invalid",
          message: "That order no longer exists.",
        };

      /**
       * A cancelled order must never become a parcel.
       *
       * Its stock is already back on the shelf, so shipping it would send pairs
       * the shop believes it still has. Checked here rather than relying on the
       * owner not pressing the button, because the button is on a page they may
       * have had open since before the cancellation.
       */
      if (order.status === "cancelled" || order.status === "returned") {
        return {
          ok: false,
          reason: "invalid",
          message: `This order is ${order.status}. Its stock has already gone back on the shelf.`,
        };
      }
      if (order.status === "pending") {
        return {
          ok: false,
          reason: "invalid",
          message:
            "This order has not been paid for yet. Confirm it before shipping it.",
        };
      }

      const outcome = await createShipment(supabase, {
        id: order.id,
        orderNumber: order.orderNumber,
        placedAt: order.placedAt,
        paymentMethod: order.paymentMethod,
        subtotal: order.subtotal,
        shippingFee: order.shippingFee,
        grandTotal: order.grandTotal,
        // What the courier collects. Never the total — see createShipment.
        balanceDueOnDelivery: order.balanceDueOnDelivery,
        address: order.address,
        contactEmail: order.contactEmail,
        items: order.items.map((item) => ({
          productName: item.productName,
          sku: item.sku,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          productId: item.productId,
        })),
      });

      if (!outcome.ok) {
        revalidatePath(`/admin/orders/${order.id}`);
        return { ok: false, reason: "error", message: outcome.message };
      }

      revalidatePath(`/admin/orders/${order.id}`);
      return { ok: true, message: outcome.message, already: outcome.already };
    },
  );
}

export async function assignAwbForOrder(
  input: unknown,
): Promise<AdminResult<StepResult>> {
  return adminAction<StepResult>(
    "assignAwb",
    "fulfilment",
    async ({ actor, supabase, elevated }) => {
      const parsed = orderSchema.safeParse(input);
      if (!parsed.success)
        return {
          ok: false,
          reason: "invalid",
          message: "That is not an order.",
        };

      const outcome = await assignAwb(supabase, parsed.data.orderId);
      if (!outcome.ok) {
        revalidatePath(`/admin/orders/${parsed.data.orderId}`);
        return { ok: false, reason: "error", message: outcome.message };
      }

      /**
       * An AWB means the parcel is a parcel, so the order becomes `packed`.
       *
       * Through `transitionOrder`, which owns the state machine and the
       * compare-and-swap — fulfilment is not allowed its own private way of
       * moving an order, and the brief was explicit about not adding one. A
       * refusal here is not a failure of the AWB step: the courier has the number
       * either way, and the status can be corrected by hand.
       */
      if (!outcome.already) {
        const moved = await transitionOrder({
          supabase,
          elevated,
          orderId: parsed.data.orderId,
          to: "packed",
          note: "AWB assigned in Shiprocket",
          actorId: actor.id,
        });
        if (!moved.ok) {
          console.warn(
            "[shiprocket] AWB assigned but the order did not move to packed",
            {
              orderId: parsed.data.orderId,
              reason: moved.reason,
            },
          );
        }
      }

      revalidatePath(`/admin/orders/${parsed.data.orderId}`);
      revalidatePath("/admin/orders");
      return { ok: true, message: outcome.message, already: outcome.already };
    },
  );
}

export async function schedulePickupForOrder(
  input: unknown,
): Promise<AdminResult<StepResult>> {
  return adminAction<StepResult>(
    "schedulePickup",
    "fulfilment",
    async ({ actor, supabase, elevated }) => {
      const parsed = orderSchema.safeParse(input);
      if (!parsed.success)
        return {
          ok: false,
          reason: "invalid",
          message: "That is not an order.",
        };

      const outcome = await schedulePickup(supabase, parsed.data.orderId);
      if (!outcome.ok) {
        revalidatePath(`/admin/orders/${parsed.data.orderId}`);
        return { ok: false, reason: "error", message: outcome.message };
      }

      // A booked pickup is the parcel leaving. `shipped` is the honest status the
      // moment a courier is coming for it.
      if (!outcome.already) {
        const moved = await transitionOrder({
          supabase,
          elevated,
          orderId: parsed.data.orderId,
          to: "shipped",
          note: "Pickup booked with the courier",
          actorId: actor.id,
        });
        if (!moved.ok) {
          console.warn(
            "[shiprocket] pickup booked but the order did not move to shipped",
            {
              orderId: parsed.data.orderId,
              reason: moved.reason,
            },
          );
        }
      }

      revalidatePath(`/admin/orders/${parsed.data.orderId}`);
      revalidatePath("/admin/orders");
      return { ok: true, message: outcome.message, already: outcome.already };
    },
  );
}

export async function generateDocumentsForOrder(
  input: unknown,
): Promise<AdminResult<StepResult>> {
  return adminAction<StepResult>(
    "generateDocuments",
    "fulfilment",
    async ({ supabase }) => {
      const parsed = orderSchema.safeParse(input);
      if (!parsed.success)
        return {
          ok: false,
          reason: "invalid",
          message: "That is not an order.",
        };

      const outcome = await generateDocuments(supabase, parsed.data.orderId);
      if (!outcome.ok) {
        revalidatePath(`/admin/orders/${parsed.data.orderId}`);
        return { ok: false, reason: "error", message: outcome.message };
      }

      revalidatePath(`/admin/orders/${parsed.data.orderId}`);
      return { ok: true, message: outcome.message, already: outcome.already };
    },
  );
}

export async function trackOrder(
  input: unknown,
): Promise<AdminResult<{ tracking: TrackingSnapshot }>> {
  return adminAction<{ tracking: TrackingSnapshot }>(
    "trackOrder",
    "fulfilment",
    async ({ supabase }) => {
      const parsed = orderSchema.safeParse(input);
      if (!parsed.success)
        return {
          ok: false,
          reason: "invalid",
          message: "That is not an order.",
        };

      const outcome = await readTracking(supabase, parsed.data.orderId);
      if (!outcome.ok) {
        revalidatePath(`/admin/orders/${parsed.data.orderId}`);
        return { ok: false, reason: "error", message: outcome.message };
      }

      /**
       * The button reads, and the shared seam decides.
       *
       * Until 2026-08-15 this call cached whatever Shiprocket said onto the
       * shipment row and acted on two patterns; anything else became a caption
       * the owner might notice. So a portal cancellation was, at best, a word
       * on this page — which is what FV-2026-00668 was, and nobody saw it.
       * Going through `applyCourierSignal` means pressing Refresh on a
       * cancelled parcel now raises it on the dashboard, exactly as the webhook
       * would, and dedupes against the webhook if both see the same transition.
       */
      const order = await maybeRow<{ order_number: string }>(
        "shipping.trackOrder.number",
        supabase
          .from("orders")
          .select("order_number")
          .eq("id", parsed.data.orderId)
          .maybeSingle(),
      );
      const signal = signalFromTracking(
        "admin",
        { awb: outcome.awb, orderNumber: order?.order_number ?? null },
        outcome.tracking,
        outcome.raw,
      );
      await applyCourierSignal(
        supabase,
        signal,
        JSON.stringify(outcome.raw ?? {}),
      );

      revalidatePath(`/admin/orders/${parsed.data.orderId}`);
      revalidatePath("/admin");
      return { ok: true, tracking: outcome.tracking };
    },
  );
}

const courierEventSchema = z.object({
  id: z.uuid("That is not a courier event."),
});

/**
 * "I have dealt with this."
 *
 * The only thing an operator can do to a raised courier event, and the only
 * thing this deploy lets them do to one. It clears the row from the dashboard
 * and records who cleared it and when; it does **not** refund anything, cancel
 * anything, or move an order.
 *
 * That separation is deliberate and it is the answer to the obvious objection —
 * that a queue you can only dismiss is a queue that gets dismissed. The
 * alternative is a button on the dashboard that returns a customer's money on
 * the strength of a courier status string this shop has, by its own admission,
 * never successfully interpreted. Whether a parcel is actually dead is a fact
 * that lives in the Shiprocket portal. So the mechanism computes the amount,
 * names the order, and puts a person in front of the decision; the refund is
 * made where refunds are made, and *this* row's job is to stop the shop
 * forgetting the decision exists.
 *
 * Resolving is not destructive: the event stays, with a resolver and a
 * timestamp, and the payload stays with it. It is the audit trail of a
 * cancellation that somebody looked at.
 */
export async function resolveCourierEvent(
  input: unknown,
): Promise<AdminResult<object>> {
  return adminAction<object>(
    "resolveCourierEvent",
    "adminMutation",
    async ({ supabase, actor }) => {
      const parsed = courierEventSchema.safeParse(input);
      if (!parsed.success)
        return {
          ok: false,
          reason: "invalid",
          message: "That is not a courier event.",
        };

      const { data, error } = await supabase
        .from("courier_events")
        .update({
          resolved_at: new Date().toISOString(),
          resolved_by: actor.id,
        })
        .eq("id", parsed.data.id)
        .is("resolved_at", null)
        .select("order_id")
        .maybeSingle();

      if (error)
        return {
          ok: false,
          reason: "error",
          message: "That could not be marked as dealt with. Nothing changed.",
        };
      if (!data)
        // Already resolved, by the other tab or the other person. Not an error:
        // the thing they wanted is true.
        return { ok: true };

      revalidatePath("/admin");
      if (data.order_id) revalidatePath(`/admin/orders/${data.order_id}`);
      return { ok: true };
    },
  );
}
