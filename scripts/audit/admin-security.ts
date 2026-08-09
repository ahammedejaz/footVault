/**
 * `npm run audit:admin` — the admin panel, attacked as a signed-in customer.
 *
 * The brief for Phase 6 named four attempts specifically, and this suite is
 * those four plus what they suggested:
 *
 *   1. call each admin server action as a plain customer
 *   2. escalate via a crafted payload
 *   3. read admin-only data through PostgREST directly
 *   4. mutate another customer's order
 *
 * **Everything here runs over the network against the real database**, with a
 * real customer session created for the purpose. Nothing is mocked, because the
 * question is whether the deployed policies hold, and a mock of the policies is
 * a test of the mock.
 *
 * The premise the whole suite is built on: **middleware returning 404 is not
 * authorization.** It protects navigation to /admin. A Server Action is a POST
 * to a route the matcher does not distinguish, addressed by an id that ships in
 * the browser bundle. So the checks below deliberately bypass the panel
 * entirely and go straight at PostgREST and the RPCs, which is where a real
 * attacker with a valid session would go.
 */

// clients first, before any other import and before anything reads
// process.env: importing it repoints this process at staging and refuses to
// run against production. This file used to read .env.local itself and
// therefore built its accounts and admin promotions on the LIVE shop while
// the app under test pointed at staging — found in Batch 3, the exact
// near-miss clients.ts exists to stop. See the batch 3 report.
import "./clients";

import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../../src/lib/database.types";
import { maybeRow } from "../../src/lib/queries/run";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PASSWORD = "correct-horse-battery-staple-42";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

function check(label: string, held: boolean, detail = "") {
  if (held) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(
      `  \x1b[31m✗ HOLE\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`,
    );
  }
}

