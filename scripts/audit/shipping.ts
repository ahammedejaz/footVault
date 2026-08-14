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
 *   8  a failed step writing its reason down, and that reason surviving the
 *      create step deleting its own row
 *   9  the order page actually rendering that reason, by rendering the real
 *      component with the row that came back out of the database
 *  10  the wallet balance: "299.47" → 29947 paise, and every way of failing to
 *      read it degrading to "could not read" rather than to zero
 */

// clients first, before any other import and before anything reads
// process.env. This suite gets its database through the app's own
// `createAdminClient()`, so it never names a Supabase credential and the first
// version of the fixtures-guard import check did not flag it — while it was
// creating and deleting `shipments` rows against the **live shop**, and picking
// its fixture order out of production. Found in Phase 9 when its COD fixture
// asserted against FV-2026-00623, an order that exists only in production.
import "./clients";
import { assertNotProduction } from "./clients";

assertNotProduction("run shipping");

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import type { SupabaseClient } from "@supabase/supabase-js";

// The same loader the other audit suites use: no dotenv dependency, and a
// variable already in the environment always wins so CI can override any of it
// — which is precisely what makes the `./clients` import above effective, since
// it has already written the staging credentials into `process.env` under these
// names by the time this runs.
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

/**
 * Render a real component to HTML, in a child process.
 *
 * This suite runs under `--conditions=react-server` — it has to, because the
 * modules it imports are Server Components and their dependencies resolve
 * differently without it — and under that condition `react-dom/server` refuses
 * to load at all: "react-dom/server is not supported in React Server
 * Components". So the render happens in a child with the condition dropped.
 *
 * It is a real render of the real component, not a stand-in. The alternative
 * was asserting on the mapping function alone and *claiming* the page shows it,
 * which is the kind of half-test that lets a component quietly stop rendering
 * the thing it was written for.
 */
