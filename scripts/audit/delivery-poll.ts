/**
 * `npm run audit:delivery-poll` — the delivered signal, held to its promises.
 *
 *   npm run dev:stage          # a server on :3210, for the route-wiring half
 *   npm run audit:delivery-poll
 *
 * Batch 0.4 made "delivered" real: one authoritative field
 * (`orders.delivered_at`), stamped by courier evidence through
 * `fetchTracking`'s write path or by the owner's button through
 * `transitionOrder`, with `delivered_source` recording whose word it rests
 * on, and a pg_cron-driven route promoting evidence into the status
 * transition that fires the history row and the delivered email.
 *
 * The courier is simulated at exactly the seam `fetchTracking` uses — a
 * synthetic tracking payload handed to `applyTrackingSnapshot`, the same
 * trick `audit:rto` uses and for the same reason: no Shiprocket call, real
 * write path. **What this deliberately cannot prove:** that Shiprocket's
 * actual Delivered payload parses. `deliveredTimestamp` has never seen one,
 * because no parcel in this shop's history has ever been delivered. The
 * first real delivery is the real test, and this gate claims wiring,
 * idempotency and transition — not payload coverage.
 *
 *   1. a Delivered payload stamps the COURIER'S timestamp, never now()
 *   2. the promotion transitions the order, writes one history row, and the
 *      delivered email hangs off that transition (proven single by 3)
 *   3. replaying the same payload + promotion ten times: one transition, one
 *      history row, timestamp unmoved
 *   4. an RTO payload routes to RTO detection and never marks delivered
 *   5. the manual button stamps delivered_at + delivered_source='admin'
 *   6. withinReplacementWindow returns a real boolean on both paths
 *   7. the real route: 401 without the bearer token; a tick with it leaves a
 *      shipment whose tracking cannot be fetched exactly as it was
 *
 * Run as: NODE_OPTIONS=--conditions=react-server tsx scripts/audit/delivery-poll.ts
 */
// clients first: repoints this process at staging, refuses production.
import { adminClient, assertNotProduction, assertServerNotProduction } from "./clients";

import { promoteDeliveredOrder } from "../../src/lib/orders/delivery";
import { withinReplacementWindow } from "../../src/lib/orders/replacement-window";
import { transitionOrder } from "../../src/lib/orders/transition";
import {
  applyTrackingSnapshot,
  type TrackingSnapshot,
} from "../../src/lib/shipping/fulfilment";
import { BASE_URL } from "./routes";

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail = ""): void {
  checks++;
  if (!condition) failures++;
  console.log(
    `  ${condition ? "ok  " : "FAIL"}  ${label}${condition || !detail ? "" : `\n          ${detail}`}`,
  );
}

/**
 * 14:23 IST on the 9th is 08:53 UTC — the exact instant the courier's
 * activity line names, which is the value `delivered_at` must carry. Any
 * answer near "now" means somebody stamped the poll time instead, handing
 * the customer a window that starts whenever an admin happened to look.
 */
const COURIER_SAYS = "2026-08-09 14:23:00";
const COURIER_SAYS_UTC = "2026-08-09T08:53:00.000Z";

const DELIVERED_PAYLOAD: TrackingSnapshot = {
  status: "Delivered",
  activities: [
    { date: COURIER_SAYS, activity: "Delivered", location: "Coimbatore" },
    {
      date: "2026-08-09 09:02:00",
      activity: "Out for delivery",
      location: "Coimbatore",
    },
  ],
};

const RTO_PAYLOAD: TrackingSnapshot = {
  status: "RTO INITIATED",
  activities: [
    { date: "2026-08-09 11:00:00", activity: "RTO INITIATED", location: "Hub" },
  ],
};

