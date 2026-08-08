/**
 * Sweep the live project of everything the audits created.
 *
 * The scripted checks each clean up their own orders, but three things they
 * cannot clean up accumulate: the throwaway accounts (deleting an auth user
 * needs the service role), the guest carts behind guest orders, and the
 * payment-event ledger rows, which deliberately carry no foreign key to
 * `orders` so that an event for an order nobody can resolve is still
 * recordable. `docs/rls-tests.md` §8 has been doing this by hand in SQL; this
 * is the same sweep, in one command, with the stock restored properly.
 *
 * **Order matters and is not obvious.** An order is deleted only after
 * `cancel_order_with_restock` has put its units back — deleting the row first
 * loses the stock silently, and `order_items` cascades away with it so there is
 * nothing left to reconstruct the count from. That function is idempotent, so a
 * second run over an already-cancelled order is a no-op rather than a
 * double-restock.
 *
 * It also **reconciles stock**, which is the part that matters most and the
 * part a row sweep alone silently gets wrong. Every order that has not been
 * cancelled is still holding its units, so a run of the audits leaves variants
 * sitting below their seed count — four of them were found short this way, held
 * by orders belonging to a different agent. The reconciliation is computed, not
 * assumed:
 *
 *     want = seed stock − units held by orders that have not restocked
 *
 * so it is correct whether or not a real order is outstanding, and restoring it
 * can never invent inventory that somebody has already bought.
 *
 *   npx tsx scripts/audit/teardown.ts --dry-run       # say what would go
 *   npx tsx scripts/audit/teardown.ts --prefix fv-qa. # one agent's rows only
 *   npx tsx scripts/audit/teardown.ts --stock-only    # reconcile, delete nothing
 *   npx tsx scripts/audit/teardown.ts                 # every known prefix
 *
 * `--dry-run` first, always. This talks to the live project.
 */
import { products } from "../seed-data";
import { variantsFor } from "../seed";
import { adminClient } from "./fixtures";

/**
 * Every prefix Phase 4 and Phase 5 minted accounts under.
 *
 * Kept as a list rather than a single `fv-%` wildcard on purpose: a wildcard
 * that broad would also match a real customer who happened to sign up as
 * `fv-something@example.com`, and this runs against production data with a
 * service-role key. Add a prefix when a harness invents one.
 */
const KNOWN_PREFIXES = [
  "fv-qa.", // this agent — routes/a11y/keyboard/hydration fixtures
  "fv-checkout.", // checkout-orders.ts
  "fv-merge", // cart-merge.ts, both accounts
  "fv-signedin.", // signed-in.ts
  "fv-agentd.", // the checkout UI pass
  "fv-sec.", // the adversarial pass
  "fv-adopt.", // checkout-orders.ts — guest-order adoption
  "fv-thief.", // checkout-orders.ts — the stranger who must not read an order
  "fv-test-", // Phase 4 leftovers named in docs/rls-tests.md §8
] as const;

const DOMAIN = "@example.com";

type Args = {
  dryRun: boolean;
  stockOnly: boolean;
  prefixes: string[];
  orders: string[];
};

function parseArgs(argv: string[]): Args {
  const prefixes: string[] = [];
  const orders: string[] = [];
  let dryRun = false;
  let stockOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--stock-only") stockOnly = true;
    else if (argv[i] === "--prefix") prefixes.push(argv[++i] ?? "");
    else if (argv[i] === "--orders")
      orders.push(...(argv[++i] ?? "").split(",").filter(Boolean));
  }
  return {
    dryRun,
    stockOnly,
    prefixes: prefixes.length > 0 ? prefixes : [...KNOWN_PREFIXES],
    orders,
  };
}

/**
 * What the seed says every SKU should hold.
 *
 * From `scripts/seed.ts` rather than from a remembered histogram: a
 * distribution says thirty-three variants should be at zero, which is no help
 * at all when the question is *which* variant is two short. Importing the seed
 * helpers is safe — that file guards its own `main()` precisely so they can be
 * reused.
 */
function seedStock(): Map<string, number> {
  const expected = new Map<string, number>();
  for (const product of products) {
    for (const variant of variantsFor(product))
      expected.set(variant.sku, variant.stock);
  }
  return expected;
}

