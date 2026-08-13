/**
 * `npm run audit:security-advance` — attacking the money split.
 *
 * The brief names these attempts specifically, because the Pay-on-Delivery
 * model adds two numbers that decide how much a customer pays online and how
 * much a courier collects at the door. If either can be moved from a browser,
 * the shop ships goods for a rupee.
 *
 * Every attempt below is made as a **real signed-in customer over the real
 * PostgREST endpoint**, with their own JWT — not as an anonymous caller, and
 * not through the application's own code. That is the threat: somebody who
 * legitimately has an account, has read the JavaScript bundle, and is now
 * talking to the database directly.
 *
 * **Known gap, stated rather than hidden:** this suite reaches the data layer,
 * not Next's Server Action endpoints. An action's authorization is re-checked
 * inside `adminAction`, which `audit:admin-security` covers by calling the RPCs
 * those actions depend on — but neither suite drives an action over HTTP with a
 * forged payload. That remains the most valuable test still missing, and it is
 * carried in the report rather than quietly omitted.
 */

import { adminClient, anonClient, createAccount } from "./fixtures";
import {
  gate,
  refusedBy,
  removeWitness,
  unchangedBy,
  unreadableBy,
} from "./refusal";

/**
 * The tally and the refusal classifier are shared — see `./refusal`.
 *
 * §3 below was already doing the right thing the hard way: it derives
 * `create_order_with_stock`'s privileges from the catalog rather than reading
 * "some error came back" as a refusal, because reading it that way is what let
 * a `PGRST202` masquerade as authorization for two days. That lesson is now a
 * module instead of a comment in one section of one file, and the rest of this
 * suite is converted to it below.
 */
const g = gate("audit:security-advance");
const { section, check } = { section: g.section.bind(g), check: g.check.bind(g) };

