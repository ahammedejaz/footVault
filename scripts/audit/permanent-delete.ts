/**
 * `npm run audit:permanent-delete` — the two functions that destroy things.
 *
 * `admin_purge_product` and `admin_delete_order` are the only writes in this
 * panel with no way back. Everything else soft-deletes, cancels, or removes
 * something re-creatable; these remove rows. So the interesting assertions are
 * not that they work — a delete usually works — but that they **refuse the
 * right things** and that what they leave behind is intact.
 *
 * Both halves matter equally and the second is the one a normal test skips:
 *
 *   - a purged product must leave every order line readable, with its own name,
 *     size and price still on it and only the foreign key nulled;
 *   - a deleted order must put its stock back, because the decrement happened
 *     in the same transaction that wrote the row and nothing else will ever
 *     undo it;
 *   - a paid order must survive the attempt, because that row is the shop's
 *     record of a sale.
 *
 * Every fixture here is built by this file and destroyed by it. Nothing reads
 * "the newest order" or "the first product" — see the note in `admin-pages.ts`
 * about why a gate whose verdict depends on residue is worthless in both
 * directions.
 *
 * ## Why it authenticates rather than using the service role
 *
 * `is_admin()` reads `auth.uid()`. A service-role client has no user, so it
 * would fail the guard inside both functions and every call would raise
 * `not_admin` — a run that "passes" by never reaching the code under test. The
 * probe therefore holds a real session belonging to a real promoted admin,
 * which is also the only way the grant on these functions is exercised at all.
 */

import "./clients";

import { readFileSync } from "node:fs";

import type { SupabaseClient } from "@supabase/supabase-js";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

import type { Database } from "../../src/lib/database.types";
import { adminClient, anonClient } from "./clients";
import { assertNotProduction } from "./clients";
import { createAccount } from "./fixtures";

assertNotProduction("run audit:permanent-delete");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed += 1;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * "Is this row gone?", asked so that a broken read cannot answer yes.
 *
 * `maybeSingle()` returns `data: null` both when nothing matched and when the
 * query failed, and every "it was deleted" assertion in this file is a test for
 * `null`. Dropping the error would therefore make a dead connection look exactly
 * like a successful delete — a gate that passes hardest when the database is
 * least reachable. `footvault/no-unchecked-supabase-error` exists for this shape
 * and is right to flag it.
 */
