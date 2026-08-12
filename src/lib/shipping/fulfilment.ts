import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/database.types";
import {
  detectRtoFromTracking,
  isRtoTrackingStatus,
} from "@/lib/orders/rto";
import { shiprocketFetch, type ShiprocketResult } from "@/lib/shipping/client";
import { shiprocketPickupLocation } from "@/lib/shipping/config";
import { chooseCourier } from "@/lib/shipping/courier-choice";
import {
  ParcelDefaultsIncompleteError,
  quoteDelivery,
  shippingDefaults,
} from "@/lib/shipping/quote";
import { shippingSettings } from "@/lib/shipping/settings";
import { maybeRow, rows } from "@/lib/queries/run";

/**
 * The five fulfilment steps, each one safe to press twice.
 *
 * **Every step is admin-triggered and none of them is automatic.** Shiprocket's
 * API acts on the live account: creating an order creates a real order in the
 * panel, and assigning an AWB can commit real money to a courier. Automatic
 * fulfilment on payment would mean a bug ships real parcels — so a human presses
 * the button, every time, and this module never runs on its own.
 *
 * **Idempotency is a read of our own row, not a hope.** Each step begins by
 * loading the `shipments` row and checking whether its own output is already
 * there; if it is, it returns `already` and touches nothing. That plus the
 * `unique (order_id)` constraint is what makes a double-click, a retry after a
 * timeout, or two admins on two tablets all converge on one shipment.
 *
 * The uniqueness constraint matters most in the case the read cannot cover: two
 * simultaneous "create shipment" presses both read no row, both call Shiprocket,
 * and one loses the insert with 23505. That is why creation writes its row
 * *before* it is certain — see `createShipment`.
 */

export type FulfilmentStep =
  "create" | "awb" | "pickup" | "documents" | "track";

export type FulfilmentOutcome =
  | { ok: true; step: FulfilmentStep; already: boolean; message: string }
  | { ok: false; step: FulfilmentStep; message: string; detail?: unknown };

type Db = SupabaseClient<Database>;

export type ShipmentRow = Database["public"]["Tables"]["shipments"]["Row"];

export async function getShipment(
  supabase: Db,
  orderId: string,
): Promise<ShipmentRow | null> {
  return maybeRow<ShipmentRow>(
    "shipping.getShipment",
    supabase
      .from("shipments")
      .select("*")
      .eq("order_id", orderId)
      .maybeSingle(),
  );
}

/* --------------------------------------------------- why it last failed -- */

/**
 * The reason the last attempt did not work, kept where the owner can read it
 * tomorrow.
 *
 * Until now a failed step's only trace was a toast. `outcome.message` — which is
 * usually Shiprocket's own sentence, and usually the actionable one, "Wrong
 * Pickup location entered" rather than anything this file could write instead —
 * reached the admin's browser and nowhere else. Reload the page and the shop
 * knew nothing except that the parcel had not gone out.
 *
 * It lives in `shipment_errors`, keyed by order, rather than in columns on
 * `shipments`. The migration comment on `20260809120000_shipment_errors.sql`
 * carries the full reasoning; the short version is that `createShipment`
 * deletes its own row on failure and that delete must stay, and that a customer
 * can read `shipments` but has no business reading errors about the shop's
 * Shiprocket account.
 *
 * Every write below is best-effort. Losing the note is bad; failing a fulfilment
 * step that already succeeded at the courier because we could not write the note
 * is worse.
 */

export type ShipmentErrorRow = {
  order_id: string;
  step: string;
  /** Shiprocket's own words, stored verbatim and rendered verbatim. */
  message: string;
  /** The whole response body: what we were told, beside what we understood. */
  detail: Json | null;
  failed_at: string;
};

export async function getShipmentError(
  supabase: Db,
  orderId: string,
): Promise<ShipmentErrorRow | null> {
  return maybeRow<ShipmentErrorRow>(
    "shipping.getShipmentError",
    supabase
      .from("shipment_errors")
      .select("*")
      .eq("order_id", orderId)
      .maybeSingle(),
  );
}

/**
 * One row per order, replaced by each new failure.
 *
 * Not appended to: the question the owner is asking is "why is this parcel not
 * moving", which has one answer at a time. What was *tried* is already in
 * `shipment_events`, and a second append-only table would be a second place to
 * look for the same incident.
 */
async function recordShipmentError(
  supabase: Db,
  orderId: string,
  step: FulfilmentStep,
  message: string,
  detail: unknown,
): Promise<void> {
  const { error } = await supabase
    .from("shipment_errors")
    .upsert(
      {
        order_id: orderId,
        step,
        message,
        detail: (detail ?? null) as Json,
        failed_at: new Date().toISOString(),
      },
      { onConflict: "order_id" },
    );
  if (error)
    console.error("[shiprocket] could not record why the step failed:", error.message);
}

/** A step that worked clears it. A row present means something is wrong *now*. */
async function clearShipmentError(
  supabase: Db,
  orderId: string,
): Promise<void> {
  const { error } = await supabase
    .from("shipment_errors")
    .delete()
    .eq("order_id", orderId);
  if (error)
    console.error("[shiprocket] could not clear the last error:", error.message);
}

