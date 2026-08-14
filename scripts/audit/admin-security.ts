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
// process.env: importing it repoints this process at staging. It does not, on its
// own, refuse anything — the refusal is assertNotProduction, which the client
// factories in clients.ts now call for you. This file used to read .env.local itself and
// therefore built its accounts and admin promotions on the LIVE shop while
// the app under test pointed at staging — found in Batch 3, the exact
// near-miss clients.ts exists to stop. See the batch 3 report.
import { assertNotProduction } from "./clients";
import { createAccountWithEmail } from "./accounts";

import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../../src/lib/database.types";
import { maybeRow } from "../../src/lib/queries/run";
import {
  gate,
  refusedBy,
  removeWitness,
  unchangedBy,
  unreadableBy,
  type Witness,
} from "./refusal";

/**
 * Nothing below this line may run against the live shop.
 *
 * This harness builds its own Supabase client rather than taking one from the
 * factories in `./clients`, so the refusal those factories now carry does not
 * reach it. It used to `import "./clients"` for the side effect, which repoints
 * the process at staging but asserts nothing — under `AUDIT_TARGET=env-local`,
 * or on a checkout with no `SUPABASE_STAGE_*`, it would have written to
 * production and said nothing. `audit:fixtures-guard` now fails on any writing
 * harness that hand-rolls a client without this call.
 */
assertNotProduction("run this harness");


for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

/**
 * The tally, the three outcome states and the refusal classifier all live in
 * `./refusal` now. This file used to carry its own `check(label, boolean)`,
 * which is precisely how six of the assertions below came to be vacuous: a
 * boolean cannot say *why* a probe was refused, and half of these were being
 * satisfied by a control other than the one they name — or by nothing at all.
 */
const g = gate("audit:admin");
const { section, check } = { section: g.section.bind(g), check: g.check.bind(g) };

