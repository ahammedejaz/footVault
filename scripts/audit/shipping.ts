/**
 * `npm run audit:shipping` — the Shiprocket integration, against a mock.
 *
 * **It never touches the live account, and that is not a shortcut.** Shiprocket's
 * API acts on a real business: `orders/create/adhoc` creates a real order and
 * `courier/assign/awb` can commit real money. A suite that ran against it would
 * be a suite that books couriers every time CI runs. So `globalThis.fetch` is
 * replaced for the duration, which also lets the interesting cases — a 401, a
 * timeout, an unreachable host — be produced on demand rather than waited for.
 *
 * What the mock cannot prove is that Shiprocket's real responses have the shape
 * this code reads. That is what the single manual test against the live account
 * is for, and `docs/admin-guide.md` has the click-path. Both halves are needed
 * and neither substitutes for the other; the report says so.
 *
 * Covered, in order:
 *   1  token fetch, and that the cache is used rather than a login per call
 *   2  proactive refresh before expiry
 *   3  401 → re-authenticate once → retry; a second 401 surfaces
 *   4  serviceability for a serviceable PIN and a non-serviceable one
 *   5  COD gating both ways
 *   6  fail-soft when Shiprocket is unreachable, slow, or unconfigured
 *   7  idempotency on every fulfilment step
 */

import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

// The same loader the other audit suites use: no dotenv dependency, and a
// variable already in the environment always wins so CI can override any of it.
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

/**
 * Credentials the mock accepts, assigned rather than defaulted.
 *
 * `||=` would let a real `SHIPROCKET_EMAIL` in `.env.local` through, and the
 * one thing this suite must never be able to do is reach the live account. The
 * mock intercepts every shiprocket.in request anyway; this is the second lock.
 */
process.env.SHIPROCKET_EMAIL = "api-user@example.invalid";
process.env.SHIPROCKET_PASSWORD = "mock-password";
process.env.SHIPROCKET_PICKUP_LOCATION = "Primary";

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
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ------------------------------------------------------------- the mock -- */

type Handler = (
  url: string,
  init: RequestInit | undefined,
) => Promise<Response> | Response;

const realFetch = globalThis.fetch;
let handler: Handler = () => new Response("{}", { status: 200 });

/** Every request the code under test made, so call counts can be asserted. */
let calls: { url: string; method: string }[] = [];

function installMock() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    // Supabase's own traffic must reach the real network: the token cache is a
    // database row, and stubbing it would test the mock rather than the code.
    if (!url.includes("shiprocket.in"))
      return realFetch(input as RequestInfo, init);
    calls.push({ url, method: init?.method ?? "GET" });

    /**
     * The mock has to honour `init.signal`, or the timeout case proves nothing.
     *
     * Real `fetch` rejects with an AbortError when the controller fires; a mock
     * that ignores the signal simply resolves late, the client waits for it,
     * and a "the deadline works" assertion passes only because the mock is
     * fast. This is the first version of that test failing at 6089ms against a
     * 4000ms budget — the bug was here, not in the client.
     */
    const signal = init?.signal;
    if (!signal) return handler(url, init);
    return Promise.race([
      Promise.resolve(handler(url, init)),
      new Promise<Response>((_, reject) => {
        if (signal.aborted) {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          return;
        }
        signal.addEventListener(
          "abort",
          () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      }),
    ]);
  }) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TOKEN = "mock.jwt.token";
const SECOND_TOKEN = "mock.jwt.token.2";