/* ------------------------------------------------------------ 1 · create -- */

/**
 * Create the Shiprocket order.
 *
 * The row is inserted **before** the API call, holding `status = 'creating'`.
 * That looks backwards and is the only ordering that is safe: `unique
 * (order_id)` can only serialise two concurrent presses if both try to write
 * before either calls Shiprocket. Calling first and inserting after would let
 * both calls through and create two real orders in the panel, and no constraint
 * can undo that.
 *
 * The cost is a row left at `creating` if the call then fails, which is why the
 * failure path clears it — and why a retry finds no row and starts cleanly.
 */
export async function createShipment(
  supabase: Db,
  order: {
    id: string;
    orderNumber: string;
    placedAt: string;
    paymentMethod: string;
    subtotal: number;
    shippingFee: number;
    grandTotal: number;
    /**
     * What the courier must collect in cash. **Never `grandTotal`.**
     *
     * A Pay-on-Delivery customer has already paid the advance online. Handing
     * Shiprocket the order total would have the courier collect that money a
     * second time, at the door, from someone who can prove they already paid —
     * and we would find out by complaint, one customer at a time. Zero for a
     * prepaid order, which is what makes `payment_method: "Prepaid"` consistent.
     */
    balanceDueOnDelivery: number;
    address: {
      recipientName: string;
      phone: string;
      line1: string;
      line2: string | null;
      city: string;
      state: string;
      postalCode: string;
    };
    contactEmail: string | null;
    items: {
      productName: string;
      sku: string;
      quantity: number;
      unitPrice: number;
      productId: string | null;
    }[];
  },
): Promise<FulfilmentOutcome> {
  const existing = await getShipment(supabase, order.id);
  if (existing?.shiprocket_order_id) {
    return {
      ok: true,
      step: "create",
      already: true,
      message: `Already created in Shiprocket as ${existing.shiprocket_order_id}.`,
    };
  }

  if (!existing) {
    const { error } = await supabase
      .from("shipments")
      .insert({ order_id: order.id, status: "creating" });
    if (error) {
      // 23505: somebody else claimed this order between the read and the write.
      if (error.code === "23505") {
        return {
          ok: true,
          step: "create",
          already: true,
          message: "Another tab is already creating this shipment.",
        };
      }
      return {
        ok: false,
        step: "create",
        message: "Could not start the shipment.",
      };
    }
  }

  /**
   * The shop's default parcel, which now refuses rather than guesses.
   *
   * `shippingDefaults()` used to answer a half-filled settings row with a 900g
   * box nobody had chosen. It throws instead, and this is the call site where
   * that lands hardest: the claim row has already been inserted, so an
   * uncaught throw here would leave a shipment stuck at `creating` that no
   * retry could get past, and the owner would see a generic action failure with
   * no hint that the cause was one empty field on their own settings page.
   *
   * So it is caught, the claim is given back exactly as it is for a Shiprocket
   * refusal, and the error is recorded with the field names in it. `.missing`
   * goes into `detail` because "which field" is the whole of the fix.
   */
  let defaults: Awaited<ReturnType<typeof shippingDefaults>>;
  try {
    defaults = await shippingDefaults();
  } catch (error) {
    if (!existing) await releaseClaim(supabase, order.id);
    const message =
      error instanceof ParcelDefaultsIncompleteError
        ? error.message
        : "The shop's parcel defaults could not be read, so nothing was sent to Shiprocket.";
    await recordShipmentError(
      supabase,
      order.id,
      "create",
      message,
      error instanceof ParcelDefaultsIncompleteError
        ? { missing: error.missing }
        : null,
    );
    return { ok: false, step: "create", message };
  }

  const weights = await productWeights(
    supabase,
    order.items
      .map((item) => item.productId)
      .filter((id): id is string => !!id),
  );

  const totalGrams = order.items.reduce(
    (total, item) =>
      total +
      (weights.get(item.productId ?? "")?.weight_grams ??
        defaults.weight_grams) *
        item.quantity,
    0,
  );
  // Box size comes from the first line that has one. A parcel holding several
  // pairs is bigger than one pair's box, but Shiprocket prices on whichever of
  // weight and volume is greater, and weight is the one that is summed
  // correctly — so understating the box is the safe direction to be wrong in.
  const box = order.items
    .map((item) => weights.get(item.productId ?? ""))
    .find((row) => row?.length_cm && row.breadth_cm && row.height_cm);

  const payload = {
    order_id: order.orderNumber,
    order_date: order.placedAt.slice(0, 10),
    pickup_location: shiprocketPickupLocation(),
    billing_customer_name: order.address.recipientName,
    billing_last_name: "",
    billing_address: order.address.line1,
    billing_address_2: order.address.line2 ?? "",
    billing_city: order.address.city,
    billing_pincode: order.address.postalCode,
    billing_state: order.address.state,
    billing_country: "India",
    billing_email: order.contactEmail ?? "",
    billing_phone: order.address.phone.replace(/\D/g, "").slice(-10),
    shipping_is_billing: true,
    order_items: order.items.map((item) => ({
      name: item.productName,
      sku: item.sku,
      units: item.quantity,
      // Shiprocket quotes rupees. Everything in this codebase is paise, and
      // this is the boundary where that stops being true.
      selling_price: Math.round(item.unitPrice / 100),
    })),
    payment_method: order.paymentMethod === "cod" ? "COD" : "Prepaid",
    /**
     * For a COD shipment Shiprocket treats `sub_total` as **the amount to
     * collect**, so it is the outstanding balance and nothing else. For a
     * prepaid shipment nothing is collected and the field is the declared value
     * of the goods, which is the subtotal.
     *
     * This previously passed `order.subtotal` for both. That was very nearly
     * right by coincidence — with the default `greater_of` rule the advance is
     * the whole delivery charge, so the balance *is* the goods subtotal — and
     * silently wrong under any other setting. With a fixed ₹99 advance against
     * a ₹220 delivery it under-collects by ₹121 on every parcel.
     */
    sub_total:
      order.paymentMethod === "cod"
        ? // A whole rupee by construction — `advanceFor` puts the paise on the
          // advance precisely so nothing rounds here. `Math.round` stays as a
          // belt-and-braces cast for a legacy row written before that rule, and
          // `audit:totals` asserts the balance is a multiple of 100 paise so a
          // regression fails there rather than in a courier's collection.
          Math.round(order.balanceDueOnDelivery / 100)
        : Math.round(order.subtotal / 100),
    length: box?.length_cm ?? defaults.length_cm,
    breadth: box?.breadth_cm ?? defaults.breadth_cm,
    height: box?.height_cm ?? defaults.height_cm,
    weight: Math.max(0.1, Number((totalGrams / 1000).toFixed(2))),
  };

  const result = await shiprocketFetch<{
    order_id?: unknown;
    shipment_id?: unknown;
  }>("/orders/create/adhoc", { method: "POST", body: payload });

  if (!result.ok) {
    // Give the claim back so the next press starts clean rather than finding a
    // half-made row it cannot get past.
    if (!existing) await releaseClaim(supabase, order.id);
    // The row is going away; the reason is not. See recordShipmentError.
    await recordShipmentError(
      supabase,
      order.id,
      "create",
      result.message,
      result.detail,
    );
    return {
      ok: false,
      step: "create",
      message: result.message,
      detail: result.detail,
    };
  }

  const shiprocketOrderId = stringify(result.data?.order_id);
  const shipmentId = stringify(result.data?.shipment_id);

  if (!shiprocketOrderId) {
    if (!existing) await releaseClaim(supabase, order.id);
    const message = "Shiprocket accepted the order but did not return an id.";
    await recordShipmentError(supabase, order.id, "create", message, result.data);
    return { ok: false, step: "create", message, detail: result.data };
  }

  const { error } = await supabase
    .from("shipments")
    .update({
      shiprocket_order_id: shiprocketOrderId,
      shipment_id: shipmentId,
      status: "created",
      // Recorded so the admin can see what the courier was actually asked for,
      // and so a discrepancy is answerable from our own data rather than from
      // the Shiprocket panel. The column existed and nothing ever wrote it.
      cod_collectable_amount:
        order.paymentMethod === "cod" ? order.balanceDueOnDelivery : 0,
      raw_order: result.data as never,
    })
    .eq("order_id", order.id);

  if (error) {
    /**
     * The parcel exists in Shiprocket and we failed to write down that it does.
     *
     * This is the worst outcome available in this file and it is reported as
     * such rather than smoothed over: a retry would create a *second* real
     * order in the panel. The id goes into the log so a human can reconcile it.
     */
    console.error("[shiprocket] created an order we failed to record", {
      orderId: order.id,
      shiprocketOrderId,
      detail: error.message,
    });
    const message =
      `Shiprocket created order ${shiprocketOrderId} but we could not save it. ` +
      "Do not press this again — check the Shiprocket panel first.";
    // The one failure here that a reload must not lose: the id in this sentence
    // is the only record that a real order exists in the panel.
    await recordShipmentError(supabase, order.id, "create", message, {
      shiprocket_order_id: shiprocketOrderId,
      write_error: error.message,
    });
    return { ok: false, step: "create", message };
  }

  await recordEvent(
    supabase,
    order.id,
    `create:${shiprocketOrderId}`,
    "shipment.created",
    result.data,
  );
  await clearShipmentError(supabase, order.id);
  return {
    ok: true,
    step: "create",
    already: false,
    message: `Created in Shiprocket as ${shiprocketOrderId}.`,
  };
}