const admin = createClient<Database>(URL_, SERVICE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const madeUsers: string[] = [];

async function makeCustomer(): Promise<SupabaseClient<Database> | null> {
  const email = `fv-admin-probe.${Date.now().toString(36)}@example.com`;
  let account;
  try {
    account = await createAccountWithEmail(email);
  } catch {
    return null;
  }
  madeUsers.push(account.userId);
  return createClient<Database>(URL_, ANON, {
    auth: { persistSession: false },
    global: {
      headers: { Authorization: `Bearer ${account.session.access_token}` },
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
    /*
      `guard_profile_role` answers this with SQLSTATE 42501 and "Only an admin
      can change a profile role" — a *trigger* raising `insufficient_privilege`,
      not Postgres refusing a grant. The classifier reads the message rather
      than the code for exactly this reason: three unrelated controls answer
      42501 here, and a check that accepted any of them would keep passing if
      the trigger were dropped and the row simply stopped existing.
    */
    const probeId = madeUsers[madeUsers.length - 1]!;
    g.verdict(
      "a customer cannot promote themselves to admin",
      await unchangedBy({
        attempt: () =>
          customer.from("profiles").update({ role: "admin" }).eq("id", probeId),
        readBack: async () => {
          const { data, error } = await admin
            .from("profiles")
            .select("role")
            .eq("id", probeId)
            .maybeSingle();
          if (error) throw new Error(`probe profile read: ${error.message}`);
          return data?.role ?? null;
        },
        describe: (role) => String(role),
        expect: ["app-check"],
      }),
    );
  }

  /* ═══ 2 · admin-only data through PostgREST ══════════════════════════════ */
  section("2 · Reading admin-only tables directly");
  {
    /*
      This section is the reason `./refusal` exists.

      It used to assert `(data?.length ?? 0) === 0` against all eight tables and
      count that as "not readable by a customer". Five of the eight are empty in
      staging — `shipments`, `shipment_events`, `payment_events`, `coupons`, and
      `shipping_quotes` next door in `security-advance` — so five of those ticks
      were `0 === 0`. Disabling row level security on `coupons` outright left
      this section reporting 8 held, which is how the class was found.

      Two things changed. Each case now names **which layer** is supposed to
      refuse it, so a check satisfied by a grant cannot be read as evidence
      about a policy and vice versa; and each empty table carries a **witness** —
      a row planted with the service role for the duration of the read, so that
      RLS has something to hide. A table with neither rows nor a witness is
      reported UNPROVABLE and fails the run, because a tick that proves nothing
      is worse than no tick at all.
    */
    const stamp = Date.now().toString(36);

    /** An order to hang a witness shipment off. Any order will do; none is owned by the probe. */
    const anyOrder = await maybeRow<{ id: string }>(
      "probe.anyOrder",
      admin.from("orders").select("id").limit(1).maybeSingle(),
    );

    const witnessShipment: Witness = async (a) => {
      if (!anyOrder?.id) return null;
      const { data, error } = await a
        .from("shipments")
        .insert({ order_id: anyOrder.id, status: "created", awb_code: `WITNESS-${stamp}` })
        .select("id")
        .single();
      if (error || !data) return null;
      return async () => {
        await removeWitness("shipments", a.from("shipments").delete().eq("id", data.id));
      };
    };

    const witnessShipmentEvent: Witness = async (a) => {
      if (!anyOrder?.id) return null;
      const { data: ship, error: shipError } = await a
        .from("shipments")
        .insert({ order_id: anyOrder.id, status: "created", awb_code: `WITNESS-EV-${stamp}` })
        .select("id")
        .single();
      if (shipError || !ship) return null;
      const { data, error } = await a
        .from("shipment_events")
        .insert({
          shipment_id: ship.id,
          event_id: `witness-${stamp}`,
          event_type: "picked_up",
        })
        .select("id")
        .single();
      if (error || !data) {
        await removeWitness("shipments", a.from("shipments").delete().eq("id", ship.id));
        return null;
      }
      return async () => {
        await removeWitness(
          "shipment_events",
          a.from("shipment_events").delete().eq("id", data.id),
        );
        await removeWitness("shipments", a.from("shipments").delete().eq("id", ship.id));
      };
    };

    const witnessPaymentEvent: Witness = async (a) => {
      const { data, error } = await a
        .from("payment_events")
        .insert({
          event_id: `witness-${stamp}`,
          event_type: "payment.captured",
          provider: "razorpay",
        })
        .select("id")
        .single();
      if (error || !data) return null;
      return async () => {
        await removeWitness(
          "payment_events",
          a.from("payment_events").delete().eq("id", data.id),
        );
      };
    };

    const witnessCoupon: Witness = async (a) => {
      const { data, error } = await a
        .from("coupons")
        .insert({ code: `FV-WITNESS-${stamp}`.toUpperCase(), type: "percent", value: 5 })
        .select("id")
        .single();
      if (error || !data) return null;
      return async () => {
        await removeWitness("coupons", a.from("coupons").delete().eq("id", data.id));
      };
    };

    const cases: {
      table: keyof Database["public"]["Tables"];
      why: string;
      /** The control this check is actually about. Observed, not assumed — see the probe in the report. */
      expect: Parameters<typeof unreadableBy>[0]["expect"];
      witness?: Witness;
    }[] = [
      { table: "inventory_movements", why: "the stock ledger", expect: ["rls-read"] },
      { table: "shipments", why: "AWBs and courier detail", expect: ["rls-read"], witness: witnessShipment },
      { table: "shipment_events", why: "fulfilment history", expect: ["rls-read"], witness: witnessShipmentEvent },
      { table: "payments", why: "money", expect: ["rls-read"] },
      { table: "payment_events", why: "webhook ledger", expect: ["rls-read"], witness: witnessPaymentEvent },
      // These two are refused a whole layer earlier: `authenticated` holds no
      // SELECT grant at all, so PostgREST never reaches a policy. Saying so is
      // the point — if somebody adds a permissive grant intending RLS to carry
      // it, this check goes red rather than quietly changing what it means.
      { table: "rate_limits", why: "the limiter's own counters", expect: ["table-grant"] },
      { table: "integration_tokens", why: "a live Shiprocket bearer token", expect: ["table-grant"] },
      { table: "coupons", why: "unissued discount codes", expect: ["rls-read"], witness: witnessCoupon },
    ];

    for (const { table, why, expect, witness } of cases) {
      g.verdict(
        `${table} — ${why} — is not readable by a customer`,
        await unreadableBy({ admin, caller: customer, table, expect, witness }),
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

      /*
        `adjust_variant_stock` is executable by `authenticated` on purpose — the
        refusal is the `if not public.is_admin() then raise` at the top of its
        body, which answers FVADM/not_admin. Naming that layer is what stops the
        check being satisfied by a PGRST202: add a parameter to this function in
        a migration and the old call shape stops matching, PostgREST says "no
        such function", and `error !== null` would have called that a pass while
        the new arity sat un-ACLed. That is not hypothetical — it is what
        happened to `create_order_with_stock`.
      */
      g.verdict(
        "adjust_variant_stock refuses a non-admin",
        refusedBy(error, "app-check"),
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
      g.verdict(
        "admin_delete_product refuses a non-admin",
        refusedBy(error, "app-check"),
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
      // A different layer from the two above, and the distinction is the whole
      // claim: these three carry no EXECUTE grant, so the body never runs. If
      // one ever acquires a grant and starts refusing from inside instead, this
      // goes red — which is correct, because "cannot call it" and "can call it
      // but it says no" are different security postures.
      g.verdict(
        `${fn}() is not executable by a customer`,
        refusedBy(error, "function-grant"),
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
      /*
        Provable without a witness, and worth saying why: `someone` was fetched
        with the service role a moment ago, so the row demonstrably exists and is
        demonstrably not the probe's — the account was minted for this run. "No
        rows came back" therefore means RLS filtered it rather than that there
        was nothing to filter. That is the same precondition `unreadableBy`
        enforces by counting; here it is already satisfied by construction.
      */
      const { data: read, error: readError } = await customer
        .from("orders")
        .select("id")
        .eq("id", someone.id)
        .maybeSingle();
      g.verdict(
        "a customer cannot read an order that is not theirs",
        readError
          ? refusedBy(readError, "rls-read", "table-grant")
          : read === null
            ? { state: "held", detail: `RLS hid order ${someone.order_number}` }
            : { state: "hole", detail: `read back order ${someone.order_number}` },
      );

      g.verdict(
        "and cannot mark it delivered and paid",
        await unchangedBy({
          attempt: () =>
            customer
              .from("orders")
              .update({ status: "delivered", payment_status: "paid" })
              .eq("id", someone.id),
          readBack: async () => {
            const { data, error } = await admin
              .from("orders")
              .select("status, payment_status")
              .eq("id", someone.id)
              .maybeSingle();
            if (error) throw new Error(`order read-back: ${error.message}`);
            return data ?? null;
          },
          // Silence is the expected answer here: the RLS `USING` clause filters
          // the UPDATE to zero rows rather than raising. `unchangedBy` says so
          // in its detail instead of leaving "nothing happened" ambiguous.
          expect: ["rls-write", "app-check"],
        }),
      );

      const { error: historyError } = await customer
        .from("order_status_history")
        .insert({
          order_id: someone.id,
          status: "delivered",
          note: "escalation probe",
        });
      g.verdict(
        "and cannot forge a line on its timeline",
        refusedBy(historyError, "rls-write"),
      );

      const { error: shipError } = await customer.from("shipments").insert({
        order_id: someone.id,
        status: "created",
        awb_code: "FORGED",
      });
      g.verdict(
        "and cannot invent a shipment for it",
        refusedBy(shipError, "rls-write"),
      );
    }
  }

  /* ═══ 5 · the ledger's integrity ═════════════════════════════════════════ */
  section("5 · The stock ledger cannot be rewritten");
  {
    /*
      The state of the ledger *before* this section attacks it.

      `reconcile_inventory()` answers two different questions at once — its
      HAVING clause is `sum(delta) <> stock_quantity OR unspecified_rows > 0`,
      and the function's own comment names them apart: "a write bypassed the
      trigger … **or** a caller failed to declare its reason". Only the first is
      a security finding. The second is attribution hygiene, and on staging it
      is manufactured by this suite rather than by the shop.

      It has to be, structurally. Attribution reaches the trigger through four
      transaction-local GUCs — `app.inventory_reason` and friends, set with
      `set_config(..., true)` — and a PostgREST `.update({ stock_quantity })`
      has no way to set one, because every REST write is its own transaction. So
      every harness that moves stock directly to build a fixture leaves an
      `unspecified` row behind by construction: zero-stock.ts, coupons.ts,
      transitions.ts, checkout-orders.ts, security-checkout.ts and teardown.ts
      all do it, and the rows accumulate across runs. Counting them had this
      gate report 2 drifting variants one night and 4 the next, neither caused
      by anything it did — and three of those four had `drift: 0`, so the
      "drifting variants" it named were not drifting at all.

      So the assertion at the end of this block compares against this snapshot
      instead of against zero. That is what its label has always claimed:
      "after every attempt above" is a statement about a delta, not an absolute.
      It is strictly sharper than counting rows — an `unspecified` row created
      *by this gate* now fails it, where before it was lost in the pile.
    */
    const { data: ledgerBefore, error: beforeError } =
      await admin.rpc("reconcile_inventory");
    check(
      "the ledger's starting state is readable",
      !beforeError,
      beforeError ? beforeError.message : "snapshot taken",
    );
    const baseline = new Map(
      (ledgerBefore ?? []).map((row) => [
        row.variant_id,
        { drift: row.drift ?? 0, unspecified: row.unspecified_rows ?? 0 },
      ]),
    );

    const { error: insertError } = await customer
      .from("inventory_movements")
      .insert({
        variant_sku: "FORGED",
        delta: 999,
        balance_after: 999,
        reason: "restock",
      });
    // Refused by the *grant*, not by a policy — `authenticated` has no INSERT on
    // this table at all. Worth naming because the read three sections up is
    // refused by RLS: the same table is protected by two different layers
    // depending on the verb, and a check that could not tell them apart would
    // survive losing either one.
    g.verdict(
      "a customer cannot write a movement row",
      refusedBy(insertError, "table-grant"),
    );

    /*
      The reconciliation is the real assertion: nothing above moved the ledger.

      A variant fails if it *gained* drift or *gained* an unattributed row while
      these attempts were running — including one that was clean before and
      appears now. Anything already there when the section opened belongs to
      whichever harness ran earlier, and saying so is not this gate's job.
    */
    const { data: ledgerAfter, error } = await admin.rpc("reconcile_inventory");
    const worsened = (ledgerAfter ?? []).filter((row) => {
      const was = baseline.get(row.variant_id) ?? { drift: 0, unspecified: 0 };
      return (
        Math.abs(row.drift ?? 0) > Math.abs(was.drift) ||
        (row.unspecified_rows ?? 0) > was.unspecified
      );
    });
    check(
      "and after every attempt above, the ledger still reconciles",
      !error && worsened.length === 0,
      worsened.length === 0
        ? `nothing moved (${baseline.size} pre-existing finding(s) from earlier harnesses, untouched)`
        : worsened
            .map((row) => {
              const was = baseline.get(row.variant_id) ?? {
                drift: 0,
                unspecified: 0,
              };
              return `${row.sku}: drift ${was.drift}→${row.drift}, unattributed ${was.unspecified}→${row.unspecified_rows}`;
            })
            .join("; "),
    );
  }

  /* ------------------------------------------------------------- teardown -- */
  for (const id of madeUsers) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error)
      console.warn(`  could not remove probe user ${id}: ${error.message}`);
  }

  g.finish();
}

main().catch((error) => {
  console.error("\n\x1b[31maudit:admin threw\x1b[0m\n", error);
  process.exit(1);
});
