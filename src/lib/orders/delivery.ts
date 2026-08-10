import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { transitionOrder, type TransitionResult } from "@/lib/orders/transition";
import { maybeRow } from "@/lib/queries/run";

/**
 * Status becomes a consequence of the evidence — the inversion Batch 0.4
 * exists for.
 *
 * `fetchTracking` stamps `orders.delivered_at` from the courier's own
 * activity line; this promotes the order's *status* to match, through
 * `transitionOrder` — the same seam the owner's button uses — so the history
 * row is written and the delivered email fires exactly the way they always
 * have. There is deliberately no second path to `delivered`.
 *
 * Idempotent by construction, not by care: a second call sees
 * `status = 'delivered'` and `transitionOrder` answers "already there" as a
 * success without swapping, writing history, or emailing. The gate proves it
 * by replaying ten times.
 *
 * Never acts on an absence: no `delivered_at`, or a status that is not
 * `shipped`, means nothing happens. A false negative here costs one tick of
 * delay; a false positive would start a damage-window clock and (from Batch
 * B) mint coins — so this only ever follows evidence already on the row.
 */
export async function promoteDeliveredOrder(
  admin: SupabaseClient<Database>,
  orderId: string,
): Promise<
  | { promoted: false; why: "no_evidence" | "not_shipped" | "missing" }
  | { promoted: boolean; result: TransitionResult }
> {
  const order = await maybeRow<{
    id: string;
    status: string;
    delivered_at: string | null;
  }>(
    "delivery.promote.read",
    admin
      .from("orders")
      .select("id, status, delivered_at")
      .eq("id", orderId)
      .maybeSingle(),
  );

  if (!order) return { promoted: false, why: "missing" };
  if (!order.delivered_at) return { promoted: false, why: "no_evidence" };
  if (order.status !== "shipped") return { promoted: false, why: "not_shipped" };

  const result = await transitionOrder({
    supabase: admin,
    elevated: () => admin,
    orderId,
    to: "delivered",
    note: "Delivered — confirmed by courier tracking",
    // The system, not a person: renders as "Foot Vault" on the timeline.
    actorId: null,
  });

  return { promoted: result.ok, result };
}