/* --------------------------------------------------------------- 2 · awb -- */

/**
 * Which courier this parcel should go with, and the record of why.
 *
 * It re-quotes the lane rather than reading the courier list frozen at
 * checkout, and that is deliberate: the quote may be days old by the time the
 * owner packs the parcel, couriers drop off lanes, and the scores move. The
 * decision should be made against what is true now, not against what was true
 * when the customer paid — the *price* the customer was charged is frozen, and
 * that is a different question from who carries it.
 *
 * Never throws and never refuses. Every unhappy path returns
 * `{ courierId: null }`, which means "Shiprocket, you choose" — the behaviour
 * this had before Phase 10. A parcel the customer has paid for must not sit
 * unassigned because a preference could not be resolved.
 */
async function selectCourierFor(
  supabase: Db,
  orderId: string,
  shipment: { order_id?: string | null },
): Promise<{
  courierId: number | null;
  mode: string | null;
  reason: string | null;
  warning: string | null;
}> {
  void shipment;
  const none = { courierId: null, mode: null, reason: null };

  try {
    const settings = await shippingSettings();

    if (settings.courierSelectionMode === "shiprocket") {
      // Nothing to decide, and saying so is still worth recording: it separates
      // "the owner chose to defer" from "we could not work it out".
      return {
        ...none,
        mode: "shiprocket",
        reason: "Shiprocket's own recommendation, by the shop's setting",
        warning: null,
      };
    }

    const { data: order, error } = await supabase
      .from("orders")
      .select("shipping_address, grand_total")
      .eq("id", orderId)
      .maybeSingle();

    if (error || !order) {
      return { ...none, warning: `could not read the order: ${error?.message}` };
    }

    const address = order.shipping_address as { postalCode?: string } | null;
    const postcode = address?.postalCode;
    if (!postcode) {
      return { ...none, warning: "the order has no delivery pin code" };
    }

    const defaults = await shippingDefaults();
    const verdict = await quoteDelivery({
      deliveryPostcode: postcode,
      weightKg: Math.max(0.1, defaults.weight_grams / 1000),
      valuePaise: order.grand_total ?? undefined,
    });

    if (verdict.source !== "shiprocket") {
      return {
        ...none,
        warning: `the lane could not be re-quoted (${verdict.source})`,
      };
    }

    const choice = chooseCourier({
      couriers: verdict.couriers,
      mode: settings.courierSelectionMode,
      tolerancePercent: settings.courierPriceTolerancePercent,
      recommendedCourierId: verdict.recommendedCourierId,
    });

    if (!choice.ok) {
      return { ...none, warning: choice.message };
    }

    return {
      courierId: choice.courier.id,
      mode: choice.mode,
      reason: `${choice.courier.name}: ${choice.reason}`,
      warning: null,
    };
  } catch (caught) {
    return {
      ...none,
      warning: caught instanceof Error ? caught.message : "unknown",
    };
  }
}