async function main(): Promise<void> {
  /*
    The browser writes wherever BASE_URL points, which the credential guard
    cannot see. See clients.ts — this is the half that let production pick up
    two guest carts on 2026-08-14.
  */
  await assertServerNotProduction(BASE_URL, "run audit:delivery-poll");

  assertNotProduction("build delivery-poll fixtures");
  const db = adminClient();
  const run = Date.now().toString(36);

  /**
   * A real profile for `order_status_history.changed_by`. Inside the suite,
   * teardown has just swept every QA account, so "borrow an existing
   * profile" finds nothing — the same situation rto.ts handles, handled the
   * same way: create one, delete it in the finally.
   */
  let actorId: string;
  let createdUserId: string | null = null;
  {
    const { data: profile, error } = await db
      .from("profiles")
      .select("id")
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`reading profiles failed: ${error.message}`);
    if (profile) {
      actorId = profile.id;
    } else {
      const { data: created, error: createError } =
        await db.auth.admin.createUser({
          email: `fv-qa.delivery-${run}@example.com`,
          password: `Qa-${run}-Aa1!`,
          email_confirm: true,
        });
      if (createError || !created.user) {
        throw new Error(`QA user failed: ${createError?.message}`);
      }
      createdUserId = created.user.id;
      actorId = created.user.id;
    }
  }

  const orderIds: string[] = [];

  /** A shipped order with an AWB'd shipment, ready to arrive. */
  async function fixtureOrder(suffix: string): Promise<string> {
    const { data: order, error: orderError } = await db
      .from("orders")
      .insert({
        status: "shipped",
        subtotal: 259_900,
        grand_total: 259_900,
        advance_amount: 259_900,
        balance_due_on_delivery: 0,
        shipping_address: {
          recipientName: "QA Delivery",
          phone: "9800000001",
          line1: "1 Audit Street",
          line2: null,
          city: "Coimbatore",
          state: "Tamil Nadu",
          postalCode: "641001",
          country: "IN",
        },
        contact_phone: "9800000001",
        // No email on purpose: the delivered email path short-circuits before
        // the adapter, so replay counting stays about transitions, which is
        // the property that gates the email anyway.
        contact_email: null,
      })
      .select("id")
      .single();
    if (orderError || !order)
      throw new Error(`fixture order failed: ${orderError?.message}`);
    orderIds.push(order.id);

    const { error: shipmentError } = await db.from("shipments").insert({
      order_id: order.id,
      status: "In Transit",
      awb_code: `FVQA${run}${suffix}`,
    });
    if (shipmentError)
      throw new Error(`fixture shipment failed: ${shipmentError.message}`);
    return order.id;
  }

  async function orderRow(orderId: string) {
    const { data, error } = await db
      .from("orders")
      .select("status, delivered_at, delivered_source")
      .eq("id", orderId)
      .single();
    if (error || !data) throw new Error(`order re-read failed: ${error?.message}`);
    return data;
  }

  async function historyCount(
    orderId: string,
    status: "delivered",
  ): Promise<number> {
    const { count, error } = await db
      .from("order_status_history")
      .select("id", { count: "exact", head: true })
      .eq("order_id", orderId)
      .eq("status", status);
    if (error) throw new Error(`history count failed: ${error.message}`);
    return count ?? 0;
  }

  try {
    /* ══ 1 · courier evidence stamps the courier's own clock ════════════ */
    console.log("\n1 · a Delivered payload stamps the courier's timestamp\n");

    const delivered = await fixtureOrder("A");
    await applyTrackingSnapshot(db, delivered, DELIVERED_PAYLOAD, {
      simulated: "audit:delivery-poll",
    });

    let row = await orderRow(delivered);
    ok(
      "delivered_at equals the courier's activity time, to the second",
      row.delivered_at !== null &&
        new Date(row.delivered_at).toISOString() === COURIER_SAYS_UTC,
      `got ${row.delivered_at}, wanted ${COURIER_SAYS_UTC}`,
    );
    ok(
      "and never now(): the stamp is at least a day from this run",
      row.delivered_at !== null &&
        Math.abs(Date.now() - new Date(row.delivered_at).getTime()) >
          24 * 60 * 60 * 1000,
    );
    ok("delivered_source says courier", row.delivered_source === "courier");
    ok("the status has not moved yet — evidence first", row.status === "shipped");

    /* ══ 2 · promotion is a consequence of the evidence ═════════════════ */
    console.log("\n2 · the promotion transitions through the one seam\n");

    const promoted = await promoteDeliveredOrder(db, delivered);
    ok("the promotion applied", "result" in promoted && promoted.promoted);
    row = await orderRow(delivered);
    ok("the order is delivered", row.status === "delivered");
    ok(
      "the courier's timestamp survived the transition untouched",
      row.delivered_at !== null &&
        new Date(row.delivered_at).toISOString() === COURIER_SAYS_UTC,
    );
    ok("the source is still courier — not relabelled", row.delivered_source === "courier");
    ok(
      "exactly one delivered history row",
      (await historyCount(delivered, "delivered")) === 1,
    );

    /* ══ 3 · ten replays, one everything ════════════════════════════════ */
    console.log("\n3 · the same event, replayed ten times\n");

    for (let i = 0; i < 10; i++) {
      await applyTrackingSnapshot(db, delivered, DELIVERED_PAYLOAD, {
        simulated: `replay-${i}`,
      });
      await promoteDeliveredOrder(db, delivered);
    }
    row = await orderRow(delivered);
    ok(
      "still exactly one delivered history row — one transition, and the email hangs off the transition, so one email",
      (await historyCount(delivered, "delivered")) === 1,
    );
    ok(
      "the timestamp never moved",
      row.delivered_at !== null &&
        new Date(row.delivered_at).toISOString() === COURIER_SAYS_UTC,
    );

    /* ══ 4 · RTO is not delivery ════════════════════════════════════════ */
    console.log("\n4 · an RTO payload routes to RTO detection\n");

    const rto = await fixtureOrder("B");
    await applyTrackingSnapshot(db, rto, RTO_PAYLOAD, { simulated: "rto" });
    row = await orderRow(rto);
    ok("delivered_at stays null", row.delivered_at === null);
    ok("delivered_source stays null", row.delivered_source === null);
    ok(
      "the order took the RTO road, not delivery",
      row.status === "returning",
      `status is ${row.status}`,
    );
    const rtoPromotion = await promoteDeliveredOrder(db, rto);
    ok(
      "and the promotion refuses it — no evidence, nothing happens",
      !rtoPromotion.promoted,
    );

    /* ══ 5 · the manual button leaves evidence too ══════════════════════ */
    console.log("\n5 · the owner's button stamps what it asserts\n");

    const manual = await fixtureOrder("C");
    const pressed = await transitionOrder({
      supabase: db,
      elevated: () => db,
      orderId: manual,
      to: "delivered",
      note: null,
      actorId,
    });
    ok("the button's transition applied", pressed.ok);
    row = await orderRow(manual);
    ok("delivered_at is stamped — no more timestampless deliveries", row.delivered_at !== null);
    ok("delivered_source says admin", row.delivered_source === "admin");
    ok(
      "and the stamp is the press, give or take a minute",
      row.delivered_at !== null &&
        Math.abs(Date.now() - new Date(row.delivered_at).getTime()) < 60_000,
    );

    /* ══ 6 · the damage window has a clock at last ══════════════════════ */
    console.log("\n6 · withinReplacementWindow returns a real boolean\n");

    const courierRow = await orderRow(delivered);
    ok(
      "courier path: a real boolean (false — the fixture delivered days ago)",
      withinReplacementWindow(courierRow.delivered_at) === false,
    );
    ok(
      "admin path: a real boolean (true — pressed a moment ago)",
      withinReplacementWindow(row.delivered_at) === true,
    );
    ok("no timestamp is still an honest null", withinReplacementWindow(null) === null);

    /* ══ 7 · the route itself: auth, and the unknown leaves no mark ═════ */
    console.log("\n7 · the real route, over HTTP\n");

    const unreachable = await fixtureOrder("D");
    const unauthorised = await fetch(`${BASE_URL}/api/cron/poll-deliveries`, {
      method: "POST",
    });
    ok("no token → 401", unauthorised.status === 401);

    const secret = process.env.CRON_SECRET?.trim();
    if (!secret) {
      ok("CRON_SECRET available to drive an authorised tick", false, "unset in .env.local");
    } else {
      const tick = await fetch(`${BASE_URL}/api/cron/poll-deliveries`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
      });
      const body = (await tick.json()) as { ok: boolean; examined?: number };
      ok("an authorised tick answers 200 and reports its tally", tick.ok && body.ok === true);
      ok(
        "the tick examined the in-flight fixture",
        (body.examined ?? 0) >= 1,
        JSON.stringify(body),
      );
      row = await orderRow(unreachable);
      ok(
        "a shipment whose tracking cannot be fetched is exactly as it was",
        row.status === "shipped" && row.delivered_at === null,
        `status ${row.status}, delivered_at ${row.delivered_at}`,
      );
    }
  } finally {
    /* Fixtures out, dependents first. Each delete checked: a leftover fixture
       makes the next run fail for reasons that are not defects. */
    for (const orderId of orderIds) {
      const sweeps = [
        db.from("order_status_history").delete().eq("order_id", orderId),
        db.from("shipments").delete().eq("order_id", orderId),
        db.from("shipment_errors").delete().eq("order_id", orderId),
        db.from("order_items").delete().eq("order_id", orderId),
      ];
      for (const sweep of sweeps) {
        const { error } = await sweep;
        if (error) console.error(`  !! fixture not removed: ${error.message}`);
      }
      const { error } = await db.from("orders").delete().eq("id", orderId);
      if (error)
        console.error(`  !! fixture order not removed: ${error.message}`);
    }
    if (createdUserId) {
      await db.auth.admin.deleteUser(createdUserId).catch(() => {});
    }
  }

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
