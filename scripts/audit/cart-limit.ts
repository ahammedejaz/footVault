/**
 * The bag's write limit, against a real server.
 *
 * `addToBag`, `setQuantity` and `removeLine` are the only unauthenticated
 * endpoints in the shop that **create rows**, which is the shape of the
 * anonymous stock drain found in Phase 5. What made that one matter was never
 * the individual write; it was that nothing bounded how many there could be.
 *
 * The decision that carries the weight is which bucket the counter uses. Rate
 * limiting a guest by their guest *token* looks correct and is worthless: the
 * token lives in a cookie the caller controls, so a client that declines to
 * send one is handed a fresh token — and a fresh `carts` row — on every
 * request, and the limit resets with it. `callerIdentity` returns `ip:…` for a
 * guest precisely so that cannot happen.
 *
 * ## What this gate does and does not prove
 *
 * Sections 1, 2 and 3 are **structural**: they read the source and assert which
 * policy is used, which bucket it is keyed on, and that all four write actions
 * sit behind it. They do not drive the actions, because a Server Action is a
 * POST carrying a `Next-Action` id that changes every build — a gate built on
 * reverse-engineering it would fail for reasons that are not defects, which is
 * worse than not testing it.
 *
 * Section 4 is **behavioural** and is the one that proves the limiter actually
 * refuses: it drives `consume_rate_limit` in the database directly, past its
 * ceiling, under a bucket no other caller shares. A structural gate alone would
 * pass just as happily against a limiter that counted correctly and never said
 * no.
 *
 *   npm run audit:cart-limit
 */
import { adminClient } from "./clients";

const BASE = process.env.AUDIT_BASE_URL ?? "http://localhost:3210";

let failures = 0;
function check(name: string, passed: boolean, detail = "") {
  if (!passed) failures++;
  console.log(
    `${passed ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`,
  );
}

/** The bag still has to load for someone arriving with no cookie at all. */
async function hitCartPageWithoutCookies(): Promise<number> {
  const response = await fetch(`${BASE}/cart`, {
    headers: { "user-agent": "fv-audit-cart-limit" },
    redirect: "manual",
  });
  return response.status;
}

async function main() {
  console.log("\nThe bag's write limit\n");

  const admin = adminClient();

  /* 1 ── the policy exists and is keyed on something a caller cannot reset ── */

  /*
    Read out of the source rather than imported: `rate-limit.ts` is
    `server-only`, and the properties being asserted here are structural — what
    the numbers are, and which bucket the counter uses. Driving the real limit
    to exhaustion would also exhaust it for anything else running against this
    server, which is a worse way to learn the same fact.
  */
  const { readFileSync } = await import("node:fs");
  const limiterSource = readFileSync("src/lib/rate-limit.ts", "utf8");
  const source = readFileSync("src/lib/actions/cart.ts", "utf8");

  const policyMatch = /cartWrite:\s*\[(\d+),\s*(\d+)\]/.exec(limiterSource);
  const policy = policyMatch
    ? ([Number(policyMatch[1]), Number(policyMatch[2])] as const)
    : null;

  check(
    "a cartWrite policy exists",
    policy !== null,
    policy ? `${policy[0]} per ${policy[1]}s` : "missing",
  );
  check(
    "it is generous enough not to reject a real customer",
    policy !== null && policy[0] >= 60,
    policy ? `${policy[0]} per minute` : "",
  );

  /* 2 ── the identity is the IP, not the guest token ───────────────────── */

  check(
    "cart writes consume the limiter",
    /consumeRateLimit\(\s*"cartWrite"/.test(source),
  );
  check(
    "keyed by callerIdentity, which is ip:… for a guest",
    /callerIdentity\(/.test(source) &&
      !/consumeRateLimit\(\s*"cartWrite",\s*guestToken/.test(source),
    "a guest-token bucket would reset on every cookie-less request",
  );

  const guarded = [
    "addToBag",
    "setQuantity",
    "removeLine",
    "acknowledgeCartChanges",
  ];
  for (const fn of guarded) {
    const body = source.slice(source.indexOf(`export async function ${fn}`));
    const upToNext = body.slice(0, body.indexOf("\nexport async function", 1));
    check(
      `${fn} is behind the limit`,
      upToNext.includes("withinCartWriteLimit()"),
    );
  }

  /* 3 ── the limiter fails open ────────────────────────────────────────── */

  check(
    "an unreadable counter allows the write rather than blocking the bag",
    /ALLOWED_ON_ERROR/.test(limiterSource),
    "a database blip must not stop people adding to their bag",
  );

  /* 4 ── the shop still serves ─────────────────────────────────────────── */

  const status = await hitCartPageWithoutCookies();
  check("the cart page still answers 200 for a cookie-less visitor", status === 200, String(status));

  /* 4b ── the counter actually refuses ─────────────────────────────────── */

  /*
    Everything above reads source. This drives the database function the
    limiter calls, under a bucket nothing else shares, and spends it past the
    ceiling. Without this the suite would pass against a limiter that counted
    perfectly and always answered yes.

    A small synthetic limit rather than the real 90: the property being proved
    is "it says no at the ceiling", and proving it at 90 costs 91 round trips
    to establish the same fact.
  */
  const bucket = `audit:cart-limit:${Date.now()}`;
  const LIMIT = 3;
  const verdicts: boolean[] = [];
  for (let i = 0; i < LIMIT + 1; i++) {
    const { data, error } = await admin.rpc("consume_rate_limit", {
      p_bucket: bucket,
      p_limit: LIMIT,
      p_window_seconds: 60,
    });
    if (error) {
      check("the rate limit counter is callable", false, error.message);
      break;
    }
    /*
      `consume_rate_limit` returns a *set*, so the verdict is `data[0]`, not
      `data`. Reading it the other way makes every call look refused — which
      an "is the 4th refused?" assertion passes by accident. That is why the
      allowed-then-refused pair is asserted rather than just the refusal.
    */
    const row = (data as { allowed?: boolean }[] | null)?.[0];
    verdicts.push(Boolean(row?.allowed));
  }

  check(
    `the first ${LIMIT} calls are allowed`,
    verdicts.slice(0, LIMIT).every(Boolean),
    verdicts.slice(0, LIMIT).join(", "),
  );
  check(
    "the one past the ceiling is refused",
    verdicts[LIMIT] === false,
    `call ${LIMIT + 1} → allowed=${verdicts[LIMIT]}`,
  );

  /* 5 ── how many carts a cookie-less caller can already hold ──────────── */

  /*
    Context rather than a pass/fail threshold: this counts what is in staging
    now, so a future run that finds the number climbing has something to
    compare against. The limit bounds the rate, not the total — said plainly
    here so nobody reads this gate as proving more than it does.
  */
  const { count, error: countError } = await admin
    .from("carts")
    .select("id", { count: "exact", head: true })
    .is("user_id", null);
  console.log(
    countError
      ? `\n  (guest cart count unavailable: ${countError.message})`
      : `\n  (guest carts in staging right now: ${count ?? "unknown"})`,
  );

  console.log(
    failures === 0
      ? "\nAll checks passed.\n"
      : `\n${failures} check(s) failed.\n`,
  );
  if (failures > 0) process.exit(1);
}

void main();