export async function assignAwb(
  supabase: Db,
  orderId: string,
): Promise<FulfilmentOutcome> {
  const shipment = await getShipment(supabase, orderId);
  if (!shipment) {
    return { ok: false, step: "awb", message: "Create the shipment first." };
  }
  if (shipment.awb_code) {
    return {
      ok: true,
      step: "awb",
      already: true,
      message: `Already assigned: ${shipment.awb_code} with ${shipment.courier_name ?? "a courier"}.`,
    };
  }
  if (!shipment.shipment_id) {
    return {
      ok: false,
      step: "awb",
      message: "Shiprocket has not given this a shipment id yet.",
    };
  }

  /**
   * Who picks the courier.
   *
   * Posting `{ shipment_id }` alone lets Shiprocket choose, which is what this
   * did before Phase 10 — and on both lanes tested its recommendation scored
   * worst of the available set on all three metrics. So the shop asks its own
   * question first, from the same serviceability response the quote used.
   *
   * **Every failure here falls back to letting Shiprocket choose**, loudly. A
   * lane that cannot be re-quoted, a selector that refuses because the owner has
   * not set a tolerance, an outage — none of them is a reason to leave a paid
   * parcel unassigned. The previous behaviour is the floor, and the log says
   * when the shop dropped to it.
   */
  const choice = await selectCourierFor(supabase, orderId, shipment);
  if (choice.warning) {
    console.warn("[shiprocket] falling back to Shiprocket's own choice", {
      orderId,
      reason: choice.warning,
    });
  }

  const result = await shiprocketFetch<{
    response?: {
      data?: {
        awb_code?: unknown;
        courier_name?: unknown;
        courier_company_id?: unknown;
      };
    };
  }>("/courier/assign/awb", {
    method: "POST",
    body: {
      shipment_id: Number(shipment.shipment_id),
      // Omitted entirely rather than sent as null: Shiprocket treats an absent
      // courier_id as "you choose", and a null as a value it has to interpret.
      ...(choice.courierId === null ? {} : { courier_id: choice.courierId }),
    },
  });

  if (!result.ok) {
    await recordShipmentError(
      supabase,
      orderId,
      "awb",
      result.message,
      result.detail,
    );
    return {
      ok: false,
      step: "awb",
      message: result.message,
      detail: result.detail,
    };
  }

  const data = result.data?.response?.data;
  const awb = stringify(data?.awb_code);
  if (!awb) {
    const message =
      "Shiprocket did not return an AWB. It usually says why in the panel.";
    await recordShipmentError(supabase, orderId, "awb", message, result.data);
    return { ok: false, step: "awb", message, detail: result.data };
  }

  const { error: awbWriteError } = await supabase
    .from("shipments")
    .update({
      awb_code: awb,
      courier_name: stringify(data?.courier_name),
      courier_id: stringify(data?.courier_company_id),
      courier_selection_mode: choice.mode,
      courier_selection_reason: choice.reason,
      status: "awb_assigned",
      raw_awb: result.data as never,
    })
    .eq("order_id", orderId);

  if (awbWriteError) {
    // The courier has the parcel and we did not write down its number. Said
    // plainly, because pressing again asks for a *second* AWB.
    console.error("[shiprocket] assigned an AWB we failed to record", {
      orderId,
      awb,
      detail: awbWriteError.message,
    });
    const message =
      `Shiprocket assigned AWB ${awb} but we could not save it. Do not press this ` +
      "again — copy the number from the Shiprocket panel first.";
    await recordShipmentError(supabase, orderId, "awb", message, {
      awb_code: awb,
      write_error: awbWriteError.message,
    });
    return { ok: false, step: "awb", message };
  }

  await recordEvent(
    supabase,
    orderId,
    `awb:${awb}`,
    "shipment.awb_assigned",
    result.data,
  );
  await clearShipmentError(supabase, orderId);
  return {
    ok: true,
    step: "awb",
    already: false,
    message: `AWB ${awb} assigned to ${stringify(data?.courier_name) ?? "the courier"}.`,
  };
}

