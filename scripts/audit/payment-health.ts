/**
 * `npm run audit:payment-health` — the two assertions that make "silently
 * wrong" detectable, asserted themselves.
 *
 * Stage 1 ran `GET /v1/webhooks` against the live keys and got
 * `{"count":0,"items":[]}`. No live webhook had ever existed. Every
 * Razorpay-paid order was being confirmed by the customer's browser calling
 * back, and the shop had no way to know — the orders confirmed, the money
 * arrived, and the one class of customer it failed (anyone who closed the tab
 * after paying) simply had their order swept and cancelled thirty minutes
 * later.
 *
 * Two checks now sit on the admin dashboard to make that visible. This suite
 * proves they are not decorative, and section 3 is the one that matters:
 *
 *   **`payment_events` holds two different things.** The webhook route writes
 *   `payment.captured`; `verifyRazorpayPayment` writes `client.callback` from
 *   the browser, one for every paid order. Count the callbacks and a webhook
 *   chain that has never fired reads back as perfectly healthy — the browser is
 *   still reporting in. `event_type <> 'client.callback'` is the entire reason
 *   this check works, and a filter is exactly the sort of thing that gets
 *   dropped in a refactor by somebody who reads it as an optimisation.
 *
 * Sections 1–3 are pure and need nothing. Section 4 reads the real database and
 * writes nothing to it — this is a live shop, and a fixture row in
 * `payment_events` would be indistinguishable from a real delivery forever.
 */

import { readFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "../../src/lib/database.types";
import { maybeRow, pagedRows } from "../../src/lib/queries/run";
import {
  CLIENT_CALLBACK_EVENT_TYPE,
  checkKeyMode,
  deploymentEnv,
  judgeWebhookLiveness,
  razorpayMode,
  relativeAge,
  WEBHOOK_GRACE_MS,
} from "../../src/lib/payments/health";

// The same loader the other audit suites use: no dotenv dependency, and a
// variable already in the environment always wins so CI can override any of it.
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

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

/** Fixed, so "two hours ago" means the same thing on every run. */
const NOW = new Date("2026-08-09T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/* ------------------------------------------------- 1 · the key mode check -- */

section("1 · RAZORPAY_KEY_ID's prefix against the deployment");

{
  const LIVE = "rzp_live_R9xxxxxxxxxxxx";
  const TEST = "rzp_test_R9xxxxxxxxxxxx";

  const live_production = checkKeyMode(LIVE, "production");
  check(
    "a live key on production is the only correct production state",
    live_production.ok && live_production.mode === "live",
    JSON.stringify(live_production),
  );

  /**
   * The one this whole check exists for. Test keys on production take no money
   * and confirm the order anyway: the customer sees "paid", the shop ships, and
   * nothing ever throws. It is the inverse of the bug Phase 8 opened on and it
   * fails in the shop's favour exactly never.
   */
  const test_production = checkKeyMode(TEST, "production");
  check(
    "a TEST key on production fails, and says so",
    !test_production.ok &&
      test_production.expected === "live" &&
      /TEST key/.test(test_production.message),
    JSON.stringify(test_production),
  );

  const test_development = checkKeyMode(TEST, "development");
  check(
    "a test key in development is correct",
    test_development.ok && test_development.mode === "test",
    JSON.stringify(test_development),
  );

  /**
   * And the direction that costs a real person real money: a developer with
   * live keys in `.env.local` who runs the checkout to see if it works has
   * charged their own card.
   */
  const live_development = checkKeyMode(LIVE, "development");
  check(
    "a LIVE key in development fails, and says so",
    !live_development.ok &&
      live_development.expected === "test" &&
      /LIVE key/.test(live_development.message),
    JSON.stringify(live_development),
  );

  const test_preview = checkKeyMode(TEST, "preview");
  const live_preview = checkKeyMode(LIVE, "preview");
  check(
    "preview wants a test key and rejects a live one",
    test_preview.ok && !live_preview.ok && live_preview.expected === "test",
    JSON.stringify({ test_preview, live_preview }),
  );

  const missing = checkKeyMode(null, "production");
  check(
    "no key at all is a failure, not a pass",
    !missing.ok &&
      missing.mode === "unknown" &&
      /not set/.test(missing.message),
    JSON.stringify(missing),
  );

  const nonsense = checkKeyMode("sk_live_something_else", "production");
  check(
    "a key that is neither rzp_live_ nor rzp_test_ is `unknown`, never assumed correct",
    !nonsense.ok && nonsense.mode === "unknown",
    JSON.stringify(nonsense),
  );

  check(
    "razorpayMode reads the prefix and nothing else",
    razorpayMode("rzp_live_x") === "live" &&
      razorpayMode("rzp_test_x") === "test" &&
      razorpayMode("") === "unknown" &&
      razorpayMode(null) === "unknown",
  );
}

/* ------------------------------------------------ 2 · which deployment it is -- */

section("2 · the environment comes from VERCEL_ENV, never NODE_ENV");

{
  const original = process.env.VERCEL_ENV;

  /**
   * `next build` sets `NODE_ENV=production` for preview builds too, so a check
   * written against `NODE_ENV` passes on preview whichever key is loaded —
   * which is precisely the hole this was meant to close. Asserted here because
   * "we used the other variable" is the kind of thing a later refactor
   * simplifies away.
   */
  // `NODE_ENV` is typed read-only by Next's ambient types. The cast is the
  // point of the test: this suite has to be able to set the misleading variable
  // in order to prove `deploymentEnv()` does not read it.
  (process.env as Record<string, string | undefined>).NODE_ENV = "production";

  process.env.VERCEL_ENV = "production";
  check(
    "VERCEL_ENV=production is production",
    deploymentEnv() === "production",
  );

  process.env.VERCEL_ENV = "preview";
  check(
    "VERCEL_ENV=preview is preview, even with NODE_ENV=production",
    deploymentEnv() === "preview",
    `NODE_ENV=${process.env.NODE_ENV}`,
  );

  delete process.env.VERCEL_ENV;
  check(
    "no VERCEL_ENV at all is local development, even with NODE_ENV=production",
    deploymentEnv() === "development",
    `NODE_ENV=${process.env.NODE_ENV}`,
  );

  process.env.VERCEL_ENV = "something-new";
  check(
    "an unrecognised VERCEL_ENV falls back to development, the safe answer",
    deploymentEnv() === "development",
  );

  if (original === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = original;
}

/* --------------------------------------------- 3 · the liveness verdict -- */

section("3 · the liveness verdict, all four states");

{
  const idle = judgeWebhookLiveness({
    lastServerEventAt: null,
    lastPaidOrderAt: null,
    now: NOW,
  });
  check(
    "no paid orders and no events is `idle` — a new shop is not a broken one",
    idle.state === "idle",
    idle.state,
  );

  const healthy = judgeWebhookLiveness({
    lastServerEventAt: ago(4 * MINUTE),
    lastPaidOrderAt: ago(5 * MINUTE),
    now: NOW,
  });
  check(
    "a webhook after the last paid order is `ok`",
    healthy.state === "ok" &&
      relativeAge(healthy.lastEventAt, NOW) === "4 minutes ago",
    JSON.stringify(healthy),
  );

  const never = judgeWebhookLiveness({
    lastServerEventAt: null,
    lastPaidOrderAt: ago(2 * HOUR),
    now: NOW,
  });
  check(
    "money arrived and no server-to-server event ever is `never`",
    never.state === "never" && never.lastPaidOrderAt === ago(2 * HOUR),
    JSON.stringify(never),
  );

  const behind = judgeWebhookLiveness({
    lastServerEventAt: ago(3 * HOUR),
    lastPaidOrderAt: ago(2 * HOUR),
    now: NOW,
  });
  check(
    "a paid order newer than the newest webhook is `behind`",
    behind.state === "behind" && behind.lastPaidOrderAt === ago(2 * HOUR),
    JSON.stringify(behind),
  );

  /**
   * The hazard the plan named: *"the liveness indicator crying wolf on a quiet
   * shop with no orders at all"*. Three days of silence with a webhook that
   * arrived right after the last order is a healthy shop that sold nothing, and
   * a wall-clock rule would paint it red every quiet week until the owner
   * stopped reading it.
   */
  const quiet = judgeWebhookLiveness({
    lastServerEventAt: ago(3 * DAY - MINUTE),
    lastPaidOrderAt: ago(3 * DAY),
    now: NOW,
  });
  check(
    "three days with no trade at all is `ok`, not red",
    quiet.state === "ok",
    JSON.stringify(quiet),
  );

  /**
   * The other direction: the browser callback confirms the order before
   * Razorpay's webhook lands, so without a grace window the dashboard would
   * flash red for those seconds on every single payment — to an owner who is
   * watching precisely because a payment just came in.
   */
  const inFlight = judgeWebhookLiveness({
    lastServerEventAt: ago(2 * HOUR),
    lastPaidOrderAt: ago(30_000),
    now: NOW,
  });
  check(
    "a payment taken seconds ago is not yet `behind` — the webhook is in flight",
    inFlight.state === "ok",
    JSON.stringify(inFlight),
  );
  const pastGrace = judgeWebhookLiveness({
    lastServerEventAt: ago(2 * HOUR),
    lastPaidOrderAt: ago(WEBHOOK_GRACE_MS + MINUTE),
    now: NOW,
  });
  check(
    "and it is `behind` once the grace window has passed",
    pastGrace.state === "behind",
    JSON.stringify(pastGrace),
  );

  const noOrdersButWired = judgeWebhookLiveness({
    lastServerEventAt: ago(10 * MINUTE),
    lastPaidOrderAt: null,
    now: NOW,
  });
  check(
    "a webhook with no paid orders behind it still reads `ok` — the chain is provably wired",
    noOrdersButWired.state === "ok",
    JSON.stringify(noOrdersButWired),
  );

  const unreadable = judgeWebhookLiveness({
    lastServerEventAt: "not a timestamp",
    lastPaidOrderAt: ago(2 * HOUR),
    now: NOW,
  });
  check(
    "an unreadable event timestamp is treated as no event, not as a pass",
    unreadable.state === "never",
    JSON.stringify(unreadable),
  );
}

/* ------------------------------- 4 · the client.callback filter, in the pure -- */

section("4 · a browser callback must never count as a webhook");

{
  /**
   * The scenario, exactly: the webhook chain is dead, the customer paid, their
   * browser called back and wrote a `client.callback` row **newer** than the
   * order. That row is the only thing in `payment_events` more recent than the
   * payment.
   *
   * With the `<>` filter the query finds nothing, so the verdict is `never`.
   * Without it, the callback is the newest "event" and the verdict is `ok` —
   * a dead chain reporting itself healthy, using the customer's own browser as
   * the evidence. Both are computed below so the difference is the assertion.
   */
  const paidAt = ago(2 * HOUR);
  const callbackAt = ago(2 * HOUR - 20_000);

  const events = [
    { event_type: CLIENT_CALLBACK_EVENT_TYPE, received_at: callbackAt },
    { event_type: CLIENT_CALLBACK_EVENT_TYPE, received_at: ago(3 * DAY) },
  ];

  const newest = (rows: typeof events) =>
    rows
      .map((row) => row.received_at)
      .sort()
      .at(-1) ?? null;

  const withFilter = judgeWebhookLiveness({
    lastServerEventAt: newest(
      events.filter((row) => row.event_type !== CLIENT_CALLBACK_EVENT_TYPE),
    ),
    lastPaidOrderAt: paidAt,
    now: NOW,
  });
  const withoutFilter = judgeWebhookLiveness({
    lastServerEventAt: newest(events),
    lastPaidOrderAt: paidAt,
    now: NOW,
  });

  check(
    "callbacks only, filtered: `never` — the dead chain is reported dead",
    withFilter.state === "never",
    JSON.stringify(withFilter),
  );
  check(
    "callbacks only, unfiltered: `ok` — which is the bug the filter prevents",
    withoutFilter.state === "ok",
    JSON.stringify(withoutFilter),
  );

  /**
   * A mixed set where the callback is newer than the last real webhook AND
   * newer than the paid order. Dropping the filter turns `behind` into `ok`:
   * the same masking, one state milder, and just as wrong.
   */
  const mixed = [
    { event_type: "payment.captured", received_at: ago(3 * HOUR) },
    { event_type: CLIENT_CALLBACK_EVENT_TYPE, received_at: callbackAt },
  ];
  const mixedFiltered = judgeWebhookLiveness({
    lastServerEventAt: newest(
      mixed.filter((row) => row.event_type !== CLIENT_CALLBACK_EVENT_TYPE),
    ),
    lastPaidOrderAt: paidAt,
    now: NOW,
  });
  const mixedUnfiltered = judgeWebhookLiveness({
    lastServerEventAt: newest(mixed),
    lastPaidOrderAt: paidAt,
    now: NOW,
  });
  check(
    "a stale webhook behind a fresh callback, filtered: `behind`",
    mixedFiltered.state === "behind",
    JSON.stringify(mixedFiltered),
  );
  check(
    "the same set unfiltered: `ok` — the callback masks it",
    mixedUnfiltered.state === "ok",
    JSON.stringify(mixedUnfiltered),
  );

  /**
   * The filter proved above is only worth anything if the dashboard actually
   * applies it. Read rather than inferred, because this is the line a later
   * refactor deletes as redundant.
   */
  const source = readFileSync("src/lib/queries/admin/dashboard.ts", "utf8");
  check(
    "dashboard.ts excludes client.callback from the liveness read",
    source.includes(`.neq("event_type", CLIENT_CALLBACK_EVENT_TYPE)`),
    "the `<>` filter is missing from admin.dashboard.lastWebhook",
  );
  check(
    "and measures it against the last paid order, not the clock",
    source.includes(`.eq("payment_status", "paid")`),
  );
}

/* ------------------------------------- 5 · the same filter, on real rows -- */

section("5 · the filter against the live database (read-only)");

async function againstTheDatabase(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.log(
      "  \x1b[33m!\x1b[0m skipped: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.\n" +
        "      Sections 1–4 still ran. This one did not, and that is a gap rather than a pass.",
    );
    return;
  }

  const supabase = createClient<Database>(url, key, {
    auth: { persistSession: false },
  });

  try {
    // Byte for byte the query dashboard.ts issues.
    const filtered = await maybeRow<{ received_at: string }>(
      "audit.payment-health.filtered",
      supabase
        .from("payment_events")
        .select("received_at")
        .neq("event_type", CLIENT_CALLBACK_EVENT_TYPE)
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    );
    // The same query without the filter, purely to show the two differ.
    const unfiltered = await maybeRow<{
      received_at: string;
      event_type: string;
    }>(
      "audit.payment-health.unfiltered",
      supabase
        .from("payment_events")
        .select("received_at, event_type")
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    );
    const callbacks = await maybeRow<{ received_at: string }>(
      "audit.payment-health.callbacks",
      supabase
        .from("payment_events")
        .select("received_at")
        .eq("event_type", CLIENT_CALLBACK_EVENT_TYPE)
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    );

    check(
      "the filtered read never returns a client.callback row",
      filtered === null ||
        callbacks === null ||
        filtered.received_at !== callbacks.received_at,
      `filtered=${filtered?.received_at ?? "none"} newest-callback=${callbacks?.received_at ?? "none"}`,
    );

    if (unfiltered?.event_type === CLIENT_CALLBACK_EVENT_TYPE) {
      check(
        "the newest row in payment_events IS a callback, and the filter skips past it",
        filtered !== null && filtered.received_at < unfiltered.received_at,
        `filtered=${filtered?.received_at ?? "none"} unfiltered=${unfiltered.received_at}`,
      );
    } else {
      console.log(
        "  \x1b[90m·\x1b[0m the newest payment_events row is not a callback today, so\n" +
          "      the masking case could not be exercised on live rows. Section 4\n" +
          "      covers it on constructed rows.",
      );
    }

    const lastPaid = await maybeRow<{ placed_at: string }>(
      "audit.payment-health.lastPaidOrder",
      supabase
        .from("orders")
        .select("placed_at")
        .eq("payment_status", "paid")
        .order("placed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    );

    const verdict = judgeWebhookLiveness({
      lastServerEventAt: filtered?.received_at ?? null,
      lastPaidOrderAt: lastPaid?.placed_at ?? null,
    });
    console.log(
      `  \x1b[90m·\x1b[0m production today: ${verdict.state}` +
        (verdict.state === "ok"
          ? ` — last webhook ${relativeAge(verdict.lastEventAt)}`
          : ""),
    );

    /**
     * The refund queue, in the shape dashboard.ts issues it — exact count and
     * a bounded page, so a queue of one and a queue of two hundred both read
     * correctly. Stage 1 measured this at zero and it must stay there; a row
     * here means the shop is holding a customer's money for goods it will not
     * send, and this suite is the thing that says so out loud.
     */
    const owed = await pagedRows<{ id: string; order_number: string }>(
      "audit.payment-health.refundsOwed",
      supabase
        .from("orders")
        .select(
          `id, order_number, grand_total, advance_amount, payment_reference, updated_at`,
          { count: "exact" },
        )
        .eq("status", "cancelled")
        .eq("payment_status", "paid")
        .order("updated_at", { ascending: false })
        .limit(20),
    );
    check(
      "the refund queue reads back an exact count, not a page size",
      owed.total >= owed.rows.length,
      `count=${owed.total} rows=${owed.rows.length}`,
    );
    check(
      "no cancelled order is sitting on a customer's money",
      owed.total === 0,
      owed.rows.map((order) => order.order_number).join(", "),
    );
  } catch (error) {
    check(
      "the live database could be read",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/* ---------------------------------------------------------------- report -- */

void againstTheDatabase().then(() => {
  console.log(
    `\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m` +
      "\n\nNothing here writes a row. The one thing this suite cannot prove is" +
      "\nthat RAZORPAY_WEBHOOK_SECRET matches the secret Razorpay signs with —" +
      "\nthat needs a real delivery, and a real delivery needs the live webhook" +
      "\nto exist. Until the first one lands, `never` on the dashboard is the" +
      "\nevidence.",
  );
  if (failed > 0) {
    console.log("\nFailures:");
    for (const failure of failures) console.log(`  · ${failure}`);
    process.exit(1);
  }
});
