import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/lib/database.types";
import type { OrderStatus } from "@/lib/orders/types";
import { maybeRow, rows } from "@/lib/queries/run";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * RTO — the parcel coming back, and everything the shop records about it.
 *
 * Batch 3.3. Three moments, three writers, and the discipline is that stock
 * only moves at the third:
 *
 *   1. **The courier says RTO.** `detectRtoFromTracking` moves the order
 *      `shipped → returning` and stamps `orders.rto_at` / `shipments.rto_at`.
 *      Nothing is restocked — the units are in a van, and parcels are lost and
 *      crushed on the way back.
 *   2. **The box is in somebody's hands.** The receive action (in
 *      `src/lib/actions/admin/rto.ts`) moves `returning → returned` and records
 *      the inspection: `rto_received_at`, `rto_received_by`, `rto_condition`.
 *   3. **The stock returns — only for `condition = 'ok'`.** The
 *      `restock_rto_order` RPC, called through `restockRtoOrder` below, writes
 *      one `inventory_movements` row per item with reason `rto_return` and
 *      stamps `rto_restocked_at`, exactly once.
 *
 * This module is the server-side reads and the two pieces that cannot live in
 * an action: detection, which is called from inside `fetchTracking` where there
 * is no admin actor, and the RPC call, which the audit harness exercises
 * directly against staging.
 */

type Db = SupabaseClient<Database>;

/* -------------------------------------------------------------- detection -- */

/**
 * Does this tracking status mean the parcel is coming back?
 *
 * Shiprocket's vocabulary varies by courier — "RTO INITIATED", "RTO
 * IN TRANSIT", "RTO DELIVERED", "RTO_NDR" have all been seen — but the three
 * letters are the constant, so the test is a case-insensitive substring rather
 * than a list that goes stale the first time a courier invents a new phrase.
 */
export function isRtoTrackingStatus(status: string | null): boolean {
  return status !== null && /rto/i.test(status);
}

export type RtoDetectionVerdict =
  /** Moved `shipped → returning` and stamped `rto_at`. The one real transition. */
  | "detected"
  /** The order was already `returning`/`returned` by hand; only `rto_at` was stamped. */
  | "recorded"
  /** `rto_at` was already set — a repeat poll of a known RTO. Nothing written. */
  | "already"
  /** A status the courier has no business moving: pending, delivered, cancelled… */
  | "wrong_status"
  | "not_found"
  /** Lost the compare-and-swap three times running. Somebody is rewriting the order. */
  | "conflict";

/** Matches `transitionOrder`'s CAS_ATTEMPTS: a fourth loss is not contention. */
const CAS_ATTEMPTS = 3;

/**
 * The courier reported RTO — record it, idempotently.
 *
 * **Why this does not go through `transitionOrder`.** That function is built
 * for a human: it takes the caller's RLS-bound client and a non-null
 * `actorId`, and its cancel branch exists for moves a courier can never cause.
 * Detection runs inside `fetchTracking`, which has neither — its only caller
 * passes the RLS client of whoever opened the page, and the actor of this
 * change is the *courier*, so the history line's `changed_by` must be null
 * (the timeline renders that as the shop itself, which is honest: the shop's
 * tracking poll noticed). Widening `fetchTracking`'s signature to smuggle an
 * actor through would attribute a courier's decision to whichever admin
 * happened to press "track". So this writes with the service client and keeps
 * the discipline that matters — the same compare-and-swap `transitionOrder`
 * uses: the UPDATE re-asserts the status it decided against
 * (`.eq("status", "shipped")`) plus `rto_at is null`, so of two concurrent
 * detections exactly one matches a row, and only the winner writes the history
 * line. The loser re-reads and finds `rto_at` set: `already`.
 *
 * The transition is `shipped → returning` and nothing else. An order the admin
 * already moved to `returning`/`returned` by hand gets its `rto_at` stamped —
 * the fact "the courier reported RTO" is true and the RTO view needs it — but
 * no second transition and no history line unless this call is the one that
 * won the guarded stamp.
 */