/* ------------------------------------------------------------ 3 · pickup -- */

export async function schedulePickup(
  supabase: Db,
  orderId: string,
): Promise<FulfilmentOutcome> {
  const shipment = await getShipment(supabase, orderId);
  if (!shipment?.shipment_id) {
    return { ok: false, step: "pickup", message: "Create the shipment first." };
  }
  if (shipment.pickup_scheduled_at) {
    return {
      ok: true,
      step: "pickup",
      already: true,
      message: "A pickup is already booked for this parcel.",
    };
  }
  if (!shipment.awb_code) {
    return {
      ok: false,
      step: "pickup",
      message: "Assign an AWB before booking a pickup.",
    };
  }

  const result = await shiprocketFetch<{
    pickup_token_number?: unknown;
    response?: unknown;
  }>("/courier/generate/pickup", {
    method: "POST",
    body: { shipment_id: [Number(shipment.shipment_id)] },
  });

  if (!result.ok) {
    await recordShipmentError(
      supabase,
      orderId,
      "pickup",
      result.message,
      result.detail,
    );
    return {
      ok: false,
      step: "pickup",
      message: result.message,
      detail: result.detail,
    };
  }

  const { error: pickupWriteError } = await supabase
    .from("shipments")
    .update({
      pickup_scheduled_at: new Date().toISOString(),
      pickup_token: stringify(result.data?.pickup_token_number),
      status: "pickup_scheduled",
      raw_pickup: result.data as never,
    })
    .eq("order_id", orderId);

  if (pickupWriteError) {
    // Booked at the courier, unrecorded here. Pressing again books a second
    // pickup for the same parcel, which is a wasted courier visit rather than a
    // disaster — but the owner should know which it is.
    console.error("[shiprocket] booked a pickup we failed to record", {
      orderId,
      detail: pickupWriteError.message,
    });
    const message =
      "The pickup was booked but we could not save it. Check the Shiprocket panel before booking again.";
    await recordShipmentError(supabase, orderId, "pickup", message, {
      write_error: pickupWriteError.message,
    });
    return { ok: false, step: "pickup", message };
  }

  await recordEvent(
    supabase,
    orderId,
    `pickup:${shipment.awb_code}`,
    "shipment.pickup_scheduled",
    result.data,
  );
  await clearShipmentError(supabase, orderId);
  return {
    ok: true,
    step: "pickup",
    already: false,
    message: "Pickup booked.",
  };
}

/* --------------------------------------------------------- 4 · documents -- */

/**
 * Label, manifest and invoice, fetched together.
 *
 * Three calls rather than one because Shiprocket has no combined endpoint, and
 * a partial success is recorded rather than rolled back: a label that printed is
 * worth keeping even if the manifest call failed, and the step is safe to press
 * again for whichever URL is still missing.
 */