/**
 * Reconcile every variant against the seed, minus what live orders still hold.
 *
 * An order holds its units until something restocks them, and
 * `orders.stock_restored_at` is the one marker for that — the same marker
 * `cancel_order_with_restock` sets. Subtracting what is genuinely outstanding
 * is what separates "restore the shelf" from "invent inventory somebody has
 * already bought".
 */
async function reconcileStock(dryRun: boolean): Promise<number> {
  const admin = adminClient();
  const expected = seedStock();

  const { data: held, error: heldError } = await admin
    .from("order_items")
    .select("sku, quantity, orders!inner(stock_restored_at)")
    .is("orders.stock_restored_at", null);
  if (heldError)
    throw new Error(`reading outstanding orders: ${heldError.message}`);

  const outstanding = new Map<string, number>();
  for (const item of held ?? []) {
    outstanding.set(item.sku, (outstanding.get(item.sku) ?? 0) + item.quantity);
  }

  const { data: live, error: liveError } = await admin
    .from("product_variants")
    .select("id, sku, stock_quantity");
  if (liveError) throw new Error(`reading stock: ${liveError.message}`);

  const drift: {
    sku: string;
    id: string;
    is: number;
    want: number;
    heldBy: number;
  }[] = [];
  let unknown = 0;
  for (const variant of live ?? []) {
    const seed = expected.get(variant.sku);
    if (seed === undefined) {
      unknown++;
      continue;
    }
    const claimed = outstanding.get(variant.sku) ?? 0;
    const want = Math.max(0, seed - claimed);
    if (variant.stock_quantity !== want) {
      drift.push({
        sku: variant.sku,
        id: variant.id,
        is: variant.stock_quantity,
        want,
        heldBy: claimed,
      });
    }
  }

  /*
   * Two different questions, and conflating them is how "four variants are
   * short" becomes an alarm about nothing — or hides a real one.
   *
   *   below seed  — the shelf holds fewer than the seed says. Expected while an
   *                 order is outstanding; that is what an order *is*.
   *   drift       — the shelf holds something no order accounts for. That is
   *                 the leak, and the only thing worth restoring.
   */
  const belowSeed = (live ?? []).filter((variant) => {
    const seed = expected.get(variant.sku);
    return seed !== undefined && variant.stock_quantity < seed;
  });

  console.log(
    `\n  Stock: ${live?.length ?? 0} variants, ${expected.size} defined by the seed` +
      `${unknown > 0 ? `, ${unknown} not in the seed (left alone)` : ""}.`,
  );
  console.log(`  ${belowSeed.length} variant(s) below the seed count:`);
  for (const variant of belowSeed) {
    const seed = expected.get(variant.sku) ?? 0;
    const claimed = outstanding.get(variant.sku) ?? 0;
    console.log(
      `    ${variant.sku.padEnd(34)} ${variant.stock_quantity} of ${seed}` +
        `  — ${claimed > 0 ? `${claimed} held by a live order` : "UNACCOUNTED FOR"}`,
    );
  }
  if (drift.length === 0) {
    console.log(
      "  Every variant matches the seed, less what outstanding orders hold.",
    );
    return 0;
  }
  console.log(`  ${drift.length} variant(s) off the seed baseline:`);
  for (const row of drift) {
    console.log(
      `    ${row.sku.padEnd(34)} is ${String(row.is).padStart(3)}  want ${String(row.want).padStart(3)}` +
        `${row.heldBy > 0 ? `  (${row.heldBy} held by a live order)` : ""}`,
    );
  }
  if (dryRun) return drift.length;

  let fixed = 0;
  for (const row of drift) {
    const { error } = await admin
      .from("product_variants")
      .update({ stock_quantity: row.want })
      .eq("id", row.id);
    if (error)
      console.error(`    could not restore ${row.sku}: ${error.message}`);
    else fixed++;
  }
  console.log(`  Restored ${fixed} of ${drift.length}.`);
  return drift.length - fixed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const admin = adminClient();
  const mode = args.dryRun
    ? "DRY RUN — nothing will be deleted"
    : "LIVE — rows will be deleted";

  console.log(`\nAudit teardown · ${mode}`);
  console.log(`  prefixes: ${args.prefixes.join(", ")}`);
  if (args.orders.length > 0)
    console.log(`  extra orders: ${args.orders.join(", ")}`);

  /* ── 1 · the accounts ───────────────────────────────────────────────────── */
  // listUsers rather than a query: auth.users is not exposed through PostgREST,
  // and it should not be.
  const users: { id: string; email: string }[] = [];
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) throw new Error(`listing users: ${error.message}`);
    for (const user of data.users) {
      const email = user.email ?? "";
      if (
        args.prefixes.some((prefix) => email.startsWith(prefix)) &&
        email.endsWith(DOMAIN)
      ) {
        users.push({ id: user.id, email });
      }
    }
    if (data.users.length < 200) break;
  }
  console.log(`\n  ${users.length} test account(s):`);
  for (const user of users) console.log(`    ${user.email}`);

  /* ── 2 · their orders, plus any guest order with a test contact address ─── */
  const ids = users.map((user) => user.id);
  const found = new Map<string, { id: string; number: string; who: string }>();

  if (ids.length > 0) {
    const { data, error } = await admin
      .from("orders")
      .select("id, order_number, contact_email")
      .in("user_id", ids);
    if (error) throw new Error(`reading account orders: ${error.message}`);
    for (const row of data ?? []) {
      found.set(row.id, {
        id: row.id,
        number: row.order_number,
        who: row.contact_email ?? "account",
      });
    }
  }
  for (const prefix of args.prefixes) {
    const { data, error } = await admin
      .from("orders")
      .select("id, order_number, contact_email")
      .like("contact_email", `${prefix}%${DOMAIN}`);
    if (error)
      throw new Error(`reading guest orders for ${prefix}: ${error.message}`);
    for (const row of data ?? []) {
      found.set(row.id, {
        id: row.id,
        number: row.order_number,
        who: row.contact_email ?? "guest",
      });
    }
  }
  if (args.orders.length > 0) {
    const { data, error } = await admin
      .from("orders")
      .select("id, order_number, contact_email")
      .in("order_number", args.orders);
    if (error) throw new Error(`reading named orders: ${error.message}`);
    for (const row of data ?? []) {
      found.set(row.id, {
        id: row.id,
        number: row.order_number,
        who: row.contact_email ?? "named",
      });
    }
  }

  const orders = [...found.values()].sort((a, b) =>
    a.number.localeCompare(b.number),
  );
  console.log(`\n  ${orders.length} order(s):`);
  for (const order of orders) console.log(`    ${order.number}  ${order.who}`);

  if (args.stockOnly) {
    await reconcileStock(args.dryRun);
    console.log("");
    return;
  }
  if (args.dryRun) {
    await reconcileStock(true);
    console.log("\n  Dry run. Re-run without --dry-run to delete.\n");
    return;
  }

  /* ── 3 · cancel, then delete ────────────────────────────────────────────── */
  let restocked = 0;
  let deleted = 0;
  for (const order of orders) {
    const { error: cancelError } = await admin.rpc(
      "cancel_order_with_restock",
      {
        p_order_id: order.id,
        p_reason: "audit teardown",
        p_release_cart: false,
      },
    );
    if (cancelError)
      console.error(
        `    could not cancel ${order.number}: ${cancelError.message}`,
      );
    else restocked++;

    const { error: eventError } = await admin
      .from("payment_events")
      .delete()
      .eq("order_id", order.id);
    if (eventError)
      console.error(
        `    payment_events for ${order.number}: ${eventError.message}`,
      );

    const { error: deleteError } = await admin
      .from("orders")
      .delete()
      .eq("id", order.id);
    if (deleteError)
      console.error(
        `    could not delete ${order.number}: ${deleteError.message}`,
      );
    else deleted++;
  }

  /* ── 4 · the carts, then the accounts ───────────────────────────────────── */
  let carts = 0;
  if (ids.length > 0) {
    const { data, error } = await admin
      .from("carts")
      .delete()
      .in("user_id", ids)
      .select("id");
    if (error) console.error(`    deleting account carts: ${error.message}`);
    else carts = data?.length ?? 0;
  }

  let removedUsers = 0;
  for (const user of users) {
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error)
      console.error(`    could not delete ${user.email}: ${error.message}`);
    else removedUsers++;
  }

  console.log(
    `\n  Restocked ${restocked}, deleted ${deleted} order(s), ${carts} cart(s), ${removedUsers} account(s).`,
  );

  // Last, and only last: the cancellations above have to have happened before
  // "what is still held" means anything.
  const stillOff = await reconcileStock(false);
  if (stillOff > 0) process.exitCode = 1;
  console.log(
    "  Guest carts behind guest orders are left alone — they are indistinguishable from a\n" +
      "  real visitor's bag, and the orders that referenced them are gone.\n",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