export async function detectRtoFromTracking(
  orderId: string,
  trackingStatus: string,
): Promise<RtoDetectionVerdict> {
  const admin = createAdminClient();

  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const order = await maybeRow<{
      id: string;
      status: OrderStatus;
      rto_at: string | null;
    }>(
      "rto.detect.read",
      admin
        .from("orders")
        .select("id, status, rto_at")
        .eq("id", orderId)
        .maybeSingle(),
    );

    if (!order) return "not_found";

    if (order.rto_at) {
      // A repeat poll of a known RTO. Repair the shipment stamp if an earlier
      // partial failure left it null, then say so — the caller's cheap
      // pre-filter reads `shipments.rto_at`, so leaving it unset would make
      // every future poll arrive here.
      await stampShipmentRto(admin, orderId, order.rto_at);
      return "already";
    }

    if (order.status === "shipped") {
      const rtoAt = new Date().toISOString();
      const { data: swapped, error } = await admin
        .from("orders")
        .update({ status: "returning", rto_at: rtoAt })
        .eq("id", orderId)
        .eq("status", "shipped")
        .is("rto_at", null)
        .select("id");
      if (error) {
        throw new Error(`rto.detect.swap: ${error.message} [${error.code ?? "?"}]`);
      }
      // Zero rows means the row is no longer the one this decision was made
      // against. Go round and decide again against whatever won.
      if ((swapped?.length ?? 0) !== 1) continue;

      await writeHistory(
        admin,
        orderId,
        "returning",
        `Courier reported RTO: ${trackingStatus}`,
        null,
      );
      await stampShipmentRto(admin, orderId, rtoAt);
      return "detected";
    }

    if (order.status === "returning" || order.status === "returned") {
      // Moved by hand before the tracking poll caught up. The transition
      // already happened; what is missing is the fact and its timestamp.
      const rtoAt = new Date().toISOString();
      const { data: stamped, error } = await admin
        .from("orders")
        .update({ rto_at: rtoAt })
        .eq("id", orderId)
        .is("rto_at", null)
        .select("id");
      if (error) {
        throw new Error(`rto.detect.stamp: ${error.message} [${error.code ?? "?"}]`);
      }
      if ((stamped?.length ?? 0) !== 1) continue;

      await writeHistory(
        admin,
        orderId,
        order.status,
        `Courier reported RTO: ${trackingStatus}`,
        null,
      );
      await stampShipmentRto(admin, orderId, rtoAt);
      return "recorded";
    }

    // pending / confirmed / packed / delivered / cancelled. A tracking status
    // containing "RTO" against any of these is the courier and the shop
    // disagreeing about reality, which a poll must record nowhere and a human
    // must untangle. Logged so it is findable, refused so it cannot move stock.
    console.warn(
      `[rto] tracking says "${trackingStatus}" but order ${orderId} is ${order.status} — not touching it`,
    );
    return "wrong_status";
  }

  return "conflict";
}

/**
 * Mirror `rto_at` onto the shipment row, guarded so it is written once.
 * Best-effort: the order is the record, the shipment is the cache the
 * fulfilment panel reads, and a failed mirror costs a repair on the next poll.
 */
async function stampShipmentRto(
  admin: Db,
  orderId: string,
  rtoAt: string,
): Promise<void> {
  const { error } = await admin
    .from("shipments")
    .update({ rto_at: rtoAt })
    .eq("order_id", orderId)
    .is("rto_at", null);
  if (error) {
    console.error("[rto] could not stamp the shipment:", error.message);
  }
}

/**
 * A timeline line that must not sink the operation it describes — the same
 * stance `transition.ts` and `refunds.ts` take: history is evidence, not a
 * dependency.
 */
async function writeHistory(
  admin: Db,
  orderId: string,
  status: OrderStatus,
  note: string,
  changedBy: string | null,
): Promise<void> {
  const { error } = await admin.from("order_status_history").insert({
    order_id: orderId,
    status,
    note,
    changed_by: changedBy,
  });
  if (error) {
    console.error(
      `[rto] history line for order ${orderId} was not written: ${error.message}`,
    );
  }
}

/* ---------------------------------------------------------------- receive -- */

/**
 * What the receive action accepts. Lives here rather than in the action file so
 * the audit harness can hold the damaged-requires-a-note rule to account —
 * a `"use server"` file may only export async functions, so a schema in there
 * is untestable from outside a request.
 *
 * The note is *required* for a damaged parcel because the note is the
 * write-off record: `rto_condition = 'damaged'` says what happened, the note
 * says what was seen, and together with the history row that is the entire
 * paper trail — deliberately no inventory movement, see the action.
 */
export const rtoReceiveSchema = z
  .object({
    orderId: z.uuid("That is not an order."),
    condition: z.enum(["ok", "damaged"]),
    note: z
      .string()
      .trim()
      .max(500, "Keep the note under 500 characters.")
      .optional(),
  })
  .refine(
    (value) => value.condition !== "damaged" || (value.note?.length ?? 0) > 0,
    {
      message:
        "Say what is damaged — this note is the write-off record, and it is all there is.",
      path: ["note"],
    },
  );

/* ---------------------------------------------------------------- restock -- */

export type RestockVerdict =
  | "restocked"
  | "not_found"
  | "not_received"
  | "damaged"
  | "already_restocked"
  | "wrong_status";