export async function generateDocuments(
  supabase: Db,
  orderId: string,
): Promise<FulfilmentOutcome> {
  const shipment = await getShipment(supabase, orderId);
  if (!shipment?.shipment_id) {
    return {
      ok: false,
      step: "documents",
      message: "Create the shipment first.",
    };
  }
  if (!shipment.awb_code) {
    return {
      ok: false,
      step: "documents",
      message: "Assign an AWB before printing a label.",
    };
  }
  if (shipment.label_url && shipment.manifest_url && shipment.invoice_url) {
    return {
      ok: true,
      step: "documents",
      already: true,
      message: "All three are already printed.",
    };
  }

  const shipmentId = Number(shipment.shipment_id);
  // Typed against the table rather than as Record<string, string>: the three
  // keys below are the only ones this step may write, and a typo would
  // otherwise be a silent no-op on a column that does not exist.
  const patch: Partial<
    Pick<
      Database["public"]["Tables"]["shipments"]["Update"],
      "label_url" | "manifest_url" | "invoice_url"
    >
  > = {};
  const failures: string[] = [];

  if (!shipment.label_url) {
    const label = await shiprocketFetch<{ label_url?: unknown }>(
      "/courier/generate/label",
      {
        method: "POST",
        body: { shipment_id: [shipmentId] },
      },
    );
    const url = label.ok ? stringify(label.data?.label_url) : null;
    if (url) patch.label_url = url;
    else
      failures.push(`label (${label.ok ? "no URL returned" : label.message})`);
  }

  if (!shipment.manifest_url) {
    const manifest = await shiprocketFetch<{ manifest_url?: unknown }>(
      "/manifests/generate",
      {
        method: "POST",
        body: { shipment_id: [shipmentId] },
      },
    );
    const url = manifest.ok ? stringify(manifest.data?.manifest_url) : null;
    if (url) patch.manifest_url = url;
    else
      failures.push(
        `manifest (${manifest.ok ? "no URL returned" : manifest.message})`,
      );
  }

  if (!shipment.invoice_url) {
    const invoice = await shiprocketFetch<{ invoice_url?: unknown }>(
      "/orders/print/invoice",
      {
        method: "POST",
        body: { ids: [Number(shipment.shiprocket_order_id)] },
      },
    );
    const url = invoice.ok ? stringify(invoice.data?.invoice_url) : null;
    if (url) patch.invoice_url = url;
    else
      failures.push(
        `invoice (${invoice.ok ? "no URL returned" : invoice.message})`,
      );
  }

  if (Object.keys(patch).length > 0) {
    const { error } = await supabase
      .from("shipments")
      .update(patch)
      .eq("order_id", orderId);
    // A URL we fetched and failed to store is only a lost link: the step is
    // safe to press again and will re-fetch exactly what is missing.
    if (error)
      console.error(
        "[shiprocket] could not save a document URL:",
        error.message,
      );
  }

  if (failures.length > 0) {
    const message =
      `Got ${Object.keys(patch).length} of 3. Still missing: ${failures.join(", ")}. ` +
      "Pressing again retries only what is missing.";
    // A partial success is still a failure to record: the reason each document
    // was refused is Shiprocket's, and it is inside `failures`.
    await recordShipmentError(supabase, orderId, "documents", message, {
      fetched: Object.keys(patch),
      failures,
    });
    return { ok: false, step: "documents", message };
  }

  await clearShipmentError(supabase, orderId);
  return {
    ok: true,
    step: "documents",
    already: false,
    message: "Label, manifest and invoice ready.",
  };
}

/* ----------------------------------------------------------- 5 · tracking -- */

export type TrackingSnapshot = {
  status: string | null;
  activities: { date: string; activity: string; location: string | null }[];
};

/**
 * Where the parcel is.
 *
 * Two callers since Phase 11: the admin's "Refresh tracking" button
 * (`trackOrder`), and the delivery poller
 * (`/api/cron/poll-deliveries`) — the Phase 10 header said "polled on view,
 * never in the background", and Phase 11 reversed that deliberately, because
 * a `delivered_at` that only exists when somebody presses a button turned out
 * to be a `delivered_at` that never exists (zero non-null values across the
 * shop's history, audit 11B). Both callers run this same function: two
 * implementations of "has this parcel arrived" is how they drift, and RTO
 * detection is wired in here too.
 */
export async function fetchTracking(
  supabase: Db,
  orderId: string,
): Promise<
  { ok: true; tracking: TrackingSnapshot } | { ok: false; message: string }
> {
  const shipment = await getShipment(supabase, orderId);
  if (!shipment?.awb_code)
    return { ok: false, message: "No AWB to track yet." };

  const result = await shiprocketFetch<TrackingResponse>(
    `/courier/track/awb/${encodeURIComponent(shipment.awb_code)}`,
  );
  if (!result.ok) {
    await recordShipmentError(
      supabase,
      orderId,
      "track",
      result.message,
      result.detail,
    );
    return { ok: false, message: result.message };
  }

  const tracking = readTracking(result);
  await applyTracking(supabase, orderId, shipment, tracking, result.data);
  await clearShipmentError(supabase, orderId);
  return { ok: true, tracking };
}

/**
 * The courier's answer, applied — separated from the HTTP call so
 * `audit:delivery-poll` can hand a synthetic payload to the *real* write
 * path, the same seam-level simulation `audit:rto` uses. What Shiprocket's
 * actual Delivered payload parses to has still never been seen (no parcel
 * has ever been delivered); the first real delivery is the real test of
 * `readTracking`, and this split keeps everything downstream of it proven.
 */
