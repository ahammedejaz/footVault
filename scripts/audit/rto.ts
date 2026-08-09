/**
 * The RTO promises, held to.
 *
 * Batch 3.3's gates, all of them promises about what the **database** does
 * under repeated or misordered writes, so they run against staging for real —
 * synthetic product, synthetic shipped orders, real trigger, real RPC, real
 * detection code. No Shiprocket call is made anywhere in it; the courier is
 * simulated at exactly the seam `fetchTracking` uses, the tracking status
 * string handed to `detectRtoFromTracking`.
 *
 *   - detection is idempotent: two calls, one transition, one history line
 *   - stock cannot return before the box is physically received
 *   - a damaged parcel never restocks, and its write-off requires a note
 *   - restocking writes one `rto_return` movement per item, actor recorded
 *   - a second restock press is `already_restocked` and moves nothing —
 *     asserted on exact stock counts, not on the verdict alone
 *   - the RTO view flags a phone number that appears on two RTO orders
 *
 * Run as: NODE_OPTIONS=--conditions=react-server tsx scripts/audit/rto.ts
 */
// clients first, before any src import: it repoints this process at staging
// and refuses to run against production. Order matters.
import { adminClient, assertNotProduction } from "./clients";

import {
  detectRtoFromTracking,
  isRtoTrackingStatus,
  restockRtoOrder,
  rtoOverview,
  rtoReceiveSchema,
} from "../../src/lib/orders/rto";

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail = ""): void {
  checks++;
  if (!condition) failures++;
  console.log(
    `  ${condition ? "ok  " : "FAIL"}  ${label}${condition || !detail ? "" : `\n          ${detail}`}`,
  );
}

/* ════════════════════════════════════════════════════ the pure edges ══════ */

console.log("\nWhat counts as an RTO status\n");

ok("'RTO INITIATED' is one", isRtoTrackingStatus("RTO INITIATED"));
ok("'RTO DELIVERED' is one", isRtoTrackingStatus("RTO DELIVERED"));
ok("'rto in transit' is one — case does not matter", isRtoTrackingStatus("rto in transit"));
ok("'Delivered' is not", !isRtoTrackingStatus("Delivered"));
ok("'In Transit' is not", !isRtoTrackingStatus("In Transit"));
ok("null is not", !isRtoTrackingStatus(null));

console.log("\nThe receive schema\n");

// A real v4 UUID, not a hand-typed one: z.uuid() checks the version and
// variant nibbles, and "1111…-2222-…" fails them — which made every parse
// below fail for the wrong reason on the first run of this file.
const someOrder = crypto.randomUUID();
ok(
  "damaged without a note is refused — the note is the write-off record",
  !rtoReceiveSchema.safeParse({ orderId: someOrder, condition: "damaged" })
    .success,
);
ok(
  "damaged with a note passes",
  rtoReceiveSchema.safeParse({
    orderId: someOrder,
    condition: "damaged",
    note: "Sole split, box crushed",
  }).success,
);
ok(
  "ok needs no note",
  rtoReceiveSchema.safeParse({ orderId: someOrder, condition: "ok" }).success,
);

/* ══════════════════════════════════ the database promises, on staging ═════ */