function renderComponent(
  modulePath: string,
  exportName: string,
  props: unknown,
): string {
  const script =
    `import { renderToStaticMarkup } from "react-dom/server";` +
    `import { createElement } from "react";` +
    `const mod = await import(${JSON.stringify(modulePath)});` +
    `process.stdout.write(renderToStaticMarkup(createElement(` +
    `mod[${JSON.stringify(exportName)}],` +
    `JSON.parse(process.env.FV_RENDER_PROPS ?? "{}"))));`;

  try {
    return execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          NODE_OPTIONS: "",
          FV_RENDER_PROPS: JSON.stringify(props),
        },
      },
    );
  } catch (error) {
    return `RENDER FAILED: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** React escapes quotes and angle brackets in text; assertions have to match. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
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
  const {
    UNKNOWN_SERVICEABILITY: UNKNOWN,
    FLAT_SERVICEABILITY: FLAT,
  } = await import("@/lib/shipping/serviceability");
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
      /**
       * What replaced `fallback_fee_paise`, and it is one number rather than
       * two. The COD half of that pair is what produced the ₹150 "cash
       * handling" line on FV-2026-00571: the no-quote branch presented
       * `cod − razorpay`, the difference between two figures the owner typed,
       * as though it were the courier's fee. There is no COD counterpart now,
       * because a cash order with no live quote is refused rather than priced.
       */
      prepaidEstimateFeePaise: 19_900,
      codEnabled: true,
    courierSelectionMode: "shiprocket" as const,
    courierPriceTolerancePercent: null,
      codMinimumOrderValuePaise: 0,
      codAdvanceMaximumPaise: 0,
      includeGstInAdvance: false,
      prepaidDiscount: { mode: "flat" as const, value: 0 },
      maxTotalDiscountPercent: null,
      shippingRateMode: "live" as const,
      flatShippingFeePaise: 0,
      flatCodDeposit: { mode: "unset" as const },
      waiveCodFeeAboveThreshold: false,
      fallbackBehaviour: "refuse_cod" as const,
      rtoDeductionPolicy: "actual_freight" as const,
      rtoDeductionFlatPaise: 0,
      walletLowBalancePaise: null,
    };

    // Measured against the live account: Delhivery Surface, Proddatur to
    // Bengaluru, 0.9kg. rate already includes the cash-collection fee.
    /**
     * Delhivery Surface on the tested lane, as quoted live on 2026-08-08:
     * 516360 → 560001, 1 kg, ₹1,000 declared.
     *
     *   rate 191.36 = freight 139.36 + cod 52.00,  rto 142.00
     *
     * `forwardCostPaise` is the all-in rate because a Pay-on-Delivery quote is
     * taken with `cod=1`; `freightPaise` is the leg without the collection fee,
     * and it is the half of the advance that this file's assertions depend on.
     */
    const live = {
      estimatedDays: 4,
      deliverable: true,
      forwardCostPaise: 19136,
      freightPaise: 13936,
      codFeePaise: 5200,
      rtoCostPaise: 14200,
      codAvailable: true,
      cheapestRatePaise: 19136,
      courierName: "Delhivery Surface",
      courierId: 43,
      couriers: [],
      recommendedCourierId: 10,
      source: "shiprocket" as const,
    };

    /** The same lane quoted prepaid, where `rate` and `freight` coincide. */
    const livePrepaid = { ...live, forwardCostPaise: 13936, codFeePaise: 0 };

    const prepaidUnder = deliveryFee({
      method: "razorpay",
      subtotalPaise: 199900,
      verdict: livePrepaid,
      settings: SETTINGS,
    });
    check(
      "prepaid under the threshold pays the forward rate, rounded up to Rs 10",
      prepaidUnder.feePaise === 14000,
      String(prepaidUnder.feePaise),
    );
    check(
      "and none of it is a Pay-on-Delivery extra",
      prepaidUnder.codHandlingPaise === 0,
      String(prepaidUnder.codHandlingPaise),
    );

    const prepaidOver = deliveryFee({
      method: "razorpay",
      subtotalPaise: SETTINGS.freeAbovePaise,
      verdict: livePrepaid,
      settings: SETTINGS,
    });
    check(
      "prepaid at exactly the threshold is free",
      prepaidOver.feePaise === 0 && prepaidOver.basis === "free",
      JSON.stringify(prepaidOver.feePaise),
    );

    /**
     * **Phase 7 changed this number, and the change is the money model.**
     *
     * A Pay-on-Delivery delivery charge used to be `forward + RTO` — the
     * customer paid for a return that usually never happened. The return leg is
     * now covered by the *advance*, which is netted straight off what the
     * courier collects, so it costs a customer nothing on a delivered parcel
     * and covers the shop completely on a refused one. What is charged for
     * delivery is now simply what the courier charges to deliver: the live COD
     * rate, ₹191.36, rounded up to ₹200.
     */
    const codUnder = deliveryFee({
      method: "cod",
      subtotalPaise: 199900,
      verdict: live,
      settings: SETTINGS,
    });
    check(
      "Pay on Delivery pays the live COD rate — 191.36 rounds to Rs 200",
      codUnder.feePaise === 20000,
      String(codUnder.feePaise),
    );
    check(
      "the cash-collection fee is the whole of the named extra",
      codUnder.codHandlingPaise === 5200 &&
        codUnder.shippingFeePaise === 14800,
      `${codUnder.shippingFeePaise} + ${codUnder.codHandlingPaise}`,
    );
    check(
      "the two parts still sum to the total charged",
      codUnder.shippingFeePaise + codUnder.codHandlingPaise ===
        codUnder.feePaise,
    );
    check(
      "the shop's own costs are freight and RTO, not the all-in rate",
      codUnder.costForwardPaise === 13936 && codUnder.costRtoPaise === 14200,
      `${codUnder.costForwardPaise} / ${codUnder.costRtoPaise}`,
    );

    /**
     * **This assertion is the inverse of what it used to be, and the inversion
     * is the bug fix.**
     *
     * The free tier was gated `!isCod`, so a ₹7,000 cash order paid full
     * freight while a ₹7,000 card order paid nothing, and nothing on the page
     * explained why. The owner's decision 2 on 2026-08-09 removed the gate.
     * Decision 3 kept the cash-handling fee chargeable on top of free delivery
     * — it is a real courier cost and it gives customers a reason to prepay —
     * so the two are asserted separately: free delivery, and a surviving named
     * COD line.
     */
    const codOver = deliveryFee({
      method: "cod",
      subtotalPaise: 500000,
      verdict: live,
      settings: SETTINGS,
    });
    check(
      "Pay on Delivery earns the free-delivery threshold too",
      codOver.shippingFeePaise === 0 && codOver.basis === "free",
      `${codOver.shippingFeePaise} / ${codOver.basis}`,
    );
    check(
      "and the cash-handling fee is still charged on top of it",
      codOver.codHandlingPaise === 5200 && codOver.feePaise === 5200,
      `${codOver.codHandlingPaise} / ${codOver.feePaise}`,
    );
    check(
      "unless the owner turns the waiver on",
      deliveryFee({
        method: "cod",
        subtotalPaise: 500000,
        verdict: live,
        settings: { ...SETTINGS, waiveCodFeeAboveThreshold: true },
      }).feePaise === 0,
    );

    /**
     * Flat mode, which is now a *verdict* as much as a setting.
     *
     * The fee comes from `flat_shipping_fee_paise` and **no courier call is
     * made at all** — which is why the verdict passed here is
     * `FLAT_SERVICEABILITY` rather than a live quote. That is the owner's
     * festival-sale requirement: a fixed price rather than a fixed price plus
     * an API dependency.
     *
     * The cost fields are null, and that is the honest record rather than a
     * gap. They used to be asserted as the live figures; asserting them now
     * would be asserting that we know what a courier we never asked would have
     * charged.
     */
    const flat = deliveryFee({
      method: "cod",
      subtotalPaise: 199900,
      verdict: FLAT,
      settings: {
        ...SETTINGS,
        shippingRateMode: "flat" as const,
        flatShippingFeePaise: 9900,
      },
    });
    check(
      "the owner can charge a flat fee and absorb the difference",
      flat.feePaise === 9900 && flat.basis === "flat",
      `${flat.feePaise} / ${flat.basis}`,
    );
    check(
      "and no cost is claimed for a courier that was never asked",
      flat.costForwardPaise === null && flat.costRtoPaise === null,
      `${flat.costForwardPaise} / ${flat.costRtoPaise}`,
    );
    check(
      "the mode is frozen onto the fee, which `basis` alone cannot answer",
      flat.rateMode === "flat" &&
        deliveryFee({
          method: "cod",
          subtotalPaise: 500000,
          verdict: FLAT,
          settings: { ...SETTINGS, shippingRateMode: "flat" as const },
        }).rateMode === "flat",
    );

    /**
     * An outage, and the ₹150 that must never come back.
     *
     * This check used to assert that a cash order fell back to
     * `fallback_fee_paise.cod`. Both halves of that pair are gone: the branch
     * now charges the prepaid estimate and — the part that reached a customer —
     * **invents no cash-handling line at all**, because Shiprocket was never
     * asked what it charges to collect. The old code answered that question by
     * subtracting one owner-typed constant from another and printing the
     * difference as a courier fee. Order FV-2026-00571 carries it.
     *
     * Pay on Delivery is withdrawn upstream on an unknown verdict under
     * decision 4, so this fee is never what a customer actually pays for a cash
     * order; it is asserted here so the subtraction cannot be reintroduced.
     */
    const outage = deliveryFee({
      method: "cod",
      subtotalPaise: 199900,
      verdict: { ...UNKNOWN, forwardCostPaise: null },
      settings: SETTINGS,
    });
    check(
      "an outage prices from the estimate, and says so rather than calling it a rate",
      outage.feePaise === SETTINGS.prepaidEstimateFeePaise &&
        outage.basis === "unavailable",
      `${outage.feePaise} / ${outage.basis}`,
    );
    check(
      "and never invents a cash-handling fee out of two settings",
      outage.codHandlingPaise === 0,
      String(outage.codHandlingPaise),
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
      "prepaid never carries a COD handling line",
      prepaidUnder.codHandlingPaise === 0 && prepaidOver.codHandlingPaise === 0,
    );
    check(
      "the split always reconstitutes the fee actually charged",
      [
        prepaidUnder,
        prepaidOver,
        codUnder,
        codOver,
        flat,
        outage,
        outageFree,
      ].every((f) => f.shippingFeePaise + f.codHandlingPaise === f.feePaise),
    );
  }

  /* ═══ 6 · fulfilment idempotency ═════════════════════════════════════════ */
  section("6 · Every fulfilment step is safe to press twice");
  {
    const { createShipment, assignAwb, schedulePickup, generateDocuments } =
      await import("@/lib/shipping/fulfilment");
    const { parcelDefaultsStatus } = await import("@/lib/shipping/quote");

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

      /**
       * Nothing can be created while the shop's own parcel is incomplete.
       *
       * `shippingDefaults()` used to answer a half-filled settings row with a
       * 900g box nobody had chosen; it throws now, and `default_parcel_height_cm`
       * is deliberately unset until the owner measures it. So on a database in
       * that state every assertion below would fail for a reason that has
       * nothing to do with idempotency.
       *
       * The suite refuses to pretend either way: it asserts that the refusal
       * happens *here* rather than at Shiprocket, that it names the field to
       * fill in, and then says plainly which checks did not run. A skip that is
       * itself an assertion is the only kind worth having.
       */
      const parcels = await parcelDefaultsStatus();
      if (!parcels.ok) {
        const blocked = await createShipment(admin, order);
        check(
          "an incomplete default parcel stops creation here, not at the courier",
          !blocked.ok &&
            parcels.missing.every((field: string) =>
              blocked.message.includes(field),
            ),
          JSON.stringify(blocked),
        );
        console.log(
          `  \x1b[33m•\x1b[0m the rest of section 6 did not run — ${parcels.missing.join(", ")} ` +
            "unset, so there is no shipment to press twice",
        );
        const { error: claimError } = await admin
          .from("shipments")
          .delete()
          .eq("order_id", order.id);
        if (claimError) throw new Error(claimError.message);
      }

      if (parcels.ok) {
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
          const stored = await maybeRow<{ cod_collectable_amount: number }>(
            "audit.shipment.collectable",
            admin
              .from("shipments")
              .select("cod_collectable_amount")
              .eq("order_id", order.id)
              .maybeSingle(),
          );
          check(
            "the shipment records what the courier was asked to collect",
            stored?.cod_collectable_amount === order.balanceDueOnDelivery,
            `stored ${String(stored?.cod_collectable_amount)}, expected ${order.balanceDueOnDelivery}`,
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
  }

  /* ═══ 6b · a failure is written down ════════════════════════════════════ */
  section("6b · A failed step leaves the reason on the order, not in a toast");

  /** Carried into 6c so the render is fed the row that came out of Postgres. */
  let storedFailure: {
    step: string;
    message: string;
    failed_at: string;
  } | null = null;

  {
    const { assignAwb, createShipment, getShipment, getShipmentError } =
      await import("@/lib/shipping/fulfilment");
    const { parcelDefaultsStatus } = await import("@/lib/shipping/quote");

    await clearStoredToken();

    /**
     * Two real refusals, in Shiprocket's own words.
     *
     * The wallet one is the failure that stops every parcel in the shop at
     * once; the pickup one is the failure `SHIPROCKET_PICKUP_LOCATION` exists to
     * prevent, and the exact sentence the panel returns for it.
     */
    const WALLET_REFUSAL = {
      message:
        "Insufficient balance in your wallet. Please recharge to continue shipping.",
      status_code: 400,
    };
    const PICKUP_REFUSAL = {
      message: "Wrong Pickup location entered.",
      status_code: 422,
    };
    let awbSucceeds = false;

    handler = (url) => {
      if (url.endsWith("/auth/login")) return json({ token: TOKEN });
      if (url.includes("/orders/create/adhoc")) return json(WALLET_REFUSAL, 400);
      if (url.includes("/courier/assign/awb"))
        return awbSucceeds
          ? json({
              response: {
                data: {
                  awb_code: "AWB987654321",
                  courier_name: "Delhivery",
                  courier_company_id: 51,
                },
              },
            })
          : json(PICKUP_REFUSAL, 422);
      return json({});
    };

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
        "  \x1b[33m•\x1b[0m skipped — no orders in the database to fail a shipment for",
      );
    } else {
      /**
       * `shipment_errors` is newer than `src/lib/database.types.ts`, which is
       * generated and regenerated as a batch. Reached through an untyped client
       * here for the same reason `fulfilment.ts` declares its own schema type:
       * hand-editing generated output is how a file stops being generated.
       */
      const untyped = admin as unknown as SupabaseClient;

      const wipe = async () => {
        const { error: shipmentWipe } = await admin
          .from("shipments")
          .delete()
          .eq("order_id", orderRow.id);
        if (shipmentWipe) throw new Error(shipmentWipe.message);
        const { error: errorWipe } = await untyped
          .from("shipment_errors")
          .delete()
          .eq("order_id", orderRow.id);
        if (errorWipe) throw new Error(errorWipe.message);
      };
      await wipe();

      const order = {
        id: orderRow.id,
        orderNumber: orderRow.order_number,
        placedAt: orderRow.placed_at,
        paymentMethod: orderRow.payment_method,
        subtotal: orderRow.subtotal,
        shippingFee: orderRow.shipping_fee,
        grandTotal: orderRow.grand_total,
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

      /**
       * The create step, which is the hard case.
       *
       * It inserts its `shipments` row *before* calling Shiprocket — that
       * ordering is what makes `unique (order_id)` able to serialise two
       * simultaneous presses — and deletes it again when the call fails. So the
       * reason has to live somewhere that delete cannot reach, which is the
       * whole argument in `20260809120000_shipment_errors.sql`. This asserts
       * both halves: the row goes, the reason stays.
       */
      const parcels = await parcelDefaultsStatus();
      const failed = await createShipment(admin, order);
      check(
        "a refused create is reported as a failure",
        failed.ok === false,
        JSON.stringify(failed),
      );

      const rowAfter = await getShipment(admin, order.id);
      check(
        "the half-made shipments row is cleared, exactly as before",
        rowAfter === null,
        JSON.stringify(rowAfter),
      );

      const stored = await getShipmentError(admin, order.id);
      check(
        "and the reason survived that clear",
        stored !== null,
        "nothing was stored",
      );
      check(
        "stored verbatim — the same sentence the step reported",
        !failed.ok && stored?.message === failed.message,
        `stored ${JSON.stringify(stored?.message)}`,
      );
      check(
        "under the step that failed",
        stored?.step === "create",
        String(stored?.step),
      );
      check(
        "with the raw body beside it, not just our reading of it",
        stored?.detail !== null && stored?.detail !== undefined,
        JSON.stringify(stored?.detail),
      );
      check(
        "and when it happened",
        stored ? !Number.isNaN(Date.parse(stored.failed_at)) : false,
        String(stored?.failed_at),
      );

      // The point of the whole exercise: it is a row, not a toast.
      const reread = await getShipmentError(admin, order.id);
      check(
        "still there on a second read, after the action has long returned",
        reread !== null && reread.message === stored?.message,
        JSON.stringify(reread?.message),
      );

      if (parcels.ok) {
        check(
          "it is Shiprocket's own sentence, not one of ours",
          stored?.message === WALLET_REFUSAL.message,
          String(stored?.message),
        );
        check(
          "and the whole response body is kept",
          JSON.stringify(stored?.detail) === JSON.stringify(WALLET_REFUSAL),
          JSON.stringify(stored?.detail),
        );
      } else {
        console.log(
          `  \x1b[90m·\x1b[0m the create failure available on this database is the ` +
            `parcel-defaults one (${parcels.missing.join(", ")} unset), so ` +
            `Shiprocket was never reached. The AWB step below carries the ` +
            `verbatim-message assertion instead.`,
        );
      }

      /**
       * The AWB step, which needs no parcel dimensions and therefore always
       * reaches Shiprocket. The row it works from is inserted directly, because
       * what is under test here is the failure path rather than creation.
       */
      await wipe();
      const { error: seedError } = await admin.from("shipments").insert({
        order_id: order.id,
        status: "created",
        shiprocket_order_id: "900001",
        shipment_id: "800001",
      });
      if (seedError) throw new Error(seedError.message);

      const awbFailed = await assignAwb(admin, order.id);
      check(
        "a refused AWB is reported as a failure",
        awbFailed.ok === false,
        JSON.stringify(awbFailed),
      );

      const awbStored = await getShipmentError(admin, order.id);
      check(
        "Shiprocket's own words are stored, character for character",
        awbStored?.message === PICKUP_REFUSAL.message,
        String(awbStored?.message),
      );
      check(
        "and its entire response body with them",
        JSON.stringify(awbStored?.detail) === JSON.stringify(PICKUP_REFUSAL),
        JSON.stringify(awbStored?.detail),
      );
      check(
        "attributed to the awb step",
        awbStored?.step === "awb",
        String(awbStored?.step),
      );
      check(
        "and the shipment row itself is untouched by a failed step",
        (await getShipment(admin, order.id)) !== null,
      );

      if (awbStored) {
        storedFailure = {
          step: awbStored.step,
          message: awbStored.message,
          failed_at: awbStored.failed_at,
        };
      }

      // A step that works says so by leaving nothing behind.
      awbSucceeds = true;
      const awbOk = await assignAwb(admin, order.id);
      check(
        "a step that then succeeds clears the reason",
        awbOk.ok === true && (await getShipmentError(admin, order.id)) === null,
        JSON.stringify(awbOk),
      );

      await wipe();
    }
  }

  /* ═══ 6c · and the page renders it ═══════════════════════════════════════ */
  section("6c · The order page renders that stored message");
  {
    const COMPONENT = "./src/components/admin/orders/shipment-error.tsx";

    if (!storedFailure) {
      console.log(
        "  \x1b[33m•\x1b[0m skipped — 6b stored nothing to render",
      );
    } else {
      const markup = renderComponent(COMPONENT, "ShipmentErrorNotice", {
        failure: {
          step: storedFailure.step,
          message: storedFailure.message,
          failedAt: storedFailure.failed_at,
        },
      });

      check(
        "the stored message reaches the page verbatim",
        markup.includes(escapeHtml(storedFailure.message)),
        markup.slice(0, 200),
      );
      check(
        "beside what to do about it",
        markup.includes("Pickup Addresses"),
        markup.slice(0, 300),
      );
      check(
        "and a link to the panel where it is fixed",
        markup.includes("https://app.shiprocket.in/"),
        markup.slice(0, 300),
      );
    }

    /**
     * The case the mapping cannot be written for.
     *
     * A message nobody has seen before must still arrive on the page word for
     * word, with an action that is honest about not recognising it. A mapper
     * that answered an unknown error with "something went wrong" would have
     * reintroduced, one layer up, exactly the problem this item exists to fix.
     */
    const unknown = "E-4471: shipment blocked by risk engine, contact account manager";
    const unknownMarkup = renderComponent(COMPONENT, "ShipmentErrorNotice", {
      failure: { step: "pickup", message: unknown, failedAt: null },
    });
    check(
      "an unrecognised message is still printed in full",
      unknownMarkup.includes(escapeHtml(unknown)),
      unknownMarkup.slice(0, 200),
    );
    check(
      "with a generic action rather than silence",
      unknownMarkup.includes("safe to press twice"),
      unknownMarkup.slice(0, 300),
    );

    // The wallet case, which is the one the owner is most likely to meet.
    const walletMarkup = renderComponent(COMPONENT, "ShipmentErrorNotice", {
      failure: {
        step: "create",
        message: "Insufficient balance in your wallet.",
        failedAt: null,
      },
    });
    check(
      "an insufficient-balance refusal says to recharge",
      walletMarkup.includes("Recharge the wallet"),
      walletMarkup.slice(0, 300),
    );

    // And ours, which is the one it is failing with today.
    const parcelMarkup = renderComponent(COMPONENT, "ShipmentErrorNotice", {
      failure: {
        step: "create",
        message:
          "The shop's default parcel is incomplete — default_parcel_height_cm is not set.",
        failedAt: null,
      },
    });
    check(
      "an unset parcel dimension points at our settings page, not at Shiprocket",
      parcelMarkup.includes("/admin/settings") &&
        !parcelMarkup.includes("app.shiprocket.in"),
      parcelMarkup.slice(0, 300),
    );
  }

  /* ═══ 6d · the wallet ════════════════════════════════════════════════════ */
  section("6d · The wallet balance, and every way of failing to read it");
  {
    const {
      judgeWallet,
      parseWalletBalancePaise,
      readWalletBalance,
      shiprocketWalletStatus,
    } = await import("@/lib/shipping/wallet");
    const WALLET_COMPONENT = "./src/components/admin/shipping/wallet-status.tsx";

    /**
     * The shape verified against the live account: rupees, as a string, two
     * decimal places. `299.47 * 100` is 29946.999999999996 in IEEE 754, which is
     * why the parser reads the string rather than multiplying.
     */
    check(
      'the live shape: {"data":{"balance_amount":"299.47"}} is 29947 paise',
      parseWalletBalancePaise({ data: { balance_amount: "299.47" } }) === 29947,
      String(parseWalletBalancePaise({ data: { balance_amount: "299.47" } })),
    );
    check(
      "a whole-rupee balance keeps its two zeroes",
      parseWalletBalancePaise({ data: { balance_amount: "1200" } }) === 120000,
    );
    check(
      "one decimal place is tens of paise, not units",
      parseWalletBalancePaise({ data: { balance_amount: "12.5" } }) === 1250,
    );
    check(
      "an account in arrears keeps its minus sign",
      parseWalletBalancePaise({ data: { balance_amount: "-5.50" } }) === -550,
    );
    check(
      "an empty wallet is zero, and zero is a number",
      parseWalletBalancePaise({ data: { balance_amount: "0.00" } }) === 0,
    );
    for (const [label, payload] of [
      ["a missing field", { data: {} }],
      ["a missing envelope", {}],
      ["null", null],
      ["prose", { data: { balance_amount: "unavailable" } }],
    ] as const) {
      check(
        `${label} is unreadable, never zero`,
        parseWalletBalancePaise(payload) === null,
        String(parseWalletBalancePaise(payload)),
      );
    }

    await clearStoredToken();
    handler = (url) => {
      if (url.endsWith("/auth/login")) return json({ token: TOKEN });
      if (url.includes("/account/details/wallet-balance"))
        return json({ data: { balance_amount: "299.47" } });
      return json({});
    };
    const live = await readWalletBalance();
    check(
      "the endpoint is read through the same client as everything else",
      live.state === "read" && live.balancePaise === 29947,
      JSON.stringify(live),
    );

    /**
     * A wallet lookup that never answers must not hold the dashboard open.
     *
     * The mock honours `init.signal`, so this measures the real deadline rather
     * than a fast stub — see the note on `installMock`.
     */
    await clearStoredToken();
    handler = async (url) => {
      if (url.endsWith("/auth/login")) return json({ token: TOKEN });
      await sleep(6000);
      return json({ data: { balance_amount: "299.47" } });
    };
    const startedAt = Date.now();
    const timedOut = await readWalletBalance();
    const elapsed = Date.now() - startedAt;
    check(
      "a wallet that stops answering is abandoned, not waited for",
      elapsed < 4500,
      `${elapsed}ms`,
    );
    check(
      "and it degrades to could-not-read rather than throwing",
      timedOut.state === "unreadable",
      JSON.stringify(timedOut),
    );

    await clearStoredToken();
    handler = (url) => {
      if (url.endsWith("/auth/login")) return json({ token: TOKEN });
      return json({ message: "Service temporarily unavailable" }, 503);
    };
    const down = await readWalletBalance();
    check(
      "a 503 is could-not-read, carrying Shiprocket's own words",
      down.state === "unreadable" &&
        down.message.includes("Service temporarily unavailable"),
      JSON.stringify(down),
    );

    await clearStoredToken();
    handler = (url) => {
      if (url.endsWith("/auth/login")) return json({ token: TOKEN });
      return json({ data: {} });
    };
    const nonsense = await readWalletBalance();
    check(
      "a 200 in a shape we do not recognise is could-not-read, not zero",
      nonsense.state === "unreadable",
      JSON.stringify(nonsense),
    );

    /**
     * The comparison, over every combination that matters. The two that would
     * be easy to get wrong are the last two: neither an unknown balance nor an
     * unconfigured threshold may produce a warning, because neither is
     * something the owner can act on.
     */
    const READ = { state: "read", balancePaise: 29947 } as const;
    const SET = { state: "set", paise: 50000 } as const;
    check(
      "below the line is low",
      judgeWallet(READ, SET).low === true,
    );
    check(
      "exactly on the line is low — it says at or below",
      judgeWallet({ state: "read", balancePaise: 50000 }, SET).low === true,
    );
    check(
      "above it is not",
      judgeWallet({ state: "read", balancePaise: 100000 }, SET).low === false,
    );
    check(
      "an unreadable balance is never low",
      judgeWallet({ state: "unreadable", message: "x" }, SET).low === false,
    );
    check(
      "and an unset threshold cannot make anything low",
      judgeWallet(READ, { state: "unset" }).low === false,
    );

    /**
     * End to end against the real settings row. The threshold is the owner's
     * number and is not set on this deployment, so what is asserted is the
     * behaviour rather than the figure: nothing warns, and the dashboard says
     * out loud that nothing is watching.
     */
    await clearStoredToken();
    handler = (url) => {
      if (url.endsWith("/auth/login")) return json({ token: TOKEN });
      if (url.includes("/account/details/wallet-balance"))
        return json({ data: { balance_amount: "299.47" } });
      return json({});
    };
    const status = await shiprocketWalletStatus();
    check(
      "the dashboard's reading comes back whole",
      status.reading.state === "read" &&
        status.reading.balancePaise === 29947,
      JSON.stringify(status.reading),
    );
    check(
      "with no threshold configured, nothing is reported as low",
      status.threshold.state !== "set" && status.low === false,
      JSON.stringify(status.threshold),
    );

    const unsetMarkup = renderComponent(
      WALLET_COMPONENT,
      "ShiprocketWalletStatus",
      { status },
    );
    check(
      "and the dashboard says so loudly rather than quietly never warning",
      unsetMarkup.includes("Nothing is watching the Shiprocket wallet"),
      unsetMarkup.slice(0, 300),
    );
    check(
      "while still showing the balance it did read",
      unsetMarkup.includes("299.47"),
      unsetMarkup.slice(0, 300),
    );

    const unreadableMarkup = renderComponent(
      WALLET_COMPONENT,
      "ShiprocketWalletStatus",
      {
        status: judgeWallet(
          { state: "unreadable", message: "Shiprocket did not answer in time." },
          { state: "set", paise: 50000 },
        ),
      },
    );
    check(
      "an unreadable balance renders as could-not-read",
      unreadableMarkup.includes("could not be read"),
      unreadableMarkup.slice(0, 300),
    );
    check(
      "and never as zero, which would mean the opposite thing",
      !unreadableMarkup.includes(">0") && !/₹0\b/.test(unreadableMarkup),
      unreadableMarkup.slice(0, 300),
    );

    const lowMarkup = renderComponent(
      WALLET_COMPONENT,
      "ShiprocketWalletStatus",
      { status: judgeWallet(READ, SET) },
    );
    check(
      "a low balance says what stops if it empties",
      lowMarkup.includes("shipping stops for every order at once"),
      lowMarkup.slice(0, 300),
    );
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