async function absent(
  label: string,
  query: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<boolean> {
  const { data, error } = await query;
  if (error) throw new Error(`could not re-read ${label}: ${error.message}`);
  return data === null;
}

const stamp = Date.now().toString(36);

async function main() {
  const admin = adminClient();

  /* An admin session, so `is_admin()` inside the functions is actually true. */
  const account = await createAccount("purge");
  {
    const { error } = await admin
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", account.userId);
    if (error) throw new Error(`could not promote the probe: ${error.message}`);
  }
  const asAdmin: SupabaseClient<Database> = anonClient();
  await asAdmin.auth.setSession({
    access_token: account.session.access_token,
    refresh_token: account.session.refresh_token,
  });

  /** Everything this run creates, torn down in the finally whatever happens. */
  const madeProducts: string[] = [];
  const madeOrders: string[] = [];

  try {
    /* ═══ 1 · purging a product that has been ordered ═══════════════════════ */
    section("1 · a purged product leaves its order lines readable");

    const { data: product, error: productError } = await admin
      .from("products")
      .insert({
        name: `QA purge ${stamp}`,
        slug: `qa-purge-${stamp}`,
        base_price: 249900,
        footwear_type: "sneaker",
        is_active: false,
      })
      .select("id")
      .single();
    if (productError || !product) {
      throw new Error(`could not make a product: ${productError?.message}`);
    }
    madeProducts.push(product.id);

    const { data: variant, error: variantError } = await admin
      .from("product_variants")
      .insert({
        product_id: product.id,
        size: "9",
        color: "Black",
        sku: `QA-PURGE-${stamp}`,
        stock_quantity: 5,
      })
      .select("id")
      .single();
    if (variantError || !variant) {
      throw new Error(`could not make a variant: ${variantError?.message}`);
    }

    const { data: image, error: imageError } = await admin
      .from("product_images")
      .insert({
        product_id: product.id,
        url: "/seed/placeholder.svg",
        sort_order: 0,
        is_primary: true,
      })
      .select("id")
      .single();
    if (imageError) throw new Error(`could not make an image: ${imageError.message}`);

    /* An order carrying that product, so the purge has history to preserve. */
    const { data: order, error: orderError } = await admin
      .from("orders")
      .insert({
        status: "delivered",
        payment_status: "paid",
        payment_method: "cod",
        subtotal: 249900,
        grand_total: 249900,
        // `advance + balance + coin_paid = grand_total` is a check constraint,
        // and this fixture is a fully prepaid order, so the whole total is the
        // advance. Left at the defaults the insert is refused.
        advance_amount: 249900,
        shipping_address: { recipientName: "QA", line1: "1 Test Road" },
        contact_email: `qa.purge.${stamp}@example.com`,
      })
      .select("id, order_number")
      .single();
    if (orderError || !order) {
      throw new Error(`could not make an order: ${orderError?.message}`);
    }
    madeOrders.push(order.id);

    const { error: lineError } = await admin.from("order_items").insert({
      order_id: order.id,
      product_id: product.id,
      variant_id: variant.id,
      product_name: `QA purge ${stamp}`,
      product_slug: `qa-purge-${stamp}`,
      size: "9",
      color: "Black",
      sku: `QA-PURGE-${stamp}`,
      unit_price: 249900,
      quantity: 1,
      line_total: 249900,
    });
    if (lineError) throw new Error(`could not make a line: ${lineError.message}`);

    const { data: purge, error: purgeError } = await asAdmin.rpc(
      "admin_purge_product",
      { p_product_id: product.id },
    );
    const purged = Array.isArray(purge) ? purge[0] : purge;

    check(
      "the purge runs for an admin",
      !purgeError && purged?.outcome === "purged",
      purgeError?.message ?? JSON.stringify(purged),
    );
    check(
      "it reports the order line it unlinked",
      purged?.order_lines === 1,
      `reported ${purged?.order_lines}`,
    );
    check(
      "it hands back the image URL so storage can be cleared",
      (purged?.image_urls ?? []).includes("/seed/placeholder.svg"),
      JSON.stringify(purged?.image_urls),
    );

    const goneProduct = await absent(
      "products after the purge",
      admin.from("products").select("id").eq("id", product.id).maybeSingle(),
    );
    check("the product row is gone", goneProduct);

    const goneVariant = await absent(
      "variants after the purge",
      admin
        .from("product_variants")
        .select("id")
        .eq("id", variant.id)
        .maybeSingle(),
    );
    check("its sizes cascaded", goneVariant);

    if (image) {
      const goneImage = await absent(
        "images after the purge",
        admin
          .from("product_images")
          .select("id")
          .eq("id", image.id)
          .maybeSingle(),
      );
      check("its photographs cascaded", goneImage);
    }

    /* The whole point: the invoice still reads correctly. */
    const { data: line, error: lineReadError } = await admin
      .from("order_items")
      .select("product_id, product_name, size, color, unit_price, line_total")
      .eq("order_id", order.id)
      .maybeSingle();
    if (lineReadError) {
      throw new Error(`could not read the order line: ${lineReadError.message}`);
    }
    check("the order line survives", line !== null);
    check(
      "its link to the product is nulled rather than the row deleted",
      line?.product_id === null,
      `product_id ${String(line?.product_id)}`,
    );
    check(
      "and every figure on it still reads as it did",
      line?.product_name === `QA purge ${stamp}` &&
        line?.size === "9" &&
        line?.unit_price === 249900 &&
        line?.line_total === 249900,
      JSON.stringify(line),
    );

    /* ═══ 2 · an order that must not be deletable ═══════════════════════════ */
    section("2 · a paid, delivered order refuses to be deleted");

    const { data: paidRefusal, error: paidError } = await asAdmin.rpc(
      "admin_delete_order",
      { p_order_id: order.id },
    );
    check(
      "the function refuses it, by name",
      !paidError && paidRefusal === "paid",
      paidError?.message ?? String(paidRefusal),
    );

    const { data: stillThere, error: stillError } = await admin
      .from("orders")
      .select("id")
      .eq("id", order.id)
      .maybeSingle();
    if (stillError) {
      throw new Error(`could not re-read the paid order: ${stillError.message}`);
    }
    check("and the order is still in the database", stillThere !== null);

    /* ═══ 3 · an unpaid order, and its stock ════════════════════════════════ */
    section("3 · deleting an unpaid order puts its stock back");

    const { data: product2, error: p2Error } = await admin
      .from("products")
      .insert({
        name: `QA order-delete ${stamp}`,
        slug: `qa-order-delete-${stamp}`,
        base_price: 100000,
        footwear_type: "sneaker",
        is_active: true,
      })
      .select("id")
      .single();
    if (p2Error || !product2) {
      throw new Error(`could not make the second product: ${p2Error?.message}`);
    }
    madeProducts.push(product2.id);

    const { data: variant2, error: v2Error } = await admin
      .from("product_variants")
      .insert({
        product_id: product2.id,
        size: "8",
        color: "White",
        sku: `QA-ORDDEL-${stamp}`,
        stock_quantity: 10,
      })
      .select("id")
      .single();
    if (v2Error || !variant2) {
      throw new Error(`could not make the second variant: ${v2Error?.message}`);
    }

    /*
      Placed through `create_order_with_stock`, not by inserting rows. That is
      the function that decrements, so it is the only way to arrive at the state
      this section is about — a live order genuinely holding stock. Hand-built
      rows would leave stock untouched and the restock assertion below would
      pass without ever having anything to restore.

      It takes a cart rather than a list of items, so the cart is built first.
      `pending`/`unpaid` is a Razorpay order that was never paid for, which is
      the commonest thing the owner will actually want to delete.
    */
    const { data: cart, error: cartError } = await admin
      .from("carts")
      .insert({ user_id: account.userId, status: "active" })
      .select("id")
      .single();
    if (cartError || !cart) {
      throw new Error(`could not make a cart: ${cartError?.message}`);
    }
    const { error: cartItemError } = await admin.from("cart_items").insert({
      cart_id: cart.id,
      variant_id: variant2.id,
      quantity: 3,
      unit_price_seen: 100000,
    });
    if (cartItemError) {
      throw new Error(`could not fill the cart: ${cartItemError.message}`);
    }

    const { data: placed, error: placeError } = await admin.rpc(
      "create_order_with_stock",
      {
        p_cart_id: cart.id,
        p_shipping_address: {
          recipientName: "QA",
          line1: "1 Test Road",
          city: "Proddatur",
          state: "Andhra Pradesh",
          postalCode: "516360",
          country: "IN",
          phone: "9999999999",
        },
        p_payment_method: "razorpay",
        p_initial_status: "pending",
        p_payment_status: "unpaid",
        p_shipping_flat_fee: 0,
        p_user_id: account.userId,
        p_contact_phone: "9999999999",
      },
    );
    if (placeError) {
      throw new Error(`could not place the order: ${placeError.message}`);
    }
    const placedNumber = placed?.[0]?.order_number;
    if (!placedNumber) {
      throw new Error(`no order came back: ${JSON.stringify(placed)}`);
    }
    const { data: placedRow, error: placedError } = await admin
      .from("orders")
      .select("id")
      .eq("order_number", placedNumber)
      .single();
    if (placedError || !placedRow) {
      throw new Error(`could not find the placed order: ${placedError?.message}`);
    }
    const placedId = placedRow.id;
    madeOrders.push(placedId);

    const { data: afterPlace, error: afterPlaceError } = await admin
      .from("product_variants")
      .select("stock_quantity")
      .eq("id", variant2.id)
      .single();
    if (afterPlaceError) {
      throw new Error(`could not read stock: ${afterPlaceError.message}`);
    }
    check(
      "placing the order took the pairs off the shelf",
      afterPlace?.stock_quantity === 7,
      `stock ${afterPlace?.stock_quantity}, expected 7`,
    );

    const { data: deleted, error: deleteError } = await asAdmin.rpc(
      "admin_delete_order",
      { p_order_id: placedId },
    );
    check(
      "the unpaid order deletes",
      !deleteError && deleted === "deleted",
      deleteError?.message ?? String(deleted),
    );

    const goneOrder = await absent(
      "orders after the delete",
      admin.from("orders").select("id").eq("id", placedId).maybeSingle(),
    );
    check("the order row is gone", goneOrder);
    if (goneOrder) madeOrders.pop();

    const { data: afterDelete, error: afterDeleteError } = await admin
      .from("product_variants")
      .select("stock_quantity")
      .eq("id", variant2.id)
      .single();
    if (afterDeleteError) {
      throw new Error(`could not re-read stock: ${afterDeleteError.message}`);
    }
    check(
      "and the three pairs are back on the shelf",
      afterDelete?.stock_quantity === 10,
      `stock ${afterDelete?.stock_quantity}, expected 10`,
    );

    /* ═══ 4 · the guard ════════════════════════════════════════════════════ */
    section("4 · neither function is reachable without being an admin");

    const asNobody = anonClient();
    const { error: anonPurge } = await asNobody.rpc("admin_purge_product", {
      p_product_id: product2.id,
    });
    check(
      "an anonymous caller cannot purge a product",
      anonPurge !== null,
      anonPurge ? anonPurge.message : "IT SUCCEEDED",
    );
    const { error: anonDelete } = await asNobody.rpc("admin_delete_order", {
      p_order_id: order.id,
    });
    check(
      "an anonymous caller cannot delete an order",
      anonDelete !== null,
      anonDelete ? anonDelete.message : "IT SUCCEEDED",
    );
  } finally {
    /*
      Reported rather than thrown. A teardown failure must not mask the verdict
      of the run — but it must not be silent either, or the next run inherits
      this one's rows and starts lying.
    */
    for (const id of madeOrders) {
      const { error: itemsError } = await admin
        .from("order_items")
        .delete()
        .eq("order_id", id);
      const { error: orderError } = await admin
        .from("orders")
        .delete()
        .eq("id", id);
      if (itemsError || orderError) {
        console.warn(
          `  left behind order ${id}: ${itemsError?.message ?? ""} ${orderError?.message ?? ""}`,
        );
      }
    }
    for (const id of madeProducts) {
      const { error: productError } = await admin
        .from("products")
        .delete()
        .eq("id", id);
      if (productError) {
        console.warn(`  left behind product ${id}: ${productError.message}`);
      }
    }
    await admin.auth.admin.deleteUser(account.userId);
  }

  console.log(
    `\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m`,
  );
  if (failed > 0) {
    console.log("\nFailures:");
    for (const failure of failures) console.log(`  · ${failure}`);
    process.exit(1);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
