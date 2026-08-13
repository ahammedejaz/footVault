/**
 * `npm run audit:rate-limit-public` — the public read endpoints have a ceiling.
 *
 * ## Why this gate exists
 *
 * Stage 1 found `/api/search/suggest` with no rate limit: a public GET, called
 * on a keystroke cadence, running the trigram `catalog_query` per call. The
 * `revalidate = 60` on it caches *per URL*, so a caller varying `q` on every
 * request bypasses the cache completely and lands a database query each time.
 * The cost is DB load rather than money or third-party quota, which is exactly
 * the kind of failure that looks like nothing until the database saturates and
 * then looks like the whole shop being down.
 *
 * ## Why it drives HTTP rather than reading the source
 *
 * The tempting version of this test greps `route.ts` for `consumeRateLimit`.
 * That would pass the moment the call exists, whether or not it is reached,
 * whether or not the policy is registered, and whether or not the handler
 * actually refuses. This phase's headline finding was a gate reporting 127
 * passed with the guard it was named after deleted, because it asserted
 * something adjacent to the property instead of the property. So this one
 * hammers the real endpoint over the network and requires an actual 429.
 *
 * Each request carries a distinct `q`, which is the attack: distinct query
 * strings mean distinct cache keys, so every one of them is a real query. If a
 * limit is in force the burst trips it; if it is not, all of them return 200
 * and this gate fails — which is what it did on the unfixed tree.
 *
 * Read-only. It creates nothing and writes nothing; it only reads the catalogue
 * through a public endpoint, which is what any visitor does.
 */
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.AUDIT_BASE_URL ?? "http://localhost:3210";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, held: boolean, detail = ""): void {
  if (held) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(
      `  \x1b[31m✗ FAIL\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`,
    );
  }
}

/**
 * Fire `count` requests with distinct queries and report what came back.
 *
 * Sequential rather than concurrent on purpose: the limiter counts requests,
 * and a concurrent burst can race the counter's read-modify-write and let more
 * through than the policy names. That race is a real property worth knowing
 * about, but it is not what this gate is measuring, and mixing the two would
 * make a flaky gate out of a deterministic one.
 */
async function burst(
  path: (q: string) => string,
  count: number,
): Promise<{ statuses: Map<number, number>; retryAfter: string | null }> {
  const statuses = new Map<number, number>();
  let retryAfter: string | null = null;
  for (let i = 0; i < count; i++) {
    // A fresh term every time: distinct URL, distinct cache key, real query.
    const res = await fetch(`${BASE}${path(`zq${Date.now().toString(36)}${i}`)}`);
    statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
    if (res.status === 429 && !retryAfter) {
      retryAfter = res.headers.get("retry-after");
    }
    await res.arrayBuffer();
  }
  return { statuses, retryAfter };
}

function describe(statuses: Map<number, number>): string {
  return [...statuses.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([status, n]) => `${status}×${n}`)
    .join(" ");
}

async function main(): Promise<void> {
  console.log(`\nPublic read endpoints have a ceiling — ${BASE}\n`);

  console.log("\x1b[1m1 · /api/search/suggest\x1b[0m");
  {
    // The policy is 60/60s. 75 sequential distinct queries must cross it.
    const { statuses, retryAfter } = await burst(
      (q) => `/api/search/suggest?q=${q}`,
      75,
    );
    check(
      "a burst of distinct queries is eventually refused",
      (statuses.get(429) ?? 0) > 0,
      describe(statuses),
    );
    check(
      "the refusal carries Retry-After, so a caller knows when to return",
      retryAfter !== null && Number(retryAfter) > 0,
      `retry-after=${retryAfter ?? "absent"}`,
    );
    check(
      "and it served real answers before refusing (not a blanket block)",
      (statuses.get(200) ?? 0) > 0,
      describe(statuses),
    );
  }

  /*
    The limiter is fail-open by design (see src/lib/rate-limit.ts), so a
    throttled endpoint must recover on its own rather than needing a deploy.
    Waiting a full window would make this gate a minute slower for a property
    the window arithmetic already guarantees, so this only asserts that the
    endpoint still answers correctly for a *different* key — which is the
    property that would break if the limit were keyed on something global.
  */
  console.log("\n\x1b[1m2 · The limit is per-caller, not global\x1b[0m");
  {
    const res = await fetch(`${BASE}/api/search/suggest?q=nike`, {
      headers: { "x-forwarded-for": "203.0.113.77" },
    });
    check(
      "a different caller is not collateral damage",
      res.status === 200,
      `status=${res.status}`,
    );
    await res.arrayBuffer();
  }

  console.log("\n\x1b[1m3 · /api/cart GET\x1b[0m");
  {
    // cartRead is 120/60s. 140 sequential opens must cross it.
    const { statuses, retryAfter } = await burst(() => `/api/cart`, 140);
    check(
      "opening the drawer in a loop is eventually refused",
      (statuses.get(429) ?? 0) > 0,
      describe(statuses),
    );
    check(
      "the refusal carries Retry-After",
      retryAfter !== null && Number(retryAfter) > 0,
      `retry-after=${retryAfter ?? "absent"}`,
    );
  }

  /*
    Address writes are Server Actions rather than routes, so the only honest way
    to test the limit is to drive the real action over HTTP the way the browser
    does — the same technique `server-actions.ts` uses. That needs a built
    artifact to read the action id out of, so this section skips loudly rather
    than silently when there is no build. A skipped check that announces itself
    is recoverable; one that quietly passes is the failure mode this whole phase
    has been about.
  */
  console.log("\n\x1b[1m4 · saveAddress (Server Action)\x1b[0m");
  {
    const built = existsSync(".next/static/chunks");
    if (!built) {
      console.log(
        "  \x1b[33mSKIP\x1b[0m no .next/static/chunks — run build:stage first.\n" +
          "         This section needs the action id from the built bundle.",
      );
    } else {
      const { createAccount } = await import("./fixtures");
      const { findActionId, postServerAction, sessionCookieHeader } =
        await import("./action-post");

      const id = findActionId("saveAddress");
      if (!id) {
        check("saveAddress id present in the bundle", false);
      } else {
        const account = await createAccount("ratelimit");
        const cookie = await sessionCookieHeader(account.session);
        /*
          Valid payloads, deliberately. `saveAddress` parses the schema *before*
          it reaches the limiter, so an empty body is rejected by zod and never
          spends an allowance — a burst of junk would prove nothing. Real rows
          get written to a throwaway QA account instead, which teardown sweeps
          on the `fv-qa.` prefix.
        */
        const payload = JSON.stringify([
          {
            recipientName: "Rate Limit",
            phone: "9876500011",
            line1: "4 Harness Lane",
            line2: null,
            city: "Panaji",
            state: "Goa",
            postalCode: "403001",
            label: null,
          },
        ]);
        // addressWrite is 20/60s, so 26 must cross it.
        let throttled = 0;
        let accepted = 0;
        for (let i = 0; i < 26; i++) {
          const body = await postServerAction(
            BASE,
            "/account/addresses",
            id,
            payload,
            cookie,
          );
          if (/a lot of changes at once/.test(body)) throttled += 1;
          else if (/"ok"\s*:\s*true/.test(body)) accepted += 1;
        }
        check(
          "a burst of address writes is eventually throttled",
          throttled > 0,
          `accepted=${accepted} throttled=${throttled}`,
        );
        check(
          "and the allowance was spent on real writes first",
          accepted > 0,
          `accepted=${accepted} throttled=${throttled}`,
        );
      }
    }
  }

  await sleep(50);
  console.log(
    `\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m`,
  );
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

void main();