export async function applyTrackingSnapshot(
  supabase: Db,
  orderId: string,
  tracking: TrackingSnapshot,
  raw: unknown,
): Promise<{ ok: boolean; message?: string }> {
  const shipment = await getShipment(supabase, orderId);
  if (!shipment) return { ok: false, message: "No shipment row." };
  await applyTracking(supabase, orderId, shipment, tracking, raw);
  return { ok: true };
}

async function applyTracking(
  supabase: Db,
  orderId: string,
  shipment: NonNullable<Awaited<ReturnType<typeof getShipment>>>,
  tracking: TrackingSnapshot,
  raw: unknown,
): Promise<void> {
  /**
   * The delivery timestamp, captured once and never moved.
   *
   * The replacement window is 24 hours from delivery, so this is evidence
   * rather than a display field: without it the policy is unenforceable and
   * unprovable, and with the *wrong* value it is unfair in one direction or the
   * other.
   *
   * **The courier's own timestamp is used, not `now()`.** Tracking is fetched
   * when somebody opens the page, which may be many hours after the parcel
   * arrived — stamping `now()` would hand that customer a window running from
   * whenever an admin happened to look, and a customer whose page nobody opened
   * for two days would get two extra days. Falling back to `now()` only when
   * the courier gave us nothing parseable is the honest compromise, and it errs
   * towards the customer.
   *
   * Written only when it is not already set. A parcel is delivered once; a
   * later tracking fetch that still says "Delivered" must not restart the clock.
   */
  const deliveredAt =
    shipment.delivered_at ?? deliveredTimestamp(tracking) ?? null;

  const { error } = await supabase
    .from("shipments")
    .update({
      status: tracking.status ?? shipment.status,
      raw_tracking: raw as never,
      tracked_at: new Date().toISOString(),
      ...(deliveredAt && !shipment.delivered_at
        ? { delivered_at: deliveredAt }
        : {}),
    })
    .eq("order_id", orderId);

  // Tracking is a read of somebody else's system; failing to cache it costs a
  // round trip next time and nothing else.
  if (error)
    console.error("[shiprocket] could not cache tracking:", error.message);

  /**
   * Mirrored onto the order so the account page can count down without joining
   * to `shipments`, and so the window survives a shipment row being replaced.
   *
   * `delivered_source: 'courier'` beside it — this path's timestamp was parsed
   * out of the courier's own activity line, and Phase 11 hangs review
   * eligibility and coin credit on this field, so the evidence records whose
   * word it rests on. The `.is("delivered_at", null)` guard covers the source
   * too: an admin's earlier stamp is never relabelled as courier evidence.
   */
  if (deliveredAt && !shipment.delivered_at) {
    const { error: orderError } = await supabase
      .from("orders")
      .update({ delivered_at: deliveredAt, delivered_source: "courier" })
      .eq("id", orderId)
      .is("delivered_at", null);
    if (orderError)
      console.error(
        "[shiprocket] could not record delivery on the order:",
        orderError.message,
      );
  }

  /**
   * RTO detection — Batch 3.3. The courier saying "RTO …" is the one tracking
   * status this module acts on beyond caching, because it is the moment the
   * shop stops owing a delivery and starts expecting a parcel back.
   *
   * `shipment.rto_at` is the cheap pre-filter: once detection has stamped it,
   * every later poll of the same returning parcel skips the call entirely. The
   * real guards — order still `shipped`, `orders.rto_at` still null, the
   * compare-and-swap that lets exactly one of two concurrent polls transition
   * — live inside `detectRtoFromTracking`, which is idempotent on its own and
   * repairs a half-written stamp if a previous poll failed partway.
   *
   * Best-effort, like every write in this step: the tracking read *succeeded*,
   * and failing the whole step because our own detection write hiccuped would
   * tell the admin the courier could not be reached, which is false. The next
   * poll retries — the pre-filter only skips once `shipments.rto_at` is
   * actually written, which detection does last.
   */
  if (isRtoTrackingStatus(tracking.status) && !shipment.rto_at) {
    try {
      await detectRtoFromTracking(orderId, tracking.status ?? "RTO");
    } catch (thrown) {
      console.error("[shiprocket] RTO detection failed:", thrown);
    }
  }
}

/**
 * The parcels the delivery poller should ask about, oldest first.
 *
 * Every filter is a reason not to spend a Shiprocket call: no AWB means
 * nothing to track; a stamped `delivered_at` or `rto_at` means the question
 * is answered; a status other than `shipped` means no transition could
 * follow; and the 45-day age cap means a parcel lost in 2026 is not still
 * being polled in 2027 — Shiprocket's quota is finite and it also moves the
 * shop's real parcels. The cap bounds a tick after an outage for the same
 * reason the reconciler's does: an unbounded backlog is a self-inflicted
 * rate-limit incident.
 */