async function main(): Promise<void> {
  console.log("\nThe database promises (staging)\n");

  assertNotProduction("build RTO fixtures");

  const db = adminClient();
  const run = Date.now().toString(36);
  // Unique per run so repeat-phone counting cannot collide with leftovers.
  const sharedPhone = `97${String(Date.now()).slice(-8)}`;

  /**
   * The actor the movements must record. `inventory_movements.actor` and
   * `order_status_history.changed_by` both reference `profiles(id)`, so this
   * has to be a real profile — an existing one if staging has any, otherwise a
   * QA auth user whose profile the `handle_new_user()` trigger creates.
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
          email: `fv-qa.rto-${run}@example.com`,
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

  let productId: string | null = null;
  const orderIds: string[] = [];

  /** A shipped order with a shipment row, ready to be reported RTO. */
  async function fixtureOrder(
    items: { variantId: string; sku: string; quantity: number }[],
    quotedRtoPaise: number,
  ): Promise<string> {
    const subtotal = items.reduce((sum, item) => sum + 259900 * item.quantity, 0);
    const { data: order, error: orderError } = await db
      .from("orders")
      .insert({
        status: "shipped",
        subtotal,
        grand_total: subtotal,
        // The money identity the schema enforces: advance + balance = total.
        advance_amount: subtotal,
        balance_due_on_delivery: 0,
        shipping_address: {
          recipientName: "QA RTO",
          phone: sharedPhone,
          line1: "1 Audit Street",
          line2: null,
          city: "Coimbatore",
          state: "Tamil Nadu",
          postalCode: "641001",
          country: "IN",
        },
        contact_phone: sharedPhone,
        contact_email: `fv-qa.rto-${run}@example.com`,
        quoted_rto_paise: quotedRtoPaise,
      })
      .select("id")
      .single();
    if (orderError || !order) {
      throw new Error(`fixture order failed: ${orderError?.message}`);
    }
    orderIds.push(order.id);

    const { error: itemsError } = await db.from("order_items").insert(
      items.map((item) => ({
        order_id: order.id,
        product_id: productId,
        variant_id: item.variantId,
        product_name: `QA RTO product ${run}`,
        product_slug: null,
        size: "UK 9",
        color: "Black",
        sku: item.sku,
        unit_price: 259900,
        quantity: item.quantity,
        line_total: 259900 * item.quantity,
      })),
    );
    if (itemsError) throw new Error(`fixture items failed: ${itemsError.message}`);

    const { error: shipmentError } = await db.from("shipments").insert({
      order_id: order.id,
      status: "In Transit",
      awb_code: `FVQA${run}${orderIds.length}`,
    });
    if (shipmentError) {
      throw new Error(`fixture shipment failed: ${shipmentError.message}`);
    }
    return order.id;
  }

  async function stockOf(variantId: string): Promise<number> {
    const { data, error } = await db
      .from("product_variants")
      .select("stock_quantity")
      .eq("id", variantId)
      .single();
    if (error || !data) throw new Error(`reading stock failed: ${error?.message}`);
    return data.stock_quantity;
  }

  async function orderRow(orderId: string) {
    const { data, error } = await db
      .from("orders")
      .select("status, rto_at, rto_restocked_at")
      .eq("id", orderId)
      .single();
    if (error || !data) throw new Error(`reading order failed: ${error?.message}`);
    return data;
  }

  try {
    /* ── fixtures: a product with two sizes, and two orders on one phone ──── */
    {
      const { data: product, error } = await db
        .from("products")
        .insert({
          name: `QA RTO product ${run}`,
          slug: `fv-qa-rto-${run}`,
          footwear_type: "sneaker",
          base_price: 259900,
          // Off the storefront: staging is shared, and a QA shoe in the
          // catalog rail would outlive a failed cleanup visibly.
          is_active: false,
        })
        .select("id")
        .single();
      if (error || !product) throw new Error(`fixture product failed: ${error?.message}`);
      productId = product.id;
    }

    const { data: variants, error: variantsError } = await db
      .from("product_variants")
      .insert([
        {
          product_id: productId,
          size: "UK 9",
          color: "Black",
          sku: `FVQA-RTO-${run}-1`,
          stock_quantity: 5,
          is_active: false,
        },
        {
          product_id: productId,
          size: "UK 10",
          color: "Black",
          sku: `FVQA-RTO-${run}-2`,
          stock_quantity: 7,
          is_active: false,
        },
      ])
      .select("id, sku")
      .order("sku");
    if (variantsError || !variants || variants.length !== 2) {
      throw new Error(`fixture variants failed: ${variantsError?.message}`);
    }
    const [v1, v2] = variants;

    // Order 1: two lines — UK 9 ×2 and UK 10 ×1 — so "one movement per item"
    // is two rows with two different deltas, not one row read twice.
    const order1 = await fixtureOrder(
      [
        { variantId: v1.id, sku: v1.sku, quantity: 2 },
        { variantId: v2.id, sku: v2.sku, quantity: 1 },
      ],
      11400,
    );
    // Order 2: same phone. Its only job is to make the number a repeat.
    const order2 = await fixtureOrder(
      [{ variantId: v1.id, sku: v1.sku, quantity: 1 }],
      9800,
    );

    /* ── gate: detection is idempotent ───────────────────────────────────── */
    {
      const first = await detectRtoFromTracking(order1, "RTO INITIATED");
      ok("the first report transitions: verdict 'detected'", first === "detected", first);

      const after = await orderRow(order1);
      ok(
        "the order is returning with rto_at stamped",
        after.status === "returning" && after.rto_at !== null,
        JSON.stringify(after),
      );

      const { data: shipment, error } = await db
        .from("shipments")
        .select("rto_at")
        .eq("order_id", order1)
        .single();
      ok(
        "the shipment carries rto_at too",
        !error && shipment?.rto_at !== null,
        error?.message ?? "",
      );

      const second = await detectRtoFromTracking(order1, "RTO IN TRANSIT");
      ok("the second report is 'already', not a second move", second === "already", second);

      const { data: lines, error: historyError } = await db
        .from("order_status_history")
        .select("id")
        .eq("order_id", order1)
        .eq("status", "returning");
      ok(
        "one transition, one history line",
        !historyError && lines?.length === 1,
        historyError?.message ?? `lines: ${lines?.length}`,
      );
    }

    /* ── gate: stock cannot return before the box is received ────────────── */
    {
      const verdict = await restockRtoOrder(order1, actorId);
      ok(
        "restock while still returning: 'wrong_status'",
        verdict === "wrong_status",
        verdict,
      );

      // The parcel arrives: returned, but nobody has recorded receiving it.
      // (Written directly — the receive *action* needs an admin session, and
      // what is being proved here is that the RPC's guards hold whatever the
      // caller did or skipped.)
      const { error } = await db
        .from("orders")
        .update({ status: "returned" })
        .eq("id", order1);
      if (error) throw new Error(`moving to returned failed: ${error.message}`);

      const unreceived = await restockRtoOrder(order1, actorId);
      ok(
        "returned but not received: 'not_received'",
        unreceived === "not_received",
        unreceived,
      );
      ok(
        "and stock has not moved",
        (await stockOf(v1.id)) === 5 && (await stockOf(v2.id)) === 7,
      );
    }

    /* ── gate: damaged never restocks ────────────────────────────────────── */
    {
      const { error } = await db
        .from("orders")
        .update({
          rto_received_at: new Date().toISOString(),
          rto_received_by: actorId,
          rto_condition: "damaged",
        })
        .eq("id", order1);
      if (error) throw new Error(`marking received failed: ${error.message}`);

      const verdict = await restockRtoOrder(order1, actorId);
      ok("a damaged parcel answers 'damaged'", verdict === "damaged", verdict);
      ok(
        "and stock has not moved",
        (await stockOf(v1.id)) === 5 && (await stockOf(v2.id)) === 7,
      );
      const { data: movements, error: movementsError } = await db
        .from("inventory_movements")
        .select("id")
        .eq("reference_id", order1);
      ok(
        "and no movement row was written — a write-off leaves the ledger alone",
        !movementsError && movements?.length === 0,
        movementsError?.message ?? `rows: ${movements?.length}`,
      );
    }

    /* ── gate: a good parcel restocks, once, with a ledger row per item ───── */
    {
      const { error } = await db
        .from("orders")
        .update({ rto_condition: "ok" })
        .eq("id", order1);
      if (error) throw new Error(`re-inspecting failed: ${error.message}`);

      const verdict = await restockRtoOrder(order1, actorId);
      ok("condition ok restocks: 'restocked'", verdict === "restocked", verdict);
      ok(
        "stock is back: UK 9 went 5 → 7, UK 10 went 7 → 8",
        (await stockOf(v1.id)) === 7 && (await stockOf(v2.id)) === 8,
        `v1=${await stockOf(v1.id)} v2=${await stockOf(v2.id)}`,
      );

      const { data: movements, error: movementsError } = await db
        .from("inventory_movements")
        .select("variant_id, delta, reason, actor")
        .eq("reference_id", order1)
        .order("delta");
      ok(
        "two movement rows — one per order item",
        !movementsError && movements?.length === 2,
        movementsError?.message ?? `rows: ${movements?.length}`,
      );
      if (movements?.length === 2) {
        ok(
          "both say rto_return and name the actor",
          movements.every(
            (movement) =>
              movement.reason === "rto_return" && movement.actor === actorId,
          ),
          JSON.stringify(movements),
        );
        ok(
          "the deltas are the item quantities: 1 and 2",
          movements[0].delta === 1 && movements[1].delta === 2,
          JSON.stringify(movements.map((movement) => movement.delta)),
        );
      }
      ok(
        "rto_restocked_at is stamped",
        (await orderRow(order1)).rto_restocked_at !== null,
      );
    }

    /* ── gate: the second press is a no-op ───────────────────────────────── */
    {
      const verdict = await restockRtoOrder(order1, actorId);
      ok(
        "pressing again answers 'already_restocked'",
        verdict === "already_restocked",
        verdict,
      );
      ok(
        "and stock is exactly where it was: 7 and 8",
        (await stockOf(v1.id)) === 7 && (await stockOf(v2.id)) === 8,
        `v1=${await stockOf(v1.id)} v2=${await stockOf(v2.id)}`,
      );
      const { data: movements, error } = await db
        .from("inventory_movements")
        .select("id")
        .eq("reference_id", order1);
      ok(
        "still two movement rows, not four",
        !error && movements?.length === 2,
        error?.message ?? `rows: ${movements?.length}`,
      );
    }

    /* ── gate: the view flags the repeat phone ───────────────────────────── */
    {
      const second = await detectRtoFromTracking(order2, "RTO DELIVERED");
      ok("the second order's RTO is detected too", second === "detected", second);

      // The actual charge, as the record action would write it, so the view
      // can be held to showing quoted and actual side by side.
      const { error } = await db
        .from("orders")
        .update({ rto_actual_charge_paise: 12800 })
        .eq("id", order1);
      if (error) throw new Error(`recording the charge failed: ${error.message}`);

      const overview = await rtoOverview(db);
      const row1 = overview.rows.find((row) => row.id === order1);
      const row2 = overview.rows.find((row) => row.id === order2);

      ok("both fixture orders are in the view", Boolean(row1 && row2));
      ok(
        "the shared phone is flagged on both",
        row1?.repeatOffender === true && row2?.repeatOffender === true,
        JSON.stringify({ row1: row1?.repeatOffender, row2: row2?.repeatOffender }),
      );
      ok(
        "the PIN code is read from the address snapshot's postalCode key",
        row1?.pincode === "641001",
        String(row1?.pincode),
      );
      ok(
        "quoted and actual sit side by side: ₹114 quoted, ₹128 actual",
        row1?.quotedRtoPaise === 11400 && row1?.actualRtoPaise === 12800,
        JSON.stringify({ quoted: row1?.quotedRtoPaise, actual: row1?.actualRtoPaise }),
      );
      ok(
        "the restocked order reads as restocked",
        row1?.restockedAt !== null && row1?.condition === "ok",
      );
    }
  } finally {
    /* ── leave staging as found ──────────────────────────────────────────── */
    // Movements first: they have no FK to orders (reference_id is a plain
    // uuid), so nothing else deletes them. Then the orders — history, items,
    // shipments all cascade — then the product, which cascades its variants.
    // A failed delete is shouted, never thrown: a throw here would mask
    // whichever assertion actually failed, and the leftovers carry the run id
    // so a later sweep can find them.
    const sweep = async (
      label: string,
      result: PromiseLike<{ error: { message: string } | null }>,
    ) => {
      const { error } = await result;
      if (error) console.error(`  cleanup: ${label} failed — ${error.message}`);
    };
    for (const orderId of orderIds) {
      await sweep(
        "inventory_movements",
        db.from("inventory_movements").delete().eq("reference_id", orderId),
      );
      await sweep(
        "order_status_history",
        db.from("order_status_history").delete().eq("order_id", orderId),
      );
      await sweep("shipments", db.from("shipments").delete().eq("order_id", orderId));
      await sweep("orders", db.from("orders").delete().eq("id", orderId));
    }
    if (productId) {
      await sweep("products", db.from("products").delete().eq("id", productId));
    }
    // The variants' opening_balance rows: written on *creation* by the
    // ledger-covers-new-variants trigger with a null reference_id, so the
    // order-keyed delete above never sees them, and they survive the product
    // delete because the ledger keeps the SKU snapshot on purpose. Swept by
    // that snapshot.
    await sweep(
      "inventory_movements (opening balances)",
      db
        .from("inventory_movements")
        .delete()
        .like("variant_sku", `FVQA-RTO-${run}-%`),
    );
    if (createdUserId) {
      const { error } = await db.auth.admin.deleteUser(createdUserId);
      if (error) console.error(`  cleanup: QA user failed — ${error.message}`);
    }
  }

  console.log(
    failures === 0
      ? `\nPASS — ${checks}/${checks} checks`
      : `\nFAIL — ${failures} of ${checks} checks failed`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