const RESTOCK_VERDICTS: readonly RestockVerdict[] = [
  "restocked",
  "not_found",
  "not_received",
  "damaged",
  "already_restocked",
  "wrong_status",
];

/**
 * `src/lib/database.types.ts` is generated from the schema and does not know
 * `restock_rto_order` yet — the types are regenerated by the lead after the
 * migration lands, and this file is not allowed to edit them pre-emptively.
 * Until then the one call site declares the function's shape itself, extending
 * the generated `Functions` map rather than abandoning the typed client, so
 * the regeneration changes nothing except making this alias redundant.
 */
type DatabaseWithRestockRpc = Omit<Database, "public"> & {
  public: Omit<Database["public"], "Functions"> & {
    Functions: Database["public"]["Functions"] & {
      restock_rto_order: {
        Args: { p_order_id: string; p_actor: string | null };
        Returns: string;
      };
    };
  };
};

/**
 * The stock back on the shelf, exactly once. Every guard lives inside the RPC
 * — see `supabase/migrations/20260809170000_restock_rto_order.sql` — because
 * only a row lock can make "check then restock" one decision. This wrapper
 * exists to type the call and to refuse a verdict it does not recognise, so a
 * future edit to the function cannot be silently interpreted as success.
 */
export async function restockRtoOrder(
  orderId: string,
  actorId: string,
): Promise<RestockVerdict> {
  const admin = createAdminClient() as unknown as SupabaseClient<DatabaseWithRestockRpc>;

  const { data, error } = await admin.rpc("restock_rto_order", {
    p_order_id: orderId,
    p_actor: actorId,
  });
  if (error) {
    throw new Error(`rto.restock: ${error.message} [${error.code ?? "?"}]`);
  }
  if (!RESTOCK_VERDICTS.includes(data as RestockVerdict)) {
    throw new Error(`rto.restock: unrecognised verdict "${String(data)}"`);
  }
  return data as RestockVerdict;
}

/* ------------------------------------------------------------ panel state -- */

export type RtoPanelState = {
  rtoAt: string | null;
  receivedAt: string | null;
  condition: "ok" | "damaged" | null;
  restockedAt: string | null;
  quotedRtoPaise: number | null;
  actualRtoPaise: number | null;
  canReceive: boolean;
  canRestock: boolean;
};

/**
 * What the RTO panel on an order page needs, or null when the order has no RTO
 * dimension at all — the page renders the panel only when this is non-null, so
 * the vast majority of orders never see it.
 *
 * The service client, because the page's own RLS-bound `getOrderDetail` has
 * already proved the caller may see this order — the same sequencing
 * `refundPanelState` relies on.
 */
export async function rtoPanelState(
  orderId: string,
): Promise<RtoPanelState | null> {
  const admin = createAdminClient();

  const order = await maybeRow<{
    status: OrderStatus;
    rto_at: string | null;
    rto_received_at: string | null;
    rto_condition: string | null;
    rto_restocked_at: string | null;
    quoted_rto_paise: number | null;
    rto_actual_charge_paise: number | null;
  }>(
    "rto.panel.order",
    admin
      .from("orders")
      .select(
        `status, rto_at, rto_received_at, rto_condition, rto_restocked_at,
         quoted_rto_paise, rto_actual_charge_paise`,
      )
      .eq("id", orderId)
      .maybeSingle(),
  );
  if (!order) return null;

  /**
   * No RTO dimension: `rto_at` null and not `returning`. A `returned` order
   * with a null `rto_at` is a replacement (`recordReplacement`), not an RTO,
   * and showing it a receive button would invite restocking a swap that has
   * its own stock policy. A `returning` order with a null `rto_at` is an admin
   * who moved it by hand before tracking caught up — still an RTO.
   */
  if (!order.rto_at && order.status !== "returning") return null;

  const condition =
    order.rto_condition === "ok" || order.rto_condition === "damaged"
      ? order.rto_condition
      : null;

  return {
    rtoAt: order.rto_at,
    receivedAt: order.rto_received_at,
    condition,
    restockedAt: order.rto_restocked_at,
    quotedRtoPaise: order.quoted_rto_paise,
    actualRtoPaise: order.rto_actual_charge_paise,
    /**
     * `returned` with a null `rto_received_at` is the retry seam: the receive
     * action transitions first and stamps second, so a stamp that failed
     * leaves a `returned` order whose receive button must still work.
     */
    canReceive:
      !order.rto_received_at &&
      (order.status === "returning" ||
        (order.status === "returned" && order.rto_at !== null)),
    canRestock:
      order.status === "returned" &&
      order.rto_received_at !== null &&
      condition === "ok" &&
      !order.rto_restocked_at,
  };
}