export async function inFlightDeliveryCandidates(
  supabase: Db,
  limit: number,
): Promise<{ id: string; order_number: string }[]> {
  const cutoff = new Date(Date.now() - 45 * 24 * 60 * 60_000).toISOString();
  return rows<{ id: string; order_number: string }>(
    "fulfilment.inFlightDeliveryCandidates",
    supabase
      .from("orders")
      .select("id, order_number, shipments!inner(awb_code)")
      .eq("status", "shipped")
      .is("delivered_at", null)
      .is("rto_at", null)
      .gt("placed_at", cutoff)
      .not("shipments.awb_code", "is", null)
      .order("placed_at", { ascending: true })
      .limit(limit),
  );
}

/** Shiprocket's own words for "it arrived". Matched loosely; it varies by courier. */
function isDelivered(status: string | null): boolean {
  return status !== null && /delivered/i.test(status) && !/undelivered/i.test(status);
}

/**
 * When the courier says it was delivered, as an ISO string.
 *
 * Returns null unless the shipment is actually delivered, so the caller can use
 * a plain truthiness check. The activity list is searched for the delivery line
 * because it carries a real timestamp; the summary status carries none.
 *
 * Shiprocket returns dates as `YYYY-MM-DD HH:MM:SS` in IST with no offset, and
 * `new Date()` on that string would read it as the server's local time — which
 * on Vercel is UTC, putting delivery five and a half hours early and shortening
 * every customer's window by that much. The offset is therefore explicit.
 */
function deliveredTimestamp(tracking: TrackingSnapshot): string | null {
  if (!isDelivered(tracking.status)) return null;

  const line = tracking.activities.find(
    (activity) => isDelivered(activity.activity) || isDelivered(activity.date),
  );
  const raw = line?.date;
  if (raw) {
    const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)
      ? raw
      : `${raw.replace(" ", "T")}+05:30`;
    const parsed = new Date(withZone);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  // Delivered, but the courier gave us no usable time. Better a window that
  // starts late than no window at all.
  return new Date().toISOString();
}

type TrackingResponse = {
  tracking_data?: {
    shipment_track?: { current_status?: unknown }[];
    shipment_track_activities?: {
      date?: unknown;
      activity?: unknown;
      location?: unknown;
    }[];
  };
};

function readTracking(
  result: ShiprocketResult<TrackingResponse> & { ok: true },
): TrackingSnapshot {
  const data = result.data?.tracking_data;
  return {
    status: stringify(data?.shipment_track?.[0]?.current_status),
    activities: (data?.shipment_track_activities ?? []).flatMap((activity) => {
      const date = stringify(activity.date);
      const text = stringify(activity.activity);
      if (!date || !text) return [];
      return [{ date, activity: text, location: stringify(activity.location) }];
    }),
  };
}

/* ------------------------------------------------------------------ parts -- */

async function productWeights(
  supabase: Db,
  productIds: string[],
): Promise<
  Map<
    string,
    {
      weight_grams: number | null;
      length_cm: number | null;
      breadth_cm: number | null;
      height_cm: number | null;
    }
  >
> {
  if (productIds.length === 0) return new Map();
  const found = await rows<{
    id: string;
    weight_grams: number | null;
    length_cm: number | null;
    breadth_cm: number | null;
    height_cm: number | null;
  }>(
    "shipping.productWeights",
    supabase
      .from("products")
      .select(`id, weight_grams, length_cm, breadth_cm, height_cm`)
      .in("id", [...new Set(productIds)]),
  );
  return new Map(found.map((row) => [row.id, row]));
}

/**
 * One shipment event, claimed by its key.
 *
 * The same discipline as `payment_events`: `unique (shipment_id, event_id)`
 * means a repeated step records once. Failures here are logged and swallowed —
 * losing an audit row is bad, and failing a fulfilment step that already
 * succeeded at the courier is worse.
 */
async function recordEvent(
  supabase: Db,
  orderId: string,
  eventId: string,
  eventType: string,
  payload: unknown,
): Promise<void> {
  const shipment = await getShipment(supabase, orderId);
  if (!shipment) return;

  const { error } = await supabase.from("shipment_events").insert({
    shipment_id: shipment.id,
    event_id: eventId,
    event_type: eventType,
    payload: payload as never,
  });
  if (error && error.code !== "23505") {
    console.error("[shiprocket] could not record the event:", error.message);
  }
}

/**
 * Hand the `unique (order_id)` claim back after a failed creation.
 *
 * Only ever called for a row this call inserted moments ago, so it cannot
 * delete a shipment somebody else owns.
 *
 * The row goes and the reason stays: `recordShipmentError` writes to
 * `shipment_errors`, which is keyed by order rather than by shipment precisely
 * so this delete cannot reach it.
 */
async function releaseClaim(supabase: Db, orderId: string): Promise<void> {
  const { error } = await supabase
    .from("shipments")
    .delete()
    .eq("order_id", orderId)
    .eq("status", "creating");
  if (error) {
    console.error(
      "[shiprocket] could not release the shipment claim:",
      error.message,
    );
  }
}

/** Shiprocket returns ids as numbers or strings depending on the endpoint. */
function stringify(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}
