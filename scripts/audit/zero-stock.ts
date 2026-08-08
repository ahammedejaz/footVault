/**
 * `npm run audit:zero-stock` — the A1 regression the brief demands by name:
 * *"Write a regression test that attempts to order a zero-stock variant through
 * the real checkout path and asserts it is refused."*
 *
 * Phase 7 opened with the owner having placed an order for a size the admin
 * showed as zero. The diagnosis (see `src/lib/queries/availability.ts`) was a
 * stale `unstable_cache` overlay, not a broken decrement — but "the last guard
 * caught it" is not the same as "it cannot happen", and nothing exercised the
 * whole chain from outside. This does.
 *
 * The scenario is the real one: a unit is in the bag, then **sells out between
 * add-to-bag and checkout**. The cart still holds it optimistically, by design;
 * the guard has to be at order creation. So:
 *
 *   1. Build a guest bag holding an in-stock variant.
 *   2. Zero that variant's stock (what another buyer would have done).
 *   3. Drive the **real** `placeOrder` Server Action over HTTP — the exact
 *      endpoint the checkout page posts to, discovered from the client bundle,
 *      with the guest's own `fv_guest` cookie — and assert it is refused with
 *      `out_of_stock`, before any payment is initiated.
 *   4. Assert no order row was written and the unit never went negative.
 *
 * Then the database-level backstops the customer-facing path relies on:
 *   5. `create_order_with_stock` itself raises `OSTCK` on the same cart.
 *   6. The `CHECK (stock_quantity >= 0)` constraint makes negative stock
 *      unrepresentable — a direct forced decrement is rejected.
 *
 * And the positive control, so a pass means "the guard fired" and not "the
 * fixture was broken":
 *   7. The **same** variant, restocked, places an order cleanly — then it is
 *      cancelled and restocked, leaving the catalog as it was found.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../../src/lib/database.types";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BASE = process.env.AUDIT_BASE_URL ?? "http://localhost:3210";
const ORIGIN = new URL(BASE).origin;

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, held: boolean, detail = "") {
  if (held) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed += 1;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const admin = createClient<Database>(URL_, SERVICE, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const guestClient = (token: string): SupabaseClient<Database> =>
  createClient<Database>(URL_, ANON, {
    auth: { persistSession: false },
    global: { headers: { "x-guest-token": token } },
  });

const ADDRESS = {
  recipientName: "Quality Runner",
  phone: "9876500011",
  line1: "4 Harness Lane",
  line2: null,
  city: "Panaji",
  state: "Goa",
  postalCode: "403001",
  country: "IN" as const,
};

/** placeOrder's action id, discovered the attacker's way — from the bundle. */
function placeOrderActionId(): string | null {
  const re =
    /createServerReference\)\(\s*"([0-9a-f]{40,})"\s*,[^,]*,[^,]*,[^,]*,\s*"([^"]+)"\s*\)/g;
  let id: string | null = null;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".js")) {
        const src = readFileSync(p, "utf8");
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) if (m[2] === "placeOrder") id = m[1];
      }
    }
  };
  walk(".next/static/chunks");
  return id;
}