async function main() {
  installMock();

  const { __resetShiprocketTokenCache, getShiprocketToken } =
    await import("@/lib/shipping/token");
  const { shiprocketFetch } = await import("@/lib/shipping/client");
  const { checkServiceability } = await import("@/lib/shipping/serviceability");
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { UNKNOWN_SERVICEABILITY: UNKNOWN } =
    await import("@/lib/shipping/serviceability");
  const { maybeRow } = await import("@/lib/queries/run");

  const admin = createAdminClient();

  /** The cache is a real database row, so each case starts from a known state. */
  async function clearStoredToken() {
    const { error } = await admin
      .from("integration_tokens")
      .delete()
      .eq("provider", "shiprocket");
    if (error)
      throw new Error(`could not clear the token row: ${error.message}`);
    __resetShiprocketTokenCache();
  }

  /* ═══ 1 · the token is fetched once and then cached ══════════════════════ */
  section("1 · One login, then the cache");
  {
    await clearStoredToken();
    let logins = 0;
    handler = (url) => {
      if (url.endsWith("/auth/login")) {
        logins += 1;
        return json({ token: TOKEN });
      }
      return json({ ok: true });
    };

    const first = await getShiprocketToken();
    check("a login returns the token", first === TOKEN, first);
    check("exactly one login so far", logins === 1, String(logins));

    // Same instance: served by the memo, no round trip at all.
    await getShiprocketToken();
    await getShiprocketToken();
    check("repeated calls do not log in again", logins === 1, String(logins));

    // A cold start: the memo is gone but the database row is not.
    __resetShiprocketTokenCache();
    const afterColdStart = await getShiprocketToken();
    check(
      "the token survives a cold start",
      afterColdStart === TOKEN,
      afterColdStart,
    );
    check(
      "and a cold start still does not log in — the cache is in Postgres, not memory",
      logins === 1,
      `${logins} logins`,
    );
  }

  /* ═══ 2 · proactive refresh ══════════════════════════════════════════════ */
  section("2 · Refreshed before it expires, not after");
  {
    await clearStoredToken();
    let logins = 0;
    handler = (url) => {
      if (url.endsWith("/auth/login")) {
        logins += 1;
        return json({ token: logins === 1 ? TOKEN : SECOND_TOKEN });
      }
      return json({ ok: true });
    };

    await getShiprocketToken();
    check("first login", logins === 1);

    /**
     * A token that is still valid but inside the refresh margin. This is the
     * case the whole design exists for: expiring mid-request is a failed
     * shipment, so the margin has to make that unreachable.
     */
    const { error } = await admin
      .from("integration_tokens")
      .update({
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
      .eq("provider", "shiprocket");
    if (error) throw new Error(error.message);
    __resetShiprocketTokenCache();

    const refreshed = await getShiprocketToken();
    check(
      "a token one hour from expiry is replaced rather than used",
      logins === 2 && refreshed === SECOND_TOKEN,
      `${logins} logins, token ${refreshed}`,
    );

    const stored = await maybeRow<{ expires_at: string }>(
      "audit.storedToken",
      admin
        .from("integration_tokens")
        .select("expires_at")
        .eq("provider", "shiprocket")
        .maybeSingle(),
    );
    const expiry = stored
      ? new Date(stored.expires_at).getTime() - Date.now()
      : 0;
    check(
      "the replacement is stored with a fresh 240-hour expiry",
      expiry > 239 * 60 * 60 * 1000,
      `${Math.round(expiry / 3600000)}h`,
    );
  }

  /* ═══ 3 · 401 handling ═══════════════════════════════════════════════════ */
  section("3 · One re-authentication on 401, and only one");
  {
    await clearStoredToken();
    let logins = 0;
    let dataCalls = 0;
    handler = (url, init) => {
      if (url.endsWith("/auth/login")) {
        logins += 1;
        return json({ token: logins === 1 ? TOKEN : SECOND_TOKEN });
      }
      dataCalls += 1;
      const auth = new Headers(init?.headers).get("authorization");
      // The first token is refused; the one minted after it is accepted.
      if (auth === `Bearer ${TOKEN}`)
        return json({ message: "Unauthorized" }, 401);
      return json({ ok: true, saw: auth });
    };

    const result = await shiprocketFetch<{ ok: boolean }>(
      "/settings/company/pickup",
    );
    check(
      "the call succeeds after re-authenticating",
      result.ok === true,
      JSON.stringify(result),
    );
    check("it logged in exactly twice", logins === 2, String(logins));
    check(
      "and made exactly two data calls — one retry, not a loop",
      dataCalls === 2,
      String(dataCalls),
    );

    // Now a token that is rejected however fresh it is: revoked credentials.
    await clearStoredToken();
    logins = 0;
    dataCalls = 0;
    handler = (url) => {
      if (url.endsWith("/auth/login")) {
        logins += 1;
        return json({ token: `t${logins}` });
      }
      dataCalls += 1;
      return json({ message: "Unauthorized" }, 401);
    };

    const stubborn = await shiprocketFetch("/settings/company/pickup");
    check(
      "a second 401 is surfaced rather than retried forever",
      !stubborn.ok && stubborn.reason === "auth",
      JSON.stringify(stubborn),
    );
    check(
      "it stopped after two data calls",
      dataCalls === 2,
      String(dataCalls),
    );
    check(
      "the failure names the API-user mistake rather than saying 'unauthorized'",
      !stubborn.ok && stubborn.message.includes("Settings → API"),
      !stubborn.ok ? stubborn.message : "",
    );
  }

  /* ═══ 4 · serviceability ═════════════════════════════════════════════════ */
  section("4 · Serviceability, both answers");
  {
    await clearStoredToken();
    handler = (url) => {
      if (url.endsWith("/auth/login")) return json({ token: TOKEN });
      if (url.includes("/courier/serviceability/")) {
        const pin = new URL(url).searchParams.get("delivery_postcode");
        // 560001 — Bengaluru, served, COD offered.
        if (pin === "560001") {
          return json({
            data: {
              available_courier_companies: [
                {
                  courier_name: "Delhivery",
                  rate: "84.5",
                  estimated_delivery_days: "3",
                  cod: 1,
                },
                {
                  courier_name: "Bluedart",
                  rate: 121,
                  estimated_delivery_days: "2",
                  cod: 0,
                },
              ],
            },
          });
        }
        // 190001 — Srinagar, served, but nobody will collect cash.
        if (pin === "190001") {
          return json({
            data: {
              available_courier_companies: [
                {
                  courier_name: "Ekart",
                  rate: "150",
                  estimated_delivery_days: "8",
                  cod: 0,
                },
              ],
            },
          });
        }
        // Observed against the live account: pickup 516360 -> 744101 returns
        // 200 with zero couriers and this exact sentence.
        if (pin === "744101") {
          return json({
            data: { available_courier_companies: [] },
            message: "No courier service available between 516360 and 744101",
          });
        }
        // Zero couriers with no explanation — the genuinely ambiguous case.
        return json({ data: { available_courier_companies: [] } });
      }
      return json({});
    };

    const served = await checkServiceability({
      pickupPostcode: "560001",
      deliveryPostcode: "560001",
      weightKg: 0.9,
    });
    check(
      "a serviceable PIN reports its source as shiprocket",
      served.source === "shiprocket",
    );
    check(
      "COD is offered when a courier offers it",
      served.codAvailable === true,
    );
    check(
      "the estimate is the fastest courier's, not the average",
      served.estimatedDays === 2,
      String(served.estimatedDays),
    );
    check(
      "the cheapest rate is converted from rupees to paise",
      served.cheapestRatePaise === 8450,
      String(served.cheapestRatePaise),
    );

    const noCod = await checkServiceability({
      pickupPostcode: "560001",
      deliveryPostcode: "190001",
      weightKg: 0.9,
    });
    check(
      "COD is refused when couriers serve the PIN and none will collect cash",
      noCod.codAvailable === false,
      JSON.stringify(noCod),
    );
    check(
      "and the delivery estimate still comes through",
      noCod.estimatedDays === 8,
    );

    const empty = await checkServiceability({
      pickupPostcode: "560001",
      deliveryPostcode: "999999",
      weightKg: 0.9,
    });
    check(
      "an unexplained empty courier list does NOT switch COD off — it may be our own parameters",
      empty.codAvailable === true && empty.source === "unknown",
      JSON.stringify(empty),
    );

    const unserviceable = await checkServiceability({
      pickupPostcode: "560001",
      deliveryPostcode: "744101",
      weightKg: 0.9,
    });
    check(
      "but an empty list WITH Shiprocket's 'no courier service available' does refuse COD",
      unserviceable.codAvailable === false &&
        unserviceable.source === "shiprocket",
      JSON.stringify(unserviceable),
    );

    const malformed = await checkServiceability({
      pickupPostcode: "560001",
      deliveryPostcode: "12",
      weightKg: 0.9,
    });
    check(
      "a PIN that is not six digits is rejected without a round trip",
      malformed.source === "unknown" &&
        malformed.reason?.includes("six digits") === true,
      JSON.stringify(malformed),
    );
  }

  /* ═══ 5 · fail-soft ══════════════════════════════════════════════════════ */
  section("5 · A logistics outage never blocks a sale");
  {
    await clearStoredToken();

    // Unreachable host.
    handler = () => {
      throw new TypeError("fetch failed");
    };
    const down = await checkServiceability({
      pickupPostcode: "560001",
      deliveryPostcode: "560001",
      weightKg: 0.9,
    });
    check(
      "Shiprocket unreachable → COD still available",
      down.codAvailable === true,
    );
    check("and no estimate is invented", down.estimatedDays === null);

    // Slow enough to trip the 4s serviceability deadline.
    await clearStoredToken();
    handler = async (url) => {
      if (url.endsWith("/auth/login")) return json({ token: TOKEN });
      await sleep(6000);
      return json({ data: { available_courier_companies: [] } });
    };
    const started = Date.now();
    const slow = await checkServiceability({
      pickupPostcode: "560001",
      deliveryPostcode: "560001",
      weightKg: 0.9,
    });
    const elapsed = Date.now() - started;
    check(
      "a slow provider is abandoned, not waited for",
      elapsed < 5500,
      `${elapsed}ms`,
    );
    check("and COD survives the timeout", slow.codAvailable === true);

    // No credentials at all.
    await clearStoredToken();
    const email = process.env.SHIPROCKET_EMAIL;
    const password = process.env.SHIPROCKET_PASSWORD;
    delete process.env.SHIPROCKET_EMAIL;
    delete process.env.SHIPROCKET_PASSWORD;
    handler = () => json({});
    const unconfigured = await checkServiceability({
      pickupPostcode: "560001",
      deliveryPostcode: "560001",
      weightKg: 0.9,
    });
    check(
      "an unconfigured integration leaves COD available",
      unconfigured.codAvailable === true &&
        unconfigured.reason === "not_configured",
      JSON.stringify(unconfigured),
    );
    process.env.SHIPROCKET_EMAIL = email;
    process.env.SHIPROCKET_PASSWORD = password;
    __resetShiprocketTokenCache();
  }

  /* ═══ 5b · the delivery fee the customer pays ════════════════════════════ */
  section("5b · Delivery pricing");
  {
    const { deliveryFee } = await import("@/lib/shipping/fee");

    /**
     * The thresholds, stated here rather than read from the database.
     *
     * They are the shop's numbers and they move — the owner edits them in
     * /admin/settings — so a suite that read them would assert whatever the
     * database happened to hold and prove nothing. Pinning them keeps this
     * testing the *rules*, which is the part that must not change silently.
     * `shippingSettings()` is covered separately by its own parse fallbacks.
     */
    const SETTINGS = {
      freeAbovePaise: 249_900,
      fallbackFeePaise: { razorpay: 19_900, cod: 34_900 },
      codEnabled: true,
      codAdvanceMode: "greater_of" as const,
      codAdvanceMinimumPaise: 9_900,
      codAdvanceFixedPaise: 9_900,
    };

    // Measured against the live account: Delhivery Surface, Cuddapah to
    // Bengaluru, 0.9kg. rate already includes the cash-collection fee.
    const live = {
      estimatedDays: 3,
      deliverable: true,
      forwardCostPaise: 20533,
      rtoCostPaise: 14200,
      codAvailable: true,
      cheapestRatePaise: 20533,
      courierName: "Delhivery Surface",
      source: "shiprocket" as const,
    };

    const prepaidUnder = deliveryFee({
      method: "razorpay",
      subtotalPaise: 199900,
      verdict: live,
      settings: SETTINGS,
    });
    check(
      "prepaid under the threshold pays the forward rate, rounded up to Rs 10",
      prepaidUnder.feePaise === 21000,
      String(prepaidUnder.feePaise),
    );

    const prepaidOver = deliveryFee({
      method: "razorpay",
      subtotalPaise: SETTINGS.freeAbovePaise,
      verdict: live,
      settings: SETTINGS,
    });
    check(
      "prepaid at exactly Rs 2,499 is free",
      prepaidOver.feePaise === 0 && prepaidOver.basis === "free",
      JSON.stringify(prepaidOver.feePaise),
    );

    const codUnder = deliveryFee({
      method: "cod",
      subtotalPaise: 199900,
      verdict: live,
      settings: SETTINGS,
    });
    check(
      "COD pays forward PLUS the return leg — 205.33 + 142 rounds to Rs 350",
      codUnder.feePaise === 35000,
      String(codUnder.feePaise),
    );

    const codOver = deliveryFee({
      method: "cod",
      subtotalPaise: 500000,
      verdict: live,
      settings: SETTINGS,
    });
    check(
      "COD gets NO free threshold, however large the order",
      codOver.feePaise === 35000 && codOver.basis === "shiprocket",
      `${codOver.feePaise} / ${codOver.basis}`,
    );

    const noRto = deliveryFee({
      method: "cod",
      subtotalPaise: 199900,
      verdict: { ...live, rtoCostPaise: null },
      settings: SETTINGS,
    });
    check(
      "a missing return cost is assumed to equal the forward one, never zero",
      noRto.feePaise === 42000,
      String(noRto.feePaise),
    );

    const outage = deliveryFee({
      method: "cod",
      subtotalPaise: 199900,
      verdict: { ...UNKNOWN, forwardCostPaise: null },
      settings: SETTINGS,
    });
    check(
      "an outage falls back to the COD flat rate, not the prepaid one",
      outage.feePaise === SETTINGS.fallbackFeePaise.cod &&
        outage.basis === "fallback",
      String(outage.feePaise),
    );

    const outageFree = deliveryFee({
      method: "razorpay",
      subtotalPaise: 300000,
      verdict: { ...UNKNOWN, forwardCostPaise: null },
      settings: SETTINGS,
    });
    check(
      "and an outage never costs a customer their earned free delivery",
      outageFree.feePaise === 0,
      String(outageFree.feePaise),
    );

    const dead = deliveryFee({
      method: "razorpay",
      subtotalPaise: 199900,
      verdict: { ...UNKNOWN, deliverable: false, forwardCostPaise: null },
      settings: SETTINGS,
    });
    check(
      "an undeliverable pin code is reported as such rather than priced",
      dead.deliverable === false,
      JSON.stringify(dead.deliverable),
    );

    /**
     * The COD extra is a named line, which is the owner's condition for keeping
     * the surcharge at all: the difference between a prepaid total and a
     * Pay-on-Delivery one must be something a customer can see and point at.
     */
    check(
      "the COD extra is split out as its own line",
      codUnder.shippingFeePaise === 21000 &&
        codUnder.codHandlingPaise === 14000,
      `${codUnder.shippingFeePaise} + ${codUnder.codHandlingPaise}`,
    );
    check(
      "prepaid never carries a COD handling line",
      prepaidUnder.codHandlingPaise === 0 && prepaidOver.codHandlingPaise === 0,
    );
    check(
      "the split always reconstitutes the fee actually charged",
      [prepaidUnder, prepaidOver, codUnder, codOver, noRto, outage, outageFree].every(
        (f) => f.shippingFeePaise + f.codHandlingPaise === f.feePaise,
      ),
    );
    check(
      "splitting did not change what the customer pays",
      codUnder.feePaise === 35000 && prepaidUnder.feePaise === 21000,
      `${codUnder.feePaise} / ${prepaidUnder.feePaise}`,
    );
  }

  /* ═══ 6 · fulfilment idempotency ═════════════════════════════════════════ */
  section("6 · Every fulfilment step is safe to press twice");
  {
    const { createShipment, assignAwb, schedulePickup, generateDocuments } =
      await import("@/lib/shipping/fulfilment");

    await clearStoredToken();
    let creates = 0;
    let awbs = 0;
    let pickups = 0;
    /** The adhoc payload as Shiprocket would have received it. */
    let adhocBody: Record<string, unknown> | null = null;
    handler = (url, init) => {
      if (url.endsWith("/auth/login")) return json({ token: TOKEN });
      if (url.includes("/orders/create/adhoc")) {
        creates += 1;
        adhocBody =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : null;
        return json({ order_id: 900001, shipment_id: 800001 });
      }
      if (url.includes("/courier/assign/awb")) {
        awbs += 1;
        return json({
          response: {
            data: {
              awb_code: "AWB123456789",
              courier_name: "Delhivery",
              courier_company_id: 51,
            },
          },
        });
      }
      if (url.includes("/courier/generate/pickup")) {
        pickups += 1;
        return json({ pickup_token_number: "PT-99" });
      }
      if (url.includes("/courier/generate/label"))
        return json({ label_url: "https://x/label.pdf" });
      if (url.includes("/manifests/generate"))
        return json({ manifest_url: "https://x/man.pdf" });
      if (url.includes("/orders/print/invoice"))
        return json({ invoice_url: "https://x/inv.pdf" });
      return json({});
    };

    // A real order to hang the shipment off — shipments.order_id is a foreign
    // key, so a fabricated uuid would test the constraint rather than the code.
    const { data: orderRow, error: orderError } = await admin
      .from("orders")
      .select(
        "id, order_number, placed_at, payment_method, subtotal, shipping_fee, grand_total, contact_email",
      )
      .order("placed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (orderError) throw new Error(orderError.message);

    if (!orderRow) {
      console.log(
        "  \x1b[33m•\x1b[0m skipped — no orders in the database to attach a shipment to",
      );
    } else {
      const { error: cleanupError } = await admin
        .from("shipments")
        .delete()
        .eq("order_id", orderRow.id);
      if (cleanupError) throw new Error(cleanupError.message);

      const order = {
        id: orderRow.id,
        orderNumber: orderRow.order_number,
        placedAt: orderRow.placed_at,
        paymentMethod: orderRow.payment_method,
        subtotal: orderRow.subtotal,
        shippingFee: orderRow.shipping_fee,
        grandTotal: orderRow.grand_total,
        /**
         * Deliberately equal to none of the other three figures.
         *
         * With the default `greater_of` advance rule the balance happens to
         * equal the goods subtotal, so a fixture built that way would pass
         * whether the code read the balance or the subtotal. A fixed ₹99
         * advance against a ₹220 delivery separates them, which is the only
         * way this assertion can actually fail when the code is wrong.
         */
        balanceDueOnDelivery: orderRow.grand_total - 9_900,
        contactEmail: orderRow.contact_email,
        address: {
          recipientName: "Audit Probe",
          phone: "+919000000000",
          line1: "1 Test Street",
          line2: null,
          city: "Bengaluru",
          state: "Karnataka",
          postalCode: "560001",
        },
        items: [
          {
            productName: "Probe Shoe",
            sku: "PROBE-1",
            quantity: 1,
            unitPrice: 499900,
            productId: null,
          },
        ],
      };

      const created = await createShipment(admin, order);
      check(
        "create shipment succeeds",
        created.ok === true,
        JSON.stringify(created),
      );

      /**
       * The single most expensive mistake available in this phase.
       *
       * Shiprocket treats `sub_total` on a COD shipment as **the amount to
       * collect at the door**. Handing it the order total makes the courier
       * collect the delivery fee a second time from a customer who has already
       * paid it online — and it is discovered by complaint, one customer at a
       * time, after the money has changed hands.
       *
       * All three figures are asserted, not just the right one: a test that
       * only checked "equals the balance" would still pass if the balance
       * happened to equal the subtotal, which under the default advance rule it
       * does.
       */
      {
        const body = adhocBody as Record<string, unknown> | null;
        const sent = body?.sub_total;
        const expected = Math.round(order.balanceDueOnDelivery / 100);
        check(
          "the COD collectable is the balance, not the order total",
          sent === expected,
          `sent ${String(sent)}, expected ${expected}`,
        );
        check(
          "and is not the grand total",
          sent !== Math.round(order.grandTotal / 100),
          `grand total is ${Math.round(order.grandTotal / 100)}`,
        );
        check(
          "and is not the goods subtotal",
          sent !== Math.round(order.subtotal / 100),
          `subtotal is ${Math.round(order.subtotal / 100)}`,
        );
        check(
          "the shipment records what the courier was asked to collect",
          true === (await (async () => {
            const { data } = await admin
              .from("shipments")
              .select("cod_collectable_amount")
              .eq("order_id", order.id)
              .maybeSingle();
            return data?.cod_collectable_amount === order.balanceDueOnDelivery;
          })()),
        );
      }
      const againCreated = await createShipment(admin, order);
      check(
        "pressing create twice does not create a second Shiprocket order",
        creates === 1 && againCreated.ok && againCreated.already === true,
        `${creates} create calls`,
      );

      const awb = await assignAwb(admin, order.id);
      check("assign AWB succeeds", awb.ok === true, JSON.stringify(awb));
      const againAwb = await assignAwb(admin, order.id);
      check(
        "pressing assign twice does not request a second AWB",
        awbs === 1 && againAwb.ok && againAwb.already === true,
        `${awbs} awb calls`,
      );

      const pickup = await schedulePickup(admin, order.id);
      check(
        "schedule pickup succeeds",
        pickup.ok === true,
        JSON.stringify(pickup),
      );
      const againPickup = await schedulePickup(admin, order.id);
      check(
        "pressing pickup twice does not book a second collection",
        pickups === 1 && againPickup.ok && againPickup.already === true,
        `${pickups} pickup calls`,
      );

      const docs = await generateDocuments(admin, order.id);
      check("documents are generated", docs.ok === true, JSON.stringify(docs));
      const againDocs = await generateDocuments(admin, order.id);
      check(
        "and are not re-fetched once stored",
        againDocs.ok && againDocs.already === true,
        JSON.stringify(againDocs),
      );

      // Ordering preconditions: a step cannot run before the one it needs.
      const { error: wipeError } = await admin
        .from("shipments")
        .delete()
        .eq("order_id", order.id);
      if (wipeError) throw new Error(wipeError.message);
      const awbFirst = await assignAwb(admin, order.id);
      check(
        "assigning an AWB before creating the shipment is refused here, not at Shiprocket",
        !awbFirst.ok && awbFirst.message.includes("Create the shipment first"),
        JSON.stringify(awbFirst),
      );

      const { error: finalCleanup } = await admin
        .from("shipments")
        .delete()
        .eq("order_id", order.id);
      if (finalCleanup) throw new Error(finalCleanup.message);
    }
  }

  /* ═══ 7 · nothing leaks ══════════════════════════════════════════════════ */
  section("7 · The token is never in a URL");
  {
    const leaked = calls.filter(
      (call) => call.url.includes(TOKEN) || call.url.includes(SECOND_TOKEN),
    );
    check(
      "no request put the token in a query string",
      leaked.length === 0,
      String(leaked.length),
    );
  }

  globalThis.fetch = realFetch;
  calls = [];

  /**
   * Teardown, and it is not optional.
   *
   * `integration_tokens` is a *shared* table, not a fixture. Every mock login in
   * this suite writes its fake token into the same row a real deployment reads,
   * with a 240-hour expiry — so without this, finishing the suite leaves the
   * application holding `mock.jwt.token` and believing it good for ten days.
   *
   * The damage is bounded, because the client's 401 path re-authenticates and
   * retries: the first real request after a run pays one wasted round trip and
   * then repairs itself. That is exactly what happened the first time this was
   * noticed — a live check read the leftover mock token, got a 401 from
   * Shiprocket, logged in once and succeeded. Self-healing, and still wrong to
   * leave behind.
   */
  const { error: teardownError } = await admin
    .from("integration_tokens")
    .delete()
    .eq("provider", "shiprocket");
  if (teardownError) {
    console.log(
      `\n\x1b[33m!\x1b[0m could not clear the cached token: ${teardownError.message}`,
    );
  } else {
    console.log(
      "\n  cleared the cached token — the next real request logs in fresh",
    );
  }

  console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  globalThis.fetch = realFetch;
  console.error("\n\x1b[31maudit:shipping threw\x1b[0m\n", error);
  process.exit(1);
});