const admin = createClient<Database>(URL_, SERVICE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const madeUsers: string[] = [];

async function makeCustomer(): Promise<SupabaseClient<Database> | null> {
  const email = `fv-admin-probe.${Date.now().toString(36)}@example.com`;
  const anon = createClient<Database>(URL_, ANON, {
    auth: { persistSession: false },
  });
  const { data, error } = await anon.auth.signUp({ email, password: PASSWORD });
  if (error || !data.session) return null;
  madeUsers.push(data.session.user.id);
  return createClient<Database>(URL_, ANON, {
    auth: { persistSession: false },
    global: {
      headers: { Authorization: `Bearer ${data.session.access_token}` },
    },
  });
}

async function main() {
  const customer = await makeCustomer();
  if (!customer) {
    console.error(
      "Could not create a customer session — the suite cannot run.",
    );
    process.exit(1);
  }

  /* ═══ 1 · is_admin() itself ══════════════════════════════════════════════ */
  section("1 · The predicate everything else rests on");
  {
    const { data, error: isAdminError } = await customer.rpc("is_admin");
    check(
      "a plain customer is not an admin",
      data !== true,
      `data=${JSON.stringify(data)} error=${isAdminError?.code ?? "none"}`,
    );

    /**
     * The escalation that would make everything else moot: writing your own
     * role. `guard_profile_role` is the trigger that refuses it.
     */
    const { error: escalateError } = await customer
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", madeUsers[madeUsers.length - 1]!);
    const { data: after, error: readBack } = await customer
      .from("profiles")
      .select("role")
      .eq("id", madeUsers[madeUsers.length - 1]!)
      .maybeSingle();
    if (readBack)
      throw new Error(
        `could not read the probe profile back: ${readBack.message}`,
      );
    check(
      "a customer cannot promote themselves to admin",
      after?.role !== "admin",
      `error=${escalateError?.code ?? "none"} role=${after?.role}`,
    );
  }

  /* ═══ 2 · admin-only data through PostgREST ══════════════════════════════ */
  section("2 · Reading admin-only tables directly");
  {
    const cases: { table: keyof Database["public"]["Tables"]; why: string }[] =
      [
        { table: "inventory_movements", why: "the stock ledger" },
        { table: "shipments", why: "AWBs and courier detail" },
        { table: "shipment_events", why: "fulfilment history" },
        { table: "payments", why: "money" },
        { table: "payment_events", why: "webhook ledger" },
        { table: "rate_limits", why: "the limiter's own counters" },
        { table: "integration_tokens", why: "a live Shiprocket bearer token" },
        { table: "coupons", why: "unissued discount codes" },
      ];

    for (const { table, why } of cases) {
      const { data, error } = await customer.from(table).select("*").limit(5);
      const leaked = (data?.length ?? 0) > 0;
      check(
        `${table} — ${why} — is not readable by a customer`,
        !leaked,
        leaked
          ? `${data!.length} rows leaked`
          : `error=${error?.code ?? "empty"}`,
      );
    }
  }

  /* ═══ 3 · the admin RPCs, called directly ════════════════════════════════ */
  section("3 · Admin RPCs, invoked by a customer with a valid session");
  {
    const variant = await maybeRow<{
      id: string;
      stock_quantity: number;
      sku: string;
    }>(
      "probe.variant",
      admin
        .from("product_variants")
        .select("id, stock_quantity, sku")
        .order("sku")
        .limit(1)
        .maybeSingle(),
    );
    const variantId = variant?.id;
    const before = variant?.stock_quantity ?? 0;

    if (!variantId) {
      console.log("  \x1b[33m•\x1b[0m skipped — no variants to attack");
    } else {
      const { error } = await customer.rpc("adjust_variant_stock", {
        p_variant_id: variantId,
        p_delta: 100,
        p_reason: "restock",
        p_note: "escalation probe",
      });

      const after = await maybeRow<{ stock_quantity: number }>(
        "probe.variantAfter",
        admin
          .from("product_variants")
          .select("stock_quantity")
          .eq("id", variantId)
          .maybeSingle(),
      );

      check(
        "adjust_variant_stock refuses a non-admin",
        error !== null,
        `error=${error?.code ?? "NONE — the call succeeded"}`,
      );
      check(
        "and the stock did not move",
        after?.stock_quantity === before,
        `${before} → ${after?.stock_quantity}`,
      );
    }

    const product = await maybeRow<{ id: string; deleted_at: string | null }>(
      "probe.product",
      admin
        .from("products")
        .select("id, deleted_at")
        .is("deleted_at", null)
        .limit(1)
        .maybeSingle(),
    );
    if (product?.id) {
      const { error } = await customer.rpc("admin_delete_product", {
        p_product_id: product.id,
      });
      const after = await maybeRow<{ deleted_at: string | null }>(
        "probe.productAfter",
        admin
          .from("products")
          .select("deleted_at")
          .eq("id", product.id)
          .maybeSingle(),
      );
      check(
        "admin_delete_product refuses a non-admin",
        error !== null,
        `error=${error?.code ?? "NONE"}`,
      );
      check("and the product is still live", after?.deleted_at === null);
    }

    // The limiter and the order machinery are service_role-only by grant, so a
    // customer should not be able to execute them at all.
    for (const fn of [
      "consume_rate_limit",
      "reconcile_inventory",
      "release_abandoned_orders",
    ] as const) {
      const { error } = await customer.rpc(
        fn,
        fn === "consume_rate_limit"
          ? { p_bucket: "probe", p_limit: 1, p_window_seconds: 60 }
          : ({} as never),
      );
      check(
        `${fn}() is not executable by a customer`,
        error !== null,
        `error=${error?.code ?? "NONE"}`,
      );
    }
  }

  /* ═══ 4 · another customer's order ═══════════════════════════════════════ */
  section("4 · Somebody else's order");
  {
    const someone = await maybeRow<{
      id: string;
      order_number: string;
      status: string;
    }>(
      "probe.someonesOrder",
      admin
        .from("orders")
        .select("id, order_number, status")
        .limit(1)
        .maybeSingle(),
    );

    if (!someone) {
      console.log("  \x1b[33m•\x1b[0m skipped — no orders to attack");
    } else {
      const { data: read, error: readError } = await customer
        .from("orders")
        .select("id")
        .eq("id", someone.id)
        .maybeSingle();
      check(
        "a customer cannot read an order that is not theirs",
        read === null,
        `error=${readError?.code ?? "none"}`,
      );

      const { error: writeError } = await customer
        .from("orders")
        .update({ status: "delivered", payment_status: "paid" })
        .eq("id", someone.id);
      const after = await maybeRow<{ status: string; payment_status: string }>(
        "probe.orderAfter",
        admin
          .from("orders")
          .select("status, payment_status")
          .eq("id", someone.id)
          .maybeSingle(),
      );
      check(
        "and cannot mark it delivered and paid",
        after?.status === someone.status,
        `error=${writeError?.code ?? "none"} status=${after?.status}`,
      );

      const { error: historyError } = await customer
        .from("order_status_history")
        .insert({
          order_id: someone.id,
          status: "delivered",
          note: "escalation probe",
        });
      check(
        "and cannot forge a line on its timeline",
        historyError !== null,
        `error=${historyError?.code ?? "NONE"}`,
      );

      const { error: shipError } = await customer.from("shipments").insert({
        order_id: someone.id,
        status: "created",
        awb_code: "FORGED",
      });
      check(
        "and cannot invent a shipment for it",
        shipError !== null,
        `error=${shipError?.code ?? "NONE"}`,
      );
    }
  }

  /* ═══ 5 · the ledger's integrity ═════════════════════════════════════════ */
  section("5 · The stock ledger cannot be rewritten");
  {
    const { error: insertError } = await customer
      .from("inventory_movements")
      .insert({
        variant_sku: "FORGED",
        delta: 999,
        balance_after: 999,
        reason: "restock",
      });
    check(
      "a customer cannot write a movement row",
      insertError !== null,
      `error=${insertError?.code ?? "NONE"}`,
    );

    // The reconciliation is the real assertion: after everything above, the
    // ledger and the stock still agree.
    const { data: drift, error } = await admin.rpc("reconcile_inventory");
    check(
      "and after every attempt above, the ledger still reconciles",
      !error && (drift?.length ?? 0) === 0,
      `${drift?.length ?? "?"} drifting variants`,
    );
  }

  /* ------------------------------------------------------------- teardown -- */
  for (const id of madeUsers) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error)
      console.warn(`  could not remove probe user ${id}: ${error.message}`);
  }

  console.log(`\n\x1b[1m${passed} held, ${failed} holes\x1b[0m`);
  if (failed > 0) {
    console.log("\nHoles:");
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("\n\x1b[31maudit:admin threw\x1b[0m\n", error);
  process.exit(1);
});