async function main() {
  const admin = adminClient();
  const attacker = await createAccount("advance-attacker");
  const victim = await createAccount("advance-victim");

  const attackerClient = anonClient();
  await attackerClient.auth.setSession({
    access_token: attacker.session.access_token,
    refresh_token: attacker.session.refresh_token,
  });

  /** A real order belonging to the victim, written with the service role. */
  const { data: variant, error: variantError } = await admin
    .from("product_variants")
    .select("id, price_override, product_id")
    .gt("stock_quantity", 0)
    .limit(1)
    .maybeSingle();
  if (variantError || !variant) {
    throw new Error(`no variant to build a fixture from: ${variantError?.message}`);
  }

  const { data: victimOrder, error: orderError } = await admin
    .from("orders")
    .insert({
      user_id: victim.userId,
      status: "pending",
      payment_status: "unpaid",
      payment_method: "cod",
      subtotal: 500_000,
      shipping_fee: 34_900,
      cod_handling_fee: 15_000,
      grand_total: 534_900,
      advance_amount: 34_900,
      balance_due_on_delivery: 500_000,
      shipping_address: {
        recipientName: "Victim",
        phone: "9000000001",
        line1: "1 Test Street",
        line2: null,
        city: "Panaji",
        state: "Goa",
        postalCode: "403001",
        country: "IN",
      },
    })
    .select("id, order_number, advance_amount, balance_due_on_delivery")
    .single();
  if (orderError || !victimOrder) {
    throw new Error(`could not build the victim order: ${orderError?.message}`);
  }

  try {
    /* ═══ 1 · moving the split on somebody else's order ════════════════════ */
    section("1 · Another customer's advance and balance");

    /*
      Captured once, before the first attempt, and compared against for all six.

      Re-reading a "before" inside the loop is what the original constant
      comparison (`after?.advance_amount === 34_900`) was implicitly avoiding:
      if one write lands, the compromised row becomes the next iteration's
      baseline and the remaining checks go green off the damage. Proved by
      opening RLS on `orders` — three of six stayed green until this was fixed.
    */
    const { data: moneyBaseline, error: moneyBaselineError } = await admin
      .from("orders")
      .select(
        "advance_amount, balance_due_on_delivery, grand_total, payment_status, cash_collected_at",
      )
      .eq("id", victimOrder.id)
      .maybeSingle();
    if (moneyBaselineError)
      throw new Error(`money baseline: ${moneyBaselineError.message}`);

    for (const [label, patch] of [
      ["advance_amount", { advance_amount: 100 }],
      ["balance_due_on_delivery", { balance_due_on_delivery: 0 }],
      ["both at once", { advance_amount: 100, balance_due_on_delivery: 534_800 }],
      ["grand_total", { grand_total: 100 }],
      ["cash_collected_at", { cash_collected_at: new Date().toISOString() }],
      ["payment_status", { payment_status: "paid" as const }],
    ] as const) {
      /*
        Provable by construction: `victimOrder` was inserted by this harness a
        few lines above, so "nothing changed" cannot be true merely because
        there was nothing to change — which is the failure mode `unchangedBy`
        exists to catch on tables that might be empty. What it adds here is the
        *layer*: RLS filters this UPDATE to zero rows rather than raising, and
        the detail now says so instead of leaving silence ambiguous.
      */
      g.verdict(
        `a customer cannot rewrite ${label} on an order that is not theirs`,
        await unchangedBy({
          attempt: () =>
            attackerClient.from("orders").update(patch).eq("id", victimOrder.id),
          readBack: async () => {
            const { data, error } = await admin
              .from("orders")
              .select(
                "advance_amount, balance_due_on_delivery, grand_total, payment_status, cash_collected_at",
              )
              .eq("id", victimOrder.id)
              .maybeSingle();
            if (error) throw new Error(`order read-back: ${error.message}`);
            return data ?? null;
          },
          baseline: moneyBaseline ?? undefined,
          expect: ["rls-write", "app-check"],
        }),
      );
    }

    /* ═══ 2 · the same, on an order they do own ════════════════════════════ */
    section("2 · Their own order");

    const victimClient = anonClient();
    await victimClient.auth.setSession({
      access_token: victim.session.access_token,
      refresh_token: victim.session.refresh_token,
    });

    g.verdict(
      "owning an order does not permit rewriting what you owe on it",
      await unchangedBy({
        attempt: () =>
          victimClient
            .from("orders")
            .update({ advance_amount: 100, balance_due_on_delivery: 534_800 })
            .eq("id", victimOrder.id),
        readBack: async () => {
          const { data, error } = await admin
            .from("orders")
            .select("advance_amount, balance_due_on_delivery")
            .eq("id", victimOrder.id)
            .maybeSingle();
          if (error) throw new Error(`own-order read-back: ${error.message}`);
          return data ?? null;
        },
        expect: ["rls-write", "app-check"],
      }),
    );

    /* ═══ 3 · the function that decides the split ══════════════════════════ */
    section("3 · create_order_with_stock, called directly");

    /*
      This check used to POST a fixed 25-argument shape as the attacker and read
      any error as "refused". It could not tell a permission refusal from a
      *signature mismatch*: when 20260811140000 added p_coin_spend, PostgREST
      answered the old shape with PGRST202 ("no function matches") and the gate
      counted that non-null error as a pass — while the new 26-argument function
      sat executable by anon, because a new arity is a new function that inherits
      no ACL. The door reopened and the gate stayed green for two days.

      So the signature is now *derived from the catalog* rather than named:
      function_execute_audit() returns every public create_order_with_stock that
      exists and whether anon or authenticated can execute it. Two properties are
      asserted — that there is exactly one (a second is the overload landmine of
      20260809130000 / 20260811160000, which lets PostgREST pick either), and
      that neither client role can execute the one that exists. An arity change
      produces a new catalog row that this check reads, so it cannot walk past.
    */
    const { data: coStock, error: coStockError } = await admin.rpc(
      "function_execute_audit",
      { p_proname: "create_order_with_stock" },
    );
    if (coStockError)
      throw new Error(
        `could not read create_order_with_stock privileges: ${coStockError.message}`,
      );
    check(
      "exactly one create_order_with_stock exists (no ambiguous overload)",
      (coStock?.length ?? 0) === 1,
      `signatures=${coStock?.length ?? 0}`,
    );
    const coStockOpen = (coStock ?? []).filter(
      (r) => r.anon_execute || r.authenticated_execute,
    );
    check(
      "no client role can execute create_order_with_stock (derived from catalog)",
      coStockOpen.length === 0,
      coStockOpen
        .map(
          (r) =>
            `${r.signature} anon=${r.anon_execute} auth=${r.authenticated_execute}`,
        )
        .join("; ") || "none open",
    );

    /* ═══ 4 · the quote the order is priced from ═══════════════════════════ */
    section("4 · shipping_quotes, where the fee is stored");

    /*
      `error !== null || rows === 0` was the whole assertion here, and
      `shipping_quotes` is empty in staging — so the second half was `0 === 0`
      and the first half would have accepted any error at all. In fact this
      table is refused a layer earlier than the label implies: `authenticated`
      holds no SELECT grant, so PostgREST never consults a policy. Naming
      `table-grant` means that if somebody grants SELECT intending RLS to carry
      it, this goes red rather than silently changing what it proves.
    */
    g.verdict(
      "a customer cannot read anybody's stored quote",
      await unreadableBy({
        admin,
        caller: attackerClient,
        table: "shipping_quotes",
        expect: ["table-grant"],
        /*
          The table is empty, and the grant refuses before the row count can
          matter — so this witness never gets planted today. It is here for the
          day the grant is added: without it the check degrades to UNPROVABLE
          ("empty table, proves nothing"), which is honest but unhelpful. With
          it, the same change reports the useful thing instead — that the
          refusal moved to RLS and the layer this check names is gone.
        */
        witness: async (a) => {
          const { data: cart, error: cartError } = await a
            .from("carts")
            .select("id")
            .limit(1)
            .maybeSingle();
          if (cartError || !cart?.id) return null;
          const { data, error } = await a
            .from("shipping_quotes")
            .insert({
              cart_id: cart.id,
              postal_code: "403001",
              payment_method: "cod",
              subtotal_paise: 500_000,
              // `shipping_quotes_fee_split` requires shipping + cod == fee.
              fee_paise: 49_900,
              shipping_fee_paise: 34_900,
              cod_handling_paise: 15_000,
              deliverable: true,
              cod_available: true,
              source: "shiprocket",
            })
            .select("id")
            .single();
          if (error || !data) return null;
          return async () => {
            await removeWitness(
              "shipping_quotes",
              a.from("shipping_quotes").delete().eq("id", data.id),
            );
          };
        },
      }),
    );

    const { error: quoteWriteError } = await attackerClient
      .from("shipping_quotes")
      .insert({
        cart_id: victimOrder.id,
        postal_code: "403001",
        payment_method: "cod",
        subtotal_paise: 500_000,
        fee_paise: 0,
        shipping_fee_paise: 0,
        cod_handling_paise: 0,
        deliverable: true,
        cod_available: true,
        source: "shiprocket",
      });
    g.verdict(
      "nor write themselves a free-delivery quote",
      refusedBy(quoteWriteError, "table-grant"),
    );

    /* ═══ 5 · the settings the advance rule comes from ═════════════════════ */
    section("5 · The rule itself");

    /*
      **The row is unchanged**, asserted against what it actually holds rather
      than against a key that used to be in it.

      This check read back `cod_advance_minimum_paise === 9_900`. Phase 7
      replaced the advance rule entirely and deleted that key from
      `site_settings` on purpose — so against production's older row the check
      passed by reading a fossil, and against a rebuilt database it failed while
      the security property it names was perfectly intact.

      `admin-pages.ts` already learned this lesson and wrote it down: "A sentinel
      tests the property itself and cannot go stale with the schema." Same fix
      here. The property is that an attacker's write does not land, so the
      before-and-after of the whole row is the only thing worth comparing —
      which is exactly what `unchangedBy` does, so the hand-rolled "before" read
      that used to sit here is now its `readBack`.
    */
    g.verdict(
      "a customer cannot rewrite the settings the advance rule comes from",
      await unchangedBy({
        attempt: () =>
          attackerClient
            .from("site_settings")
            .update({ value: { cod_advance_minimum_paise: 100 } })
            .eq("key", "shipping"),
        readBack: async () => {
          const { data, error } = await admin
            .from("site_settings")
            .select("value")
            .eq("key", "shipping")
            .maybeSingle();
          if (error) throw new Error(`shipping settings read-back: ${error.message}`);
          return data?.value ?? null;
        },
        expect: ["rls-write", "app-check"],
      }),
    );

    /* ═══ 6 · the shipment, and what the courier is told to collect ════════ */
    section("6 · The COD collectable");

    const { error: shipmentError } = await attackerClient
      .from("shipments")
      .insert({
        order_id: victimOrder.id,
        status: "created",
        cod_collectable_amount: 0,
      });
    g.verdict(
      "a customer cannot invent a shipment collecting nothing",
      refusedBy(shipmentError, "rls-write"),
    );

    /* ═══ 7 · the ledger that would show the tampering ═════════════════════ */
    section("7 · The audit trail");

    const { error: historyError } = await attackerClient
      .from("order_status_history")
      .insert({
        order_id: victimOrder.id,
        status: "delivered",
        note: "forged",
      });
    g.verdict(
      "a customer cannot forge a line on somebody's timeline",
      refusedBy(historyError, "rls-write"),
    );
  } finally {
    const { error: cleanupError } = await admin
      .from("orders")
      .delete()
      .eq("id", victimOrder.id);
    if (cleanupError) {
      console.error(
        `  !! left a fixture order behind (${victimOrder.order_number}): ${cleanupError.message}`,
      );
    }
    await admin.auth.admin.deleteUser(attacker.userId).catch(() => {});
    await admin.auth.admin.deleteUser(victim.userId).catch(() => {});
  }

  g.finish();
}

void main();