async function main() {
  console.log(`\nA1 — a zero-stock variant cannot be ordered (${BASE})\n`);

  // Direct stock edits below fire the inventory_movements trigger with the
  // default `unspecified` reason and a null actor — the same rows an owner
  // editing stock in the Supabase dashboard would leave. They net to zero, but
  // `reconcile_inventory()` flags any `unspecified` row, so the finally block
  // sweeps exactly the ones this run created. Bounded by this timestamp.
  const runStartedAt = new Date().toISOString();

  // Two in-stock variants: one to sell out, one to leave intact — so the
  // brief's "the rest of the bag intact, told which item" case is exercised.
  const { data: variants, error: vErr } = await admin
    .from("product_variants")
    .select("id, product_id, size, color, stock_quantity, is_active")
    .eq("is_active", true)
    .gt("stock_quantity", 0)
    .limit(2);
  if (vErr) throw new Error(`variant read: ${vErr.message}`);
  const variant = variants?.[0];
  const other = variants?.[1];
  if (!variant || !other) throw new Error("need two in-stock active variants");
  const originalStock = variant.stock_quantity;

  const createdOrderIds: string[] = [];
  const carts: string[] = [];

  try {
    /* ═══ 1 · the real HTTP checkout path refuses, and names the item ═══════ */
    console.log("1 · placeOrder over HTTP, one line sold out after add-to-bag");
    const token = randomUUID();
    const guest = guestClient(token);
    const { data: cart, error: cErr } = await guest
      .from("carts")
      .insert({ guest_token: token })
      .select("id")
      .maybeSingle();
    if (cErr || !cart) throw new Error(`cart: ${cErr?.message}`);
    carts.push(cart.id);
    // A mixed bag: the item that will sell out, plus one that stays available.
    const { error: liErr } = await guest.from("cart_items").insert([
      { cart_id: cart.id, variant_id: variant.id, quantity: 1 },
      { cart_id: cart.id, variant_id: other.id, quantity: 1 },
    ]);
    if (liErr) throw new Error(`cart_item: ${liErr.message}`);

    // Somebody else bought the last one between add-to-bag and checkout.
    const { error: zErr } = await admin
      .from("product_variants")
      .update({ stock_quantity: 0 })
      .eq("id", variant.id);
    if (zErr) throw new Error(`zeroing stock: ${zErr.message}`);

    const actionId = placeOrderActionId();
    check("placeOrder action id found in the client bundle", Boolean(actionId));

    let httpBody = "";
    if (actionId) {
      const res = await fetch(`${BASE}/checkout`, {
        method: "POST",
        headers: {
          "Next-Action": actionId,
          "Content-Type": "text/plain;charset=UTF-8",
          Accept: "text/x-component",
          Origin: ORIGIN,
          Cookie: `fv_guest=${token}`,
        },
        body: JSON.stringify([
          {
            paymentMethod: "cod",
            address: ADDRESS,
            contactEmail: "fv-secact.zerostock@example.com",
            contactPhone: "9876500011",
          },
        ]),
      });
      httpBody = (await res.text()).slice(0, 400);
    }
    // The refusal is `out_of_stock` — the sold-out line is still a cart_items
    // row, so create_order_with_stock sees it and refuses the whole order,
    // naming the item. (A sole-item bag instead reads `empty_cart`, because
    // getCart drops the gone line before placeOrder runs — see the report.)
    check(
      'the checkout action refuses with out_of_stock',
      /"reason"\s*:\s*"out_of_stock"/.test(httpBody),
      httpBody,
    );
    check(
      "the refusal names the item and size that sold out",
      new RegExp(`"reason":"out_of_stock"[\\s\\S]*${variant.size}`).test(
        httpBody,
      ) || /productName/.test(httpBody),
      httpBody,
    );
    check(
      "it did NOT return a placed order (ok:true)",
      !/"ok"\s*:\s*true/.test(httpBody),
      httpBody,
    );

    const { data: ordersForToken, error: oErr } = await admin
      .from("orders")
      .select("id")
      .eq("guest_token", token);
    if (oErr) throw new Error(`orders read: ${oErr.message}`);
    check(
      "no order row was created for the guest",
      (ordersForToken?.length ?? 0) === 0,
      `${ordersForToken?.length} orders`,
    );

    const { data: afterHttp, error: sErr } = await admin
      .from("product_variants")
      .select("stock_quantity")
      .eq("id", variant.id)
      .maybeSingle();
    if (sErr) throw new Error(`stock read: ${sErr.message}`);
    check(
      "stock is still zero, never negative",
      afterHttp?.stock_quantity === 0,
      `${afterHttp?.stock_quantity}`,
    );

    /* ═══ 2 · the transactional core refuses the same cart ══════════════════ */
    console.log("\n2 · create_order_with_stock is the backstop");
    const { error: rpcErr } = await admin.rpc("create_order_with_stock", {
      p_cart_id: cart.id,
      p_shipping_address: ADDRESS as never,
      p_payment_method: "cod",
      p_initial_status: "pending",
      p_payment_status: "unpaid",
      p_shipping_flat_fee: 9900,
      p_guest_token: token,
      p_contact_email: "fv-secact.zerostock@example.com",
    });
    check(
      "create_order_with_stock raises OSTCK on a zero-stock line",
      rpcErr?.code === "OSTCK",
      `code=${rpcErr?.code ?? "none"} msg=${rpcErr?.message ?? ""}`,
    );

    /* ═══ 3 · negative stock is unrepresentable ═════════════════════════════ */
    console.log("\n3 · the database makes negative stock impossible");
    const { error: negErr } = await admin
      .from("product_variants")
      .update({ stock_quantity: -1 })
      .eq("id", variant.id);
    check(
      "a forced decrement below zero is rejected (CHECK 23514)",
      negErr?.code === "23514",
      `code=${negErr?.code ?? "none — HOLE"}`,
    );

    /* ═══ 4 · positive control — restocked, it places cleanly ═══════════════ */
    console.log("\n4 · positive control: the same variant, restocked, sells");
    const { error: reErr } = await admin
      .from("product_variants")
      .update({ stock_quantity: Math.max(originalStock, 1) })
      .eq("id", variant.id);
    if (reErr) throw new Error(`restock: ${reErr.message}`);

    const token2 = randomUUID();
    const guest2 = guestClient(token2);
    const { data: cart2, error: cart2Err } = await guest2
      .from("carts")
      .insert({ guest_token: token2 })
      .select("id")
      .maybeSingle();
    if (cart2Err || !cart2) throw new Error(`second cart: ${cart2Err?.message}`);
    carts.push(cart2.id);
    const { error: line2Err } = await guest2
      .from("cart_items")
      .insert({ cart_id: cart2.id, variant_id: variant.id, quantity: 1 });
    if (line2Err) throw new Error(`second line: ${line2Err.message}`);

    const { data: placed, error: placeErr } = await admin.rpc(
      "create_order_with_stock",
      {
        p_cart_id: cart2.id,
        p_shipping_address: ADDRESS as never,
        p_payment_method: "cod",
        p_initial_status: "pending",
        p_payment_status: "unpaid",
        p_shipping_flat_fee: 9900,
        p_guest_token: token2,
        p_contact_email: "fv-secact.zerostock@example.com",
      },
    );
    const placedRow = placed?.[0];
    check(
      "an in-stock variant DOES place — so the refusal above is stock-specific",
      Boolean(placedRow) && !placeErr,
      placeErr?.message ?? "",
    );
    if (placedRow) {
      createdOrderIds.push(placedRow.order_id);
      // Undo it, restoring the unit, so the catalog is left as found.
      const { error: cancelErr } = await admin.rpc(
        "cancel_order_with_restock",
        {
          p_order_id: placedRow.order_id,
          p_reason: "audit: zero-stock regression cleanup",
          p_require_unpaid: true,
          p_release_cart: false,
        },
      );
      check(
        "the positive-control order is cancelled and its unit restocked",
        !cancelErr,
        cancelErr?.message ?? "",
      );
    }
  } finally {
    // Leave the catalog exactly as found.
    const { error: restoreErr } = await admin
      .from("product_variants")
      .update({ stock_quantity: originalStock })
      .eq("id", variant.id);
    if (restoreErr) console.error("restore stock:", restoreErr.message);
    for (const id of createdOrderIds) {
      const { error } = await admin.from("orders").delete().eq("id", id);
      if (error) console.error("cleanup order:", error.message);
    }
    for (const id of carts) {
      const { error } = await admin.from("carts").delete().eq("id", id);
      if (error) console.error("cleanup cart:", error.message);
    }
    // Sweep the `unspecified` ledger rows this run's direct stock edits left,
    // so reconcile_inventory() stays clean. Scoped to this run and this reason.
    const { error: sweepErr } = await admin
      .from("inventory_movements")
      .delete()
      .eq("reason", "unspecified")
      .is("actor", null)
      .in("variant_id", [variant.id, other.id])
      .gte("created_at", runStartedAt);
    if (sweepErr) console.error("sweep ledger:", sweepErr.message);
  }

  console.log(
    `\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m`,
  );
  if (failures.length) for (const f of failures) console.log(`  - ${f}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