/* --------------------------------------------------------------- overview -- */

export type RtoOverviewRow = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  rtoAt: string | null;
  /** From the shipping_address snapshot; null when the snapshot is malformed. */
  pincode: string | null;
  phone: string | null;
  /** This phone appears on two or more RTO orders. The flag the view exists for. */
  repeatOffender: boolean;
  quotedRtoPaise: number | null;
  actualRtoPaise: number | null;
  condition: "ok" | "damaged" | null;
  receivedAt: string | null;
  restockedAt: string | null;
};

export type RtoOverview = {
  rows: RtoOverviewRow[];
  quotedTotalPaise: number;
  actualTotalPaise: number;
  repeatPhoneCount: number;
};

/**
 * Everything that came back: `returning` orders plus `returned` ones that
 * carry an `rto_at` — a `returned` order without one is a replacement and does
 * not belong here.
 *
 * Takes its client rather than making one so the page can pass the caller's
 * RLS-bound client (the admin policies let it through, same as every list
 * under `src/lib/queries/admin/`) and the audit harness can pass its staging
 * client without a request context.
 */
export async function rtoOverview(supabase: Db): Promise<RtoOverview> {
  const orders = await rows<{
    id: string;
    order_number: string;
    status: OrderStatus;
    rto_at: string | null;
    contact_phone: string | null;
    shipping_address: unknown;
    quoted_rto_paise: number | null;
    rto_actual_charge_paise: number | null;
    rto_condition: string | null;
    rto_received_at: string | null;
    rto_restocked_at: string | null;
  }>(
    "rto.overview",
    supabase
      .from("orders")
      .select(
        `id, order_number, status, rto_at, contact_phone, shipping_address,
         quoted_rto_paise, rto_actual_charge_paise, rto_condition,
         rto_received_at, rto_restocked_at`,
      )
      .or("status.eq.returning,and(status.eq.returned,rto_at.not.is.null)")
      .order("rto_at", { ascending: false, nullsFirst: true })
      // Bounded because unbounded admin lists have bitten this codebase
      // before. Two hundred RTOs is not a page, it is a courier contract
      // problem — but the totals below are computed from what is shown, so
      // the ceiling is stated rather than silent.
      .limit(200),
  );

  /**
   * Repeat offenders by phone, counted within the RTO set only. Two RTO orders
   * from one number is the pattern the owner blocks COD over; one RTO plus ten
   * delivered orders is a customer who moved house.
   */
  const phoneCounts = new Map<string, number>();
  for (const order of orders) {
    if (!order.contact_phone) continue;
    phoneCounts.set(
      order.contact_phone,
      (phoneCounts.get(order.contact_phone) ?? 0) + 1,
    );
  }

  const overviewRows: RtoOverviewRow[] = orders.map((order) => ({
    id: order.id,
    orderNumber: order.order_number,
    status: order.status,
    rtoAt: order.rto_at,
    pincode: pincodeFrom(order.shipping_address),
    phone: order.contact_phone,
    repeatOffender:
      order.contact_phone !== null &&
      (phoneCounts.get(order.contact_phone) ?? 0) >= 2,
    quotedRtoPaise: order.quoted_rto_paise,
    actualRtoPaise: order.rto_actual_charge_paise,
    condition:
      order.rto_condition === "ok" || order.rto_condition === "damaged"
        ? order.rto_condition
        : null,
    receivedAt: order.rto_received_at,
    restockedAt: order.rto_restocked_at,
  }));

  return {
    rows: overviewRows,
    quotedTotalPaise: overviewRows.reduce(
      (sum, row) => sum + (row.quotedRtoPaise ?? 0),
      0,
    ),
    actualTotalPaise: overviewRows.reduce(
      (sum, row) => sum + (row.actualRtoPaise ?? 0),
      0,
    ),
    repeatPhoneCount: [...phoneCounts.values()].filter((count) => count >= 2)
      .length,
  };
}

/**
 * The PIN code out of the `shipping_address` snapshot.
 *
 * The snapshot's shape is `ShippingAddress` in `src/lib/orders/types.ts`,
 * written by `shippingAddressSchema` in `src/lib/validations/checkout.ts` —
 * the key is `postalCode`, camel-cased, not `pincode` or `postal_code`.
 * Defensive anyway, because jsonb makes no promises and an audit fixture or a
 * hand-written row must degrade to a dash in the UI, not a crash.
 */
function pincodeFrom(address: unknown): string | null {
  if (typeof address !== "object" || address === null) return null;
  const value = (address as { postalCode?: unknown }).postalCode;
  return typeof value === "string" && value.length > 0 ? value : null;
}
